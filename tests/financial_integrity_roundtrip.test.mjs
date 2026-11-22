import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const cartSource = await readFile(new URL('../anas-pos-floating-cart.js', import.meta.url), 'utf8');

function topLevelFunction(source, name) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'function ' + name + ' must exist');
  const next = source.indexOf('\n        function ', start + marker.length);
  return source.slice(start, next >= 0 ? next : source.length);
}

function helperContext(appData) {
  const names = [
    'anasBackupWarehouseDefinitions','anasBackupWarehouseStockEntries','anasBackupQuantityUnits',
    'anasBackupInventorySignature','anasNormalizeBackupInventory','anasBuildBackupExportPayload',
    'anasAppendAuditTrailEvent','anasEnsurePosCartZeroPriceApproved'
  ];
  const source = names.map(name => topLevelFunction(indexSource, name)).join('\n');
  const context = vm.createContext({
    AppData: appData, Map, BigInt, Number, String, Object, Array, JSON, Error, Date, Math,
    anasToQtyUnits: value => Math.round(Number(value) * 1000000),
    anasQtyFromUnits: units => Number(units) / 1000000,
    anasToCents: value => Math.round(Number(value) * 100),
    alert: () => {}
  });
  vm.runInContext(source, context);
  return context;
}

function stock312() {
  return Array.from({ length: 312 }, (_, index) => ({
    id: 'P-' + String(index + 1).padStart(3, '0'),
    name: 'Product ' + (index + 1),
    stock: index === 311 ? 150.43 : 121
  }));
}

test('backup export preserves exact stock total for the 312-product 22/11 baseline', () => {
  const products = stock312().map(product => ({ ...product, warehouseStock: {} }));
  const ctx = helperContext({ products, warehouses: [], auditTrail: [] });
  const payload = JSON.parse(ctx.anasBuildBackupExportPayload());
  const signature = JSON.parse(ctx.anasBackupInventorySignature(payload));
  assert.equal(payload.products.length, 312);
  assert.equal(signature.productCount, 312);
  assert.equal(signature.mainStockUnits, '37781430000');
  assert.equal(signature.warehouseStockUnits, '0');
  assert.deepEqual(payload.warehouses, []);
  assert.ok(payload.products.every(product => product.warehouseStock && typeof product.warehouseStock === 'object'));
});

test('backup export round-trips warehouse definitions and Map/object warehouseStock without quantity loss', () => {
  const products = stock312().map((product, index) => ({
    ...product,
    warehouseStock: index === 0 ? new Map([['Store-A', '1.125']]) : { 'Store-A': '0.125' }
  }));
  const warehouses = [{ id: 'W-A', name: 'Store-A' }];
  const ctx = helperContext({ products, warehouses, auditTrail: [] });
  const payload = JSON.parse(ctx.anasBuildBackupExportPayload());
  const signature = JSON.parse(ctx.anasBackupInventorySignature(payload));
  assert.deepEqual(payload.warehouses, warehouses);
  assert.equal(payload.products[0].warehouseStock['Store-A'], '1.125');
  assert.equal(signature.mainStockUnits, '37781430000');
  assert.equal(signature.warehouseStockUnits, '40000000');
  assert.equal(signature.allLocationsStockUnits, '37821430000');
  assert.equal(signature.warehouseStockTotals[0][0], 'Store-A');
  assert.equal(signature.warehouseStockTotals[0][1], '40000000');
});

test('backup import refuses to synthesize a missing secondary balance map when current balances exist', () => {
  const ctx = helperContext({
    products: [{ id: 'P-1', stock: 5, warehouseStock: { 'Store-A': 7 } }],
    warehouses: [{ name: 'Store-A' }],
    auditTrail: []
  });
  const incoming = { products: [{ id: 'P-1', stock: 5 }], warehouses: [{ name: 'Store-A' }], auditTrail: [] };
  assert.throws(() => ctx.anasNormalizeBackupInventory(incoming), /تفتقد أرصدة المخازن الفرعية/);
});

test('backup import normalizes a legacy absent warehouseStock map only when no current subwarehouse balance would be lost', () => {
  const ctx = helperContext({ products: [{ id: 'P-1', stock: 5, warehouseStock: {} }], warehouses: [], auditTrail: [] });
  const incoming = { products: [{ id: 'P-1', stock: 5 }], auditTrail: [] };
  const signature = ctx.anasNormalizeBackupInventory(incoming);
  assert.equal(typeof signature, 'string');
  assert.deepEqual(incoming.warehouses, []);
  assert.deepEqual(incoming.products[0].warehouseStock, {});
});

test('new audit events are append-only, attributed, and reject duplicate IDs or malformed ledgers', () => {
  const ctx = helperContext({ currentUser: { id: 'user-1', name: 'Cashier' }, auditTrail: [] });
  const event = { id: 'AUD-RECEIPT-1', eventType: 'CUSTOMER_DEBT_RECEIPT_COMMITTED', entityType: 'customer_debt_receipt', entityId: 'RECEIPT-1', amountCentimes: 2500 };
  const record = ctx.anasAppendAuditTrailEvent(event);
  assert.equal(record.actorId, 'user-1');
  assert.equal(record.actorName, 'Cashier');
  assert.equal(ctx.AppData.auditTrail.length, 1);
  assert.throws(() => ctx.anasAppendAuditTrailEvent(event), /مستخدم مسبقاً/);
  ctx.AppData.auditTrail = { invalid: true };
  assert.throws(() => ctx.anasAppendAuditTrailEvent({ ...event, id: 'AUD-RECEIPT-2' }), /سجل التدقيق تالف/);
});

test('all new invoice, receipt, supplier-payment, edit and cashbox save paths append audit events', () => {
  for (const name of ['savePurchaseItem', 'collectCustDebt', 'paySupplierDebt', 'editSalesInvoice', 'submitCashOperation']) {
    const body = topLevelFunction(indexSource, name);
    assert.match(body, /anasAppendAuditTrailEvent\(/, name + ' must append auditTrail before save');
    assert.match(body, /auditTrail/, name + ' must include auditTrail in its rollback protection');
  }
  for (const name of ['confirmHasibPayment', 'confirmHasibPaymentDurable']) {
    const body = topLevelFunction(indexSource, name);
    assert.match(body, /anasEnsurePosCartZeroPriceApproved\(cart\)/, name + ' must fail closed on unapproved zero-price lines');
  }
});

test('zero price is accepted only with a recorded explicit free/gift confirmation', () => {
  const ctx = helperContext({});
  const approved = [{
    price: '0.00', freeSample: true, freeSampleConfirmed: true,
    freeSampleConfirmedAt: '2026-11-22T10:00:00.000Z', freeSampleReason: 'هدية'
  }];
  assert.equal(ctx.anasEnsurePosCartZeroPriceApproved(approved), true);
  assert.equal(ctx.anasEnsurePosCartZeroPriceApproved([{ price: '0.00', freeSample: true, freeSampleReason: 'هدية' }]), false);
  assert.match(cartSource, /freeSampleConfirmed===true/);
  assert.match(cartSource, /window\.confirm\('تأكيد صريح/);
  assert.match(cartSource, /window\.prompt\('اكتب سبب المجانية/);
});
