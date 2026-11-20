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
