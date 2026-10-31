'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAllocationRequest } = require('../functions/settlement-allocation-service.js');

const base = {
  operationId: 'ALLOC-OP-00000001',
  periodId: 'FY-2026-10',
  partyType: 'customer',
  partyId: 'C-1',
  sourceMovementId: 'CASH-1',
  sourceMovementType: 'customer_debt',
  allocations: [{ invoiceId: 'INV-1', amountCentimes: 12550 }]
};

test('normalizes a multi-invoice allocation request with exact integer centimes', () => {
  const result = normalizeAllocationRequest({
    ...base,
    allocations: [
      { invoiceId: 'INV-1', amountCentimes: 10000 },
      { invoiceId: 'INV-2', amountCentimes: 2550 }
    ]
  });
  assert.equal(result.partyType, 'customer');
  assert.equal(result.allocations.length, 2);
  assert.equal(result.allocations[0].invoiceType, 'sales_invoice');
  assert.equal(result.allocations[1].amountCentimes, 2550);
  assert.equal(normalizeAllocationRequest({ ...base, allocations: [{ invoiceId: 'INV-1', amountCentimes: '12550' }] }).allocations[0].amountCentimes, 12550);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.allocations), true);
});

test('normalizes supplier payment allocation to purchase invoices', () => {
  const result = normalizeAllocationRequest({
    ...base,
    partyType: 'supplier',
    partyId: 'S-1',
    sourceMovementId: 'SUP-PAY-1',
    sourceMovementType: 'supplier_payment'
  });
  assert.equal(result.allocations[0].invoiceType, 'purchase_invoice');
});

test('rejects malformed IDs, party/source mismatch, duplicate invoices and fractional centimes', () => {
  assert.throws(() => normalizeAllocationRequest({ ...base, operationId: 'short' }), /operationId format/);
  assert.throws(() => normalizeAllocationRequest({ ...base, partyType: 'supplier' }), /source movement type/);
  assert.throws(() => normalizeAllocationRequest({ ...base, allocations: [
    { invoiceId: 'INV-1', amountCentimes: 10 }, { invoiceId: 'INV-1', amountCentimes: 20 }
  ] }), /duplicate invoice/);
  assert.throws(() => normalizeAllocationRequest({ ...base, allocations: [
    { invoiceId: 'INV-1', amountCentimes: '1.001' }
  ] }), /safe integer number of centimes/);
  assert.throws(() => normalizeAllocationRequest({ ...base, extra: true }), /unsupported allocation request fields/);
});

test('rejects empty, oversized and non-positive allocations', () => {
  assert.throws(() => normalizeAllocationRequest({ ...base, allocations: [] }), /between 1 and/);
  assert.throws(() => normalizeAllocationRequest({ ...base, allocations: [
    { invoiceId: 'INV-1', amountCentimes: 0 }
  ] }), /must be positive/);
});
