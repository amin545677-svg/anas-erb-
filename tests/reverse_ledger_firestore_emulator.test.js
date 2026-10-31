'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const functionsRequire = createRequire(require.resolve('../functions/package.json'));
const { initializeApp, deleteApp } = functionsRequire('firebase-admin/app');
const { getFirestore, FieldValue } = functionsRequire('firebase-admin/firestore');
const { createReverseLedgerHandler } = require('../functions/reverse-ledger-service.js');
const ReverseLedger = require('../functions/lib/reverse-ledger.js');
const { authorizePreparedReverseOperation, PERMISSIONS } = require('../functions/reverse-ledger-adapter.js');

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-anas-erp';
const app = initializeApp({ projectId: PROJECT_ID }, 'reverse-ledger-firestore-emulator');
const db = getFirestore(app);
after(async () => deleteApp(app));

class TestHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function makeRequest(uid, operationId, overrides = {}) {
  const data = {
    operationId,
    periodId: 'FY-2026-10',
    invoiceId: 'INV-EMULATOR-1',
    originalInvoiceType: 'sales_invoice',
    returnType: 'SALE_RETURN',
    items: [{ productId: 'P-1', quantity: '1' }],
    settlementMode: 'cash',
    reason: 'emulator transaction test',
    ...overrides
  };
  return {
    auth: {
      uid,
      token: {
        aud: PROJECT_ID,
        iss: 'https://securetoken.google.com/' + PROJECT_ID,
        auth_time: 1793400000,
        iat: 1793400100,
        exp: 1793403700
      }
    },
    app: { appId: 'emulator-test-app' },
    data
  };
}

function createHandler(options = {}) {
  const fakeEngine = {
    validateReverseLedgerParity(state) {
      if (!Array.isArray(state.invoices) || !Array.isArray(state.returns)) {
        throw new Error('emulator fixture collections are invalid');
      }
      return true;
    },
    executeReturnTransaction(nextState, input, engineOptions) {
      if (nextState.returns.some(row => row.originalInvoiceId === input.invoiceId)) {
        throw new Error('duplicate return blocked by snapshot transaction retry');
      }
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
      if (engineOptions.persist() !== true) throw new Error('engine persistence callback rejected');
      return document;
    }
  };
  return createReverseLedgerHandler({
    db,
    getUser: async () => ({ disabled: false, displayName: 'Firestore Emulator Operator' }),
    FieldValue,
    HttpsError: TestHttpsError,
    ReverseLedger: fakeEngine,
    authorizePreparedReverseOperation: context => {
      assert.equal(context.projectId, PROJECT_ID);
      assert.equal(context.reservation.acquired, true);
      assert.equal(context.reservation.durable, true);
      if (options.denyAuthorization) throw new TestHttpsError('permission-denied', 'emulator grant denied');
      return { authorized: true };
    },
    projectId: PROJECT_ID,
    now: () => 1793400200000
  });
}

async function seed(uid, operationIds = [], options = {}) {
  const user = db.collection('users').doc(uid);
  const state = options.state || {
    invoices: [{ id: 'INV-EMULATOR-1', invoiceLedgerVersion: 2 }],
    purchases: [],
    products: [{ id: 'P-1', stock: 10 }],
    customers: [],
    suppliers: [],
    returns: [],
    caisseBalance: 100
  };
  await user.collection('snapshots').doc('latest').set({ payload: JSON.stringify(state) });
  await db.collection('reverseLedgerGrants').doc(uid).set({
    uid, active: true, schemaVersion: 1, permissions: options.permissions || ['reverse_sale_return']
  });
  await db.collection('financialPeriods').doc('FY-2026-10').set({
    periodId: 'FY-2026-10', status: 'OPEN'
  });
  for (const operationId of operationIds) {
    await db.collection('reverseLedgerOperations').doc(operationId).set({
      operationId,
      ownerUid: uid,
      operationType: options.operationType || 'SALE_RETURN',
      invoiceId: options.invoiceId || 'INV-EMULATOR-1',
      periodId: 'FY-2026-10',
      status: 'RESERVED',
      schemaVersion: 1,
      createdAt: new Date().toISOString()
    });
  }
  return { user, initialPayload: JSON.stringify(state) };
}

async function cleanup(uid, operationIds) {
  await db.recursiveDelete(db.collection('users').doc(uid));
  await db.collection('reverseLedgerGrants').doc(uid).delete().catch(() => {});
  await db.collection('financialPeriods').doc('FY-2026-10').delete().catch(() => {});
  for (const id of operationIds) {
    await db.collection('reverseLedgerOperations').doc(id).delete().catch(() => {});
  }
}

test('Firestore transaction commits snapshot and reservation finalization together, then replays idempotently', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const { user, initialPayload } = await seed(uid, [operationId]);
  t.after(() => cleanup(uid, [operationId]));
  const handler = createHandler();
  const request = makeRequest(uid, operationId);

  const first = await handler(request);
  assert.equal(first.ok, true);
  assert.equal(first.document.status, 'POSTED');
  const snapshotAfterPost = await user.collection('snapshots').doc('latest').get();
  const postedState = JSON.parse(snapshotAfterPost.get('payload'));
  assert.equal(postedState.returns.length, 1);
  assert.notEqual(snapshotAfterPost.get('payload'), initialPayload);

  const operationAfterPost = await db.collection('reverseLedgerOperations').doc(operationId).get();
  assert.equal(operationAfterPost.get('status'), 'POSTED');
  assert.equal(operationAfterPost.get('requestHash').length, 64);
  assert.equal(operationAfterPost.get('result').document.returnId, first.document.returnId);

  const second = await handler(request);
  assert.deepEqual(second, first);
  const replayedSnapshot = await user.collection('snapshots').doc('latest').get();
  assert.equal(JSON.parse(replayedSnapshot.get('payload')).returns.length, 1);
});

test('concurrent same-operation requests converge to one posted result', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  await seed(uid, [operationId]);
  t.after(() => cleanup(uid, [operationId]));
  const handler = createHandler();
  const request = makeRequest(uid, operationId);

  const [left, right] = await Promise.all([handler(request), handler(request)]);
  assert.deepEqual(left, right);
  const operation = await db.collection('reverseLedgerOperations').doc(operationId).get();
  assert.equal(operation.get('status'), 'POSTED');
  const snapshot = await db.collection('users').doc(uid).collection('snapshots').doc('latest').get();
  assert.equal(JSON.parse(snapshot.get('payload')).returns.length, 1);
});

test('concurrent different operations against one invoice cannot both reverse the same snapshot', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const firstId = 'REV-' + crypto.randomUUID();
  const secondId = 'REV-' + crypto.randomUUID();
  await seed(uid, [firstId, secondId]);
  t.after(() => cleanup(uid, [firstId, secondId]));
  const handler = createHandler();

  const outcomes = await Promise.allSettled([
    handler(makeRequest(uid, firstId)),
    handler(makeRequest(uid, secondId))
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
  const snapshot = await db.collection('users').doc(uid).collection('snapshots').doc('latest').get();
  assert.equal(JSON.parse(snapshot.get('payload')).returns.length, 1);
  const records = await Promise.all([
    db.collection('reverseLedgerOperations').doc(firstId).get(),
    db.collection('reverseLedgerOperations').doc(secondId).get()
  ]);
  assert.equal(records.filter(x => x.get('status') === 'POSTED').length, 1);
  assert.equal(records.filter(x => x.get('status') === 'RESERVED').length, 1);
});

test('authorization rejection leaves the real Firestore snapshot and reservation unchanged', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const { user, initialPayload } = await seed(uid, [operationId]);
  t.after(() => cleanup(uid, [operationId]));
  const handler = createHandler({ denyAuthorization: true });

  await assert.rejects(
    () => handler(makeRequest(uid, operationId)),
    error => error.code === 'permission-denied'
  );
  const snapshot = await user.collection('snapshots').doc('latest').get();
  const operation = await db.collection('reverseLedgerOperations').doc(operationId).get();
  assert.equal(snapshot.get('payload'), initialPayload);
  assert.equal(operation.get('status'), 'RESERVED');
});

test('posted operation ID cannot be replayed with altered financial intent', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const { user } = await seed(uid, [operationId]);
  t.after(() => cleanup(uid, [operationId]));
  const handler = createHandler();
  await handler(makeRequest(uid, operationId));
  const before = (await user.collection('snapshots').doc('latest').get()).get('payload');

  await assert.rejects(
    () => handler(makeRequest(uid, operationId, { reason: 'changed reason' })),
    error => error.code === 'already-exists'
  );
  const after = (await user.collection('snapshots').doc('latest').get()).get('payload');
  assert.equal(after, before);
  assert.equal(JSON.parse(after).returns.length, 1);
});

test('Firestore transaction can create an operation record when no Worker reservation exists', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const { user } = await seed(uid, []);
  t.after(() => cleanup(uid, [operationId]));
  const response = await createHandler()(makeRequest(uid, operationId));
  assert.equal(response.ok, true);
  const operation = await db.collection('reverseLedgerOperations').doc(operationId).get();
  assert.equal(operation.exists, true);
  assert.equal(operation.get('status'), 'POSTED');
  const snapshot = await user.collection('snapshots').doc('latest').get();
  assert.equal(JSON.parse(snapshot.get('payload')).returns.length, 1);
});

function createRealEngineHandler() {
  return createReverseLedgerHandler({
    db,
    getUser: async () => ({ disabled: false, displayName: 'Real Engine Emulator Operator' }),
    FieldValue,
    HttpsError: TestHttpsError,
    ReverseLedger,
    authorizePreparedReverseOperation,
    projectId: PROJECT_ID,
    now: () => 1793400200000
  });
}

test('real BigInt ledger engine posts a partial sale return inside the Firestore transaction', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const customer = { id: 'C-RET', name: 'Customer', debt: 0.20 };
  const state = {
    customers: [customer],
    suppliers: [],
    invoices: [{
      id: 'INV-EMULATOR-1',
      customerId: 'C-RET',
      customerObj: customer,
      total: 0.30,
      paid: 0.10,
      remaining: 0.20,
      invoiceLedgerVersion: 2,
      items: [{ id: 'P-1', qty: 3, price: 0.10 }],
      warehouse: 'المخزن الرئيسي'
    }],
    purchases: [],
    products: [{ id: 'P-1', name: 'Tea', stock: 0, buyPrice: 0.05 }],
    cashMovements: [{
      id: 'SALE-CASH-EMULATOR', type: 'add', amount: 0.10,
      referenceType: 'sales_invoice', referenceId: 'INV-EMULATOR-1'
    }],
    stockMovements: [{
      id: 'SALE-STOCK-EMULATOR', productId: 'P-1', qty: -3, type: 'SALE_OUT',
      referenceType: 'sales_invoice', referenceId: 'INV-EMULATOR-1',
      originalSaleQuantityMicroUnits: 3000000, originalSaleCostCentimes: 15
    }],
    clientMovements: [],
    supplierMovements: [],
    settlementAllocations: [],
    returns: [],
    customerCreditMovements: [],
    caisseBalance: 1,
    currentUser: { id: 'U-RET' }
  };
  const { user } = await seed(uid, [operationId], {
    state,
    permissions: [PERMISSIONS.SALE_RETURN]
  });
  t.after(() => cleanup(uid, [operationId]));

  const response = await createRealEngineHandler()(makeRequest(uid, operationId));
  assert.equal(response.ok, true);
  assert.equal(response.document.totalCentimes, 10);
  assert.equal(response.document.debtReductionCentimes, 10);
  assert.equal(response.document.cashRefundCentimes, 0);

  const snapshot = await user.collection('snapshots').doc('latest').get();
  const postedState = JSON.parse(snapshot.get('payload'));
  assert.equal(postedState.customers[0].debt, 0.10);
  assert.equal(postedState.products[0].stock, 1);
  assert.equal(postedState.products[0].buyPrice, 0.05);
  const returnMovement = postedState.stockMovements.find(row => row.type === 'RETURN_IN');
  assert.ok(returnMovement);
  assert.equal(returnMovement.qty, 1);
  assert.equal(returnMovement.restoredInventoryCostCentimes, 5);
  assert.equal(postedState.returns[0].ledgerVersion, 2);
  assert.equal((await db.collection('reverseLedgerOperations').doc(operationId).get()).get('status'), 'POSTED');
});


function makeRealEngineState() {
  const customer = { id: 'C-RET', name: 'Customer', debt: 0.20 };
  return {
    customers: [customer],
    suppliers: [],
    invoices: [{
      id: 'INV-EMULATOR-1',
      customerId: 'C-RET',
      customerObj: customer,
      total: 0.30,
      paid: 0.10,
      remaining: 0.20,
      invoiceLedgerVersion: 2,
      items: [{ id: 'P-1', qty: 3, price: 0.10 }],
      warehouse: 'المخزن الرئيسي'
    }],
    purchases: [],
    products: [{ id: 'P-1', name: 'Tea', stock: 0, buyPrice: 0.05 }],
    cashMovements: [{
      id: 'SALE-CASH-EMULATOR', type: 'add', amount: 0.10,
      referenceType: 'sales_invoice', referenceId: 'INV-EMULATOR-1'
    }],
    stockMovements: [{
      id: 'SALE-STOCK-EMULATOR', productId: 'P-1', qty: -3, type: 'SALE_OUT',
      referenceType: 'sales_invoice', referenceId: 'INV-EMULATOR-1',
      originalSaleQuantityMicroUnits: 3000000, originalSaleCostCentimes: 15
    }],
    clientMovements: [],
    supplierMovements: [],
    settlementAllocations: [],
    returns: [],
    customerCreditMovements: [],
    caisseBalance: 1,
    currentUser: { id: 'U-RET' }
  };
}

test('real BigInt engine: concurrent identical operation IDs post exactly once in Firestore', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const { user } = await seed(uid, [operationId], {
    state: makeRealEngineState(),
    permissions: [PERMISSIONS.SALE_RETURN]
  });
  t.after(() => cleanup(uid, [operationId]));
  const handler = createRealEngineHandler();
  const request = makeRequest(uid, operationId);

  const [first, second] = await Promise.all([handler(request), handler(request)]);
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  const snapshot = await user.collection('snapshots').doc('latest').get();
  const state = JSON.parse(snapshot.get('payload'));
  assert.equal(state.returns.length, 1);
  assert.equal(state.customers[0].debt, 0.10);
  assert.equal(state.products[0].stock, 1);
  const operation = await db.collection('reverseLedgerOperations').doc(operationId).get();
  assert.equal(operation.get('status'), 'POSTED');
  assert.equal(operation.get('result').document.returnId, first.document.returnId);
});

test('real BigInt engine: concurrent same-ID requests with different payloads reject the loser without mutation', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const { user } = await seed(uid, [operationId], {
    state: makeRealEngineState(),
    permissions: [PERMISSIONS.SALE_RETURN]
  });
  t.after(() => cleanup(uid, [operationId]));
  const handler = createRealEngineHandler();
  const left = makeRequest(uid, operationId, { reason: 'first authorized reason' });
  const right = makeRequest(uid, operationId, { reason: 'different concurrent reason' });

  const outcomes = await Promise.allSettled([handler(left), handler(right)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
  const rejected = outcomes.find(x => x.status === 'rejected');
  assert.equal(rejected.reason.code, 'already-exists');

  const snapshot = await user.collection('snapshots').doc('latest').get();
  const state = JSON.parse(snapshot.get('payload'));
  assert.equal(state.returns.length, 1);
  assert.equal(state.customers[0].debt, 0.10);
  assert.equal(state.products[0].stock, 1);
  const operation = await db.collection('reverseLedgerOperations').doc(operationId).get();
  assert.equal(operation.get('status'), 'POSTED');
  assert.equal(operation.get('requestHash').length, 64);
});

test('callable handler rejects missing Auth and missing App Check before any Firestore mutation', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const { user, initialPayload } = await seed(uid, [operationId], {
    state: makeRealEngineState(),
    permissions: [PERMISSIONS.SALE_RETURN]
  });
  t.after(() => cleanup(uid, [operationId]));
  const handler = createRealEngineHandler();
  const valid = makeRequest(uid, operationId);

  await assert.rejects(
    () => handler({ ...valid, auth: null }),
    error => error.code === 'unauthenticated'
  );
  await assert.rejects(
    () => handler({ ...valid, app: null }),
    error => error.code === 'failed-precondition'
  );

  const snapshot = await user.collection('snapshots').doc('latest').get();
  const operation = await db.collection('reverseLedgerOperations').doc(operationId).get();
  assert.equal(snapshot.get('payload'), initialPayload);
  assert.equal(operation.get('status'), 'RESERVED');
});

test('real BigInt engine posts a purchase return with supplier debt and WAC parity', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const supplier = { id: 'SUP-RET', name: 'Supplier', balance: 0.20 };
  const state = {
    customers: [],
    suppliers: [supplier],
    invoices: [],
    purchases: [{
      id: 'PUR-EMULATOR-1',
      supplierId: 'SUP-RET',
      total: 0.30,
      paid: 0.10,
      remaining: 0.20,
      invoiceLedgerVersion: 2,
      productId: 'P-1',
      qty: 3,
      cost: 0.10,
      warehouse: 'المخزن الرئيسي'
    }],
    products: [{ id: 'P-1', name: 'Tea', stock: 3, buyPrice: 0.10 }],
    cashMovements: [{
      id: 'PUR-CASH-EMULATOR', type: 'subtract', amount: 0.10,
      referenceType: 'purchase_invoice', referenceId: 'PUR-EMULATOR-1'
    }],
    stockMovements: [{
      id: 'PUR-STOCK-EMULATOR', productId: 'P-1', qty: 3,
      type: 'PURCHASE_IN', referenceType: 'purchase_invoice',
      referenceId: 'PUR-EMULATOR-1'
    }],
    clientMovements: [],
    supplierMovements: [{
      id: 'SUP-PUR-EMULATOR', supplierId: 'SUP-RET', type: 'purchase',
      amount: 0.30, referenceType: 'purchase_invoice', referenceId: 'PUR-EMULATOR-1'
    }],
    settlementAllocations: [],
    returns: [],
    customerCreditMovements: [],
    caisseBalance: 1,
    currentUser: { id: 'U-RET' }
  };
  const { user } = await seed(uid, [operationId], {
    state,
    permissions: [PERMISSIONS.PURCHASE_RETURN],
    operationType: 'PURCHASE_RETURN',
    invoiceId: 'PUR-EMULATOR-1'
  });
  t.after(() => cleanup(uid, [operationId]));

  const response = await createRealEngineHandler()(makeRequest(uid, operationId, {
    invoiceId: 'PUR-EMULATOR-1',
    originalInvoiceType: 'purchase_invoice',
    returnType: 'PURCHASE_RETURN',
    items: [{ productId: 'P-1', quantity: '1' }]
  }));
  assert.equal(response.ok, true);
  assert.equal(response.document.totalCentimes, 10);
  assert.equal(response.document.debtReductionCentimes, 10);
  assert.equal(response.document.cashRefundCentimes, 0);

  const snapshot = await user.collection('snapshots').doc('latest').get();
  const postedState = JSON.parse(snapshot.get('payload'));
  assert.equal(postedState.suppliers[0].balance, 0.10);
  assert.equal(postedState.products[0].stock, 2);
  assert.equal(postedState.products[0].buyPrice, 0.10);
  const returnMovement = postedState.stockMovements.find(row => row.type === 'RETURN_OUT');
  assert.ok(returnMovement);
  assert.equal(returnMovement.qty, -1);
  assert.equal(returnMovement.inventoryBookValueCentimes, 10);
  assert.equal(returnMovement.valuationVarianceCentimes, 0);
  assert.equal(postedState.returns[0].ledgerVersion, 2);
});

test('real BigInt engine cancels a full sales invoice with debt, cash and stock parity', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const customer = { id: 'C-CANCEL', name: 'Cancellation Customer', debt: 0.20 };
  const state = {
    customers: [customer],
    suppliers: [],
    invoices: [{
      id: 'INV-EMULATOR-1',
      customerId: 'C-CANCEL',
      customerObj: customer,
      total: 0.30,
      paid: 0.10,
      remaining: 0.20,
      invoiceLedgerVersion: 2,
      items: [{ id: 'P-1', qty: 3, price: 0.10 }],
      warehouse: 'المخزن الرئيسي'
    }],
    purchases: [],
    products: [{ id: 'P-1', name: 'Tea', stock: 0, buyPrice: 0.05 }],
    cashMovements: [{
      id: 'SALE-CASH-CANCEL', type: 'add', amount: 0.10,
      referenceType: 'sales_invoice', referenceId: 'INV-EMULATOR-1'
    }],
    stockMovements: [{
      id: 'SALE-STOCK-CANCEL', productId: 'P-1', qty: -3, type: 'SALE_OUT',
      referenceType: 'sales_invoice', referenceId: 'INV-EMULATOR-1',
      originalSaleQuantityMicroUnits: 3000000, originalSaleCostCentimes: 15
    }],
    clientMovements: [],
    supplierMovements: [],
    settlementAllocations: [],
    returns: [],
    customerCreditMovements: [],
    caisseBalance: 1,
    currentUser: { id: 'U-CANCEL' }
  };
  const { user } = await seed(uid, [operationId], {
    state,
    permissions: [PERMISSIONS.INVOICE_CANCEL, PERMISSIONS.CASH_REFUND],
    operationType: 'INVOICE_CANCEL',
    invoiceId: 'INV-EMULATOR-1'
  });
  t.after(() => cleanup(uid, [operationId]));

  const request = makeRequest(uid, operationId, {
    returnType: 'INVOICE_CANCEL',
    reason: 'duplicate invoice'
  });
  delete request.data.items;
  const response = await createRealEngineHandler()(request);
  assert.equal(response.ok, true);
  assert.equal(response.document.returnType, 'INVOICE_CANCEL');
  assert.equal(response.document.totalCentimes, 30);
  assert.equal(response.document.debtReductionCentimes, 20);
  assert.equal(response.document.cashRefundCentimes, 10);

  const snapshot = await user.collection('snapshots').doc('latest').get();
  const postedState = JSON.parse(snapshot.get('payload'));
  assert.equal(postedState.customers[0].debt, 0);
  assert.equal(postedState.products[0].stock, 3);
  assert.equal(postedState.caisseBalance, 0.90);
  assert.equal(postedState.invoices[0].status, 'CANCELLED');
  const refund = postedState.cashMovements.find(row => row.referenceType === 'invoice_cancel');
  assert.ok(refund);
  assert.equal(refund.type, 'subtract');
  assert.equal(refund.amount, 0.10);
  const restored = postedState.stockMovements.find(row => row.type === 'RETURN_IN');
  assert.ok(restored);
  assert.equal(restored.qty, 3);
  assert.equal(restored.restoredInventoryCostCentimes, 15);
  assert.equal((await db.collection('reverseLedgerOperations').doc(operationId).get()).get('status'), 'POSTED');
});


test('real BigInt engine atomically cancels a partially paid sales invoice and reconciles debt, cash, and stock', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const { user } = await seed(uid, [operationId], {
    state: makeRealEngineState(),
    permissions: [PERMISSIONS.INVOICE_CANCEL, PERMISSIONS.CASH_REFUND],
    operationType: 'INVOICE_CANCEL',
    invoiceId: 'INV-EMULATOR-1'
  });
  t.after(() => cleanup(uid, [operationId]));
  const request = makeRequest(uid, operationId, { returnType: 'INVOICE_CANCEL' });
  delete request.data.items;

  const response = await createRealEngineHandler()(request);
  assert.equal(response.ok, true);
  assert.equal(response.document.totalCentimes, 30);
  assert.equal(response.document.debtReductionCentimes, 20);
  assert.equal(response.document.cashRefundCentimes, 10);

  const snapshot = await user.collection('snapshots').doc('latest').get();
  const state = JSON.parse(snapshot.get('payload'));
  assert.equal(state.invoices[0].status, 'CANCELLED');
  assert.equal(state.customers[0].debt, 0);
  assert.equal(state.caisseBalance, 0.90);
  assert.equal(state.products[0].stock, 3);
  assert.equal(state.returns.length, 1);
  assert.equal(state.returns[0].ledgerVersion, 2);
  assert.equal(ReverseLedger.validateReverseLedgerParity(state), true);
  assert.equal((await db.collection('reverseLedgerOperations').doc(operationId).get()).get('status'), 'POSTED');
});

test('real BigInt engine atomically cancels a partially paid purchase invoice with supplier cash inflow and stock reversal', async t => {
  const uid = 'emu-' + crypto.randomUUID();
  const operationId = 'REV-' + crypto.randomUUID();
  const supplier = { id: 'SUP-CANCEL', name: 'Supplier', balance: 0.20 };
  const state = {
    customers: [],
    suppliers: [supplier],
    invoices: [],
    purchases: [{
      id: 'PUR-CANCEL-EMULATOR',
      supplierId: 'SUP-CANCEL',
      total: 0.30,
      paid: 0.10,
      remaining: 0.20,
      invoiceLedgerVersion: 2,
      productId: 'P-1',
      qty: 3,
      cost: 0.10,
      warehouse: 'المخزن الرئيسي'
    }],
    products: [{ id: 'P-1', name: 'Tea', stock: 3, buyPrice: 0.10 }],
    cashMovements: [{
      id: 'PUR-CASH-CANCEL-EMULATOR', type: 'subtract', amount: 0.10,
      referenceType: 'purchase_invoice', referenceId: 'PUR-CANCEL-EMULATOR'
    }],
    stockMovements: [{
      id: 'PUR-STOCK-CANCEL-EMULATOR', productId: 'P-1', qty: 3,
      type: 'PURCHASE_IN', referenceType: 'purchase_invoice',
      referenceId: 'PUR-CANCEL-EMULATOR'
    }],
    clientMovements: [],
    supplierMovements: [{
      id: 'SUP-PUR-CANCEL-EMULATOR', supplierId: 'SUP-CANCEL', type: 'purchase',
      amount: 0.30, referenceType: 'purchase_invoice', referenceId: 'PUR-CANCEL-EMULATOR'
    }],
    settlementAllocations: [],
    returns: [],
    customerCreditMovements: [],
    caisseBalance: 1,
    currentUser: { id: 'U-RET' }
  };
  const { user } = await seed(uid, [operationId], {
    state,
    permissions: [PERMISSIONS.INVOICE_CANCEL, PERMISSIONS.CASH_REFUND],
    operationType: 'INVOICE_CANCEL',
    invoiceId: 'PUR-CANCEL-EMULATOR'
  });
  t.after(() => cleanup(uid, [operationId]));
  const request = makeRequest(uid, operationId, {
    invoiceId: 'PUR-CANCEL-EMULATOR',
    originalInvoiceType: 'purchase_invoice',
    returnType: 'INVOICE_CANCEL'
  });
  delete request.data.items;

  const response = await createRealEngineHandler()(request);
  assert.equal(response.ok, true);
  assert.equal(response.document.totalCentimes, 30);
  assert.equal(response.document.debtReductionCentimes, 20);
  assert.equal(response.document.cashRefundCentimes, 10);

  const snapshot = await user.collection('snapshots').doc('latest').get();
  const postedState = JSON.parse(snapshot.get('payload'));
  assert.equal(postedState.purchases[0].status, 'CANCELLED');
  assert.equal(postedState.suppliers[0].balance, 0);
  assert.equal(postedState.caisseBalance, 1.10);
  assert.equal(postedState.products[0].stock, 0);
  assert.equal(postedState.returns.length, 1);
  assert.equal(postedState.returns[0].ledgerVersion, 2);
  assert.equal(ReverseLedger.validateReverseLedgerParity(postedState), true);
  assert.equal((await db.collection('reverseLedgerOperations').doc(operationId).get()).get('status'), 'POSTED');
});
