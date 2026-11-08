'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ReverseLedger = require('../reverse-ledger/reverse-ledger.js');

test('bank transfer receipt can back a customer sales-invoice settlement allocation without cash ledger entry', () => {
  const state = {
    invoices: [{
      id: 'INV-BANK-1', customerId: 'C-1',
      total: 10, paid: 10, remaining: 0,
      invoiceLedgerVersion: 2,
      items: [{ productId: 'P-1', qty: 1, price: 10 }]
    }],
    purchases: [],
    products: [{ id: 'P-1', stock: 1 }],
    customers: [{ id: 'C-1', debt: 0, ledgerVersion: 2 }],
    suppliers: [],
    returns: [],
    cashMovements: [],
    bankMovements: [{
      id: 'BANK-1', type: 'add', amount: 10,
      paymentChannel: 'transfer', cashImpact: false,
      referenceType: 'sales_invoice', referenceId: 'INV-BANK-1'
    }],
    supplierMovements: [],
    clientMovements: [],
    settlementAllocations: []
  };
  const allocation = ReverseLedger.sealSettlementAllocation(state, {
    allocationId: 'ALLOC-BANK-1',
    partyType: 'customer',
    partyId: 'C-1',
    invoiceType: 'sales_invoice',
    invoiceId: 'INV-BANK-1',
    sourceMovementId: 'BANK-1',
    sourceMovementType: 'sales_invoice',
    amountCentimes: 1000,
    createdAt: '2026-11-08T00:00:00.000Z'
  });
  assert.equal(allocation.sourceMovementId, 'BANK-1');
  assert.equal(state.cashMovements.length, 0, 'non-cash receipt must not be inserted into cash movements');
  assert.equal(state.bankMovements.length, 1);
});

test('isFreeItem sale lines remain financial but are excluded from stock reversal', () => {
  const invoice = {
    items: [
      { productId: 'P-FREE', qty: 2, price: 0, isFreeItem: true },
      { productId: 'P-PAID', qty: 1, price: 10 }
    ]
  };
  assert.deepEqual(ReverseLedger.originalInvoiceItems(invoice, 'sales_invoice'), [
    { productId: 'P-PAID', qty: 1, price: 10 }
  ]);
});
