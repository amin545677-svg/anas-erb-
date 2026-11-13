import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../anas-live-status.js', import.meta.url), 'utf8');
function harness(snapshot, appData) {
  const winListeners = new Map(), docListeners = new Map();
  const bar = { dataset: {} }, networkBadge = { textContent: '' }, durabilityBadge = { textContent: '' };
  const document = {
    getElementById(id) { return id === 'anas-live-status-bar' ? bar : id === 'anas-status-network-badge' ? networkBadge : id === 'anas-status-durability-badge' ? durabilityBadge : null; },
    addEventListener(type, fn) { const list = docListeners.get(type) || []; list.push(fn); docListeners.set(type, list); },
    dispatchEvent(event) { for (const fn of docListeners.get(event.type) || []) fn(event); }
  };
  const window = {
    document, navigator: { onLine: true }, AppData: appData,
    ANASResilientStorage: { ready: () => true, getCommittedSnapshot: () => snapshot.value, canonicalizeJson: value => JSON.stringify(value) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options && options.detail; } },
    addEventListener(type, fn) { const list = winListeners.get(type) || []; list.push(fn); winListeners.set(type, list); },
    fire(type) { for (const fn of winListeners.get(type) || []) fn(); }
  };
  vm.runInNewContext(source, { window });
  return { window, document, bar, networkBadge, durabilityBadge };
}
test('one live status bar owns durable-save and network DOM updates without a competing timer', async () => {
  let release;
  const h = harness({ value: { revision: 1 } }, { revision: 1 });
  h.window.saveDBDurably = async () => new Promise(resolve => { release = resolve; });
  h.document.dispatchEvent({ type: 'anas:storage-hydrated' });
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
});
test('committed is never shown when the durable snapshot differs from AppData', () => {
  const h = harness({ value: { revision: 1 } }, { revision: 2 });
  assert.equal(h.bar.dataset.durabilityState, 'uncommitted');
  assert.equal(h.durabilityBadge.textContent, '⚠ توجد تغييرات غير محفوظة');
});
