import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeJson, sha256Canonical, CommittedSnapshotCache,
  createStateAnchor, assertCausalCAS, reconcileCausally,
  assertAlgebraicZeroSumInvariant, buildLedgerHashChain, verifyLedgerHashChain,
  cumulativeFloorDeltaCentimes, applyInventoryDomainMutation
} from "../core/sovereign-kernel.mjs";

test("JCS canonicalization is key-order invariant through three nested levels", () => {
  const a = { z: 9, invoice: { total: 100003n, customer: { name: "A", id: 7 } }, lines: [{ qty: 13, sku: "X" }] };
  const b = { lines: [{ sku: "X", qty: 13 }], invoice: { customer: { id: 7, name: "A" }, total: 100003n }, z: 9 };
  assert.equal(canonicalizeJson(a), canonicalizeJson(b));
  assert.equal(sha256Canonical(a), sha256Canonical(b));
  assert.match(sha256Canonical(a), /^[a-f0-9]{64}$/);
  assert.equal(sha256Canonical(a), createHash("sha256").update(canonicalizeJson(a), "utf8").digest("hex"));
  assert.match(canonicalizeJson({ amount: 100003n }), /"100003n"/);
});

test("canonical kernel rejects NaN, infinities, negative zero, inherited prototypes and accessors", () => {
  for (const value of [NaN, Infinity, -Infinity, -0]) {
    assert.throws(() => canonicalizeJson({ amount: value }), error => error.code === "NON_CANONICAL_NUMERIC_VALUE");
  }
  const polluted = Object.create({ polluted: true });
  polluted.own = 1;
  assert.throws(() => canonicalizeJson(polluted), /NON_CANONICAL_OBJECT_PROTOTYPE/);
  const accessor = {};
  Object.defineProperty(accessor, "secret", { enumerable: true, get() { return 1; } });
  assert.throws(() => canonicalizeJson(accessor), /NON_CANONICAL_ACCESSOR/);
});

test("committed cache isolates writes and reads and advances only after durable commit", async () => {
  let fail = false;
  const cache = new CommittedSnapshotCache(async () => { if (fail) throw new Error("disk"); });
  const input = { revision: 1, nested: { cents: 100n } };
  await cache.setItem(input);
  input.nested.cents = 999n;
  const read = cache.read();
  read.nested.cents = 777n;
  assert.equal(cache.read().nested.cents, 100n);
  const rev = cache.revision;
  fail = true;
  await assert.rejects(cache.setItem({ revision: 2 }), /disk/);
  assert.equal(cache.revision, rev);
  assert.equal(cache.read().nested.cents, 100n);
});

test("cryptographic CAS rejects same revision from a different history fork", () => {
  const state = { cash: 100n };
  const anchorA = createStateAnchor(5, state, "a".repeat(64));
  const anchorB = createStateAnchor(5, state, "b".repeat(64));
  assert.throws(() => assertCausalCAS({
    baseRevision: 5, baseStateHash: anchorA.stateCanonicalHash, baseParentStateHash: anchorA.parentStateHash
  }, anchorB),
    error => error.code === "CAUSAL_CAS_CONFLICT");
  assert.equal(assertCausalCAS({
    baseRevision: 5, baseStateHash: anchorA.stateCanonicalHash, baseParentStateHash: anchorA.parentStateHash
  }, anchorA), true);
});

test("lost ACK followed by HTTP 409 folds matching opId and rejects changed payload", () => {
  const op = { opId: "K_1", type: "COLLECTION", payload: { amountCentimes: 500n } };
  const once = reconcileCausally({ revision: 10, cashCentimes: 500n, appliedOperations: [] }, [op],
    (state, operation) => { state.cashCentimes += operation.payload.amountCentimes; });
  assert.equal(once.snapshot.cashCentimes, 1000n);
  const lostAckRetry = reconcileCausally(once.snapshot, [op],
    (state, operation) => { state.cashCentimes += operation.payload.amountCentimes; });
  assert.equal(lostAckRetry.snapshot.cashCentimes, 1000n);
  assert.deepEqual(lostAckRetry.appliedNow, [{ opId: "K_1", outcome: "folded-duplicate" }]);
  assert.throws(() => reconcileCausally(once.snapshot, [{ ...op, payload: { amountCentimes: 501n } }], () => {}),
    error => error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH");
});

test("non-commutative rebase quarantines sale exceeding V1 stock without mutating V1", () => {
  const v1 = { revision: 1, products: [{ id: "p", stockMicroUnits: 5n, wacCentimes: 1500n }], appliedOperations: [] };
  const pendingSale = { opId: "sale-B", type: "SALE", payload: { productId: "p", quantityMicroUnits: 6n } };
  const result = reconcileCausally(v1, [pendingSale], (state, op) => {
    const p = state.products.find(x => x.id === op.payload.productId);
    p.stockMicroUnits -= op.payload.quantityMicroUnits;
    if (p.stockMicroUnits < 0n) throw new Error("NEGATIVE_INVENTORY_MICRO_UNITS");
  });
  assert.equal(result.snapshot.products[0].stockMicroUnits, 5n);
  assert.equal(result.snapshot.products[0].wacCentimes, 1500n);
  assert.equal(result.quarantine[0].reason, "NEGATIVE_INVENTORY_MICRO_UNITS");
  assert.deepEqual(v1.products[0].stockMicroUnits, 5n);
});

test("13 cartons / 100003 centimes split 3,5,2,3 closes exact zero-sum and hash chain", () => {
  const slices = [3n, 5n, 2n, 3n];
  let allocatedQty = 0n;
  let allocatedValue = 0n;
  const entries = [];
  for (const qty of slices) {
    const value = cumulativeFloorDeltaCentimes(100003n, 13n, allocatedQty, qty);
    allocatedQty += qty;
    allocatedValue += value;
    const effect = {
      cash: 0n, inventoryValue: value, customerReceivables: -value,
      customerCredits: 0n, supplierPayables: 0n, recognizedNetMargin: 0n, wacVariance: 0n
    };
    const proof = assertAlgebraicZeroSumInvariant({}, { allocatedQty, allocatedValue }, effect);
    assert.equal(proof.invariant, 0n);
    entries.push({ qty, value, allocatedQty, allocatedValue });
  }
  assert.equal(allocatedQty, 13n);
  assert.equal(allocatedValue, 100003n);
  const chain = buildLedgerHashChain(entries);
  assert.equal(verifyLedgerHashChain(chain), true);
  const tampered = structuredClone(chain);
  tampered[1].entry.value += 1n;
  assert.equal(verifyLedgerHashChain(tampered), false);
});

test("zero-sum invariant rejects a one-centime discrepancy", () => {
  assert.throws(() => assertAlgebraicZeroSumInvariant({}, {}, {
    cash: 1n, inventoryValue: 0n, customerReceivables: 0n,
    customerCredits: 0n, supplierPayables: 0n, recognizedNetMargin: 0n, wacVariance: 0n
  }), error => error.code === "ALGEBRAIC_ZERO_SUM_VIOLATION" && error.delta === 1n);
});


test("semantic rebase recalculates WAC from V1 and quarantines overselling without changing V1", () => {
  const v0 = { revision: 0, products: [{
    id: "carton", stockMicroUnits: 10_000_000n,
    inventoryValueCentimes: 1_000_000n, wacCentimes: 100_000n
  }], appliedOperations: [] };
  const purchase = {
    opId: "purchase-A", type: "PURCHASE",
    payload: { productId: "carton", quantityMicroUnits: 10_000_000n, unitCostCentimes: 200_000n }
  };
  const v1 = reconcileCausally(v0, [purchase], applyInventoryDomainMutation).snapshot;
  assert.equal(v1.products[0].stockMicroUnits, 20_000_000n);
  assert.equal(v1.products[0].wacCentimes, 150_000n);
  const safeSale = {
    opId: "sale-B-safe", type: "SALE",
    payload: { productId: "carton", quantityMicroUnits: 5_000_000n }
  };
  const rebased = reconcileCausally(v1, [safeSale], applyInventoryDomainMutation);
  assert.equal(rebased.snapshot.products[0].stockMicroUnits, 15_000_000n);
  assert.equal(rebased.snapshot.products[0].inventoryValueCentimes, 2_250_000n);
  assert.equal(rebased.snapshot.products[0].wacCentimes, 150_000n);
  const oversale = {
    opId: "sale-B-oversell", type: "SALE",
    payload: { productId: "carton", quantityMicroUnits: 16_000_000n }
  };
  const rejected = reconcileCausally(rebased.snapshot, [oversale], applyInventoryDomainMutation);
  assert.equal(rejected.snapshot.products[0].stockMicroUnits, 15_000_000n);
  assert.equal(rejected.quarantine[0].reason, "NEGATIVE_INVENTORY_MICRO_UNITS");
  assert.equal(v1.products[0].stockMicroUnits, 20_000_000n);
});


test("Arabic NFC/NFD strings and keys produce identical canonical bytes and SHA-256", () => {
  const nfc = { "أ": "شاي الرقيم", description: "لآ", cents: 100003n };
  const nfd = { cents: 100003n, description: "لآ".normalize("NFD"), ["أ".normalize("NFD")]: "شاي الرقيم".normalize("NFD") };
  assert.equal(canonicalizeJson(nfc), canonicalizeJson(nfd));
  assert.equal(sha256Canonical(nfc), sha256Canonical(nfd));
  assert.throws(() => canonicalizeJson({ "أ": 1, ["أ".normalize("NFD")]: 2 }),
    error => error.code === "NON_CANONICAL_NORMALIZED_KEY_COLLISION");
});

test("staged multi-line transaction failure preserves hash and object references", async () => {
  const { transactStateAtomically } = await import("../core/sovereign-kernel.mjs");
  const state = { cash: 100n, products: [{ id: "a", stock: 3n }, { id: "b", stock: 2n }] };
  const productsRef = state.products;
  const firstProductRef = state.products[0];
  const before = sha256Canonical(state);
  assert.throws(() => transactStateAtomically(state, staged => {
    staged.products[0].stock -= 1n;
    staged.cash += 500n;
    staged.products[1].stock -= 3n; // deliberate failure in final line
    if (staged.products[1].stock < 0n) throw new Error("INSUFFICIENT_STOCK");
  }));
  assert.equal(sha256Canonical(state), before);
  assert.equal(state.products, productsRef);
  assert.equal(state.products[0], firstProductRef);
});

test("tri-action causal rebase folds lost ACK, quarantines oversell, then applies independent collection", () => {
  const { snapshot: remote } = reconcileCausally(
    { revision: 4, cashCentimes: 0n, products: [{ id: "p", stockMicroUnits: 5n }], appliedOperations: [] },
    [{ opId: "lost-ack", type: "COLLECTION", payload: { amountCentimes: 700n } }],
    (state, op) => { state.cashCentimes += op.payload.amountCentimes; }
  );
  const queue = [
    { opId: "lost-ack", type: "COLLECTION", payload: { amountCentimes: 700n } },
    { opId: "stale-sale", type: "SALE", payload: { productId: "p", quantityMicroUnits: 6n } },
    { opId: "valid-collection", type: "COLLECTION", payload: { amountCentimes: 300n } }
  ];
  const result = reconcileCausally(remote, queue, (state, op) => {
    if (op.type === "SALE") {
      const product = state.products.find(item => item.id === op.payload.productId);
      if (!product || product.stockMicroUnits < op.payload.quantityMicroUnits) {
        const error = new Error("INSUFFICIENT_REMOTE_STOCK_ON_REBASE");
        error.code = "INSUFFICIENT_REMOTE_STOCK_ON_REBASE";
        throw error;
      }
      product.stockMicroUnits -= op.payload.quantityMicroUnits;
    } else state.cashCentimes += op.payload.amountCentimes;
  });
  assert.deepEqual(result.appliedNow, [
    { opId: "lost-ack", outcome: "folded-duplicate" },
    { opId: "valid-collection", outcome: "applied" }
  ]);
  assert.equal(result.quarantine[0].reason, "INSUFFICIENT_REMOTE_STOCK_ON_REBASE");
  assert.equal(result.snapshot.products[0].stockMicroUnits, 5n);
  assert.equal(result.snapshot.cashCentimes, 1000n);
});

test("13 cartons / 100003 centimes replay identically from genesis", async () => {
  const { replayLedgerFromGenesis } = await import("../core/sovereign-kernel.mjs");
  const genesis = { stock: 0n, inventoryValue: 0n, returns: 0n };
  const events = [
    { type: "BUY", qty: 13n, value: 100003n },
    { type: "SELL", qty: 13n },
    ...[3n, 5n, 2n, 3n].map(qty => ({ type: "RETURN", qty }))
  ];
  const reducer = (state, event) => {
    if (event.type === "BUY") { state.stock += event.qty; state.inventoryValue += event.value; }
    else if (event.type === "SELL") { state.stock -= event.qty; }
    else { state.stock += event.qty; state.returns += event.qty; }
  };
  const a = replayLedgerFromGenesis(genesis, events, reducer);
  const b = replayLedgerFromGenesis(genesis, events, reducer);
  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.chain, b.chain);
  assert.equal(verifyLedgerHashChain(a.chain), true);
  assert.equal(a.state.stock, 13n);
  assert.equal(a.state.returns, 13n);
});


test("kernel canonicalization rejects unpaired UTF-16 surrogate code units", () => {
  const high = String.fromCharCode(0xD800);
  const low = String.fromCharCode(0xDC00);
  assert.throws(() => canonicalizeJson({ value: high }),
    error => error.code === "UNPAIRED_UTF16_SURROGATE");
  assert.throws(() => canonicalizeJson({ [low]: 1 }),
    error => error.code === "UNPAIRED_UTF16_SURROGATE");
  const decomposed = "cafe" + String.fromCharCode(0x0301);
  assert.equal(canonicalizeJson({ value: decomposed }), canonicalizeJson({ value: "café" }));
});

test("committed snapshot publishes a deeply frozen copy only after persistence", async () => {
  let persisted = false;
  const cache = new CommittedSnapshotCache(async ({ snapshot }) => {
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.nested), true);
    persisted = true;
  });
  const source = { nested: { cents: 100003n } };
  await cache.setItem(source);
  assert.equal(persisted, true);
  assert.equal(Object.isFrozen(cache.read()), false);
  assert.equal(cache.read().nested.cents, 100003n);
});


test("Level 24-A rejects cycles and excessive depth without recursive stack exhaustion", async () => {
  const { canonicalizeJson, cloneFrozen } = await import("../core/sovereign-kernel.mjs");
  const a = {}; a.self = a;
  const started = process.hrtime.bigint();
  assert.throws(() => canonicalizeJson(a),
    error => error.code === "CIRCULAR_REFERENCE_IN_LEDGER_STATE");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1, `cycle rejection took ${elapsedMs}ms`);
  assert.throws(() => cloneFrozen(a),
    error => error.code === "CIRCULAR_REFERENCE_IN_LEDGER_STATE");
  let deep = {};
  let cursor = deep;
  for (let i = 0; i < 66; i++) { cursor.next = {}; cursor = cursor.next; }
  assert.throws(() => canonicalizeJson(deep),
    error => error.code === "MAX_CANONICAL_DEPTH_EXCEEDED");
  assert.throws(() => cloneFrozen(deep),
    error => error.code === "MAX_CANONICAL_DEPTH_EXCEEDED");
});

test("Level 24-C emits a receipt only bound to the persisted snapshot hash", async () => {
  const { CommittedSnapshotCache, verifyCryptographicCommitReceipt } = await import("../core/sovereign-kernel.mjs");
  const cache = new CommittedSnapshotCache(async () => {});
  const state = { cashCentimes: 10n, inventoryMicroUnits: 1_000_000n };
  const receipt = await cache.setItem(state, 0, { algebraicZeroSumVerified: true });
  assert.equal(receipt.committed, true);
  assert.equal(receipt.algebraicZeroSumVerified, true);
  assert.equal(verifyCryptographicCommitReceipt(receipt, cache.read()), true);
  assert.equal(verifyCryptographicCommitReceipt(receipt, { cashCentimes: 11n, inventoryMicroUnits: 1_000_000n }), false);
  const unproven = await cache.setItem(state, 1);
  assert.equal(unproven.committed, true);
  assert.equal(unproven.algebraicZeroSumVerified, false);
  assert.equal(verifyCryptographicCommitReceipt(unproven, cache.read()), false);
});
