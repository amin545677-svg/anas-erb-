'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ReverseLedger = require('../functions/lib/reverse-ledger.js');

test('legacy invoice compatibility read preserves historical centimes without synthetic ledger rows', () => {
  const invoice = {
    id: 'LEGACY-SALE-001',
    total: '1250.35',
    paid: '300.10',
    remaining: '950.25',
    items: [{ productId: 'P-1', qty: 5, price: '250.07' }]
  };
  const before = structuredClone(invoice);
  const state = { invoices: [invoice], settlementAllocations: [], returns: [] };

  const read = ReverseLedger.readLegacyInvoiceForLedgerV2(invoice, 'sales_invoice');

  assert.equal(read.totalCentimes, '125035');
  assert.equal(read.paidCentimes, '30010');
  assert.equal(read.remainingCentimes, '95025');
  assert.equal(BigInt(read.totalCentimes) - BigInt(read.paidCentimes) - BigInt(read.remainingCentimes), 0n);
  assert.equal(read.legacy, true);
  assert.equal(read.requiresDocumentedSettlementAllocations, true);
  assert.equal(read.returnPostingAllowed, false);
  assert.deepEqual(invoice, before);
  assert.equal(state.settlementAllocations.length, 0);
  assert.equal(state.returns.length, 0);
  assert.equal(Object.hasOwn(invoice, 'invoiceLedgerVersion'), false);
});

test('legacy invoice compatibility read derives a missing remaining amount exactly in BigInt centimes', () => {
  const read = ReverseLedger.readLegacyInvoiceForLedgerV2({
    id: 'LEGACY-PUR-002', total: '80.05', paid: '0.10'
  }, 'purchase_invoice');

  assert.equal(read.totalCentimes, '8005');
  assert.equal(read.paidCentimes, '10');
  assert.equal(read.remainingCentimes, '7995');
  assert.equal(BigInt(read.totalCentimes) - BigInt(read.paidCentimes) - BigInt(read.remainingCentimes), 0n);
  assert.equal(read.requiresDocumentedSettlementAllocations, true);
  assert.equal(read.returnPostingAllowed, false);
});

test('legacy invoice compatibility read rejects inconsistent historical balances', () => {
  assert.throws(() => ReverseLedger.readLegacyInvoiceForLedgerV2({
    id: 'LEGACY-BAD-003', total: '100.00', paid: '40.00', remaining: '59.99'
  }, 'sales_invoice'), /do not reconcile/);
});

test('legacy invoice compatibility read rejects paid amounts above the invoice total', () => {
  assert.throws(() => ReverseLedger.readLegacyInvoiceForLedgerV2({
    id: 'LEGACY-BAD-004', total: '10.00', paid: '10.01'
  }, 'sales_invoice'), /outside its total/);
});
