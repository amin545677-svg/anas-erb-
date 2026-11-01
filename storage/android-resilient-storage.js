/* ANAS ERP Android-resilient storage adapter.
 * IndexedDB is durable authority; localStorage and the in-memory cache are synchronous mirrors.
 * Consumers must await hydrate() before allowing domain writes.
 */
(function installANASResilientStorage(global) {
  'use strict';
  const DB_NAME = 'anas_erp_v42_resilient_db';
  const STORE_NAME = 'snapshots';
  const APP_KEY = 'ANAS_THE_ENTERPRISE_V11_OFFLINE';
  const CACHE_KEY = '__ANAS_RESILIENT_MEM_STORE__';
  const MODE_KEY = 'ANAS_STORAGE_MODE';
  const VERSION = 1;

  const cache = global[CACHE_KEY] || (global[CACHE_KEY] = Object.create(null));
  let revision = 0;
  let hydrated = false;
  let dbPromise = null;
  let writeQueue = Promise.resolve();
  let mode = 'DUAL';

  function encode(value) {
    return JSON.stringify(value, (_, v) => typeof v === 'bigint'
      ? { __anas_bigint_v1__: v.toString() } : v);
  }
  function decode(value) {
    return JSON.parse(value, (_, v) => v && typeof v === 'object' &&
      Object.keys(v).length === 1 && typeof v.__anas_bigint_v1__ === 'string'
      ? BigInt(v.__anas_bigint_v1__) : v);
  }
  async function checksum(payload) {
    const bytes = new TextEncoder().encode(payload);
    if (global.crypto && global.crypto.subtle) {
      const digest = await global.crypto.subtle.digest('SHA-256', bytes);
      return 'sha256:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }
    let hash = 0x811c9dc5;
    for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193); }
    return 'fnv1a:' + (hash >>> 0).toString(16).padStart(8, '0');
  }
  function openDB() {
    if (!global.indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
    });
    return dbPromise;
  }
  async function readIDB() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(APP_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
    });
  }
  async function writeIDB(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }
  async function validateRecord(record) {
    if (!record || record.key !== APP_KEY || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
        typeof record.payload !== 'string' || typeof record.checksum !== 'string') return false;
    if (await checksum(record.payload) !== record.checksum) return false;
    try { decode(record.payload); return true; } catch (_) { return false; }
  }
  function getSync(key) {
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    try {
      const value = global.localStorage && global.localStorage.getItem(key);
      if (value !== null && value !== undefined) cache[key] = value;
      return value;
    } catch (_) { return null; }
  }
  function setSync(key, value) {
    const text = String(value);
    cache[key] = text;
    try { global.localStorage.setItem(key, text); }
    catch (error) {
      mode = 'INDEXEDDB_FALLBACK_ACTIVE';
      try { global.localStorage.setItem(MODE_KEY, mode); } catch (_) {}
    }
    if (key === APP_KEY) {
      return persist(text).catch(error => {
        mode = 'MEMORY_ONLY_DEGRADED';
        global.__ANAS_STORAGE_LAST_ERROR__ = String(error && error.message || error);
        throw error;
      });
    }
    return Promise.resolve();
  }
  function removeSync(key) {
    delete cache[key];
    try { global.localStorage.removeItem(key); } catch (_) {}
  }
  async function persist(payload) {
    const nextRevision = revision + 1;
    const record = { key: APP_KEY, payload, revision: nextRevision,
      checksum: await checksum(payload), updatedAt: new Date().toISOString() };
    await writeIDB(record);
    revision = nextRevision;
    cache[APP_KEY] = payload;
    return { revision, checksum: record.checksum, mode };
  }
  async function hydrate(localPayload) {
    // The caller must keep domain writes locked until this promise resolves.
    const local = typeof localPayload === 'string' ? localPayload : getSync(APP_KEY);
    let localValid = false;
    if (typeof local === 'string') { try { decode(local); localValid = true; } catch (_) {} }
    let record = null;
    try { record = await readIDB(); } catch (error) {
      global.__ANAS_STORAGE_LAST_ERROR__ = String(error && error.message || error);
    }
    const idbValid = await validateRecord(record);
    let selected = localValid ? local : null;
    if (idbValid && (!localValid || record.revision >= revision)) {
      selected = record.payload;
      revision = record.revision;
    }
    if (selected !== null) {
      cache[APP_KEY] = selected;
      if (!idbValid) await persist(selected);
      try { global.localStorage.setItem(APP_KEY, selected); } catch (_) {
        mode = 'INDEXEDDB_FALLBACK_ACTIVE';
        try { global.localStorage.setItem(MODE_KEY, mode); } catch (_) {}
      }
    }
    hydrated = true;
    return { hydrated, payload: selected, data: selected === null ? null : decode(selected),
      revision, mode, recoveredFromIndexedDB: selected !== null && idbValid && selected === record.payload };
  }
  function ready() { return hydrated; }
  function status() { return { hydrated, revision, mode, database: DB_NAME, store: STORE_NAME }; }

  global.ANASResilientStorage = Object.freeze({
    APP_KEY, DB_NAME, STORE_NAME, getSync, setSync, removeSync, hydrate, persist,
    ready, status, encode, decode, checksum
  });
})(window);
