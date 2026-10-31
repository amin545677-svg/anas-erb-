'use strict';

const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const ReverseLedger = require('../reverse-ledger/reverse-ledger.js');
const {
  normalizeReverseRequest,
  authorizePreparedReverseOperation
} = require('./reverse-ledger-adapter.js');

if (!getApps().length) initializeApp();

const db = getFirestore();
const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_CONFIG_PROJECT_ID || '';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mapError(error) {
  if (error instanceof HttpsError) return error;
  const message = String(error && error.message || 'Reverse posting failed');
  const code = /missing|required|invalid|exceeds|does not|must|blocked|not OPEN|insufficient|ambiguous|duplicate|unallocated|reconcile|mismatch|expired|permission/i.test(message)
    ? 'failed-precondition' : 'internal';
  return new HttpsError(code, message.slice(0, 400));
}

exports.executeReverseLedger = onCall({
  region: 'us-central1',
  enforceAppCheck: true,
  maxInstances: 10,
  timeoutSeconds: 60
}, async (request) => {
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
  const nowEpochMs = Date.now();
  const authUser = await getAuth().getUser(uid);
  if (authUser.disabled) throw new HttpsError('permission-denied', 'Firebase account is disabled.');

  const userRoot = db.collection('users').doc(uid);
  const snapshotRef = userRoot.collection('snapshots').doc('latest');
  const grantRef = userRoot.collection('reverseLedgerGrants').doc(uid);
  const periodRef = userRoot.collection('financialPeriods').doc(normalized.periodId);
  const operationRef = userRoot.collection('reverseLedgerOperations').doc(normalized.operationId);
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

      if (operationSnap.exists) {
        const previous = operationSnap.data();
        if (previous.ownerUid !== uid || previous.requestHash !== requestHash) {
          throw new HttpsError('already-exists', 'operationId was already used for a different reverse request.');
        }
        if (!previous.result || previous.status !== 'POSTED') {
          throw new HttpsError('failed-precondition', 'Existing operation record is incomplete; manual reconciliation is required.');
        }
        return previous.result;
      }

      if (!snapshotSnap.exists || typeof snapshotSnap.get('payload') !== 'string') {
        throw new HttpsError('failed-precondition', 'A valid cloud snapshot is required before reverse posting.');
      }
      if (!grantSnap.exists) throw new HttpsError('permission-denied', 'No trusted reverse-ledger grant exists for this user.');
      if (!periodSnap.exists) throw new HttpsError('failed-precondition', 'The requested financial period does not exist.');

      const grant = grantSnap.data();
      const period = { ...periodSnap.data(), periodId: normalized.periodId };
      const state = JSON.parse(snapshotSnap.get('payload'));
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
      if (invoice.ledgerVersion !== 2) {
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

      const reservation = {
        acquired: true,
        durable: true,
        operationId: normalized.operationId,
        ownerUid: uid,
        leaseId,
        expiresAtEpochMs: nowEpochMs + 60000
      };
      authorizePreparedReverseOperation({
        projectId: PROJECT_ID,
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
      transaction.update(snapshotRef, {
        payload: JSON.stringify(nextState),
        updatedAt: FieldValue.serverTimestamp(),
        lastReverseOperationId: normalized.operationId
      });
      transaction.create(operationRef, {
        ownerUid: uid,
        operationId: normalized.operationId,
        requestHash,
        status: 'POSTED',
        result,
        periodId: normalized.periodId,
        returnId: posted.returnId,
        leaseId,
        createdAt: FieldValue.serverTimestamp()
      });
      return result;
    }, { maxAttempts: 5 });
  } catch (error) {
    throw mapError(error);
  }
});
