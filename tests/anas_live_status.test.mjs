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
