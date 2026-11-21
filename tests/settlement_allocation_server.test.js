'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAllocationRequest, toCentimes, integerCentimes } = require('../functions/settlement-allocation-service.js');

const base = {
  operationId: 'ALLOC-OP-00000001',
  periodId: 'FY-2026-10',
  partyType: 'customer',
  partyId: 'C-1',
  sourceMovementId: 'CASH-1',
  sourceMovementType: 'customer_debt',
  allocations: [{ invoiceId: 'INV-1', amountCentimes: 12550 }]
};

test('currency amounts and integer centimes use distinct exact scales', () => {
  assert.equal(toCentimes(100), 10000);
  assert.equal(toCentimes('100.50'), 10050);
  assert.equal(integerCentimes('10050', 'amount'), 10050);
  assert.throws(() => toCentimes('100.501', 'amount'), /at most two decimals/);
});

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

test('settlement handler recognizes bank receipt sources separately from cash movements', () => {
  const source = require('fs').readFileSync(require.resolve('../functions/settlement-allocation-service.js'), 'utf8');
  assert.match(source, /const bankRows = request\.sourceMovementType === 'sales_invoice'/);
  assert.match(source, /const rows = \[\.\.\.cashRows, \.\.\.bankRows\]/);
});


class SettlementHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function settlementRef(path) {
  return {
    path,
    id: path.split('/').pop(),
    collection(name) { return { doc: id => settlementRef(path + '/' + name + '/' + id) }; }
  };
}
class SettlementSnapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.exists = value !== undefined;
    this.value = value === undefined ? undefined : structuredClone(value);
  }
  data() { return this.value === undefined ? undefined : structuredClone(this.value); }
  get(key) { return this.value && this.value[key]; }
}
class SettlementMemoryFirestore {
  constructor(seed) { this.records = new Map(Object.entries(seed)); this.commitCount = 0; }
  collection(name) { return { doc: id => settlementRef(name + '/' + id) }; }
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      getAll: async (...refs) => refs.map(ref => new SettlementSnapshot(ref, this.records.get(ref.path))),
      update: (ref, value) => writes.push({ type: 'update', ref, value: structuredClone(value) }),
      create: (ref, value) => writes.push({ type: 'create', ref, value: structuredClone(value) })
    };
    const result = await callback(transaction);
    const next = new Map(this.records);
    for (const write of writes) {
      const exists = next.has(write.ref.path);
      if (write.type === 'create' && exists) throw new Error('ALREADY_EXISTS');
      if (write.type === 'update' && !exists) throw new Error('NOT_FOUND');
      next.set(write.ref.path, write.type === 'create'
        ? write.value : { ...next.get(write.ref.path), ...write.value });
    }
    this.records = next;
    if (writes.length) this.commitCount++;
    return result;
  }
  read(path) { return this.records.get(path); }
}
function settlementFixture({ invoiceCustomerId = 'C-1' } = {}) {
  const uid = 'firebase-user-settlement-1';
  const request = {
    auth: { uid },
    app: { appId: 'staging-app-id' },
    data: {
      operationId: 'ALLOC-OP-00000001',
      periodId: 'FY-2026-10',
      partyType: 'customer',
      partyId: 'C-1',
      sourceMovementId: 'CASH-1',
      sourceMovementType: 'customer_debt',
      allocations: [{ invoiceId: 'INV-1', amountCentimes: 12550 }]
    }
  };
  const state = {
    tenantId: 'TENANT-1',
    storeId: 'STORE-1',
    invoices: [{
      id: 'INV-1', customerId: invoiceCustomerId,
      totalCentimes: 20000, paidCentimes: 0,
      tenantId: 'TENANT-1', storeId: 'STORE-1'
    }],
    purchases: [],
    customers: [{ id: 'C-1', ledgerVersion: 2 }],
    suppliers: [],
    settlementAllocations: [],
    bankMovements: [],
    cashMovements: [{
      id: 'CASH-1', referenceType: 'customer_debt',
      referenceId: 'C-1', amountCentimes: 12550,
      tenantId: 'TENANT-1', storeId: 'STORE-1'
    }],
    clientMovements: []
  };
  const grant = {
    uid, active: true, status: 'ACTIVE', schemaVersion: 1,
    role: 'accountant', tenantId: 'TENANT-1', storeIds: ['STORE-1'],
    permissions: ['settlement_allocation_post']
  };
  const db = new SettlementMemoryFirestore({
    ['users/' + uid + '/snapshots/latest']: { payload: JSON.stringify(state) },
    ['reverseLedgerGrants/' + uid]: grant,
    'financialPeriods/FY-2026-10': { status: 'OPEN' }
  });
  const reverseLedger = {
    validateReverseLedgerParity() { return true; },
    sealSettlementAllocation(_state, input) { return Object.freeze({ ...input }); },
    sealClientMovement(_state, input) { return Object.freeze({ ...input }); }
  };
  const handler = require('../functions/settlement-allocation-service.js')
    .createSettlementAllocationHandler({
      db,
      getUser: async () => ({ disabled: false, displayName: 'Settlement Test' }),
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
      HttpsError: SettlementHttpsError,
      ReverseLedger: reverseLedger,
      now: () => 1793400200000
    });
  return { db, handler, request, uid };
}

test('settlement snapshot and POSTED idempotency record commit atomically, then replay without a second write', async () => {
  const { db, handler, request, uid } = settlementFixture();
  const first = await handler(request);
  assert.equal(first.status, 'POSTED');
  assert.equal(first.allocationCount, 1);
  assert.equal(db.commitCount, 1);
  const snapshot = JSON.parse(db.read('users/' + uid + '/snapshots/latest').payload);
  assert.equal(snapshot.settlementAllocations.length, 1);
  assert.equal(snapshot.settlementAllocations[0].amountCentimes, 12550);
  assert.equal(snapshot.clientMovements.length, 1);
  const operation = db.read('reverseLedgerOperations/ALLOC-OP-00000001');
  assert.equal(operation.status, 'POSTED');
  assert.equal(operation.result.operationId, first.operationId);
  const replay = await handler(request);
  assert.deepEqual(replay, first);
  assert.equal(db.commitCount, 1);
  assert.equal(JSON.parse(db.read('users/' + uid + '/snapshots/latest').payload).settlementAllocations.length, 1);
});

test('settlement rejects an invoice owned by another customer without committing snapshot or operation', async () => {
  const { db, handler, request, uid } = settlementFixture({ invoiceCustomerId: 'C-OTHER' });
  const before = db.read('users/' + uid + '/snapshots/latest').payload;
  await assert.rejects(() => handler(request), error =>
    error.code === 'failed-precondition' && /different customer or supplier/.test(error.message));
  assert.equal(db.read('users/' + uid + '/snapshots/latest').payload, before);
  assert.equal(db.read('reverseLedgerOperations/ALLOC-OP-00000001'), undefined);
  assert.equal(db.commitCount, 0);
});
