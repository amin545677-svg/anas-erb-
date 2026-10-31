'use strict';

/**
 * ANAS ERP reverse-ledger authorization policy.
 *
 * SECURITY BOUNDARY:
 * Trusted server code only. This module does NOT verify Firebase JWT signatures,
 * load grants, reserve operation IDs, or commit Firestore writes. The server
 * adapter must do those operations before calling this policy. Never accept
 * this context directly from browser input or AppData.currentUser.
 */
const PERMISSIONS = Object.freeze({
  SALE_RETURN: 'reverse_sale_return',
  PURCHASE_RETURN: 'reverse_purchase_return',
  INVOICE_CANCEL: 'reverse_invoice_cancel',
  CASH_REFUND: 'reverse_cash_refund',
  CREDIT_ISSUE: 'reverse_credit_issue',
  LIQUIDITY_OVERRIDE: 'reverse_liquidity_override',
  LEGACY_RECONCILE: 'reverse_legacy_reconcile'
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function requiredString(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + ' is invalid');
  return value.trim();
}
function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(label + ' must be a non-negative safe integer');
  return value;
}
function requirePermission(grant, permission) {
  if (!grant.permissions.includes(permission)) throw new Error('missing required permission: ' + permission);
}
function assertVerifiedPrincipal(auth, projectId, nowEpochMs) {
  if (!auth || auth.verified !== true) throw new Error('Firebase identity must be verified by the trusted server');
  const uid = requiredString(auth.uid, 'Firebase UID', 128);
  if (auth.disabled === true) throw new Error('Firebase account is disabled');
  if (auth.audience !== projectId || auth.issuer !== 'https://securetoken.google.com/' + projectId)
    throw new Error('Firebase token audience or issuer does not match the configured project');
  if (!Number.isSafeInteger(auth.authTimeSeconds) || auth.authTimeSeconds <= 0 ||
      !Number.isSafeInteger(auth.issuedAtSeconds) || auth.issuedAtSeconds <= 0 ||
      !Number.isSafeInteger(auth.expiresAtSeconds) || auth.expiresAtSeconds <= 0 ||
      auth.issuedAtSeconds < auth.authTimeSeconds || auth.expiresAtSeconds <= auth.issuedAtSeconds)
    throw new Error('Firebase token time claims are invalid');
  const nowSeconds = Math.floor(nowEpochMs / 1000);
  if (auth.authTimeSeconds > nowSeconds || auth.issuedAtSeconds > nowSeconds)
    throw new Error('Firebase token time claims are in the future');
  if (auth.expiresAtSeconds <= nowSeconds) throw new Error('Firebase identity token is expired');
  return uid;
}
function assertGrant(grant, uid) {
  if (!grant || grant.active !== true || grant.uid !== uid || grant.schemaVersion !== 1)
    throw new Error('active trusted authorization grant is missing or mismatched');
  if (!Array.isArray(grant.permissions) ||
      grant.permissions.some(permission => typeof permission !== 'string' || !permission.trim()))
    throw new Error('trusted authorization grant permissions are malformed');
}
function assertReservation(reservation, operationId, uid, nowEpochMs) {
  if (!reservation || reservation.acquired !== true || reservation.durable !== true ||
      reservation.operationId !== operationId || reservation.ownerUid !== uid)
    throw new Error('durable operation reservation is missing or mismatched');
  requiredString(reservation.leaseId, 'operation reservation lease ID', 160);
  if (!Number.isSafeInteger(reservation.expiresAtEpochMs) || reservation.expiresAtEpochMs <= nowEpochMs)
    throw new Error('operation reservation is expired or invalid');
}
function authorizeReverseOperation(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context))
    throw new Error('trusted reverse authorization context is required');
  const projectId = requiredString(context.projectId, 'Firebase project ID', 128);
  const nowEpochMs = nonNegativeSafeInteger(context.nowEpochMs, 'authorization clock');
  const uid = assertVerifiedPrincipal(context.auth, projectId, nowEpochMs);
  assertGrant(context.grant, uid);

  const operation = context.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation))
    throw new Error('reverse operation is required');
  const operationId = requiredString(operation.operationId, 'operationId', 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(operationId))
    throw new Error('operationId format is invalid');
  const type = operation.type;
  if (!own(PERMISSIONS, type)) throw new Error('unsupported reverse operation type');
  requirePermission(context.grant, PERMISSIONS[type]);

  const period = context.period;
  if (!period || period.status !== 'OPEN') throw new Error('financial period is not OPEN');
  const periodId = requiredString(period.periodId, 'financial period ID', 128);
  if (operation.invoiceLedgerVersion !== 2) throw new Error('reverse operation requires a version-2 invoice ledger');
  if (operation.allocationsReconciled !== true) throw new Error('invoice payment allocations are not reconciled');
  if (operation.legacyRecordsPresent === true) {
    requirePermission(context.grant, PERMISSIONS.LEGACY_RECONCILE);
    if (operation.legacyReconciled !== true) throw new Error('legacy invoice requires documented reconciliation');
    requiredString(operation.legacyReconciliationId, 'legacy reconciliation ID', 160);
  }

  const refundCentimes = nonNegativeSafeInteger(operation.cashRefundCentimes ?? 0, 'cash refund');
  const creditCentimes = nonNegativeSafeInteger(operation.creditIssueCentimes ?? 0, 'credit issue');
  const cashAvailable = nonNegativeSafeInteger(context.liquidity?.cashAvailableCentimes, 'available cash');
  if (refundCentimes > 0) {
    requirePermission(context.grant, PERMISSIONS.CASH_REFUND);
    if (operation.settlementMode !== 'cash') throw new Error('cash refund requires explicit cash settlement mode');
    if (cashAvailable < refundCentimes) {
      const approval = context.liquidityOverride;
      if (!approval || approval.approved !== true || approval.uid !== uid ||
          approval.operationId !== operationId ||
          !Number.isSafeInteger(approval.amountCentimes) || approval.amountCentimes < refundCentimes - cashAvailable)
        throw new Error('insufficient liquidity; an explicit authorized liquidity approval is required');
      requirePermission(context.grant, PERMISSIONS.LIQUIDITY_OVERRIDE);
      requiredString(approval.approvalId, 'liquidity approval ID', 160);
    }
  }
  if (creditCentimes > 0) {
    requirePermission(context.grant, PERMISSIONS.CREDIT_ISSUE);
    if (operation.settlementMode !== 'credit') throw new Error('credit issue requires explicit credit settlement mode');
  }

  const stockRequired = nonNegativeSafeInteger(operation.purchaseReturnQuantityMicroUnits ?? 0, 'purchase return quantity');
  const stockAvailable = nonNegativeSafeInteger(context.stock?.availableMicroUnits ?? 0, 'available stock');
  if (type === 'PURCHASE_RETURN' && stockRequired > stockAvailable)
    throw new Error('purchase return exceeds available stock in the selected warehouse');

  assertReservation(context.reservation, operationId, uid, nowEpochMs);
  return Object.freeze({
    authorized: true, uid, operationId, operationType: type,
    permission: PERMISSIONS[type], periodId,
    grantSchemaVersion: context.grant.schemaVersion,
    reservationLeaseId: context.reservation.leaseId
  });
}
const authorizationApi = Object.freeze({ PERMISSIONS, authorizeReverseOperation });
if (typeof module === 'object' && module.exports) module.exports = authorizationApi;
if (typeof globalThis !== 'undefined' && typeof window === 'undefined')
  globalThis.ANASReverseLedgerAuthorization = authorizationApi;
