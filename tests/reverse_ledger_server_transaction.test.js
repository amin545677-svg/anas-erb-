'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReverseLedgerHandler } = require('../functions/reverse-ledger-service.js');

class FakeHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function makeRef(path) {
  const ref = {
    path,
    id: path.split('/').pop(),
    collection(name) { return { doc: id => makeRef(path + '/' + name + '/' + id) }; }
  };
  return ref;
}

class FakeSnapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.exists = value !== undefined;
    this.value = value === undefined ? undefined : structuredClone(value);
  }
  data() { return this.value === undefined ? undefined : structuredClone(this.value); }
  get(key) { return this.value && this.value[key]; }
}

class MemoryFirestore {
  constructor(seed = {}) {
    this.records = new Map(Object.entries(seed));
    this.commitCount = 0;
    this.failCommit = false;
  }
  collection(name) { return { doc: id => makeRef(name + '/' + id) }; }
  async runTransaction(callback) {
    const writes = [];
    const tx = {
      get: async ref => new FakeSnapshot(ref, this.records.get(ref.path)),
      update: (ref, value) => writes.push({ type: 'update', ref, value: structuredClone(value) }),
      create: (ref, value) => writes.push({ type: 'create', ref, value: structuredClone(value) })
    };
    const result = await callback(tx);
    if (this.failCommit) throw new Error('simulated atomic commit failure');
    const next = new Map(this.records);
    for (const write of writes) {
      const exists = next.has(write.ref.path);
      if (write.type === 'create' && exists) throw new Error('ALREADY_EXISTS');
      if (write.type === 'update' && !exists) throw new Error('NOT_FOUND');
      if (write.type === 'create') next.set(write.ref.path, write.value);
      else next.set(write.ref.path, { ...next.get(write.ref.path), ...write.value });
    }
    this.records = next;
    if (writes.length) this.commitCount++;
    return result;
  }
  read(path) { return this.records.get(path); }
}

function fixture(options = {}) {
  const uid = 'firebase-user-1';
  const request = {
    auth: {
      uid,
      token: {
        aud: 'anas-erp-staging-a25e1',
        iss: 'https://securetoken.google.com/anas-erp-staging-a25e1',
        auth_time: 1793400000,
        iat: 1793400100,
        exp: 1793403700
      }
    },
    app: { appId: 'staging-app-id' },
    data: {
      operationId: 'REV-OP-00000001',
      periodId: 'FY-2026-10',
      invoiceId: 'INV-1',
      originalInvoiceType: 'sales_invoice',
      returnType: 'SALE_RETURN',
      items: [{ productId: 'P-1', quantity: '1' }],
      settlementMode: 'cash',
      reason: 'damaged goods'
    }
  };
  const state = {
    invoices: [{ id: 'INV-1', invoiceLedgerVersion: 2 }],
    purchases: [],
    products: [{ id: 'P-1', stock: 10 }],
    customers: [],
    suppliers: [],
    returns: [],
    caisseBalance: 100
  };
  const grant = {
    uid, active: true, schemaVersion: 1,
    permissions: ['reverse_sale_return']
  };
  const period = { periodId: 'FY-2026-10', status: 'OPEN' };
  const operation = options.operation === false ? undefined : {
    operationId: request.data.operationId,
    ownerUid: uid,
    operationType: 'SALE_RETURN',
    invoiceId: 'INV-1',
    periodId: 'FY-2026-10',
    status: 'RESERVED',
    schemaVersion: 1,
    createdAt: '2026-10-31T00:00:00.000Z'
  };
  const seed = {
    'users/firebase-user-1/snapshots/latest': { payload: JSON.stringify(state) },
    'reverseLedgerGrants/firebase-user-1': grant,
    'financialPeriods/FY-2026-10': period
  };
  if (operation) seed['reverseLedgerOperations/REV-OP-00000001'] = operation;
  const db = new MemoryFirestore(seed);
  const fakeEngine = {
    validateReverseLedgerParity(value) {
      if (!Array.isArray(value.invoices) || !Array.isArray(value.returns)) throw new Error('invalid state fixture');
      return true;
    },
    executeReturnTransaction(nextState, input, engineOptions) {
      assert.equal(engineOptions.persist(), true);
      const document = {
        returnId: engineOptions.createId(),
        originalInvoiceId: input.invoiceId,
        returnType: input.returnType,
        status: 'POSTED',
        cashRefundCentimes: 0,
        customerCreditCentimes: 0,
        supplierCreditCentimes: 0,
        items: [{ productId: 'P-1', quantityMicroUnits: 1000000 }]
      };
      nextState.returns.push(document);
      return document;
    }
  };
  const authorize = context => {
    assert.equal(context.projectId, 'anas-erp-staging-a25e1');
    assert.equal(context.uid, uid);
    assert.equal(context.reservation.acquired, true);
    assert.equal(context.reservation.durable, true);
    assert.equal(context.period.status, 'OPEN');
    if (options.denyAuthorization) throw new FakeHttpsError('permission-denied', 'test grant denied');
    return { authorized: true };
  };
  const handler = createReverseLedgerHandler({
    db,
    getUser: async () => ({ disabled: false, displayName: 'Test Operator' }),
    FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
    HttpsError: FakeHttpsError,
    ReverseLedger: fakeEngine,
    authorizePreparedReverseOperation: authorize,
    projectId: 'anas-erp-staging-a25e1',
    now: () => 1793400200000
  });
  return { db, handler, request };
}

test('commits the financial snapshot and Worker reservation finalization atomically', async () => {
  const { db, handler, request } = fixture();
  const response = await handler(request);
  assert.equal(response.ok, true);
  assert.equal(response.document.status, 'POSTED');
  assert.equal(db.commitCount, 1);
  const snapshot = JSON.parse(db.read('users/firebase-user-1/snapshots/latest').payload);
  assert.equal(snapshot.returns.length, 1);
  const operation = db.read('reverseLedgerOperations/REV-OP-00000001');
  assert.equal(operation.status, 'POSTED');
  assert.equal(operation.requestHash.length, 64);
  assert.equal(operation.result.document.returnId, response.document.returnId);
  assert.equal(operation.leaseId.length > 0, true);
  assert.equal(operation.expiresAtEpochMs, 1793400260000);
});

test('same operation ID and same request replay the stored result without a second commit', async () => {
  const { db, handler, request } = fixture();
  const first = await handler(request);
  const second = await handler(request);
  assert.deepEqual(second, first);
  assert.equal(db.commitCount, 1);
  assert.equal(JSON.parse(db.read('users/firebase-user-1/snapshots/latest').payload).returns.length, 1);
});

test('same operation ID with a different request is rejected without changing state', async () => {
  const { db, handler, request } = fixture();
  await handler(request);
  const before = db.read('users/firebase-user-1/snapshots/latest').payload;
  await assert.rejects(() => handler({
    ...request,
    data: { ...request.data, reason: 'different reason' }
  }), error => error.code === 'already-exists');
  assert.equal(db.read('users/firebase-user-1/snapshots/latest').payload, before);
  assert.equal(db.commitCount, 1);
});

test('authorization failure leaves both snapshot and RESERVED operation untouched', async () => {
  const { db, handler, request } = fixture({ denyAuthorization: true });
  const before = db.read('users/firebase-user-1/snapshots/latest').payload;
  await assert.rejects(() => handler(request), error => error.code === 'permission-denied');
  assert.equal(db.read('users/firebase-user-1/snapshots/latest').payload, before);
  assert.equal(db.read('reverseLedgerOperations/REV-OP-00000001').status, 'RESERVED');
  assert.equal(db.commitCount, 0);
});

test('a missing reservation is created in the same commit as the posted snapshot', async () => {
  const { db, handler, request } = fixture({ operation: false });
  const response = await handler(request);
  assert.equal(response.ok, true);
  assert.equal(db.commitCount, 1);
  assert.equal(db.read('reverseLedgerOperations/REV-OP-00000001').status, 'POSTED');
});

test('a failed Firestore commit cannot partially persist the snapshot or operation result', async () => {
  const { db, handler, request } = fixture();
  const before = db.read('users/firebase-user-1/snapshots/latest').payload;
  db.failCommit = true;
  await assert.rejects(() => handler(request), error => error.code === 'internal');
  assert.equal(db.read('users/firebase-user-1/snapshots/latest').payload, before);
  assert.equal(db.read('reverseLedgerOperations/REV-OP-00000001').status, 'RESERVED');
  assert.equal(db.commitCount, 0);
});
