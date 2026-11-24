import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../anas-live-status.js', import.meta.url), 'utf8');
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
  }), '2026/11/8, 2:31:22 م', 'an invalid preferred field must not mask a valid invoiceDate');
  assert.equal(h.window.anasGetReportRecordDate({
    date: 'not-a-date',
    createdAt: '٢٠٢٦/١١/٨، ٢:٣١:٢٢ ص'
  }), '٢٠٢٦/١١/٨، ٢:٣١:٢٢ ص', 'createdAt is a valid fallback when earlier fields are malformed');
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
