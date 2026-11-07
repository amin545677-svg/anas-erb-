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
    let durableFallback = false;
    try { await S.setSync(S.APP_KEY, next); } catch (error) {
      indexedDbWriteRejected = true;
      durableFallback = error.durableFallback === true;
    }
    return { hydrated: hydrated.hydrated, recoveredInvoice: hydrated.data.invoices[0].id,
      localWritePreserved: localStorage.getItem(S.APP_KEY) === next,
      mode: S.status().mode, indexedDbWriteRejected, durableFallback };
  });
  assert.deepEqual(result, { hydrated: true, recoveredInvoice: 'LOCAL-ONLY-1',
    localWritePreserved: true, mode: 'LOCALSTORAGE_FALLBACK_ACTIVE',
    indexedDbWriteRejected: true, durableFallback: true });
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
    await S.hydrate(null);
    const finance = {
      invoices: [{ id: 'INV-CREDIT-1', totalCentimes: 8000000n, paidCentimes: 5900000n, debtCentimes: 2100000n }],
      stock: [{ id: 'BOX-1', quantityMicroUnits: 90000000n }],
      cashCentimes: 5900000n
    };
    const payload = S.encode(finance);
    await S.setSync(S.APP_KEY, payload);
    const local = localStorage.getItem(S.APP_KEY);
    const localMeta = JSON.parse(localStorage.getItem(S.APP_KEY + '__META_V1'));
    const localChecksumValid = localMeta.checksum === await S.checksum(local) && localMeta.algorithm === 'SHA-256';
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
    return { localMatches: local === payload, localChecksumValid, localChecksumAlgorithm: localMeta.algorithm,
      checksumValid: record.checksum === await S.checksum(record.payload), revision: record.revision };
  });
  assert.equal(first.localMatches, true);
  assert.equal(first.localChecksumValid, true);
  assert.equal(first.localChecksumAlgorithm, 'SHA-256');
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


test('Chromium fails closed when both IndexedDB and writable LocalStorage are unavailable', async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    Storage.prototype.setItem = function() {
      throw new DOMException('simulated storage denial', 'QuotaExceededError');
    };
  });
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(async () => {
    try {
      await window.ANASResilientStorage.hydrate(null);
      return { rejected: false };
    } catch (error) {
      return { rejected: true, message: error.message,
        mode: window.ANASResilientStorage.status().mode };
    }
  });
  assert.equal(result.rejected, true, 'startup must reject a memory-only storage state');
  assert.match(result.message, /No writable durable storage is available/);
  assert.equal(result.mode, 'MEMORY_ONLY_DEGRADED');
  await context.close();
});


test('runtime storage loss rejects writes when neither synchronous fallback nor IndexedDB commit is available', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const initial = S.encode({ invoices: [{ id: 'RUNTIME-BASELINE', totalCentimes: 10000n }] });
    localStorage.setItem(S.APP_KEY, initial);
    await S.hydrate(initial);
    const originalSetItem = Storage.prototype.setItem;
    const originalTransaction = IDBDatabase.prototype.transaction;
    Storage.prototype.setItem = function() {
      throw new DOMException('simulated runtime storage denial', 'QuotaExceededError');
    };
    IDBDatabase.prototype.transaction = function(storeNames, mode, options) {
      if (mode === 'readwrite') throw new DOMException('simulated IndexedDB write failure', 'UnknownError');
      return originalTransaction.call(this, storeNames, mode, options);
    };
    try {
      const next = S.encode({ invoices: [{ id: 'UNSAVED-MEMORY-ONLY', totalCentimes: 20000n }] });
      try {
        await S.setSync(S.APP_KEY, next);
        return { rejected: false, mode: S.status().mode };
      } catch (error) {
        return {
          rejected: true,
          code: error.code,
          durableFallback: error.durableFallback,
          storageMode: error.storageMode,
          persistedPayloadUnchanged: localStorage.getItem(S.APP_KEY) === initial
        };
      }
    } finally {
      Storage.prototype.setItem = originalSetItem;
      IDBDatabase.prototype.transaction = originalTransaction;
    }
  });
  assert.deepEqual(result, {
    rejected: true,
    code: 'ANAS_STORAGE_PERSIST_FAILED',
    durableFallback: false,
    storageMode: 'MEMORY_ONLY_DEGRADED',
    persistedPayloadUnchanged: true
  });
  await context.close();
});

test('V42 saveDB escalates a total asynchronous durability failure into a fail-closed state', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(shell, /error\.durableFallback === true/);
  assert.match(shell, /anasStartupFatalLoadError = true/);
  assert.match(shell, /فشل التخزين الدائم في IndexedDB وLocalStorage معاً/);
});


test('pre-hydration saveDB empty state cannot overwrite the validated IndexedDB BigInt snapshot', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    await S.hydrate(null);
    const durable = {
      invoices: [{ id: 'INV-PREBOOT-1', totalCentimes: 8000000n, paidCentimes: 5900000n, debtCentimes: 2100000n }],
      stock: [{ id: 'SKU-PREBOOT-1', quantityMicroUnits: 90000000n }],
      cashCentimes: 5900000n
    };
    await S.setSync(S.APP_KEY, S.encode(durable));
  });

  // A real document reload resets the in-memory hydrated flag but preserves IndexedDB.
  await page.reload();
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const staleEmpty = S.encode({ invoices: [], stock: [], cashCentimes: 0n });
    // saveDB() delegates to this adapter write in the V42 persistence path.
    const saveDB = () => S.setSync(S.APP_KEY, staleEmpty);
    const earlyWrite = saveDB();
    const recovered = await S.hydrate(null);
    const queued = await earlyWrite;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(S.DB_NAME);
      request.onsuccess = () => {
        const tx = request.result.transaction(S.STORE_NAME, 'readonly');
        const get = tx.objectStore(S.STORE_NAME).get(S.APP_KEY);
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      };
      request.onerror = () => reject(request.error);
    });
    const data = recovered.data;
    return {
      recoveredFromIndexedDB: recovered.recoveredFromIndexedDB,
      discardedStaleWrite: queued.discardedAsStalePreHydrationWrite === true,
      durablePayloadPreserved: db.payload === S.encode(data),
      checksumValid: db.checksum === await S.checksum(db.payload),
      invoiceCentimes: data.invoices[0].totalCentimes.toString(),
      paidCentimes: data.invoices[0].paidCentimes.toString(),
      debtCentimes: data.invoices[0].debtCentimes.toString(),
      stockMicroUnits: data.stock[0].quantityMicroUnits.toString(),
      cashCentimes: data.cashCentimes.toString(),
      centimeDelta: (data.cashCentimes - 5900000n).toString(),
      microUnitDelta: (data.stock[0].quantityMicroUnits - 90000000n).toString()
    };
  });
  assert.deepEqual(result, {
    recoveredFromIndexedDB: true,
    discardedStaleWrite: true,
    durablePayloadPreserved: true,
    checksumValid: true,
    invoiceCentimes: '8000000',
    paidCentimes: '5900000',
    debtCentimes: '2100000',
    stockMicroUnits: '90000000',
    cashCentimes: '5900000',
    centimeDelta: '0',
    microUnitDelta: '0'
  });
  await context.close();
});


test('torn LocalStorage JSON and IndexedDB bit-rot recover only a checksum-validated snapshot', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    await S.hydrate(null);
    const baseline = S.encode({
      invoices: [{ id: 'CHAOS-BASELINE', totalCentimes: 2100000n }],
      cashCentimes: 5900000n,
      debtCentimes: 2100000n
    });
    await S.setSync(S.APP_KEY, baseline);
  });

  // Simulate power loss while LocalStorage was being written.
  await page.reload();
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const torn = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    localStorage.setItem(S.APP_KEY, '{"revision":5,"invoices":[{"id":"CHAOS-BASELINE"');
    const result = await S.hydrate(null);
    return {
      recovered: result.recoveredFromIndexedDB,
      invoice: result.data.invoices[0].totalCentimes.toString(),
      cash: result.data.cashCentimes.toString(),
      debt: result.data.debtCentimes.toString()
    };
  });
  assert.deepEqual(torn, {
    recovered: true, invoice: '2100000', cash: '5900000', debt: '2100000'
  });

  // Flip one centime in the IndexedDB payload without updating its SHA-256.
  const bitRot = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(S.DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(S.STORE_NAME, 'readwrite');
      const store = tx.objectStore(S.STORE_NAME);
      const get = store.get(S.APP_KEY);
      get.onsuccess = () => {
        const record = get.result;
        record.payload = record.payload.replace('2100000', '2100001');
        store.put(record); // checksum deliberately remains unchanged
      };
      get.onerror = () => reject(get.error);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const restored = await S.hydrate(null);
    const verified = await new Promise((resolve, reject) => {
      const request = indexedDB.open(S.DB_NAME);
      request.onsuccess = () => {
        const get = request.result.transaction(S.STORE_NAME, 'readonly')
          .objectStore(S.STORE_NAME).get(S.APP_KEY);
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      };
      request.onerror = () => reject(request.error);
    });
    return {
      invoice: restored.data.invoices[0].totalCentimes.toString(),
      checksumValid: verified.checksum === await S.checksum(verified.payload),
      payloadRestored: S.decode(verified.payload).invoices[0].totalCentimes === 2100000n
    };
  });
  assert.deepEqual(bitRot, {
    invoice: '2100000', checksumValid: true, payloadRestored: true
  });
  await context.close();
});

test('Pure-JS SHA-256 fallback matches NIST FIPS 180-4 known-answer vectors', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const hashes = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'crypto');
    Object.defineProperty(window, 'crypto', { configurable: true, value: {} });
    try {
      return {
        empty: await S.checksum(''),
        abc: await S.checksum('abc')
      };
    } finally {
      if (descriptor) Object.defineProperty(window, 'crypto', descriptor);
      else delete window.crypto;
    }
  });
  assert.deepEqual(hashes, {
    empty: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    abc: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  });
  await context.close();
});


test('canonical JSON storage rejects exceptional numbers and isolates object references across commit/read boundaries', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/test.html');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    await S.hydrate();
    const source = { z: 3, invoice: { total: 100003n, customer: { id: 'C1', name: 'A' } } };
    await S.setItem(S.APP_KEY, source);
    source.invoice.total = 999999n;
    const first = S.getItem(S.APP_KEY);
    first.invoice.customer.name = 'MUTATED-READ';
    const second = S.getItem(S.APP_KEY);
    let nanRejected = false, infinityRejected = false;
    try { S.canonicalizeJson({ amount: NaN }); } catch (error) { nanRejected = error.code === 'NON_CANONICAL_NUMERIC_VALUE'; }
    try { S.canonicalizeJson({ amount: Infinity }); } catch (error) { infinityRejected = error.code === 'NON_CANONICAL_NUMERIC_VALUE'; }
    const negativeZeroCanonical = S.canonicalizeJson({ amount: -0 }) === '{"amount":0}';
    const a = { z: 1, nested: { y: 2, deep: { b: 3, a: 4 } } };
    const b = { nested: { deep: { a: 4, b: 3 }, y: 2 }, z: 1 };
    return {
      savedValue: second.invoice.total.toString(),
      readIsolation: second.invoice.customer.name,
      deterministic: S.encode(a) === S.encode(b),
      nfcDeterministic: S.encode({ ['é']: 'café' }) === S.encode({ ['e\u0301']: 'cafe\u0301' }),
      nfcKeyCollisionRejected: (() => {
        try { S.encode({ ['é']: 1, ['e\u0301']: 2 }); return false; }
        catch (error) { return error.code === 'UNICODE_NFC_KEY_COLLISION'; }
      })(),
      hashLength: (await S.checksum(S.encode(a))).replace('sha256:', '').length,
      nanRejected, infinityRejected, negativeZeroCanonical
    };
  });
  assert.deepEqual(result, {
    savedValue: '100003',
    readIsolation: 'A',
    deterministic: true,
    nfcDeterministic: true,
    nfcKeyCollisionRejected: true,
    hashLength: 64,
    nanRejected: true,
    infinityRejected: true,
    negativeZeroCanonical: true
  });
  await context.close();
});


test('V2 framed serialization round-trips BigInt without confusing user objects with legacy markers', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/test.html');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(() => {
    const S = window.ANASResilientStorage;
    const markerObject = { __anas_bigint_v1__: '12345678901234567890' };
    const nestedMarkerObject = { nested: { __anas_bigint_v1__: '42' } };
    const dangerousKeys = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    const source = {
      amount: 900719925474099312345n,
      markerObject,
      nestedMarkerObject,
      dangerousKeys,
      array: [1n, null, 'cafe\u0301', { amount: 2n }]
    };
    const payload = S.encode(source);
    const decoded = S.decode(payload);
    let legacyMarkerRejected = false;
    try { S.decode('{"amount":{"__anas_bigint_v1__":"9007199254740993","extra":true}}'); }
    catch (error) { legacyMarkerRejected = error.code === 'INVALID_BIGINT_ENVELOPE'; }
    return {
      framed: payload.startsWith('ANASERP2:'),
      amount: decoded.amount.toString(),
      markerRemainsObject: typeof decoded.markerObject === 'object' &&
        decoded.markerObject.__anas_bigint_v1__ === markerObject.__anas_bigint_v1__,
      nestedMarkerRemainsObject: decoded.nestedMarkerObject.nested.__anas_bigint_v1__ === '42',
      dangerousOwnKey: Object.prototype.hasOwnProperty.call(decoded.dangerousKeys, '__proto__'),
      noPrototypePollution: ({}).polluted === undefined &&
        decoded.dangerousKeys.__proto__.polluted === true,
      arrayBigInt: decoded.array[0].toString(),
      nestedBigInt: decoded.array[3].amount.toString(),
      unicodeNfc: decoded.array[2] === 'café',
      legacyMarkerRejected,
      stableRoundTrip: S.encode(decoded) === payload
    };
  });
  assert.deepEqual(result, {
    framed: true,
    amount: '900719925474099312345',
    markerRemainsObject: true,
    nestedMarkerRemainsObject: true,
    dangerousOwnKey: true,
    noPrototypePollution: true,
    arrayBigInt: '1',
    nestedBigInt: '2',
    unicodeNfc: true,
    legacyMarkerRejected: true,
    stableRoundTrip: true
  });
  await context.close();
});

test('V2 decoder rejects malformed tagged nodes and non-canonical object key order', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/test.html');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(() => {
    const decode = window.ANASResilientStorage.decode;
    const malformed = [
      'ANASERP2:["i","01"]',
      'ANASERP2:["i","-0"]',
      'ANASERP2:["n",-0]',
      'ANASERP2:["n",1.0]',
      'ANASERP2: ["n",1]',
      'ANASERP2:["o",[["z",["n",1]],["a",["n",2]]]]',
      'ANASERP2:["unknown",[]]'
    ];
    return malformed.map(payload => {
      try { decode(payload); return false; }
      catch (error) { return error instanceof TypeError || error instanceof SyntaxError; }
    });
  });
  assert.deepEqual(result, [true, true, true, true, true, true, true]);
  await context.close();
});


test('concurrent saves serialize checksum, revision allocation, LocalStorage and IndexedDB in invocation order', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    await S.hydrate(null);
    const subtle = window.crypto.subtle;
    const originalDescriptor = Object.getOwnPropertyDescriptor(subtle, 'digest');
    const originalDigest = subtle.digest.bind(subtle);
    let delayed = false;
    Object.defineProperty(subtle, 'digest', {
      configurable: true,
      value: async (algorithm, data) => {
        const input = new TextDecoder().decode(data);
        if (!delayed && input.includes('INV-RACE-SLOW')) {
          delayed = true;
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        return originalDigest(algorithm, data);
      }
    });
    try {
      const older = S.encode({ invoices: [{ id: 'INV-RACE-SLOW', totalCentimes: 300n }] });
      const newer = S.encode({ invoices: [{ id: 'INV-RACE-NEWER', totalCentimes: 400n }] });
      const olderSave = S.setSync(S.APP_KEY, older);
      const newerSave = S.setSync(S.APP_KEY, newer);
      const [olderResult, newerResult] = await Promise.all([olderSave, newerSave]);
      const record = await new Promise((resolve, reject) => {
        const request = indexedDB.open(S.DB_NAME);
        request.onsuccess = () => {
          const get = request.result.transaction(S.STORE_NAME, 'readonly')
            .objectStore(S.STORE_NAME).get(S.APP_KEY);
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        };
        request.onerror = () => reject(request.error);
      });
      const meta = JSON.parse(localStorage.getItem(S.APP_KEY + '__META_V1'));
      return {
        olderRevision: olderResult.revision,
        newerRevision: newerResult.revision,
        persistedRevision: record.revision,
        latestPayloadWins: record.payload === newer,
        localMirrorMatches: localStorage.getItem(S.APP_KEY) === newer,
        metadataMatches: meta.revision === record.revision && meta.checksum === record.checksum,
        decodedAmount: S.decode(record.payload).invoices[0].totalCentimes.toString()
      };
    } finally {
      if (originalDescriptor) Object.defineProperty(subtle, 'digest', originalDescriptor);
      else delete subtle.digest;
    }
  });
  assert.deepEqual(result, {
    olderRevision: 1,
    newerRevision: 2,
    persistedRevision: 2,
    latestPayloadWins: true,
    localMirrorMatches: true,
    metadataMatches: true,
    decodedAmount: '400'
  });
  await context.close();
});


test('mid-write LocalStorage crash injection recovers the last committed IndexedDB snapshot exactly', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const seeded = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    await S.hydrate(null);
    const stable = S.encode({
      invoices: [{ id: 'CRASH-LAST-COMMITTED', totalCentimes: 2100000n }],
      cashCentimes: 5900000n,
      debtCentimes: 2100000n
    });
    await S.setSync(S.APP_KEY, stable);
    return stable;
  });
  assert.ok(seeded.startsWith('ANASERP2:'));

  // Inject a torn synchronous write, then terminate this document before any
  // subsequent application recovery code can run.
  await page.evaluate(() => {
    const S = window.ANASResilientStorage;
    const key = S.APP_KEY;
    const originalSetItem = Storage.prototype.setItem;
    const candidate = S.encode({
      invoices: [{ id: 'CRASH-UNCOMMITTED', totalCentimes: 2100001n }],
      cashCentimes: 5900001n,
      debtCentimes: 2100001n
    });
    const torn = candidate.slice(0, Math.max(12, Math.floor(candidate.length / 2)));
    Storage.prototype.setItem = function(name, value) {
      if (name === key) {
        originalSetItem.call(this, name, torn);
        throw new DOMException('simulated power loss during LocalStorage write', 'AbortError');
      }
      return originalSetItem.call(this, name, value);
    };
    try { localStorage.setItem(key, candidate); }
    catch (error) {
      if (error.name !== 'AbortError') throw error;
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  });
  await page.reload();
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const recovered = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const result = await S.hydrate(null);
    return {
      recoveredFromIndexedDB: result.recoveredFromIndexedDB,
      invoiceId: result.data.invoices[0].id,
      invoiceCentimes: result.data.invoices[0].totalCentimes.toString(),
      cashCentimes: result.data.cashCentimes.toString(),
      debtCentimes: result.data.debtCentimes.toString(),
      centimeDelta: (result.data.cashCentimes - 5900000n).toString(),
      durableMirrorMatches: localStorage.getItem(S.APP_KEY) === S.encode(result.data)
    };
  });
  assert.deepEqual(recovered, {
    recoveredFromIndexedDB: true,
    invoiceId: 'CRASH-LAST-COMMITTED',
    invoiceCentimes: '2100000',
    cashCentimes: '5900000',
    debtCentimes: '2100000',
    centimeDelta: '0',
    durableMirrorMatches: true
  });
  await context.close();
});


test('storage rejects unpaired UTF-16 surrogate values and keys', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(() => {
    const S = window.ANASResilientStorage;
    const high = String.fromCharCode(0xD800);
    const low = String.fromCharCode(0xDC00);
    const rejects = fn => {
      try { fn(); return false; }
      catch (error) { return error.code === 'UNPAIRED_UTF16_SURROGATE'; }
    };
    return {
      value: rejects(() => S.encode({ value: high })),
      key: rejects(() => S.encode({ [low]: 1 }))
    };
  });
  assert.deepEqual(result, { value: true, key: true });
  await context.close();
});


test('JCS NFC canonicalization is stable for Arabic NFC/NFD and reversed object key order', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const malformedUtf16Rejected = (() => {
      try { S.assertWellFormedUtf16(String.fromCharCode(0xD800)); return false; }
      catch (error) { return error.code === 'MALFORMED_UTF16_SURROGATE_SEQUENCE'; }
    })();
    const nfc = 'أحمد';
    const nfd = nfc.normalize('NFD');
    const left = { زبون: nfc, فاتورة: 13n, اسم: 'رودينا' };
    const right = { اسم: 'رودينا'.normalize('NFD'), فاتورة: 13n, زبون: nfd };
    const a = await S.checksum(S.canonicalizeJson(left));
    const b = await S.checksum(S.canonicalizeJson(right));
    return { equal: a === b, length: a.length, malformedUtf16Rejected };
  });
  assert.deepEqual(result, { equal: true, length: 71, malformedUtf16Rejected: true });
  await context.close();
});

test('strict legacy BigInt envelopes reject extra keys and non-decimal strings without coercion', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(() => {
    const S = window.ANASResilientStorage;
    const valid = { __anas_bigint_v1__: '-1200' };
    const extra = { __anas_bigint_v1__: '1200', other: true };
    const invalid = { __anas_bigint_v1__: '12x' };
    return {
      valid: S.isStrictBigIntEnvelope(valid),
      extra: S.isStrictBigIntEnvelope(extra),
      invalid: S.isStrictBigIntEnvelope(invalid),
      malformedDecodeRejected: (() => { try { S.decode(JSON.stringify(extra)); return false; } catch (e) { return e.code === 'INVALID_BIGINT_ENVELOPE'; } })()
    };
  });
  assert.deepEqual(result, { valid: true, extra: false, invalid: false, malformedDecodeRejected: true });
  await context.close();
});

test('committed snapshot is deeply frozen and isolated from decoded working copies', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    await S.hydrate(null);
    await S.setItem(S.APP_KEY, { accounts: [{ balanceCentimes: 250n }] });
    const committed = S.getCommittedSnapshot();
    const working = S.getItem(S.APP_KEY);
    try { working.accounts[0].balanceCentimes = 251n; } catch (_) {}
    return {
      frozenRoot: Object.isFrozen(committed),
      frozenNested: Object.isFrozen(committed.accounts[0]),
      committedBalance: committed.accounts[0].balanceCentimes.toString(),
      workingBalance: working.accounts[0].balanceCentimes.toString()
    };
  });
  assert.deepEqual(result, { frozenRoot: true, frozenNested: true, committedBalance: '250', workingBalance: '251' });
  await context.close();
});

test('concurrent hydrate callers share one state transition and settle READY', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const result = await page.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const first = S.hydrate(null);
    const during = S.status().hydrationState;
    const second = S.hydrate(null);
    const [a, b] = await Promise.all([first, second]);
    return {
      during,
      samePromise: first === second,
      ready: S.ready(),
      after: S.status().hydrationState,
      bothHydrated: a.hydrated && b.hydrated
    };
  });
  assert.deepEqual(result, {
    during: 'HYDRATING',
    samePromise: true,
    ready: true,
    after: 'READY',
    bothHydrated: true
  });
  await context.close();
});


test('cross-tab IndexedDB compare-and-set rejects a stale full-snapshot write and recovers by rehydrating', async () => {
  const context = await browser.newContext();
  const firstPage = await context.newPage();
  const secondPage = await context.newPage();
  await firstPage.goto(origin + '/');
  await secondPage.goto(origin + '/');
  await firstPage.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  await secondPage.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });

  await firstPage.evaluate(async () => {
    const S = window.ANASResilientStorage;
    await S.hydrate(null);
    await S.setItem(S.APP_KEY, { version: 'base' });
  });
  await secondPage.evaluate(async () => {
    const S = window.ANASResilientStorage;
    await S.hydrate(null);
  });

  const attempts = await Promise.all([
    firstPage.evaluate(async () => {
      try {
        const result = await window.ANASResilientStorage.setItem(
          window.ANASResilientStorage.APP_KEY, { version: 'tab-a' }
        );
        return { status: 'fulfilled', revision: result.revision };
      } catch (error) {
        return { status: 'rejected', code: error.code };
      }
    }),
    secondPage.evaluate(async () => {
      try {
        const result = await window.ANASResilientStorage.setItem(
          window.ANASResilientStorage.APP_KEY, { version: 'tab-b' }
        );
        return { status: 'fulfilled', revision: result.revision };
      } catch (error) {
        return { status: 'rejected', code: error.code };
      }
    })
  ]);

  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(item => item.status === 'rejected').length, 1);
  assert.equal(attempts.find(item => item.status === 'rejected').code, 'ANAS_STORAGE_REVISION_CONFLICT');

  const recoveredPage = await context.newPage();
  await recoveredPage.goto(origin + '/');
  await recoveredPage.addScriptTag({ url: origin + '/storage/android-resilient-storage.js' });
  const recovered = await recoveredPage.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const result = await S.hydrate(null);
    return {
      version: result.data.version,
      revision: result.revision,
      ready: S.ready()
    };
  });
  assert.ok(['tab-a', 'tab-b'].includes(recovered.version));
  assert.equal(recovered.revision, 2);
  assert.equal(recovered.ready, true);

  // The losing tab remains write-locked until it explicitly reloads the winner.
  const loser = attempts[0].status === 'rejected' ? secondPage : firstPage;
  const blocked = await loser.evaluate(async () => {
    try {
      await window.ANASResilientStorage.setItem(
        window.ANASResilientStorage.APP_KEY, { version: 'stale-retry' }
      );
      return { rejected: false };
    } catch (error) {
      return { rejected: true, code: error.code };
    }
  });
  assert.deepEqual(blocked, { rejected: true, code: 'ANAS_STORAGE_REVISION_CONFLICT' });

  await loser.evaluate(async () => {
    await window.ANASResilientStorage.hydrate(null);
  });
  const afterRecovery = await loser.evaluate(async () => {
    const S = window.ANASResilientStorage;
    const result = await S.setItem(S.APP_KEY, { version: 'after-rehydrate' });
    return { revision: result.revision, ready: S.ready() };
  });
  assert.deepEqual(afterRecovery, { revision: 3, ready: true });
  await context.close();
});
