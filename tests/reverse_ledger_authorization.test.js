'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PERMISSIONS, authorizeReverseOperation } = require('../reverse-ledger/authorization.js');

function validContext(overrides = {}) {
  const base = {
    projectId: 'anas-erb',
    auth: {
      verified: true, uid: 'firebase-user-1', disabled: false,
      audience: 'anas-erb', issuer: 'https://securetoken.google.com/anas-erb',
      authTimeSeconds: 1793400000, issuedAtSeconds: 1793400100, expiresAtSeconds: 1793403700
    },
    grant: { uid: 'firebase-user-1', active: true, schemaVersion: 1, permissions: [
      PERMISSIONS.SALE_RETURN, PERMISSIONS.PURCHASE_RETURN, PERMISSIONS.INVOICE_CANCEL,
      PERMISSIONS.CASH_REFUND, PERMISSIONS.CREDIT_ISSUE
    ] },
    operation: {
      operationId: 'RET-OP-00000001', type: 'SALE_RETURN', invoiceLedgerVersion: 2,
      allocationsReconciled: true, legacyRecordsPresent: false,
      settlementMode: 'cash', cashRefundCentimes: 250, creditIssueCentimes: 0,
      purchaseReturnQuantityMicroUnits: 0
    },
    period: { periodId: 'FY-2026-10', status: 'OPEN' },
    liquidity: { cashAvailableCentimes: 1000 },
    stock: { availableMicroUnits: 10000000 },
    reservation: {
      acquired: true, durable: true, operationId: 'RET-OP-00000001',
      ownerUid: 'firebase-user-1', leaseId: 'LEASE-0001', expiresAtEpochMs: 2000000000000
    },
    nowEpochMs: 1793400200000
  };
  return {
    ...base,
    ...overrides,
    auth: { ...base.auth, ...(overrides.auth || {}) },
    grant: { ...base.grant, ...(overrides.grant || {}) },
    operation: { ...base.operation, ...(overrides.operation || {}) },
    period: { ...base.period, ...(overrides.period || {}) },
    liquidity: { ...base.liquidity, ...(overrides.liquidity || {}) },
    stock: { ...base.stock, ...(overrides.stock || {}) },
    reservation: { ...base.reservation, ...(overrides.reservation || {}) }
  };
}

test('authorizes only a verified Firebase principal with a matching active grant', () => {
  const result = authorizeReverseOperation(validContext());
  assert.equal(result.authorized, true);
  assert.equal(result.uid, 'firebase-user-1');
  assert.equal(result.operationId, 'RET-OP-00000001');
  assert.equal(Object.isFrozen(result), true);
});
test('fails closed when identity is not verified or project claims mismatch', () => {
  assert.throws(() => authorizeReverseOperation(validContext({ auth: { verified: false } })), /must be verified/);
  assert.throws(() => authorizeReverseOperation(validContext({ auth: { audience: 'other-project' } })), /audience or issuer/);
  assert.throws(() => authorizeReverseOperation(validContext({ auth: { disabled: true } })), /disabled/);
});
test('rejects expired and future Firebase token time claims', () => {
  assert.throws(() => authorizeReverseOperation(validContext({
    auth: { expiresAtSeconds: 1793400199 }
  })), /identity token is expired/);
  assert.throws(() => authorizeReverseOperation(validContext({
    auth: { issuedAtSeconds: 1793400300 }
  })), /time claims are in the future/);
  assert.throws(() => authorizeReverseOperation(validContext({
    auth: { authTimeSeconds: 1793400300 }
  })), /time claims are in the future/);
  assert.throws(() => authorizeReverseOperation(validContext({
    auth: { expiresAtSeconds: 1793400100 }
  })), /time claims are invalid/);
});

test('rejects missing, inactive, mismatched or malformed grants', () => {
  assert.throws(() => authorizeReverseOperation(validContext({ grant: { active: false } })), /grant is missing or mismatched/);
  assert.throws(() => authorizeReverseOperation(validContext({ grant: { uid: 'other-user' } })), /grant is missing or mismatched/);
  assert.throws(() => authorizeReverseOperation(validContext({ grant: { permissions: 'all' } })), /permissions are malformed/);
});
test('enforces operation-specific permission rather than generic user role', () => {
  assert.throws(() => authorizeReverseOperation(validContext({ grant: { permissions: [] } })), /missing required permission: reverse_sale_return/);
  assert.throws(() => authorizeReverseOperation(validContext({ operation: { type: 'UNSUPPORTED' } })), /unsupported reverse operation/);
});
test('requires an open financial period and version-2 reconciled invoice', () => {
  assert.throws(() => authorizeReverseOperation(validContext({ period: { status: 'CLOSED' } })), /period is not OPEN/);
  assert.throws(() => authorizeReverseOperation(validContext({ operation: { invoiceLedgerVersion: 1 } })), /version-2/);
  assert.throws(() => authorizeReverseOperation(validContext({ operation: { allocationsReconciled: false } })), /not reconciled/);
});
test('blocks legacy invoices until explicitly reconciled with a dedicated permission', () => {
  assert.throws(() => authorizeReverseOperation(validContext({ operation: { legacyRecordsPresent: true } })), /missing required permission: reverse_legacy_reconcile/);
  const reconciled = validContext({
    operation: { legacyRecordsPresent: true, legacyReconciled: true, legacyReconciliationId: 'REC-LEGACY-01' },
    grant: { permissions: [...validContext().grant.permissions, PERMISSIONS.LEGACY_RECONCILE] }
  });
  assert.equal(authorizeReverseOperation(reconciled).authorized, true);
});
test('requires explicit cash refund permission and sufficient liquidity', () => {
  assert.throws(() => authorizeReverseOperation(validContext({ grant: { permissions: [PERMISSIONS.SALE_RETURN] } })), /missing required permission: reverse_cash_refund/);
  assert.throws(() => authorizeReverseOperation(validContext({ liquidity: { cashAvailableCentimes: 100 } })), /insufficient liquidity/);
  assert.throws(() => authorizeReverseOperation(validContext({ operation: { settlementMode: 'credit' } })), /explicit cash settlement mode/);
});
test('permits insufficient cash only with separately authorized and operation-bound approval', () => {
  const context = validContext({
    liquidity: { cashAvailableCentimes: 100 },
    grant: { permissions: [...validContext().grant.permissions, PERMISSIONS.LIQUIDITY_OVERRIDE] },
    liquidityOverride: { approved: true, uid: 'firebase-user-1', operationId: 'RET-OP-00000001', amountCentimes: 150, approvalId: 'APPROVAL-01' }
  });
  assert.equal(authorizeReverseOperation(context).authorized, true);
  assert.throws(() => authorizeReverseOperation({ ...context, liquidityOverride: { ...context.liquidityOverride, operationId: 'OTHER-OP-0000001' } }), /explicit authorized liquidity approval/);
});
test('requires explicit credit permission and credit settlement mode', () => {
  assert.throws(() => authorizeReverseOperation(validContext({ operation: { cashRefundCentimes: 0, creditIssueCentimes: 200, settlementMode: 'credit' }, grant: { permissions: [PERMISSIONS.SALE_RETURN] } })), /missing required permission: reverse_credit_issue/);
  assert.throws(() => authorizeReverseOperation(validContext({ operation: { creditIssueCentimes: 200 } })), /explicit credit settlement mode/);
});
test('purchase returns cannot exceed stock in the selected warehouse', () => {
  assert.throws(() => authorizeReverseOperation(validContext({
    operation: { type: 'PURCHASE_RETURN', purchaseReturnQuantityMicroUnits: 1000001 },
    stock: { availableMicroUnits: 1000000 }
  })), /exceeds available stock/);
});
test('requires a durable, operation-bound, unexpired idempotency reservation', () => {
  assert.throws(() => authorizeReverseOperation(validContext({ reservation: { durable: false } })), /durable operation reservation/);
  assert.throws(() => authorizeReverseOperation(validContext({ reservation: { ownerUid: 'other-user' } })), /durable operation reservation/);
  assert.throws(() => authorizeReverseOperation(validContext({ reservation: { expiresAtEpochMs: 1793400199000 } })), /expired or invalid/);
  assert.throws(() => authorizeReverseOperation(validContext({ reservation: { operationId: 'OTHER-OP-0000001' } })), /durable operation reservation/);
});
test('validates identifiers and safe integer boundaries', () => {
  assert.throws(() => authorizeReverseOperation(validContext({ operation: { operationId: 'short' } })), /operationId format/);
  assert.throws(() => authorizeReverseOperation(validContext({ liquidity: { cashAvailableCentimes: -1 } })), /non-negative safe integer/);
});

test('purchase return cash proceeds are inflows and do not require outgoing liquidity', () => {
  const context = validContext({
    operation: { type: 'PURCHASE_RETURN', cashRefundCentimes: 5000, cashDirection: 'inflow' },
    liquidity: { cashAvailableCentimes: 0 }
  });
  assert.equal(authorizeReverseOperation(context).authorized, true);
  assert.throws(() => authorizeReverseOperation(validContext({
    operation: { cashRefundCentimes: 5000, cashDirection: 'outflow' },
    liquidity: { cashAvailableCentimes: 0 }
  })), /insufficient liquidity/);
});
