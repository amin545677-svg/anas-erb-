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
  let hydrationState = 'UNHYDRATED';
  let hydrationPromise = null;
  const pendingPreHydrationWrites = [];
  let dbPromise = null;
  let writeQueue = Promise.resolve();
  let mode = 'DUAL';

  function assertWellFormedUnicode(text) {
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit >= 0xD800 && unit <= 0xDBFF) {
        const next = text.charCodeAt(i + 1);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) {
          const error = new TypeError('UNPAIRED_UTF16_SURROGATE');
          error.code = 'UNPAIRED_UTF16_SURROGATE';
          throw error;
        }
        i++;
      } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
        const error = new TypeError('UNPAIRED_UTF16_SURROGATE');
        error.code = 'UNPAIRED_UTF16_SURROGATE';
        throw error;
      }
    }
    return text;
  }

  const BIGINT_ENVELOPE_KEY = '__anas_bigint_v1__';
  const CANONICAL_DIGITS_RE = /^-?\d+$/;
  let committedSnapshot = null;
  function assertWellFormedUtf16(str) {
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = str.charCodeAt(i + 1);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) throw Object.assign(new Error('MALFORMED_UTF16_SURROGATE_SEQUENCE'), { code: 'MALFORMED_UTF16_SURROGATE_SEQUENCE' });
        i++;
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        throw Object.assign(new Error('MALFORMED_UTF16_SURROGATE_SEQUENCE'), { code: 'MALFORMED_UTF16_SURROGATE_SEQUENCE' });
      }
    }
    return str;
  }
  function isStrictBigIntEnvelope(value) {
    if (value === null || typeof value !== 'object' ||
        Object.prototype.toString.call(value) !== '[object Object]') return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== BIGINT_ENVELOPE_KEY) return false;
    const d = Object.getOwnPropertyDescriptor(value, BIGINT_ENVELOPE_KEY);
    return !!d && Object.prototype.hasOwnProperty.call(d, 'value') &&
      typeof d.value === 'string' && CANONICAL_DIGITS_RE.test(d.value);
  }
  function canonicalizeJson(value, seen = new WeakSet()) {
    if (value === null) return 'null';
    const type = typeof value;
    if (type === 'boolean') return value ? 'true' : 'false';
    if (type === 'number') {
      if (!Number.isFinite(value)) throw Object.assign(new Error('NON_CANONICAL_NUMERIC_VALUE'), { code: 'NON_CANONICAL_NUMERIC_VALUE' });
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    if (type === 'bigint') return '{"' + BIGINT_ENVELOPE_KEY + '":' + JSON.stringify(value.toString(10)) + '}';
    if (type === 'string') return JSON.stringify(assertWellFormedUtf16(value).normalize('NFC'));
    if (type !== 'object') throw new TypeError('UNSUPPORTED_CANONICAL_TYPE_' + type);
    if (seen.has(value)) throw new TypeError('NON_CANONICAL_CYCLE');
    if (value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set) throw new TypeError('NON_SERIALIZABLE_LEDGER_TYPE');
    if (isStrictBigIntEnvelope(value)) return '{"' + BIGINT_ENVELOPE_KEY + '":' + JSON.stringify(value[BIGINT_ENVELOPE_KEY]) + '}';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items = [];
        for (let i = 0; i < value.length; i++) items.push(!Object.prototype.hasOwnProperty.call(value, i) || value[i] === undefined ? 'null' : canonicalizeJson(value[i], seen));
        return '[' + items.join(',') + ']';
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('NON_CANONICAL_OBJECT_PROTOTYPE');
      if (Object.getOwnPropertySymbols(value).length) throw new TypeError('NON_CANONICAL_SYMBOL_KEY');
      const pairs = [];
      for (const origKey of Object.keys(value)) {
        assertWellFormedUtf16(origKey);
        const d = Object.getOwnPropertyDescriptor(value, origKey);
        if (!d || !Object.prototype.hasOwnProperty.call(d, 'value')) throw new TypeError('NON_CANONICAL_ACCESSOR');
        if (d.value !== undefined) pairs.push({ normKey: origKey.normalize('NFC'), value: d.value });
      }
      pairs.sort((a,b) => a.normKey < b.normKey ? -1 : a.normKey > b.normKey ? 1 : 0);
      const parts = [];
      for (let i=0;i<pairs.length;i++) {
        if (i && pairs[i].normKey === pairs[i-1].normKey) throw Object.assign(new Error('DUPLICATE_NORMALIZED_UNICODE_KEY_COLLISION'), { code: 'DUPLICATE_NORMALIZED_UNICODE_KEY_COLLISION' });
        parts.push(JSON.stringify(pairs[i].normKey)+':'+canonicalizeJson(pairs[i].value,seen));
      }
      return '{'+parts.join(',')+'}';
    } finally { seen.delete(value); }
  }
  function cloneAndDeepFreezeState(value, seen = new WeakMap()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const copy=[]; seen.set(value,copy);
      for(let i=0;i<value.length;i++) copy[i]=cloneAndDeepFreezeState(value[i],seen);
      return Object.freeze(copy);
    }
    const proto=Object.getPrototypeOf(value);
    if(proto!==Object.prototype && proto!==null) throw new TypeError('NON_SERIALIZABLE_LEDGER_TYPE');
    const copy=Object.create(null); seen.set(value,copy);
    for(const key of Object.keys(value)) {
      const norm=assertWellFormedUtf16(key).normalize('NFC');
      if(Object.prototype.hasOwnProperty.call(copy,norm)) throw new TypeError('DUPLICATE_NORMALIZED_UNICODE_KEY_COLLISION');
      const d=Object.getOwnPropertyDescriptor(value,key);
      if(!d || !Object.prototype.hasOwnProperty.call(d,'value')) throw new TypeError('NON_CANONICAL_ACCESSOR');
      Object.defineProperty(copy,norm,{value:cloneAndDeepFreezeState(d.value,seen),enumerable:true,writable:false,configurable:false});
    }
    return Object.freeze(copy);
  }
  // V2 is framed outside JSON so no legacy JSON object can impersonate the
  // format marker. Every user value is represented by an explicit tagged node.
  const V2_PREFIX = 'ANASERP2:';
  function encodeNode(value, seen = new WeakSet()) {
    if (value === null) return ['0'];
    if (typeof value === 'string') return ['s', assertWellFormedUnicode(value).normalize('NFC')];
    if (typeof value === 'boolean') return ['b', value];
    if (typeof value === 'bigint') return ['i', value.toString()];
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        const error = new TypeError('NON_CANONICAL_NUMERIC_VALUE');
        error.code = 'NON_CANONICAL_NUMERIC_VALUE';
        throw error;
      }
      return ['n', value];
    }
    if (typeof value !== 'object') throw new TypeError('NON_CANONICAL_JSON_TYPE');
    if (seen.has(value)) throw new TypeError('NON_CANONICAL_CYCLE');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items = [];
        for (let i = 0; i < value.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(value, i)) throw new TypeError('NON_CANONICAL_ARRAY_HOLE');
          items.push(encodeNode(value[i], seen));
        }
        return ['a', items];
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('NON_CANONICAL_OBJECT_PROTOTYPE');
      if (Object.getOwnPropertySymbols(value).length) throw new TypeError('NON_CANONICAL_SYMBOL_KEY');
      const entries = Object.keys(value).map(originalKey => ({
        originalKey: assertWellFormedUnicode(originalKey), key: assertWellFormedUnicode(originalKey).normalize('NFC')
      }));
      const keys = new Set();
      for (const entry of entries) {
        if (keys.has(entry.key)) {
          const error = new TypeError('UNICODE_NFC_KEY_COLLISION');
          error.code = 'UNICODE_NFC_KEY_COLLISION';
          throw error;
        }
        keys.add(entry.key);
      }
      entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      return ['o', entries.map(({ key, originalKey }) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, originalKey);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw new TypeError('NON_CANONICAL_ACCESSOR');
        }
        return [key, encodeNode(descriptor.value, seen)];
      })];
    } finally { seen.delete(value); }
  }
  function decodeNode(node) {
    if (!Array.isArray(node) || typeof node[0] !== 'string') throw new TypeError('INVALID_V2_NODE');
    const tag = node[0];
    if (tag === '0' && node.length === 1) return null;
    if (tag === 's' && node.length === 2 && typeof node[1] === 'string' && node[1] === node[1].normalize('NFC')) return node[1];
    if (tag === 'b' && node.length === 2 && typeof node[1] === 'boolean') return node[1];
    if (tag === 'n' && node.length === 2 && typeof node[1] === 'number' && Number.isFinite(node[1]) && !Object.is(node[1], -0)) return node[1];
    if (tag === 'i' && node.length === 2 && typeof node[1] === 'string' && /^-?(0|[1-9][0-9]*)$/.test(node[1])) return BigInt(node[1]);
    if (tag === 'a' && node.length === 2 && Array.isArray(node[1])) return node[1].map(decodeNode);
    if (tag === 'o' && node.length === 2 && Array.isArray(node[1])) {
      const result = {};
      let previousKey = null;
      for (const entry of node[1]) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
            entry[0] !== entry[0].normalize('NFC') ||
            (previousKey !== null && entry[0] <= previousKey)) throw new TypeError('INVALID_V2_OBJECT_ENTRY');
        previousKey = entry[0];
        Object.defineProperty(result, entry[0], {
          value: decodeNode(entry[1]), enumerable: true, configurable: true, writable: true
        });
      }
      return result;
    }
    throw new TypeError('INVALID_V2_NODE');
  }
  function encode(value) { return V2_PREFIX + JSON.stringify(encodeNode(value)); }
  function decode(value) {
    if (typeof value !== 'string') throw new TypeError('STORAGE_PAYLOAD_MUST_BE_STRING');
    if (value.startsWith(V2_PREFIX)) {
      const encodedNode = value.slice(V2_PREFIX.length);
      const decoded = decodeNode(JSON.parse(encodedNode));
      // Enforce a single byte representation for every V2 value. This rejects
      // alternate JSON spellings (whitespace, escaped NFC text, 1.0, -0n, etc.)
      // instead of silently decoding them into a different canonical payload.
      if (JSON.stringify(encodeNode(decoded)) !== encodedNode) {
        const error = new TypeError('NON_CANONICAL_V2_PAYLOAD');
        error.code = 'NON_CANONICAL_V2_PAYLOAD';
        throw error;
      }
      return decoded;
    }
    // V1 payloads are ambiguous: an ordinary user object can exactly mimic
    // the historical BigInt marker. Reject that exact legacy shape instead of
    // coercing it to BigInt. New BigInt writes use ANASERP2 framed nodes above.
    const legacy = JSON.parse(value);
    const decodeLegacyBigInts = node => {
      if (!node || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(decodeLegacyBigInts);
      const keys = Object.keys(node);
      if (keys.includes(BIGINT_ENVELOPE_KEY)) {
        if (!isStrictBigIntEnvelope(node)) {
          const error = new TypeError('INVALID_BIGINT_ENVELOPE');
          error.code = 'INVALID_BIGINT_ENVELOPE';
          throw error;
        }
        return BigInt(node[BIGINT_ENVELOPE_KEY]);
      }
      const result = {};
      for (const key of keys) {
        Object.defineProperty(result, key, {
          value: decodeLegacyBigInts(node[key]), enumerable: true, configurable: true, writable: true
        });
      }
      return result;
    };
    return decodeLegacyBigInts(legacy);
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
    // Before hydration, APP_KEY writes are held outside every persistence layer.
    // hydrate() decides whether a durable snapshot exists before these writes can run.
    if (key === APP_KEY && hydrationState !== 'READY') {
      return new Promise((resolve, reject) => {
        pendingPreHydrationWrites.push({ text, resolve, reject });
      });
    }
    if (key !== APP_KEY) {
      cache[key] = text;
      try { global.localStorage.setItem(key, text); } catch (_) {}
      return Promise.resolve();
    }
    // The complete commit (revision allocation, checksum, both durable stores,
    // and cache publication) is serialized by persist(). Do not do async work
    // before entering that queue: doing so allows concurrent saves to reorder.
    return persist(text);
  }
  function removeSync(key) {
    delete cache[key];
    try { global.localStorage.removeItem(key); } catch (_) {}
  }
  function persist(payload, targetRevision) {
    const task = writeQueue.then(async () => {
      // Allocate revisions only after this operation owns the queue. An explicit
      // recovery revision may advance the clock, but can never move it backwards.
      const nextRevision = Number.isSafeInteger(targetRevision)
        ? Math.max(revision, requestedRevision, targetRevision)
        : Math.max(revision, requestedRevision) + 1;
      requestedRevision = nextRevision;
      const digest = await checksum(payload);
      let localPayloadPersisted = false;
      let previousPayload = null;
      let previousMeta = null;
      try {
        previousPayload = global.localStorage.getItem(APP_KEY);
        previousMeta = global.localStorage.getItem(META_KEY);
      } catch (_) {}
      try {
        global.localStorage.setItem(APP_KEY, payload);
        global.localStorage.setItem(META_KEY, JSON.stringify({
          revision: nextRevision, checksum: digest, algorithm: 'SHA-256',
          updatedAt: new Date().toISOString()
        }));
        localPayloadPersisted = true;
      } catch (_) {
        // A partial mirror is not a durable fallback. Restore the previous
        // payload/metadata pair where possible before relying on IndexedDB.
        try {
          if (previousPayload === null) global.localStorage.removeItem(APP_KEY);
          else global.localStorage.setItem(APP_KEY, previousPayload);
          if (previousMeta === null) global.localStorage.removeItem(META_KEY);
          else global.localStorage.setItem(META_KEY, previousMeta);
        } catch (_) {}
        mode = 'INDEXEDDB_FALLBACK_ACTIVE';
        try { global.localStorage.setItem(MODE_KEY, mode); } catch (_) {}
      }

      const record = {
        key: APP_KEY, payload, revision: nextRevision,
        checksum: digest, updatedAt: new Date().toISOString()
      };
      try {
        await writeIDB(record);
      } catch (error) {
        mode = localPayloadPersisted ? 'LOCALSTORAGE_FALLBACK_ACTIVE' : 'MEMORY_ONLY_DEGRADED';
        if (localPayloadPersisted) cache[APP_KEY] = payload;
        global.__ANAS_STORAGE_LAST_ERROR__ = String(error && error.message || error);
        const persistenceError = new Error('Durable snapshot persistence failed: ' + global.__ANAS_STORAGE_LAST_ERROR__);
        persistenceError.code = 'ANAS_STORAGE_PERSIST_FAILED';
        persistenceError.durableFallback = localPayloadPersisted;
        persistenceError.storageMode = mode;
        throw persistenceError;
      }

      revision = Math.max(revision, nextRevision);
      cache[APP_KEY] = payload;
      committedSnapshot = cloneAndDeepFreezeState(decode(payload));
      try {
        global.localStorage.setItem(META_KEY, JSON.stringify({
          revision, checksum: digest, algorithm: 'SHA-256',
          updatedAt: record.updatedAt
        }));
      } catch (_) {}
      return { revision, checksum: digest, mode };
    });
    writeQueue = task.catch(() => {});
    return task;
  }
  async function performHydrate(localPayload) {
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
          const localDigest = await checksum(local);
          if (!Number.isSafeInteger(meta.revision) || meta.revision < 1 ||
              meta.checksum !== localDigest) throw new Error('local snapshot checksum mismatch');
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
        global.localStorage.setItem(META_KEY, JSON.stringify({ revision, checksum: await checksum(selected), algorithm: 'SHA-256', updatedAt: new Date().toISOString() }));
      } catch (_) {
        mode = 'INDEXEDDB_FALLBACK_ACTIVE';
        try { global.localStorage.setItem(MODE_KEY, mode); } catch (_) {}
      }
    }
    hydrated = true;
    // Drain until the queue is empty. setSync remains closed to callers until
    // the outer hydration promise publishes READY; internal replay writes enter
    // persist() directly so they cannot deadlock behind the hydration gate.
    while (pendingPreHydrationWrites.length) {
      const pendingWrites = pendingPreHydrationWrites.splice(0);
      if (selected !== null) {
        // A pre-boot snapshot (often an empty default object) is stale by definition
        // when a validated durable snapshot already exists. Never replay it over IDB.
        for (const pending of pendingWrites) {
          pending.resolve({ revision, checksum: await checksum(selected), mode, discardedAsStalePreHydrationWrite: true });
        }
      } else {
        // No durable state existed: commit queued writes serially before READY.
        for (const pending of pendingWrites) {
          try { pending.resolve(await persist(pending.text)); }
          catch (error) { pending.reject(error); }
        }
      }
    }
    committedSnapshot = selected === null ? null : cloneAndDeepFreezeState(decode(selected));
    return { hydrated, payload: selected, data: committedSnapshot,
      revision, mode, recoveredFromIndexedDB: selected !== null && idbValid && selected === record.payload };
  }
  function hydrate(localPayload) {
    // Concurrent callers join the in-flight transaction. A later explicit
    // hydrate() after READY deliberately re-reads and revalidates durable state
    // (for example after a bit-rot or crash-recovery event in the same document).
    if (hydrationState === 'HYDRATING' && hydrationPromise) return hydrationPromise;
    hydrationState = 'HYDRATING';
    hydrationPromise = performHydrate(localPayload).then(result => {
      hydrationState = 'READY';
      return result;
    }, error => {
      hydrationState = 'UNHYDRATED';
      hydrationPromise = null;
      throw error;
    });
    return hydrationPromise;
  }
  function ready() { return hydrated && hydrationState === 'READY'; }
  function status() { return { hydrated, hydrationState, revision, mode, database: DB_NAME, store: STORE_NAME }; }

  global.ANASResilientStorage = Object.freeze({
    APP_KEY, DB_NAME, STORE_NAME, getSync, setSync, removeSync, hydrate, persist,
    getItem(key) { const text = getSync(key); return text == null ? null : decode(text); },
    setItem(key, value) { return setSync(key, encode(value)); },
    ready, status, encode, decode, canonicalizeJson, checksum, assertWellFormedUtf16, isStrictBigIntEnvelope, cloneAndDeepFreezeState, getCommittedSnapshot() { return committedSnapshot; }
  });
})(window);
