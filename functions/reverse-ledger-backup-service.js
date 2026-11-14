'use strict';

const crypto = require('node:crypto');

const MAX_SNAPSHOT_BYTES = 700 * 1024;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const MAX_OPERATION_RECORDS = 300;
const MAX_OPERATION_BYTES = 6 * 1024 * 1024;
const MAX_SINGLE_OPERATION_BYTES = 200 * 1024;

function createReverseLedgerBackupHandlers({ db, FieldValue, HttpsError, ReverseLedger }) {
  function fail(code, message) { throw new HttpsError(code, message); }
  function requireContext(request) {
    if (!request || !request.auth || !request.auth.uid) {
      fail('unauthenticated', 'A verified Firebase user session is required.');
    }
    if (!request.app) {
      fail('failed-precondition', 'A valid Firebase App Check token is required.');
    }
    return request.auth.uid;
  }
  function parseSnapshot(payload) {
    if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_SNAPSHOT_BYTES) {
      fail('failed-precondition', 'A valid reverse-ledger cloud snapshot is required.');
    }
    let state;
    try { state = JSON.parse(payload); }
    catch (_) { fail('failed-precondition', 'Cloud snapshot payload is not valid JSON.'); }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      fail('failed-precondition', 'Cloud snapshot payload is malformed.');
    }
    return state;
  }
  function readOperationRecord(doc, uid) {
    const record = doc.data();
    if (!record || record.ownerUid !== uid || record.operationId !== doc.id ||
        !['RESERVED', 'POSTED'].includes(record.status) ||
        (record.requestHash != null &&
          (typeof record.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.requestHash))) ||
        (record.status === 'POSTED' &&
          (!record.requestHash || !record.result || !record.result.document ||
           !record.returnId || String(record.result.document.returnId) !== String(record.returnId)))) {
      fail('failed-precondition', 'A reverse-ledger idempotency record is malformed or belongs to another user.');
    }
    const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
    if (bytes > MAX_SINGLE_OPERATION_BYTES) {
      fail('resource-exhausted', 'A reverse-ledger operation record exceeds the backup safety limit.');
    }
    return record;
  }
  function validateSnapshotParity(payload, records) {
    const state = parseSnapshot(payload);
    if (!ReverseLedger || typeof ReverseLedger.validateReverseLedgerParity !== 'function') {
      fail('internal', 'Canonical reverse-ledger validator is unavailable.');
    }
    try { ReverseLedger.validateReverseLedgerParity(state); }
    catch (error) {
      fail('failed-precondition', 'Backup snapshot failed reverse-ledger parity validation: ' +
        String(error && error.message || error).slice(0, 220));
    }
    for (const [operationId, record] of records) {
      if (record.status !== 'POSTED') continue;
      const returnId = record.returnId || record.result?.document?.returnId;
      const returns = Array.isArray(state.returns) ? state.returns : [];
      if (!returnId || !returns.some(row => row && row.ledgerVersion === 2 &&
          row.status === 'POSTED' && String(row.returnId) === String(returnId))) {
        fail('failed-precondition', 'Posted operation ' + operationId +
          ' is not represented in the backup snapshot; backup/ledger parity is unsafe.');
      }
    }
    return state;
  }
  function operationMap(snapshot, uid) {
    if (snapshot.size > MAX_OPERATION_RECORDS) {
      fail('resource-exhausted', 'Reverse-ledger operation count exceeds the trusted backup limit.');
    }
    const records = snapshot.docs.map(doc => [doc.id, readOperationRecord(doc, uid)]);
    const totalBytes = Buffer.byteLength(JSON.stringify(records), 'utf8');
    if (totalBytes > MAX_OPERATION_BYTES) {
      fail('resource-exhausted', 'Reverse-ledger operation records exceed the trusted backup size limit.');
    }
    return new Map(records);
  }
  function backupId(value) {
    if (typeof value !== 'string' || !/^BKP-[A-Za-z0-9-]{12,100}$/.test(value)) {
      fail('invalid-argument', 'backupId format is invalid.');
    }
    return value;
  }

  async function createTrustedReverseLedgerBackup(request) {
    const uid = requireContext(request);
    const userRoot = db.collection('users').doc(uid);
    const snapshotRef = userRoot.collection('snapshots').doc('latest');
    const backupRef = userRoot.collection('reverseLedgerBackups').doc('BKP-' + crypto.randomUUID());
    const operationsQuery = db.collection('reverseLedgerOperations')
      .where('ownerUid', '==', uid).limit(MAX_OPERATION_RECORDS + 1);

    try {
      return await db.runTransaction(async transaction => {
        const [snapshotSnap, operationsSnap] = await Promise.all([
          transaction.get(snapshotRef),
          transaction.get(operationsQuery)
        ]);
        if (!snapshotSnap.exists) fail('failed-precondition', 'A cloud snapshot is required before creating a trusted reverse-ledger backup.');
        const payload = snapshotSnap.get('payload');
        const records = operationMap(operationsSnap, uid);
        validateSnapshotParity(payload, records);
        const entries = [...records.entries()];
        transaction.create(backupRef, {
          backupId: backupRef.id,
          ownerUid: uid,
          schemaVersion: 1,
          snapshotPayload: payload,
          snapshotPayloadHash: sha256(payload),
          snapshotLastReverseOperationId: snapshotSnap.get('lastReverseOperationId') || null,
          operationCount: entries.length,
          createdAt: FieldValue.serverTimestamp()
        });
        for (const [operationId, record] of entries) {
          transaction.create(backupRef.collection('operations').doc(operationId), {
            operationId,
            record
          });
        }
        return { ok: true, backupId: backupRef.id, operationCount: entries.length };
      }, { maxAttempts: 5 });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', String(error && error.message || 'Trusted reverse-ledger backup failed').slice(0, 300));
    }
  }

  async function restoreTrustedReverseLedgerBackup(request) {
    const uid = requireContext(request);
    const data = request.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).some(key => key !== 'backupId')) {
      fail('invalid-argument', 'Only backupId is accepted for trusted reverse-ledger restore.');
    }
    const id = backupId(data.backupId);
    const userRoot = db.collection('users').doc(uid);
    const snapshotRef = userRoot.collection('snapshots').doc('latest');
    const backupRef = userRoot.collection('reverseLedgerBackups').doc(id);
    const backupOperationsQuery = backupRef.collection('operations').limit(MAX_OPERATION_RECORDS + 1);
    const currentOperationsQuery = db.collection('reverseLedgerOperations')
      .where('ownerUid', '==', uid).limit(MAX_OPERATION_RECORDS + 1);

    try {
      return await db.runTransaction(async transaction => {
        const [backupSnap, backupOperationsSnap, currentOperationsSnap, snapshotSnap] = await Promise.all([
          transaction.get(backupRef),
          transaction.get(backupOperationsQuery),
          transaction.get(currentOperationsQuery),
          transaction.get(snapshotRef)
        ]);
        if (!backupSnap.exists || backupSnap.get('ownerUid') !== uid || backupSnap.get('schemaVersion') !== 1) {
          fail('not-found', 'Trusted reverse-ledger backup was not found for this user.');
        }
        if (!snapshotSnap.exists) fail('failed-precondition', 'A cloud snapshot is required before trusted restore.');
        const backupPayload = backupSnap.get('snapshotPayload');
        if (typeof backupPayload !== 'string' || typeof backupSnap.get('snapshotPayloadHash') !== 'string' ||
            sha256(backupPayload) !== backupSnap.get('snapshotPayloadHash')) {
          fail('failed-precondition', 'Trusted backup snapshot hash does not match its manifest.');
        }
        const currentPayload = snapshotSnap.get('payload');
        if (currentPayload !== backupPayload) {
          let currentSnapshotIsValid = false;
          try {
            const currentState = parseSnapshot(currentPayload);
            ReverseLedger.validateReverseLedgerParity(currentState);
            currentSnapshotIsValid = true;
          } catch (_) {}
          if (currentSnapshotIsValid) {
            fail('failed-precondition', 'Current cloud snapshot is valid but newer or different; refusing to overwrite it with an older backup.');
          }
        }
        const backupRecords = operationMap({
          size: backupOperationsSnap.size,
          docs: backupOperationsSnap.docs.map(doc => ({
            id: doc.id,
            data: () => {
              const wrapper = doc.data();
              if (!wrapper || wrapper.operationId !== doc.id || !wrapper.record) {
                fail('failed-precondition', 'Backup operation record is malformed.');
              }
              return wrapper.record;
            }
          }))
        }, uid);
        validateSnapshotParity(backupPayload, backupRecords);
        if (backupSnap.get('operationCount') !== backupRecords.size) {
          fail('failed-precondition', 'Trusted backup operation count does not match its manifest.');
        }
        const currentRecords = operationMap(currentOperationsSnap, uid);

        // Never roll the financial snapshot behind a posted operation that is not
        // represented by the selected backup. Pending reservations may be retained.
        for (const [operationId, current] of currentRecords) {
          const saved = backupRecords.get(operationId);
          if (!saved) {
            if (current.status === 'POSTED') {
              fail('failed-precondition', 'Restore would omit a posted reverse-ledger operation; choose a newer backup.');
            }
            continue;
          }
          if (current.requestHash && saved.requestHash && current.requestHash !== saved.requestHash) {
            fail('already-exists', 'Backup operationId conflicts with a different financial request.');
          }
          if (current.status === 'POSTED' && saved.status !== 'POSTED') {
            fail('failed-precondition', 'Restore would downgrade a posted idempotency record.');
          }
          if (current.status === 'POSTED' && JSON.stringify(current.result) !== JSON.stringify(saved.result)) {
            fail('already-exists', 'Backup posted result differs from the current idempotency record.');
          }
        }

        let restoredOperations = 0;
        for (const [operationId, saved] of backupRecords) {
          const current = currentRecords.get(operationId);
          if (!current) {
            transaction.create(db.collection('reverseLedgerOperations').doc(operationId), saved);
            restoredOperations++;
          } else if (current.status === 'RESERVED' && saved.status === 'POSTED') {
            transaction.set(db.collection('reverseLedgerOperations').doc(operationId), saved);
            restoredOperations++;
          }
        }
        transaction.update(snapshotRef, {
          payload: backupPayload,
          lastReverseOperationId: backupSnap.get('snapshotLastReverseOperationId') || null,
          updatedAt: FieldValue.serverTimestamp()
        });
        return {
          ok: true,
          backupId: id,
          restoredOperations,
          preservedPendingReservations: [...currentRecords.entries()]
            .filter(([operationId, record]) => record.status === 'RESERVED' && !backupRecords.has(operationId)).length
        };
      }, { maxAttempts: 5 });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', String(error && error.message || 'Trusted reverse-ledger restore failed').slice(0, 300));
    }
  }

  return Object.freeze({ createTrustedReverseLedgerBackup, restoreTrustedReverseLedgerBackup });
}

module.exports = Object.freeze({ createReverseLedgerBackupHandlers });