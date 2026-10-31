'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeReverseRequest,
  toCentimes,
  toMicroUnits,
  buildAuthorizationOperation,
  authorizePreparedReverseOperation,
  PERMISSIONS
} = require('../functions/reverse-ledger-adapter.js');

const baseRequest = {
  operationId: 'REV-OP-00000001',
  periodId: 'FY-2026-10',
  invoiceId: 'INV-1',
  originalInvoiceType: 'sales_invoice',
  returnType: 'SALE_RETURN',
  items: [{ productId: 'P-1', quantity: '1.25' }],
  settlementMode: 'cash',
  reason: 'damaged goods'
};

test('normalizes a strict sale-return request and preserves exact decimal strings', () => {
  const request = normalizeReverseRequest(baseRequest);
  assert.equal(request.operationId, baseRequest.operationId);
  assert.equal(request.items[0].quantity, '1.25');
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.items), true);
});

test('invoice cancellation defaults to cash and does not accept browser-supplied lines', () => {
  const request = normalizeReverseRequest({
    operationId: 'REV-OP-CANCEL-01',
    periodId: 'FY-2026-10',
    invoiceId: 'INV-2',
    originalInvoiceType: 'sales_invoice',
    returnType: 'INVOICE_CANCEL',
    reason: 'duplicate invoice'
  });
  assert.equal(request.settlementMode, 'cash');
  assert.deepEqual(request.items, []);
});

test('rejects malformed, mismatched, duplicate and over-precision request data', () => {
  assert.throws(() => normalizeReverseRequest({ ...baseRequest, operationId: 'short' }), /operationId format/);
  assert.throws(() => normalizeReverseRequest({ ...baseRequest, returnType: 'PURCHASE_RETURN' }), /does not match/);
  assert.throws(() => normalizeReverseRequest({ ...baseRequest, items: [
    { productId: 'P-1', quantity: '1' }, { productId: 'P-1', quantity: '2' }
  ] }), /duplicate/);
  assert.throws(() => normalizeReverseRequest({ ...baseRequest, items: [{ productId: 'P-1', quantity: '0.0000001' }] }), /precision/);
  assert.throws(() => normalizeReverseRequest({ ...baseRequest, reason: '  ' }), /reason is invalid/);
});

test('decimal conversion is exact and bounded', () => {
  assert.equal(toCentimes('500.50', 'amount'), 50050);
  assert.equal(toMicroUnits('0.000001', 'quantity'), 1);
  assert.throws(() => toCentimes('1.001', 'amount'), /precision/);
  assert.throws(() => toMicroUnits('-1', 'quantity'), /precision/);
});

test('authorization payload classifies purchase cash refunds as inflows', () => {
  const request = normalizeReverseRequest({
    ...baseRequest,
    originalInvoiceType: 'purchase_invoice',
    returnType: 'PURCHASE_RETURN',
    invoiceId: 'PUR-1',
    items: [{ productId: 'P-1', quantity: '1' }]
  });
  const invoice = { id: 'PUR-1', ledgerVersion: 2 };
  const document = {
    cashRefundCentimes: 900,
    customerCreditCentimes: 0,
    supplierCreditCentimes: 0,
    items: [{ productId: 'P-1', quantityMicroUnits: 1000000 }]
  };
  const operation = buildAuthorizationOperation(request, invoice, document, { caisseBalance: 0 });
  assert.equal(operation.cashRefundCentimes, 900);
  assert.equal(operation.cashDirection, 'inflow');
  assert.equal(operation.invoiceLedgerVersion, 2);
});

test('server authorization rejects legacy invoices before a reverse operation can post', () => {
  const request = normalizeReverseRequest(baseRequest);
  assert.throws(() => buildAuthorizationOperation(request, { id: 'INV-1' }, {
    cashRefundCentimes: 0, customerCreditCentimes: 0, supplierCreditCentimes: 0, items: []
  }, { caisseBalance: 100 }), /version-2 ledger/);
});

test('prepared operation binds trusted Firebase claims, grant, open period and reservation', () => {
  const request = normalizeReverseRequest(baseRequest);
  const state = {
    caisseBalance: 100,
    invoices: [{ id: 'INV-1', ledgerVersion: 2 }],
    purchases: [],
    products: [{ id: 'P-1', stock: 5, buyPrice: 2 }],
    customers: [],
    suppliers: []
  };
  const result = authorizePreparedReverseOperation({
    projectId: 'anas-erp-staging-a25e1',
    uid: 'uid-1',
    token: {
      aud: 'anas-erp-staging-a25e1',
      iss: 'https://securetoken.google.com/anas-erp-staging-a25e1',
      auth_time: 1793400000,
      iat: 1793400100,
      exp: 1793403700
    },
    grant: {
      uid: 'uid-1', active: true, schemaVersion: 1,
      permissions: [PERMISSIONS.SALE_RETURN, PERMISSIONS.CASH_REFUND]
    },
    period: { periodId: 'FY-2026-10', status: 'OPEN' },
    request,
    postedDocument: {
      cashRefundCentimes: 0, customerCreditCentimes: 0, supplierCreditCentimes: 0,
      items: [{ productId: 'P-1', quantityMicroUnits: 1000000 }]
    },
    state,
    reservation: {
      acquired: true, durable: true, operationId: request.operationId,
      ownerUid: 'uid-1', leaseId: 'LEASE-1', expiresAtEpochMs: 2000000000000
    },
    nowEpochMs: 1793400200000
  });
  assert.equal(result.authorized, true);
  assert.equal(result.uid, 'uid-1');
  assert.equal(result.operationType, 'SALE_RETURN');
});
