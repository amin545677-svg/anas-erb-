const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const swSource = fs.readFileSync('sw.js', 'utf8');
const cacheMatch = swSource.match(/const CACHE = ['"]([^'"]+)['"]/);
assert.ok(cacheMatch, 'service worker must declare its cache name');
const activeCacheName = cacheMatch[1];
const baseUrl = 'https://example.test/app/sw.js';
const listeners = {};
const store = new Map();
let offline = false;
let failCacheWrites = false;
let failPrecachePath = './vendor/tesseract/lang/fra.traineddata.gz';
let networkOk = true;
let networkBody = 'network-latest';
let skipWaitingCalled = false;
let skipWaitingCalls = 0;
let messageSkipWaitingCalled = false;
let claimCalled = false;

function keyOf(input) {
  const raw = typeof input === 'string' ? input : input.url;
  return new URL(raw, baseUrl).href;
}
function makeResponse(body, ok = true) {
  return { ok, body, clone() { return makeResponse(body, ok); } };
}
function makeCache(name) {
  if (!store.has(name)) store.set(name, new Map());
  const entries = store.get(name);
  return {
    async addAll(paths) {
      for (const path of paths) entries.set(keyOf(path), makeResponse('precache:' + path));
    },
    async add(path) {
      if (path === failPrecachePath) throw new Error('simulated optional OCR asset failure');
      entries.set(keyOf(path), makeResponse('precache:' + path));
    },
    async put(request, response) {
      if (failCacheWrites) throw new Error('simulated cache quota failure');
      entries.set(keyOf(request), response.clone());
    },
    async match(request) {
      const found = entries.get(keyOf(request));
      return found ? found.clone() : undefined;
    }
  };
}
const caches = {
  async open(name) { return makeCache(name); },
  async keys() { return [...store.keys()]; },
  async delete(name) { return store.delete(name); }
};
const self = {
  location: { href: baseUrl, origin: 'https://example.test' },
  clients: { async claim() { claimCalled = true; } },
  addEventListener(name, handler) { listeners[name] = handler; },
  async skipWaiting() { skipWaitingCalled = true; skipWaitingCalls++; }
};
const context = {
  self, caches, URL, Promise,
  fetch: async request => {
    if (offline) throw new Error('network offline');
    return makeResponse(networkBody, networkOk);
  }
};
vm.runInNewContext(swSource, context, { filename: 'sw.js' });

async function dispatchLifecycle(name) {
  let pending;
  listeners[name]({ waitUntil(promise) { pending = promise; } });
  assert.ok(pending, name + ' must register lifecycle work');
  await pending;
}
async function request(url, { method = 'GET', mode = 'same-origin' } = {}) {
  let responsePromise;
  const event = {
    request: { url, method, mode },
    respondWith(promise) { responsePromise = promise; }
  };
  listeners.fetch(event);
  return responsePromise ? await responsePromise : undefined;
}

(async () => {
  store.set('anas-erp-v54-25-r1', new Map());
  store.set('other-app-cache', new Map());
  await dispatchLifecycle('install');
  listeners.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(skipWaitingCalls, 2, 'SKIP_WAITING message must invoke skipWaiting after install');
  assert.equal(skipWaitingCalled, true, 'install should activate the updated worker promptly');
  const installCache = await caches.open(activeCacheName);
  assert.ok(await installCache.match(new URL('./vendor/tesseract/tesseract.min.js', baseUrl).href),
    'OCR runtime must be cached independently');
  assert.ok(await installCache.match(new URL('./vendor/tesseract/lang/ara.traineddata.gz', baseUrl).href),
    'available Arabic OCR data must be cached even if another language asset fails');
  assert.equal(await installCache.match(new URL(failPrecachePath, baseUrl).href), undefined,
    'a failed optional OCR asset must remain explicitly absent, not be represented as cached');

  // Re-add an old cache after install to simulate a prior app shell still present at activation.
  store.set('anas-erp-v54-25-r1', new Map());
  await dispatchLifecycle('activate');
  assert.equal(store.has('anas-erp-v54-25-r1'), false, 'activation should remove old ANAS ERP cache');
  assert.equal(store.has('other-app-cache'), true, 'activation must not delete unrelated origin caches');
  assert.equal(claimCalled, true, 'activation should claim existing clients');

  const shellUrl = 'https://example.test/app/';
  const indexUrl = 'https://example.test/app/index.html';
  let response = await request(shellUrl, { mode: 'navigate' });
  assert.equal(response.body, 'network-latest', 'online navigation should use fresh network HTML');
  let cache = await caches.open(activeCacheName);
  const offlineAssets = [
    './anas-erp-ui-safe-enhancements.css',
    './reverse-ledger/reverse-ledger.js',
    './reverse-ledger/reverse-ledger-modal.js',
    './reverse-ledger/settlement-allocation-modal.js',
    './storage/android-resilient-storage.js',
    './supplier-account-statement.js',
    './cashbox-readonly-ledger.js',
    './arabic-query-engine.js',
    './customer-debt-protection.js',
    './warehouse-transfer-audit.js'
  ];
  for (const asset of offlineAssets) {
    assert.ok(await cache.match(new URL(asset, baseUrl).href), asset + ' must be precached as an app-shell dependency');
  }
  offline = true;
  for (const asset of offlineAssets) {
    const offlineResponse = await request(new URL(asset, baseUrl).href);
    assert.equal(offlineResponse.body, 'precache:' + asset, asset + ' must remain available when offline');
  }
  offline = false;
  assert.ok(await cache.match('https://example.test/app/reverse-ledger/reverse-ledger.js'), 'reverse-ledger runtime must be included in the offline app shell');
  networkBody = 'reverse-ledger-module-latest';
  response = await request('https://example.test/app/reverse-ledger/reverse-ledger.js');
  assert.equal(response.body, 'reverse-ledger-module-latest', 'reverse-ledger module must be network-first');
  assert.equal((await cache.match('https://example.test/app/reverse-ledger/reverse-ledger.js')).body, 'reverse-ledger-module-latest');
  offline = true;
  response = await request('https://example.test/app/reverse-ledger/reverse-ledger.js');
  assert.equal(response.body, 'reverse-ledger-module-latest', 'reverse-ledger module must load from cache offline');
  offline = false;
  assert.equal((await cache.match(indexUrl)).body, 'network-latest', 'fresh HTML should replace the cached shell');

  // HTTP failures must use the current app shell rather than returning a hosting error page.
  networkOk = false;
  networkBody = 'http-503';
  response = await request(shellUrl, { mode: 'navigate' });
  assert.equal(response.body, 'network-latest', 'HTTP error navigation should fall back to the latest cached shell');
  networkOk = true;

  offline = true;
  response = await request(shellUrl, { mode: 'navigate' });
  assert.equal(response.body, 'network-latest', 'offline navigation should fall back to the latest cached shell');

  offline = false;
  networkBody = 'manifest-latest';
  response = await request('https://example.test/app/manifest.webmanifest');
  assert.equal(response.body, 'manifest-latest', 'core assets should be network-first');
  assert.equal((await cache.match('https://example.test/app/manifest.webmanifest')).body, 'manifest-latest');

  offline = true;
  response = await request('https://example.test/app/manifest.webmanifest');
  assert.equal(response.body, 'manifest-latest', 'core assets should fall back to their current cached copy');

  // A cache quota/storage error must not discard a successful online response.
  offline = false;
  failCacheWrites = true;
  networkBody = 'fresh-html-cache-unavailable';
  response = await request(shellUrl, { mode: 'navigate' });
  assert.equal(response.body, 'fresh-html-cache-unavailable', 'navigation must succeed when cache writes fail');
  networkBody = 'fresh-manifest-cache-unavailable';
  response = await request('https://example.test/app/manifest.webmanifest');
  assert.equal(response.body, 'fresh-manifest-cache-unavailable', 'core asset requests must succeed when cache writes fail');
  failCacheWrites = false;

  let intercepted = await request('https://external.test/resource.js');
  assert.equal(intercepted, undefined, 'cross-origin requests should not be intercepted');
  intercepted = await request('https://example.test/app/api', { method: 'POST' });
  assert.equal(intercepted, undefined, 'non-GET requests should not be intercepted');

  console.log('Service worker runtime tests passed: cache cleanup, network-first refresh, HTTP/offline fallback, cache-write failure resilience, and request scope');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
