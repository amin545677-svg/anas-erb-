const SHA256_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];
function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes); data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotr = (x,n) => (x >>> n) | (x << (32-n));
  for (let offset=0; offset<paddedLength; offset+=64) {
    const w = new Uint32Array(64);
    for (let i=0;i<16;i++) w[i]=view.getUint32(offset+i*4);
    for (let i=16;i<64;i++) {
      const x=w[i-15], y=w[i-2];
      const s0=rotr(x,7)^rotr(x,18)^(x>>>3), s1=rotr(y,17)^rotr(y,19)^(y>>>10);
      w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;
    }
    let [a,b,c,d,e,f,g,h]=H;
    for (let i=0;i<64;i++) {
      const s1=rotr(e,6)^rotr(e,11)^rotr(e,25), ch=(e&f)^(~e&g);
      const t1=(h+s1+ch+SHA256_K[i]+w[i])>>>0;
      const s0=rotr(a,2)^rotr(a,13)^rotr(a,22), maj=(a&b)^(a&c)^(b&c);
      const t2=(s0+maj)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
  }
  return H.map(x=>x.toString(16).padStart(8,"0")).join("");
}

function assertWellFormedUnicode(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        const error = new TypeError("UNPAIRED_UTF16_SURROGATE");
        error.code = "UNPAIRED_UTF16_SURROGATE";
        throw error;
      }
      i++;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      const error = new TypeError("UNPAIRED_UTF16_SURROGATE");
      error.code = "UNPAIRED_UTF16_SURROGATE";
      throw error;
    }
  }
  return text;
}

export function canonicalizeJson(value, seen = new WeakSet()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(assertWellFormedUnicode(value).normalize("NFC"));
  if (typeof value === "bigint") return JSON.stringify(value.toString() + "n");
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      const error = new TypeError("NON_CANONICAL_NUMERIC_VALUE");
      error.code = "NON_CANONICAL_NUMERIC_VALUE";
      throw error;
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("NON_CANONICAL_JSON_TYPE");
  if (seen.has(value)) throw new TypeError("NON_CANONICAL_CYCLE");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) throw new TypeError("NON_CANONICAL_ARRAY_HOLE");
        out.push(canonicalizeJson(value[i], seen));
      }
      return "[" + out.join(",") + "]";
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("NON_CANONICAL_OBJECT_PROTOTYPE");
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError("NON_CANONICAL_SYMBOL_KEY");
    const normalizedKeys = Object.keys(value).map(key => ({ source: assertWellFormedUnicode(key), normalized: assertWellFormedUnicode(key).normalize("NFC") }));
    normalizedKeys.sort((a, b) => a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0);
    for (let i = 1; i < normalizedKeys.length; i++) {
      if (normalizedKeys[i - 1].normalized === normalizedKeys[i].normalized) {
        const error = new TypeError("NON_CANONICAL_NORMALIZED_KEY_COLLISION");
        error.code = "NON_CANONICAL_NORMALIZED_KEY_COLLISION";
        throw error;
      }
    }
    const pairs = [];
    for (const { source: key, normalized } of normalizedKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError("NON_CANONICAL_INHERITED_KEY");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) throw new TypeError("NON_CANONICAL_ACCESSOR");
      pairs.push(JSON.stringify(normalized) + ":" + canonicalizeJson(descriptor.value, seen));
    }
    return "{" + pairs.join(",") + "}";
  } finally {
    seen.delete(value);
  }
}

export function sha256Canonical(value) {
  return sha256Hex(canonicalizeJson(value));
}

export function cloneFrozen(value) {
  const copy = structuredClone(value);
  const freeze = (node) => {
    if (node && typeof node === "object" && !Object.isFrozen(node)) {
      for (const key of Object.keys(node)) freeze(node[key]);
      Object.freeze(node);
    }
    return node;
  };
  return freeze(copy);
}

export class CommittedSnapshotCache {
  #snapshot = null;
  #revision = 0;
  #hash = null;
  constructor(persist) {
    if (typeof persist !== "function") throw new TypeError("persist callback required");
    this.persist = persist;
  }
  get revision() { return this.#revision; }
  get hash() { return this.#hash; }
  read() { return this.#snapshot === null ? null : structuredClone(this.#snapshot); }
  async setItem(value, expectedRevision = this.#revision) {
    if (expectedRevision !== this.#revision) throw new Error("MONOTONIC_REVISION_CONFLICT");
    const candidate = cloneFrozen(value);
    const nextRevision = this.#revision + 1;
    const hash = sha256Canonical(candidate);
    await this.persist({ revision: nextRevision, hash, snapshot: candidate });
    this.#snapshot = candidate;
    this.#revision = nextRevision;
    this.#hash = hash;
    return { revision: nextRevision, hash };
  }
}

export function createStateAnchor(revision, state, parentStateHash = "0".repeat(64)) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("INVALID_REVISION");
  if (typeof parentStateHash !== "string" || !/^[a-f0-9]{64}$/.test(parentStateHash)) throw new Error("INVALID_PARENT_STATE_HASH");
  return Object.freeze({ revision, stateCanonicalHash: sha256Canonical(state), parentStateHash });
}

export function assertCausalCAS({ baseRevision, baseStateHash, baseParentStateHash }, currentAnchor) {
  if (baseRevision !== currentAnchor.revision ||
      baseStateHash !== currentAnchor.stateCanonicalHash ||
      baseParentStateHash !== currentAnchor.parentStateHash) {
    const error = new Error("CAUSAL_CAS_CONFLICT");
    error.code = "CAUSAL_CAS_CONFLICT";
    throw error;
  }
  return true;
}

export function assertAlgebraicZeroSumInvariant(prevState, nextState, effect) {
  const keys = ["cash", "inventoryValue", "customerReceivables", "customerCredits",
    "supplierPayables", "recognizedNetMargin", "wacVariance"];
  let invariant = 0n;
  for (const key of keys) {
    const delta = effect?.[key];
    if (typeof delta !== "bigint") throw new TypeError("ZERO_SUM_EFFECT_REQUIRES_BIGINT:" + key);
    invariant += key === "cash" || key === "inventoryValue" || key === "customerReceivables"
      ? delta : -delta;
  }
  if (invariant !== 0n) {
    const error = new Error("ALGEBRAIC_ZERO_SUM_VIOLATION:" + invariant);
    error.code = "ALGEBRAIC_ZERO_SUM_VIOLATION";
    error.delta = invariant;
    throw error;
  }
  return Object.freeze({ invariant, prevState, nextState });
}

export function buildLedgerHashChain(entries) {
  let parentHash = "0".repeat(64);
  return entries.map((entry, index) => {
    const body = { index, parentHash, entry };
    const hash = sha256Canonical(body);
    const node = Object.freeze({ ...body, hash });
    parentHash = hash;
    return node;
  });
}

export function verifyLedgerHashChain(chain) {
  if (!Array.isArray(chain)) return false;
  let parentHash = "0".repeat(64);
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    if (node.index !== i || node.parentHash !== parentHash) return false;
    const expected = sha256Canonical({ index: node.index, parentHash: node.parentHash, entry: node.entry });
    if (node.hash !== expected) return false;
    parentHash = node.hash;
  }
  return true;
}

function payloadHash(op) {
  return sha256Canonical({ type: op.type, payload: op.payload });
}

export function applyInventoryDomainMutation(state, operation) {
  const payload = operation?.payload || {};
  const product = (state.products || []).find(item => item && String(item.id) === String(payload.productId));
  if (!product) throw new Error("PRODUCT_NOT_FOUND");
  const quantity = payload.quantityMicroUnits;
  if (typeof quantity !== "bigint" || quantity <= 0n) throw new Error("INVALID_INVENTORY_QUANTITY");
  const stock = product.stockMicroUnits;
  const book = product.inventoryValueCentimes;
  if (typeof stock !== "bigint" || typeof book !== "bigint" || stock < 0n || book < 0n) {
    throw new Error("INVALID_INVENTORY_BOOK_STATE");
  }
  if (operation.type === "PURCHASE") {
    const unitCost = payload.unitCostCentimes;
    if (typeof unitCost !== "bigint" || unitCost < 0n) throw new Error("INVALID_PURCHASE_UNIT_COST");
    const MICRO_UNITS_PER_CARTON = 1_000_000n;
    const purchaseValueCentimes = quantity * unitCost / MICRO_UNITS_PER_CARTON;
    product.stockMicroUnits = stock + quantity;
    product.inventoryValueCentimes = book + purchaseValueCentimes;
  } else if (operation.type === "SALE") {
    if (quantity > stock) throw new Error("NEGATIVE_INVENTORY_MICRO_UNITS");
    const allocatedCost = book * quantity / stock;
    product.stockMicroUnits = stock - quantity;
    product.inventoryValueCentimes = book - allocatedCost;
  } else {
    throw new Error("UNSUPPORTED_INVENTORY_DOMAIN_OPERATION");
  }
  if (product.stockMicroUnits === 0n && product.inventoryValueCentimes !== 0n) {
    throw new Error("ZERO_STOCK_NONZERO_BOOK_VALUE");
  }
  const MICRO_UNITS_PER_CARTON = 1_000_000n;
  product.wacCentimes = product.stockMicroUnits === 0n
    ? 0n
    : (product.inventoryValueCentimes * MICRO_UNITS_PER_CARTON + product.stockMicroUnits / 2n) / product.stockMicroUnits;
  return { stockMicroUnits: product.stockMicroUnits, inventoryValueCentimes: product.inventoryValueCentimes, wacCentimes: product.wacCentimes };
}

export function reconcileCausally(remoteSnapshot, pending, reducer) {
  if (!remoteSnapshot || typeof remoteSnapshot !== "object" || !Array.isArray(pending) || typeof reducer !== "function") {
    throw new TypeError("INVALID_RECONCILIATION_INPUT");
  }
  const state = structuredClone(remoteSnapshot);
  if (!Array.isArray(state.appliedOperations)) state.appliedOperations = [];
  const applied = new Map(state.appliedOperations.map(item => [item.opId, item]));
  const appliedNow = [];
  const quarantine = [];
  for (const op of pending) {
    if (!op || typeof op.opId !== "string" || !op.opId || !op.payload || typeof op.payload !== "object") {
      quarantine.push({ opId: op?.opId ?? null, reason: "INVALID_OPERATION" });
      continue;
    }
    const hash = payloadHash(op);
    const prior = applied.get(op.opId);
    if (prior) {
      if (prior.payloadHash !== hash) {
        const error = new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
        error.code = "IDEMPOTENCY_PAYLOAD_MISMATCH";
        throw error;
      }
      appliedNow.push({ opId: op.opId, outcome: "folded-duplicate" });
      continue;
    }
    const candidate = structuredClone(state);
    try {
      reducer(candidate, structuredClone(op));
      for (const product of candidate.products || []) {
        if (typeof product.stockMicroUnits === "bigint" && product.stockMicroUnits < 0n) throw new Error("NEGATIVE_INVENTORY_MICRO_UNITS");
      }
      for (const customer of candidate.customers || []) {
        if (typeof customer.remainingDebtCentimes === "bigint" && customer.remainingDebtCentimes < 0n) throw new Error("NEGATIVE_INVOICE_REMAINING_DEBT");
      }
      const anchor = createStateAnchor((state.revision || 0) + 1, candidate);
      candidate.appliedOperations.push({ opId: op.opId, payloadHash: hash, parentStateHash: createStateAnchor(state.revision || 0, state).stateCanonicalHash, stateHash: anchor.stateCanonicalHash });
      candidate.revision = anchor.revision;
      Object.keys(state).forEach(key => delete state[key]);
      Object.assign(state, candidate);
      applied.set(op.opId, candidate.appliedOperations.at(-1));
      appliedNow.push({ opId: op.opId, outcome: "applied" });
    } catch (error) {
      quarantine.push({ opId: op.opId, reason: error.code || error.message || "DOMAIN_REBASE_REJECTED" });
    }
  }
  return { snapshot: state, appliedNow, quarantine };
}

export function cumulativeFloorDeltaCentimes(totalCentimes, totalQuantity, previouslyAllocated, deltaQuantity) {
  for (const [name, n] of Object.entries({ totalCentimes, totalQuantity, previouslyAllocated, deltaQuantity })) {
    if (typeof n !== "bigint" || n < 0n) throw new TypeError(name + " must be a non-negative BigInt");
  }
  if (totalQuantity === 0n || deltaQuantity === 0n || previouslyAllocated + deltaQuantity > totalQuantity) {
    throw new Error("INVALID_CUMULATIVE_ALLOCATION");
  }
  const floor = q => totalCentimes * q / totalQuantity;
  return floor(previouslyAllocated + deltaQuantity) - floor(previouslyAllocated);
}


/**
 * Stage a mutation against a private structured clone. The caller's live state
 * is untouched until all assertions pass; a thrown reducer/assertion therefore
 * preserves both its canonical hash and every pre-existing object reference.
 */
export function transactStateAtomically(liveState, stageMutation, assertStaged = () => true) {
  if (!liveState || typeof liveState !== "object" || Array.isArray(liveState) ||
      typeof stageMutation !== "function" || typeof assertStaged !== "function") {
    throw new TypeError("INVALID_ATOMIC_TRANSACTION_INPUT");
  }
  const staged = structuredClone(liveState);
  stageMutation(staged);
  const assertion = assertStaged(staged);
  if (assertion === false) throw new Error("STAGED_STATE_ASSERTION_FAILED");
  // The swap is synchronous and occurs only after staging and assertions finish.
  for (const key of Object.keys(liveState)) delete liveState[key];
  Object.assign(liveState, staged);
  return liveState;
}

/** Deterministic replay from a supplied genesis snapshot, with a verifiable chain. */
export function replayLedgerFromGenesis(genesis, entries, reducer) {
  if (!genesis || typeof genesis !== "object" || Array.isArray(genesis) ||
      !Array.isArray(entries) || typeof reducer !== "function") {
    throw new TypeError("INVALID_GENESIS_REPLAY_INPUT");
  }
  let state = structuredClone(genesis);
  const chain = [];
  for (const entry of entries) {
    const candidate = structuredClone(state);
    reducer(candidate, structuredClone(entry));
    state = candidate;
    chain.push(structuredClone(entry));
  }
  return { state, chain: buildLedgerHashChain(chain) };
}
