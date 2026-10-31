'use strict';

const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const ReverseLedger = require('./lib/reverse-ledger.js');
const { authorizePreparedReverseOperation } = require('./reverse-ledger-adapter.js');
const { createReverseLedgerHandler } = require('./reverse-ledger-service.js');
const { createReverseLedgerBackupHandlers } = require('./reverse-ledger-backup-service.js');

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

exports.executeReverseLedger = onCall({
  region: 'us-central1',
  enforceAppCheck: true,
  maxInstances: 10,
  timeoutSeconds: 60
}, executeReverseLedger);

const reverseLedgerBackupHandlers = createReverseLedgerBackupHandlers({
  db: getFirestore(),
  FieldValue,
  HttpsError,
  ReverseLedger
});

exports.createTrustedReverseLedgerBackup = onCall({
  region: 'us-central1',
  enforceAppCheck: true,
  maxInstances: 5,
  timeoutSeconds: 60
}, reverseLedgerBackupHandlers.createTrustedReverseLedgerBackup);

exports.restoreTrustedReverseLedgerBackup = onCall({
  region: 'us-central1',
  enforceAppCheck: true,
  maxInstances: 5,
  timeoutSeconds: 60
}, reverseLedgerBackupHandlers.restoreTrustedReverseLedgerBackup);
