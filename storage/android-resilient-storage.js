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
  const META_KEY = APP_KEY + '__META_V1';
  const VERSION = 1;

  const cache = global[CACHE_KEY] || (global[CACHE_KEY] = Object.create(null));
  let revision = 0;
  let requestedRevision = 0;
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
  function fastChecksum(payload) {
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(payload)) { hash ^= byte; hash = Math.imul(hash, 0x01000193); }
    return 'fnv1a:' + (hash >>> 0).toString(16).padStart(8, '0');
  }
  function sha256Fallback(bytes) {
    const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const bits=bytes.length*8, size=Math.ceil((bytes.length+9)/64)*64, data=new Uint8Array(size);
    data.set(bytes);data[bytes.length]=128;const view=new DataView(data.buffer);
    view.setUint32(size-8,Math.floor(bits/0x100000000));view.setUint32(size-4,bits>>>0);
    const r=(x,n)=>(x>>>n)|(x<<(32-n));
    for(let o=0;o<size;o+=64){
      const w=new Uint32Array(64);
      for(let i=0;i<16;i++)w[i]=view.getUint32(o+i*4);
      for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2],s0=r(x,7)^r(x,18)^(x>>>3),s1=r(y,17)^r(y,19)^(y>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
      let [a,b,c,d,e,f,g,h]=H;
      for(let i=0;i<64;i++){const s1=r(e,6)^r(e,11)^r(e,25),ch=(e&f)^(~e&g),t1=(h+s1+ch+K[i]+w[i])>>>0,s0=r(a,2)^r(a,13)^r(a,22),maj=(a&b)^(a&c)^(b&c),t2=(s0+maj)>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
      H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
    }
    return H.map(x=>x.toString(16).padStart(8,'0')).join('');
  }
  async function checksum(payload) {
    const bytes=new TextEncoder().encode(payload);
    if(global.crypto&&global.crypto.subtle){try{const digest=await global.crypto.subtle.digest('SHA-256',bytes);return 'sha256:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}catch(_){}}
    return 'sha256:'+sha256Fallback(bytes);
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
  function canUseLocalStorage() {
    try {
      const storage = global.localStorage;
      if (!storage) return false;
      const probeKey = META_KEY + '__write_probe__';
      const previous = storage.getItem(probeKey);
      storage.setItem(probeKey, '1');
      if (previous === null) storage.removeItem(probeKey);
      else storage.setItem(probeKey, previous);
      return true;
    } catch (_) {
      return false;
    }
  }

  function setSync(key, value) {
    const text = String(value);
    cache[key] = text;
    const nextRevision = Math.max(revision, requestedRevision) + 1;
    requestedRevision = nextRevision;
    let localPayloadPersisted = false;
    try {
      global.localStorage.setItem(key, text);
      global.localStorage.setItem(META_KEY, JSON.stringify({ revision: nextRevision, checksum: fastChecksum(text), updatedAt: new Date().toISOString() }));
      // Treat LocalStorage as a durable fallback only when both payload and its
      // revision/checksum metadata have been committed synchronously.
      localPayloadPersisted = true;
    }
    catch (error) {
      mode = 'INDEXEDDB_FALLBACK_ACTIVE';
      try { global.localStorage.setItem(MODE_KEY, mode); } catch (_) {}
    }
    if (key === APP_KEY) {
      return persist(text, nextRevision).catch(error => {
        mode = localPayloadPersisted ? 'LOCALSTORAGE_FALLBACK_ACTIVE' : 'MEMORY_ONLY_DEGRADED';
        global.__ANAS_STORAGE_LAST_ERROR__ = String(error && error.message || error);
        const persistenceError = new Error('Durable snapshot persistence failed: ' + global.__ANAS_STORAGE_LAST_ERROR__);
        persistenceError.code = 'ANAS_STORAGE_PERSIST_FAILED';
        persistenceError.durableFallback = localPayloadPersisted;
        persistenceError.storageMode = mode;
        throw persistenceError;
      });
    }
    return Promise.resolve();
  }
  function removeSync(key) {
    delete cache[key];
    try { global.localStorage.removeItem(key); } catch (_) {}
  }
  function persist(payload, targetRevision) {
    const task = writeQueue.then(async () => {
      const nextRevision = Number.isSafeInteger(targetRevision)
        ? targetRevision : Math.max(revision, requestedRevision) + 1;
      requestedRevision = Math.max(requestedRevision, nextRevision);
      const record = { key: APP_KEY, payload, revision: nextRevision,
        checksum: await checksum(payload), updatedAt: new Date().toISOString() };
      await writeIDB(record);
      revision = Math.max(revision, nextRevision);
      cache[APP_KEY] = payload;
      try {
        global.localStorage.setItem(META_KEY, JSON.stringify({ revision, checksum: fastChecksum(payload), updatedAt: record.updatedAt }));
      } catch (_) {}
      return { revision, checksum: record.checksum, mode };
    });
    writeQueue = task.catch(() => {});
    return task;
  }
  async function hydrate(localPayload) {
    // The caller must keep domain writes locked until this promise resolves.
    const local = typeof localPayload === 'string' ? localPayload : getSync(APP_KEY);
    let localValid = false;
    let localRevision = 0;
    if (typeof local === 'string') {
      try {
        decode(local);
        const rawMeta = global.localStorage && global.localStorage.getItem(META_KEY);
        if (rawMeta) {
          const meta = JSON.parse(rawMeta);
          if (!Number.isSafeInteger(meta.revision) || meta.revision < 1 || meta.checksum !== fastChecksum(local)) throw new Error('local snapshot checksum mismatch');
          localRevision = meta.revision;
        }
        localValid = true;
      } catch (_) { localValid = false; }
    }
    let record = null;
    let idbUnavailable = false;
    try { record = await readIDB(); } catch (error) {
      idbUnavailable = true;
      global.__ANAS_STORAGE_LAST_ERROR__ = String(error && error.message || error);
    }
    const idbValid = await validateRecord(record);
    if (idbUnavailable && !canUseLocalStorage()) {
      mode = 'MEMORY_ONLY_DEGRADED';
      throw new Error('No writable durable storage is available: IndexedDB and localStorage are unavailable.');
    }
    let selected = localValid ? local : null;
    revision = Math.max(revision, localRevision, idbValid ? record.revision : 0);
    requestedRevision = Math.max(requestedRevision, revision);
    if (idbValid && (!localValid || record.revision >= localRevision)) {
      selected = record.payload;
      revision = record.revision;
    }
    if (selected !== null) {
      cache[APP_KEY] = selected;
      if (idbUnavailable) {
        mode = 'LOCALSTORAGE_FALLBACK_ACTIVE';
      } else if (!idbValid || (localValid && localRevision > record.revision)) {
        revision = Math.max(0, (localValid ? localRevision : 0) - 1);
        requestedRevision = revision;
        await persist(selected, localValid && localRevision > 0 ? localRevision : undefined);
      }
      try {
        global.localStorage.setItem(APP_KEY, selected);
        global.localStorage.setItem(META_KEY, JSON.stringify({ revision, checksum: fastChecksum(selected), updatedAt: new Date().toISOString() }));
      } catch (_) {
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
    ready, status, encode, decode, checksum, fastChecksum
  });
})(window);
