#!/usr/bin/env node
'use strict';

/**
 * Idempotent bootstrap for the isolated ANAS ERP Firebase Staging test account.
 * Requires ADC from FIREBASE_STAGING_SERVICE_ACCOUNT; never prints credentials.
 *
 * Auth and Firestore cannot participate in one cross-service transaction. This
 * script therefore uses an idempotent saga: ensure Auth identity/claims first,
 * then commit and read back the Firestore grant, period, snapshot and audit row.
 */
const { initializeApp, applicationDefault, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const PROJECT_ID = 'anas-erp-staging-a25e1';
const email = String(process.env.ANAS_STAGING_EMAIL || '').trim().toLowerCase();
const password = String(process.env.ANAS_STAGING_PASSWORD || '');
const displayName = String(process.env.ANAS_STAGING_DISPLAY_NAME || 'ANAS ERP Staging Finance Tester').trim();
const uidOverride = String(process.env.ANAS_STAGING_UID || '').trim();

function requireEnv() {
  if (process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT !== PROJECT_ID)
    throw new Error('Refusing to bootstrap a non-Staging GCLOUD_PROJECT.');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS)
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS must point to the Staging service-account file.');
  if (!email || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email))
    throw new Error('ANAS_STAGING_EMAIL is missing or invalid.');
  if (password.length < 12)
    throw new Error('ANAS_STAGING_PASSWORD must contain at least 12 characters.');
  if (uidOverride && !/^[A-Za-z0-9_-]{1,128}$/.test(uidOverride))
    throw new Error('ANAS_STAGING_UID is invalid.');
}

async function ensureUser(auth) {
  let user;
  try {
    user = uidOverride ? await auth.getUser(uidOverride) : await auth.getUserByEmail(email);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    user = await auth.createUser({
      ...(uidOverride ? { uid: uidOverride } : {}),
      email, password, displayName, emailVerified: true, disabled: false
    });
  }
  if (user.email.toLowerCase() !== email)
    throw new Error('Configured staging UID belongs to a different email; refusing account takeover.');
  user = await auth.updateUser(user.uid, {
    email, password, displayName, emailVerified: true, disabled: false
  });
  const claims = {
    ...(user.customClaims || {}),
    canPostReverseLedger: true,
    canPostSettlementAllocation: true,
    role: 'financial_manager',
    anasStagingTestAccount: true
  };
  await auth.setCustomUserClaims(user.uid, claims);
  return { uid: user.uid, email: user.email };
}

async function main() {
  requireEnv();
  const credential = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  if (credential.project_id !== PROJECT_ID)
    throw new Error('Service-account project_id does not match the isolated Staging project.');
  const app = getApps()[0] || initializeApp({
    credential: applicationDefault(),
    projectId: PROJECT_ID
  }, 'anas-erp-staging-bootstrap');
  const auth = getAuth(app);
  const db = getFirestore(app);
  const identity = await ensureUser(auth);
  const uid = identity.uid;
  const snapshotRef = db.collection('users').doc(uid).collection('snapshots').doc('latest');
  const grantRef = db.collection('reverseLedgerGrants').doc(uid);
  const periodRef = db.collection('financialPeriods').doc('FY-2026-10');
  const auditRef = db.collection('stagingBootstrapChecks').doc(uid);
  const baseline = {
    schemaVersion: 2,
    invoices: [], purchases: [], products: [], customers: [], suppliers: [],
    returns: [], cashMovements: [], supplierMovements: [], clientMovements: [],
    stockMovements: [], settlementAllocations: [], customerCreditMovements: [],
    caisseBalance: 0
  };
  const permissions = [
    'reverse_sale_return',
    'reverse_purchase_return',
    'reverse_invoice_cancel',
    'reverse_credit_issue',
    'settlement_allocation_post'
  ];

  await db.runTransaction(async transaction => {
    const [snapshot, grant, period] = await Promise.all([
      transaction.get(snapshotRef), transaction.get(grantRef), transaction.get(periodRef)
    ]);
    if (snapshot.exists && typeof snapshot.get('payload') !== 'string')
      throw new Error('Existing staging snapshot is malformed; refusing to overwrite it.');
    if (grant.exists && grant.get('uid') !== uid)
      throw new Error('Existing staging grant owner mismatch.');
    const currentState = snapshot.exists ? JSON.parse(snapshot.get('payload')) : baseline;
    if (!currentState || typeof currentState !== 'object' || Array.isArray(currentState))
      throw new Error('Existing staging snapshot payload is not an object.');
    const requiredCollections = Object.keys(baseline).filter(key => Array.isArray(baseline[key]));
    for (const key of requiredCollections) {
      if (!Array.isArray(currentState[key]))
        throw new Error('Existing staging snapshot is missing valid collection ' + key + '; refusing destructive repair.');
    }
    if (!period.exists) {
      transaction.create(periodRef, {
        periodId: 'FY-2026-10', status: 'OPEN',
        createdAt: FieldValue.serverTimestamp(), bootstrapManaged: true
      });
    } else if (period.get('status') !== 'OPEN') {
      throw new Error('FY-2026-10 is not OPEN; refusing to reopen a closed financial period.');
    }
    if (!snapshot.exists) {
      transaction.create(snapshotRef, {
        payload: JSON.stringify(baseline),
        updatedAt: FieldValue.serverTimestamp(),
        bootstrapManaged: true
      });
    }
    transaction.set(grantRef, {
      uid, active: true, role: 'financial_manager', schemaVersion: 1,
      permissions,
      bootstrapManaged: true,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(auditRef, {
      uid, email: identity.email, projectId: PROJECT_ID,
      checks: { authIdentity: true, customClaims: true, snapshotReadable: true, grantActive: true, periodOpen: true },
      checkedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });

  const [verifiedUser, verifiedSnapshot, verifiedGrant, verifiedPeriod, verifiedAudit] = await Promise.all([
    auth.getUser(uid), snapshotRef.get(), grantRef.get(), periodRef.get(), auditRef.get()
  ]);
  const claims = verifiedUser.customClaims || {};
  if (verifiedUser.disabled || claims.canPostReverseLedger !== true ||
      claims.canPostSettlementAllocation !== true || !verifiedSnapshot.exists ||
      verifiedGrant.get('active') !== true ||
      !permissions.every(permission => verifiedGrant.get('permissions').includes(permission)) ||
      verifiedPeriod.get('status') !== 'OPEN' || !verifiedAudit.exists)
    throw new Error('Staging bootstrap read-back verification failed.');

  process.stdout.write('STAGING_BOOTSTRAP_REPORT ' + JSON.stringify({
    ok: true, projectId: PROJECT_ID, uid, email: identity.email,
    createdOrUpdated: true, claimsVerified: true, grantPermissions: permissions,
    snapshotVerified: true, periodId: 'FY-2026-10', periodStatus: 'OPEN',
    readWriteCheck: true
  }) + '\\n');
}

main().catch(error => {
  process.stderr.write('STAGING_BOOTSTRAP_FAILED ' + String(error.message || error).replace(/[\\r\\n]+/g, ' ').slice(0, 400) + '\\n');
  process.exitCode = 1;
});
