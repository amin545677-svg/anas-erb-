import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
let server, origin, browser;
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/test.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><main id="storage-test">ready</main></body></html>');
      return;
    }
    const file = path.join(ROOT, 'storage/android-resilient-storage.js');
    if (req.url !== '/storage/android-resilient-storage.js') { res.writeHead(404).end(); return; }
    fs.readFile(file, (error, bytes) => {
      if (error) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

test('Chromium keeps the synchronous LocalStorage fallback usable when Android WebView exposes no IndexedDB', async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  });
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const initial = JSON.stringify({ appName: 'Anas ERP', invoices: [{ id: 'LOCAL-ONLY-1', total: 99 }] });
    localStorage.setItem(S.APP_KEY, initial);
    const hydrated = await S.hydrate(initial);
    const next = JSON.stringify({ appName: 'Anas ERP', invoices: [{ id: 'LOCAL-ONLY-2', total: 123 }] });
    let indexedDbWriteRejected = false;
    try { await S.setSync(S.APP_KEY, next); } catch (_) { indexedDbWriteRejected = true; }
    return { hydrated: hydrated.hydrated, recoveredInvoice: hydrated.data.invoices[0].id,
      localWritePreserved: localStorage.getItem(S.APP_KEY) === next,
      mode: S.status().mode, indexedDbWriteRejected };
  });
  assert.deepEqual(result, { hydrated: true, recoveredInvoice: 'LOCAL-ONLY-1',
    localWritePreserved: true, mode: 'LOCALSTORAGE_FALLBACK_ACTIVE', indexedDbWriteRejected: true });
  await context.close();
});

test('Chromium migrates a valid legacy V42 local snapshot into IndexedDB with a positive revision', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const legacy = JSON.stringify({ appName: 'Anas ERP', invoices: [{ id: 'LEGACY-1', total: 12.5 }] });
    localStorage.setItem(S.APP_KEY, legacy);
    const hydrated = await S.hydrate(legacy);
    const record = await new Promise((resolve, reject) => {
      const req = indexedDB.open(S.DB_NAME);
      req.onsuccess = () => {
        const get = req.result.transaction(S.STORE_NAME, 'readonly').objectStore(S.STORE_NAME).get(S.APP_KEY);
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      };
      req.onerror = () => reject(req.error);
    });
    return { hydrated: hydrated.hydrated, dataPreserved: hydrated.data.invoices[0].total === 12.5,
      revision: record.revision, checksumValid: record.checksum === await S.checksum(record.payload) };
  });
  assert.deepEqual(result, { hydrated: true, dataPreserved: true, revision: 1, checksumValid: true });
  await context.close();
});

test('Chromium dual-writes, hydrates after localStorage clear, and survives quota errors without BigInt loss', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const first = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const finance = {
      invoices: [{ id: 'INV-CREDIT-1', totalCentimes: 8000000n, paidCentimes: 5900000n, debtCentimes: 2100000n }],
      stock: [{ id: 'BOX-1', quantityMicroUnits: 90000000n }],
      cashCentimes: 5900000n
    };
    const payload = S.encode(finance);
    await S.setSync(S.APP_KEY, payload);
    const local = localStorage.getItem(S.APP_KEY);
    const localMeta = JSON.parse(localStorage.getItem(S.APP_KEY + '__META_V1'));
    const localChecksumValid = localMeta.checksum === S.fastChecksum(local);
    const record = await new Promise((resolve, reject) => {
      const req = indexedDB.open(S.DB_NAME);
      req.onsuccess = () => {
        const tx = req.result.transaction(S.STORE_NAME, 'readonly');
        const get = tx.objectStore(S.STORE_NAME).get(S.APP_KEY);
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      };
      req.onerror = () => reject(req.error);
    });
    return { localMatches: local === payload, localChecksumValid, checksumValid: record.checksum === await S.checksum(record.payload),
      revision: record.revision };
  });
  assert.equal(first.localMatches, true);
  assert.equal(first.localChecksumValid, true);
  const fallbackChecksum = await page.evaluate(async () => {
    const S=window.ANASResilientStorage, descriptor=Object.getOwnPropertyDescriptor(window,'crypto');
    Object.defineProperty(window,'crypto',{configurable:true,value:{}});
    try{return await S.checksum('ANAS ERP deterministic checksum');}
    finally{if(descriptor)Object.defineProperty(window,'crypto',descriptor);else delete window.crypto;}
  });
  const nativeChecksum=await page.evaluate(()=>window.ANASResilientStorage.checksum('ANAS ERP deterministic checksum'));
  assert.equal(fallbackChecksum,await nativeChecksum);
  assert.equal(first.checksumValid, true);
  assert.equal(first.revision, 1);

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const recovery = await page.evaluate(async () => {
    const result = await window.ANASResilientStorage.hydrate(null);
    const data = result.data;
    return { recovered: result.recoveredFromIndexedDB, invoice: data.invoices[0].totalCentimes.toString(),
      paid: data.invoices[0].paidCentimes.toString(), debt: data.invoices[0].debtCentimes.toString(),
      stock: data.stock[0].quantityMicroUnits.toString(), cash: data.cashCentimes.toString(),
      localRestored: localStorage.getItem(window.ANASResilientStorage.APP_KEY) !== null };
  });
  assert.deepEqual(recovery, { recovered: true, invoice: '8000000', paid: '5900000', debt: '2100000',
    stock: '90000000', cash: '5900000', localRestored: true });

  const quota = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === S.APP_KEY) {
        const error = new DOMException('simulated quota exhaustion', 'QuotaExceededError');
        throw error;
      }
      return original.call(this, key, value);
    };
    try {
      const next = S.encode({ invoices: [{ id: 'INV-QUOTA-2', totalCentimes: 12345n }],
        cashCentimes: 5912345n });
      const result = await S.setSync(S.APP_KEY, next);
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(S.DB_NAME);
        req.onsuccess = () => {
          const get = req.result.transaction(S.STORE_NAME, 'readonly').objectStore(S.STORE_NAME).get(S.APP_KEY);
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        };
        req.onerror = () => reject(req.error);
      });
      return { saved: db.payload === next, checksumValid: db.checksum === await S.checksum(db.payload),
        mode: S.status().mode, invoice: S.decode(db.payload).invoices[0].totalCentimes.toString(),
        revision: db.revision };
    } finally { Storage.prototype.setItem = original; }
  });
  assert.deepEqual(quota, { saved: true, checksumValid: true, mode: 'INDEXEDDB_FALLBACK_ACTIVE',
    invoice: '12345', revision: 2 });
  const concurrent = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const one = S.encode({ invoices: [{ id: 'INV-RACE-3', totalCentimes: 300n }] });
    const two = S.encode({ invoices: [{ id: 'INV-RACE-4', totalCentimes: 400n }] });
    await Promise.all([S.setSync(S.APP_KEY, one), S.setSync(S.APP_KEY, two)]);
    const record = await new Promise((resolve, reject) => {
      const req = indexedDB.open(S.DB_NAME);
      req.onsuccess = () => {
        const get = req.result.transaction(S.STORE_NAME, 'readonly').objectStore(S.STORE_NAME).get(S.APP_KEY);
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      };
      req.onerror = () => reject(req.error);
    });
    return { revision: record.revision, latestPayloadWins: record.payload === two,
      localMirrorMatches: localStorage.getItem(S.APP_KEY) === two,
      decodedAmount: S.decode(record.payload).invoices[0].totalCentimes.toString() };
  });
  assert.deepEqual(concurrent, { revision: 4, latestPayloadWins: true, localMirrorMatches: true, decodedAmount: '400' });

  await context.close();
  console.log('ANDROID_WEBVIEW_STORAGE_RESILIENCE ' + JSON.stringify({ first, recovery, quota, concurrent }));
});
