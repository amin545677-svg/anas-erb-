import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../anas-live-status.js', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function harness(snapshot, appData) {
  const winListeners = new Map(), docListeners = new Map(), timers = new Map();
  let nextTimerId = 0;
  const bar = { dataset: { buildVersion: 'r39' } }, networkBadge = { textContent: '' }, durabilityBadge = { textContent: '' };
  const versionBadge = { textContent: 'r39' };
  const buildStamp = { textContent: 'Build SHA: abcdef0 | SW: r40 | Env: Staging' };
  const document = {
    getElementById(id) { return id === 'anas-live-status-bar' ? bar : id === 'anas-status-network-badge' ? networkBadge : id === 'anas-status-durability-badge' ? durabilityBadge : id === 'anas-status-version-badge' ? versionBadge : id === 'anasBuildStamp' ? buildStamp : null; },
    addEventListener(type, fn) { const list = docListeners.get(type) || []; list.push(fn); docListeners.set(type, list); },
    dispatchEvent(event) { for (const fn of docListeners.get(event.type) || []) fn(event); }
  };
  const window = {
    document, navigator: { onLine: true }, AppData: appData,
    ANASResilientStorage: { ready: () => true, getCommittedSnapshot: () => snapshot.value, canonicalizeJson: value => JSON.stringify(value) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options && options.detail; } },
    addEventListener(type, fn) { const list = winListeners.get(type) || []; list.push(fn); winListeners.set(type, list); },
    setTimeout(fn, delay) { const id = ++nextTimerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fire(type) { for (const fn of winListeners.get(type) || []) fn(); }
  };
  vm.runInNewContext(source, { window });
  return { window, document, bar, networkBadge, durabilityBadge, versionBadge, buildStamp, timers };
}
test('one live status bar owns durable-save and network DOM updates without a competing timer', async () => {
  let release;
  const h = harness({ value: { revision: 1 } }, { revision: 1 });
  h.window.saveDBDurably = async () => new Promise(resolve => { release = resolve; });
  h.document.dispatchEvent({ type: 'anas:storage-hydrated' });
  assert.equal([...h.timers.values()][0].delay, 50, 'DOM repairs are deferred by 50ms');
  const pending = h.window.saveDBDurably();
  assert.equal(h.bar.dataset.durabilityState, 'saving');
  release(true);
  assert.equal(await pending, true);
  assert.equal(h.bar.dataset.durabilityState, 'committed');
  assert.equal(h.durabilityBadge.textContent, '✓ محفوظ بأمان');
  h.window.fire('offline');
  assert.equal(h.bar.dataset.networkState, 'offline');
  assert.equal(h.networkBadge.textContent, '● غير متصل');
  assert.equal(h.document.getElementById('anasDurabilityStatus'), null);
  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.doesNotMatch(source, /anasDurabilityStatus/);
  assert.doesNotMatch(source, /badge\.textContent\s*=\s*['"]r40['"]/, 'DOM repairs must not overwrite the verified build SHA with a hard-coded version');
});
test('committed is never shown when the durable snapshot differs from AppData', () => {
  const h = harness({ value: { revision: 1 } }, { revision: 2 });
  assert.equal(h.bar.dataset.durabilityState, 'uncommitted');
  assert.equal(h.durabilityBadge.textContent, '⚠ توجد تغييرات غير محفوظة');
});

test('runtime status bar takes the exact r40 and commit identity from the About-app build stamp', () => {
  const h = harness({ value: { revision: 1 } }, { revision: 1 });
  assert.equal(h.bar.dataset.buildIdentityState, 'verified');
  assert.equal(h.bar.dataset.buildVersion, 'r40');
  assert.equal(h.bar.dataset.buildSha, 'abcdef0');
  assert.equal(h.versionBadge.textContent, 'SW: r40 | Build SHA: abcdef0');
});

test('runtime status bar fails closed when the About-app build stamp is malformed', () => {
  const h = harness({ value: { revision: 1 } }, { revision: 1 });
  h.buildStamp.textContent = 'Build SHA: a091434 | SW: r39 | Env: Staging';
  h.document.dispatchEvent({ type: 'DOMContentLoaded' });
  assert.equal(h.bar.dataset.buildIdentityState, 'unverified');
  assert.equal(h.versionBadge.textContent, '⚠ إصدار غير متحقق');
});

test('R46 report dates parse Arabic digits and time suffixes, reject impossible dates, and fall through invalid date fields', () => {
  const h = harness({ value: { revision: 1 } }, { revision: 1 });
  const parse = h.window.anasNormalizeReportDateValue;
  const samples = [
    '2026/11/8, 2:31:22 م',
    '٢٠٢٦/١١/٨، ٢:٣١:٢٢ ص',
    '۲۰۲۶/۱۱/۸ ۲:۳۱:۲۲ م',
    '2026-11-08T14:31:22.000Z',
    '08/11/2026 2:31 PM'
  ];
  for (const sample of samples) {
    const parsed = parse(sample);
    assert.ok(parsed && !Number.isNaN(parsed.getTime()), 'date should parse: ' + sample);
    assert.equal(parsed.getFullYear(), 2026);
    assert.equal(parsed.getMonth(), 10);
    assert.equal(parsed.getDate(), 8);
  }
  assert.equal(parse('2026-02-31'), null, 'impossible calendar dates must be rejected');
  assert.equal(h.window.anasGetReportRecordDate({
    date: '2026-02-31',
    invoiceDate: '2026/11/8, 2:31:22 م'
  }), '2026-11-08', 'an invalid preferred field must fall through to a normalized valid invoiceDate');
  assert.equal(h.window.anasGetReportRecordDate({
    date: 'not-a-date',
    createdAt: '٢٠٢٦/١١/٨، ٢:٣١:٢٢ ص'
  }), '2026-11-08', 'createdAt fallback is returned as a normalized day key');
  assert.equal(h.window.anasGetReportRecordDate({ id: 'INV-20261108-0001' }), '2026-11-08',
    'a valid date embedded in an invoice ID remains a fallback');
});

test('R46 report date extraction returns null when all record and invoice-ID date candidates are impossible', () => {
  const h = harness({ value: { revision: 1 } }, { revision: 1 });
  assert.equal(h.window.anasGetReportRecordDate({
    date: '2026-02-31',
    invoiceDate: '2026/02/31',
    createdAt: 'not-a-date',
    id: 'INV-20260231-0001'
  }), null);
});

test('V42 invoice metadata compatibility permits later offline cash, category, product and expense saves without weakening invoice immutability', () => {
  const committed = { invoices: [{ id: 'INV-1', total: 1550, paid: 1550, syncOpId: 'sale-op-1', syncCreatedAt: '2026-11-24T10:00:00.000Z' }] };
  const appData = { invoices: [{ id: 'INV-1', total: 1550, paid: 1550 }], cashMovements: [], productCategories: [], products: [], expenses: [] };
  const h = harness({ value: committed }, appData);
  h.window.AppData = appData; h.window.__ANAS_GET_APP_DATA__ = () => appData;
  h.window.ANASMutationQueue = { keys: { appData: 'appData' } };
  let persisted = structuredClone(committed);
  h.window.ANASResilientStorage.getItem = key => key === 'appData' ? persisted : null;
  h.window.saveDB = () => {
    const old = persisted.invoices[0], next = appData.invoices[0];
    if (JSON.stringify(old) !== JSON.stringify(next)) throw new Error('Existing invoices ledger row was modified during a new operation');
    persisted = structuredClone(appData); return true;
  };
  h.window.ANASMutationSync = { status: 'installed' };
  const operations = [
    () => appData.cashMovements.push({ id: 'CASH-1', amount: 2000, type: 'add' }),
    () => appData.productCategories.push({ id: 'CAT-1', name: 'شاي السلطان' }),
    () => appData.products.push({ id: 'P-1', name: 'شاي السلطان 100غ', stock: 1 }),
    () => appData.expenses.push({ id: 'EXP-1', amount: 2000, description: 'مازوت' })
  ];
  for (const mutate of operations) { mutate(); assert.equal(h.window.saveDB(), true); }
  assert.equal(appData.invoices[0].syncOpId, 'sale-op-1');
  appData.invoices[0].total = 9999;
  assert.throws(() => h.window.saveDB(), /Existing invoices ledger row was modified/);
});

test('last-seven-days report range includes today and excludes records before its inclusive lower bound', () => {
  const h = harness({ value: {} }, {});
  const rows = [{ id: 'today', date: '2026-11-24T23:59:00' }, { id: 'first-day', date: '2026-11-18T00:00:00' }, { id: 'old', date: '2026-11-17T23:59:59' }];
  const filtered = h.window.anasFilterReportRowsByRange(rows, { from: '2026-11-18', to: '2026-11-24' });
  assert.deepEqual(filtered.map(row => row.id), ['today', 'first-day']);
});

test('store movement KPIs use the saved invoice and canonical caisseBalance field', () => {
  const h = harness({ value: {} }, {});
  const result = h.window.anasBuildStoreMovementMetrics({ caisseBalance: 206090, invoices: [{ id: 'INV-1', date: '2026-11-24', total: 1550, paid: 1550 }], expenses: [{ id: 'EXP-1', date: '2026-11-24', amount: 2000 }] }, { from: '2026-11-24', to: '2026-11-24' });
  assert.equal(result.metrics[0][1], 1550); assert.equal(result.metrics[1][1], 1550); assert.equal(result.metrics[5][1], 206090);
});

test('report range hook restores invoices on an inclusive last-seven-days boundary', () => {
  const h = harness({ value: {} }, {});
  h.window.getReportRange = () => ({ from: '2026-11-18', to: '2026-11-24' });
  h.window.reportItemInRange = () => false;
  h.window.anasInstallReportAndLedgerHooks();
  assert.equal(h.window.reportItemInRange({ id: 'INV-TODAY', date: '2026-11-24T11:30:00' }), true);
});

test('durability badge fails closed after a failed persistent write and turns green only after a confirmed commit', () => {
  const snapshot = { value: { revision: 1 } };
  const appData = { revision: 1 };
  const h = harness(snapshot, appData);
  let writer = () => { throw new Error('disk quota exceeded'); };
  h.window.saveDB = () => writer();
  h.window.ANASMutationSync = { status: 'installed' };
  assert.throws(() => h.window.saveDB(), /disk quota exceeded/);
  assert.equal(h.bar.dataset.durabilityState, 'error');
  assert.equal(h.durabilityBadge.textContent, '⚠ فشل الحفظ المحلي');
  h.document.dispatchEvent({ type: 'anas:storage-committed' });
  assert.equal(h.durabilityBadge.textContent, '⚠ فشل الحفظ المحلي', 'commit notifications must not clear a failed-write latch');
  writer = () => false;
  assert.equal(h.window.saveDB(), false, 'a rejected durable write must remain a visible failure');
  assert.equal(h.bar.dataset.durabilityState, 'error');
  writer = () => { snapshot.value = { revision: 2 }; appData.revision = 2; return true; };
  assert.equal(h.window.saveDB(), true);
  assert.equal(h.bar.dataset.durabilityState, 'committed');
  assert.equal(h.durabilityBadge.textContent, '✓ محفوظ بأمان');
});

test('sales and profit report handlers normalize slash and day-first invoice dates without exclusions', () => {
  const invoices = Array.from({ length: 14 }, (_, i) => ({
    id: 'INV-' + (i + 1), date: '2026/11/24', total: 1000 + i, cost: 400 + i
  }));
  const originalDates = invoices.map(row => row.date);
  const h = harness({ value: { invoices } }, { invoices });
  h.window.getReportRange = () => ({ from: '24/11/2026', to: '2026/11/24' });
  h.window.reportParseDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(String(value) + 'T00:00:00') : null;
  h.window.showReportDetails = function (report) {
    const range = h.window.getReportRange();
    const accepted = h.window.AppData.invoices.filter(row => {
      const parsed = h.window.reportParseDate(row.date);
      if (!parsed) return false;
      const day = parsed.toISOString().slice(0, 10);
      return day >= range.from && day <= range.to;
    });
    return {
      report,
      count: accepted.length,
      total: accepted.reduce((sum, row) => sum + row.total, 0),
      profit: accepted.reduce((sum, row) => sum + row.total - row.cost, 0),
      excludedForDate: h.window.AppData.invoices.length - accepted.length
    };
  };
  h.window.anasInstallReportAndLedgerHooks();
  const sales = h.window.showReportDetails('sales');
  const profit = h.window.showReportDetails('profit');
  assert.equal(sales.count, 14);
  assert.equal(sales.total, 14091);
  assert.equal(sales.excludedForDate, 0);
  assert.equal(profit.count, 14);
  assert.equal(profit.profit, 8400);
  assert.equal(profit.excludedForDate, 0);
  assert.deepEqual(invoices.map(row => row.date), originalDates, 'normalization must not mutate persisted AppData invoices');
});


test('offline POS, unshift debt collection, product and customer saves preserve cash ledger identity and reject financial mutations', () => {
  const committed = {
    invoices: [{ id: 'INV-BASE', total: 2000, paid: 2000, syncOpId: 'invoice-op', syncCreatedAt: '2026-11-24T10:00:00.000Z' }],
    cashMovements: [
      { id: 'SALE-CASH-INV-TEST', amount: 2000, type: 'add', currency: 'DZD', date: '2026-11-24', description: 'POS sale', referenceType: 'sales_invoice', referenceId: 'INV-BASE', cashImpact: 2000, paymentChannel: 'cash' },
      { id: 'CASH-BASE', amount: 2000, type: 'add', currency: 'DZD', date: '2026-11-24', syncOpId: 'cash-op', syncCreatedAt: '2026-11-24T10:01:00.000Z' }
    ]
  };
  const appData = structuredClone(committed);
  appData.products = []; appData.customers = [];
  const snapshot = { value: structuredClone(committed) };
  const h = harness(snapshot, appData);
  h.window.AppData = appData;
  h.window.__ANAS_GET_APP_DATA__ = () => appData;
  h.window.ANASMutationQueue = { keys: { appData: 'appData' } };
  let persisted = structuredClone(committed);
  h.window.ANASResilientStorage.getItem = key => key === 'appData' ? persisted : null;
  h.window.saveDB = () => {
    persisted = structuredClone(appData);
    snapshot.value = structuredClone(appData);
    return true;
  };
  h.window.ANASMutationSync = { status: 'installed' };
  h.document.dispatchEvent({ type: 'anas:storage-hydrated' });
  const cashBase = () => appData.cashMovements.find(row => row.id === 'CASH-BASE');
  const saleRow = () => appData.cashMovements.find(row => row.id === 'SALE-CASH-INV-TEST');
  const save = mutate => { mutate(); assert.equal(h.window.saveDB(), true); assert.equal(h.durabilityBadge.textContent, '✓ محفوظ بأمان'); };
  save(() => appData.invoices.push({ id: 'INV-POS-NEW', total: 2000, paid: 2000 }));
  save(() => appData.products.push({ id: 'P-NEW', name: 'شاي قرية', stock: 1 }));
  save(() => appData.cashMovements.push({ id: 'CASH-NEW', amount: 2000, type: 'add', currency: 'DZD', date: '2026-11-24T10:02:00.000Z' }));
  save(() => appData.cashMovements.unshift({ id: 'DEBT-RECEIPT-NEW', amount: 2000, type: 'add', currency: 'DZD', date: '2026-11-24', description: 'Debt collection' }));
  assert.equal(appData.cashMovements[1].id, 'SALE-CASH-INV-TEST', 'the committed sale row may shift from index 0 to index 1 after unshift');
  assert.equal(saleRow().description, 'POS sale');
  save(() => appData.customers.push({ id: 'C-NEW', name: 'محمد دربا', city: 'النعامة' }));
  assert.equal(cashBase().syncOpId, 'cash-op');
  assert.equal(appData.invoices[0].syncOpId, 'invoice-op');
  save(() => {
    cashBase().date = '2026/11/24';
    cashBase().syncStatus = 'synced';
    cashBase().synced = true;
  });
  assert.equal(cashBase().date, '2026/11/24', 'same-day date formatting is permitted');
  for (const [field, value] of [
    ['amount', 1], ['type', 'remove'], ['id', 'CASH-ALTERED'],
    ['currency', 'USD'], ['invoiceId', 'INV-ALTERED'],
    ['customerId', 'CUSTOMER-ALTERED'], ['account', 'OTHER-ACCOUNT'],
    ['truckId', 'TRUCK-ALTERED'], ['warehouseId', 'WAREHOUSE-ALTERED'], ['date', '2026-11-25']
  ]) {
    const previous = cashBase()[field];
    assert.throws(() => {
      cashBase()[field] = value;
      h.window.saveDB();
    }, error => error.message.startsWith('Existing cashMovements ledger row was modified during a new operation') &&
      error.message.includes('(row=CASH-BASE, fields=' + field + ')'));
    assert.equal(cashBase()[field], previous, field + ' must be restored after rejection');
  }
  for (const [field, value] of [
    ['amount', 1], ['type', 'remove'], ['id', 'SALE-ALTERED'],
    ['currency', 'USD'], ['invoiceId', 'INV-ALTERED'], ['customerId', 'CUSTOMER-ALTERED'],
    ['account', 'OTHER-ACCOUNT'], ['truckId', 'TRUCK-ALTERED'], ['warehouseId', 'WAREHOUSE-ALTERED'],
    ['date', '2026-11-25'], ['description', 'changed'], ['referenceType', 'other'],
    ['referenceId', 'INV-OTHER'], ['cashImpact', -2000], ['paymentChannel', 'card']
  ]) {
    const previous = saleRow()[field];
    assert.throws(() => {
      saleRow()[field] = value;
      h.window.saveDB();
    }, error => error.message.startsWith('Existing cashMovements ledger row was modified during a new operation') &&
      error.message.includes('(row=SALE-CASH-INV-TEST, fields=' + field + ')'));
    assert.equal(saleRow()[field], previous, field + ' must be restored after rejection');
  }
});
test('cash ledger rejects deletion and duplicate committed IDs and restores the committed rows', () => {
  const committed = { cashMovements: [{ id: 'CASH-BASE', amount: 2000, type: 'add', date: '2026-11-24' }] };
  const appData = structuredClone(committed);
  const snapshot = { value: structuredClone(committed) };
  const h = harness(snapshot, appData);
  h.window.AppData = appData;
  h.window.__ANAS_GET_APP_DATA__ = () => appData;
  h.window.ANASMutationQueue = { keys: { appData: 'appData' } };
  let persisted = structuredClone(committed);
  h.window.ANASResilientStorage.getItem = key => key === 'appData' ? persisted : null;
  h.window.saveDB = () => { persisted = structuredClone(appData); snapshot.value = structuredClone(appData); return true; };
  h.window.ANASMutationSync = { status: 'installed' };
  h.document.dispatchEvent({ type: 'anas:storage-hydrated' });
  appData.cashMovements.length = 0;
  assert.throws(() => h.window.saveDB(), /Existing cashMovements ledger row was modified during a new operation/);
  assert.deepEqual(appData.cashMovements.map(row => row.id), ['CASH-BASE']);
  appData.cashMovements.push({ id: 'CASH-BASE', amount: 2000, type: 'add', date: '2026-11-24' });
  assert.throws(() => h.window.saveDB(), /Existing cashMovements ledger row was modified during a new operation/);
  assert.deepEqual(appData.cashMovements.map(row => row.id), ['CASH-BASE']);
});
test('live status source passes new Function syntax check', () => {
  assert.doesNotThrow(() => new Function(source));
});

test('POS invoice followed by saveProduct -> saveDB preserves immutable invoice and sync metadata', () => {
  const committed = { invoices: [{ id: 'INV-POS-LOCK', date: '2026-11-27T09:15:00.000Z', total: 4200, paid: 4200, customerId: 'C-1', items: [{ productId: 'P-1', qty: 2, price: 2100 }], syncOpId: 'pos-op', syncCreatedAt: '2026-11-27T09:15:01.000Z', synced: true, syncStatus: 'synced' }] };
  const appData = structuredClone(committed);
  appData.invoices[0].date = '2026-11-27';
  for (const key of ['syncOpId','syncCreatedAt','synced','syncStatus']) delete appData.invoices[0][key];
  appData.products = [];
  const h = harness({ value: structuredClone(committed) }, appData);
  h.window.AppData = appData; h.window.__ANAS_GET_APP_DATA__ = () => appData;
  h.window.ANASMutationQueue = { keys: { appData: 'appData' } };
  let persisted = structuredClone(committed);
  h.window.ANASResilientStorage.getItem = key => key === 'appData' ? persisted : null;
  h.window.saveDB = () => { persisted = structuredClone(appData); return true; };
  h.window.ANASMutationSync = { status: 'installed' };
  h.window.saveProduct = () => { appData.products.push({ id: 'P-NEW', name: 'منتج جديد' }); return h.window.saveDB(); };
  assert.equal(h.window.saveProduct(), true);
  for (const key of ['syncOpId','syncCreatedAt','synced','syncStatus']) assert.equal(persisted.invoices[0][key], committed.invoices[0][key]);
  assert.equal(persisted.invoices[0].total, 4200);
  appData.invoices[0].total = 1;
  assert.throws(() => h.window.saveDB(), /Existing invoices ledger row was modified/);
  assert.equal(appData.invoices[0].total, 4200, 'a financial edit is restored');
  appData.invoices.length = 0;
  assert.throws(() => h.window.saveDB(), /Existing invoices ledger row was modified/);
  assert.equal(appData.invoices[0].id, 'INV-POS-LOCK', 'deletion is restored');
});

test('report audit tries date fields in order and does not exclude a valid createdAt fallback', () => {
  const marker = "const d=['date','invoiceDate','createdAt','timestamp','updatedAt'].map(k=>reportParseDate(row?.[k])).find(Boolean);";
  const at = indexSource.indexOf(marker);
  assert.notEqual(at, -1, 'report audit must use first-valid parsed date fallback');
  const expression = marker.slice('const d='.length, -1);
  const pickDate = new Function('row', 'reportParseDate', 'return ' + expression + ';');
  const parse = value => {
    if (value === 'not-a-date') return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  let auditExcluded = 0;
  const d = pickDate({ date: 'not-a-date', invoiceDate: '', createdAt: '2026-11-27T10:00:00Z' }, parse);
  if (!d) auditExcluded++;
  assert.equal(auditExcluded, 0);
  assert.equal(d.toISOString(), '2026-11-27T10:00:00.000Z');
});
