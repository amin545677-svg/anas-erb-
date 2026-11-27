'use strict';

const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const CALLABLE_BASE_OPTIONS = Object.freeze({
  region: 'us-central1',
  enforceAppCheck: true,
  timeoutSeconds: 60
});
const ReverseLedger = require('./lib/reverse-ledger.js');
const { authorizePreparedReverseOperation } = require('./reverse-ledger-adapter.js');
const { createReverseLedgerHandler } = require('./reverse-ledger-service.js');
const { createReverseLedgerBackupHandlers } = require('./reverse-ledger-backup-service.js');
const { createSettlementAllocationHandler } = require('./settlement-allocation-service.js');

if (!getApps().length) initializeApp();

let firebaseRuntimeConfig = {};
try { firebaseRuntimeConfig = JSON.parse(process.env.FIREBASE_CONFIG || '{}'); } catch (_) {}
const projectId = process.env.GCLOUD_PROJECT || firebaseRuntimeConfig.projectId ||
  process.env.FIREBASE_CONFIG_PROJECT_ID || '';

const executeReverseLedger = createReverseLedgerHandler({
  db: getFirestore(),
  getUser: uid => getAuth().getUser(uid),
  FieldValue,
  HttpsError,
  ReverseLedger,
  authorizePreparedReverseOperation,
  projectId
});

exports.executeReverseLedger = onCall({ ...CALLABLE_BASE_OPTIONS, maxInstances: 10 }, executeReverseLedger);


const executeSettlementAllocation = createSettlementAllocationHandler({
  db: getFirestore(),
  getUser: uid => getAuth().getUser(uid),
  FieldValue,
  HttpsError,
  ReverseLedger
});

exports.executeSettlementAllocation = onCall({ ...CALLABLE_BASE_OPTIONS, maxInstances: 10 }, executeSettlementAllocation);

const reverseLedgerBackupHandlers = createReverseLedgerBackupHandlers({
  db: getFirestore(),
  FieldValue,
  HttpsError,
  ReverseLedger
});

exports.createTrustedReverseLedgerBackup = onCall({ ...CALLABLE_BASE_OPTIONS, maxInstances: 5 }, reverseLedgerBackupHandlers.createTrustedReverseLedgerBackup);

exports.restoreTrustedReverseLedgerBackup = onCall({ ...CALLABLE_BASE_OPTIONS, maxInstances: 5 }, reverseLedgerBackupHandlers.restoreTrustedReverseLedgerBackup);
