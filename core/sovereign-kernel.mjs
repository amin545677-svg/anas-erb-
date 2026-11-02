import { createHash } from "node:crypto";

export function canonicalizeJson(value, seen = new WeakSet()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
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
    const keys = Object.keys(value).sort();
    const pairs = [];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError("NON_CANONICAL_INHERITED_KEY");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) throw new TypeError("NON_CANONICAL_ACCESSOR");
      pairs.push(JSON.stringify(key) + ":" + canonicalizeJson(descriptor.value, seen));
    }
    return "{" + pairs.join(",") + "}";
  } finally {
    seen.delete(value);
  }
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
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

export function createStateAnchor(revision, state) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("INVALID_REVISION");
  return Object.freeze({ revision, stateCanonicalHash: sha256Canonical(state) });
}

export function assertCausalCAS({ baseRevision, baseStateHash }, currentAnchor) {
  if (baseRevision !== currentAnchor.revision || baseStateHash !== currentAnchor.stateCanonicalHash) {
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
