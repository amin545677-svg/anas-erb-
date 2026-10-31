'use strict';

const crypto = require('node:crypto');
const {
  normalizeReverseRequest,
  buildTrustedReservation
} = require('./reverse-ledger-adapter.js');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createReverseLedgerHandler({
  db, getUser, FieldValue, HttpsError, ReverseLedger,
  authorizePreparedReverseOperation, projectId, now = Date.now
}) {
  function mapError(error) {
    if (error instanceof HttpsError) return error;
    const message = String(error && error.message || 'Reverse posting failed');
    const code = /permission|grant|disabled|identity/i.test(message)
      ? 'permission-denied'
      : /missing|required|invalid|exceeds|does not|must|blocked|not OPEN|insufficient|ambiguous|duplicate|unallocated|reconcile|mismatch|expired/i.test(message)
        ? 'failed-precondition' : 'internal';
    return new HttpsError(code, message.slice(0, 400));
  }

  return async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'A verified Firebase user session is required.');
  }
  if (!request.app) {
    throw new HttpsError('failed-precondition', 'A valid Firebase App Check token is required.');
  }

  let normalized;
  try {
    normalized = normalizeReverseRequest(request.data);
  } catch (error) {
    throw new HttpsError('invalid-argument', String(error.message || error).slice(0, 300));
  }

  const uid = request.auth.uid;
  const token = request.auth.token || {};
  const nowEpochMs = now();
  const authUser = await getUser(uid);
  if (authUser.disabled) throw new HttpsError('permission-denied', 'Firebase account is disabled.');

  const userRoot = db.collection('users').doc(uid);
  const snapshotRef = userRoot.collection('snapshots').doc('latest');
  // Share the exact root control-plane collections with the Cloudflare reservation Worker.
  const grantRef = db.collection('reverseLedgerGrants').doc(uid);
  const periodRef = db.collection('financialPeriods').doc(normalized.periodId);
  const operationRef = db.collection('reverseLedgerOperations').doc(normalized.operationId);
  const requestHash = sha256(JSON.stringify(normalized));
  const returnId = 'RET-' + requestHash.slice(0, 32);
  const leaseId = 'LEASE-' + sha256(uid + ':' + normalized.operationId).slice(0, 24);

  try {
    return await db.runTransaction(async (transaction) => {
      const [snapshotSnap, grantSnap, periodSnap, operationSnap] = await Promise.all([
        transaction.get(snapshotRef),
        transaction.get(grantRef),
        transaction.get(periodRef),
        transaction.get(operationRef)
      ]);

      const previousOperation = operationSnap.exists ? operationSnap.data() : null;
      if (previousOperation) {
        if (previousOperation.ownerUid !== uid) {
          throw new HttpsError('already-exists', 'operationId belongs to another Firebase user.');
        }
        if (previousOperation.status === 'POSTED') {
          if (previousOperation.requestHash !== requestHash || !previousOperation.result) {
            throw new HttpsError('already-exists', 'operationId was already used for a different reverse request.');
          }
          return previousOperation.result;
        }
      }
      let reservation;
      try {
        // The reservation Worker may have created this root control-plane record.
        reservation = buildTrustedReservation(
          previousOperation, normalized, uid, leaseId, nowEpochMs, requestHash
        );
      } catch (error) {
        throw new HttpsError('failed-precondition', String(error.message || error));
      }

      if (!snapshotSnap.exists || typeof snapshotSnap.get('payload') !== 'string') {
        throw new HttpsError('failed-precondition', 'A valid cloud snapshot is required before reverse posting.');
      }
      if (!grantSnap.exists) throw new HttpsError('permission-denied', 'No trusted reverse-ledger grant exists for this user.');
      if (!periodSnap.exists) throw new HttpsError('failed-precondition', 'The requested financial period does not exist.');

      const grant = grantSnap.data();
      const period = { ...periodSnap.data(), periodId: normalized.periodId };
      const serializedSnapshot = snapshotSnap.get('payload');
      if (Buffer.byteLength(serializedSnapshot, 'utf8') > 700 * 1024) {
        throw new HttpsError('resource-exhausted', 'Cloud snapshot exceeds the 700 KiB transaction safety limit.');
      }
      let state;
      try { state = JSON.parse(serializedSnapshot); }
      catch (_) { throw new HttpsError('failed-precondition', 'Cloud snapshot payload is not valid JSON.'); }
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new HttpsError('failed-precondition', 'Cloud snapshot payload is malformed.');
      }
      if (!Array.isArray(state.invoices) || !Array.isArray(state.purchases) ||
          !Array.isArray(state.products) || !Array.isArray(state.customers) ||
          !Array.isArray(state.suppliers)) {
        throw new HttpsError('failed-precondition', 'Snapshot is missing required financial collections.');
      }

      // The browser-supplied operator identity is never trusted by the posting engine.
      state.currentUser = { id: uid, name: authUser.displayName || uid };
      ReverseLedger.validateReverseLedgerParity(state);

      const invoiceRows = normalized.originalInvoiceType === 'sales_invoice' ? state.invoices : state.purchases;
      const invoiceMatches = invoiceRows.filter(row => row && String(row.id) === normalized.invoiceId);
      if (invoiceMatches.length !== 1) {
        throw new HttpsError('failed-precondition', 'Original invoice is missing or ambiguous.');
      }
      const invoice = invoiceMatches[0];
      if (invoice.invoiceLedgerVersion !== 2) {
        throw new HttpsError('failed-precondition', 'Invoice is not sealed in the version-2 ledger; reconcile it before reverse posting.');
      }

      const nextState = cloneJson(state);
      const posted = ReverseLedger.executeReturnTransaction(nextState, {
        originalInvoiceType: normalized.originalInvoiceType,
        returnType: normalized.returnType,
        invoiceId: normalized.invoiceId,
        items: normalized.items,
        settlementMode: normalized.settlementMode,
        reason: normalized.reason
      }, {
        operatorId: uid,
        createId: () => returnId,
        persist: () => true
      });

      authorizePreparedReverseOperation({
        projectId,
        uid,
        token,
        grant,
        period,
        request: normalized,
        postedDocument: posted,
        state,
        reservation,
        nowEpochMs
      });

      const result = {
        ok: true,
        operationId: normalized.operationId,
        document: posted
      };
      const nextPayload = JSON.stringify(nextState);
      if (Buffer.byteLength(nextPayload, 'utf8') > 700 * 1024) {
        throw new HttpsError('resource-exhausted', 'Updated snapshot exceeds the 700 KiB transaction safety limit.');
      }
      transaction.update(snapshotRef, {
        payload: nextPayload,
        updatedAt: FieldValue.serverTimestamp(),
        lastReverseOperationId: normalized.operationId
      });
      const operationRecord = {
        ownerUid: uid,
        operationId: normalized.operationId,
        operationType: normalized.returnType,
        invoiceId: normalized.invoiceId,
        requestHash,
        status: 'POSTED',
        result,
        periodId: normalized.periodId,
        returnId: posted.returnId,
        leaseId: reservation.leaseId,
        expiresAtEpochMs: reservation.expiresAtEpochMs,
        schemaVersion: 1,
        postedAt: FieldValue.serverTimestamp()
      };
      if (operationSnap.exists) transaction.update(operationRef, operationRecord);
      else transaction.create(operationRef, {
        ...operationRecord,
        createdAt: FieldValue.serverTimestamp()
      });
      return result;
    }, { maxAttempts: 5 });
  } catch (error) {
    throw mapError(error);
  }
  };
}

module.exports = Object.freeze({ createReverseLedgerHandler });
