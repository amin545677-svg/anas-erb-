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
  const rejected = reconcileCausally(v1, [oversale], applyInventoryDomainMutation);
  assert.equal(rejected.snapshot.products[0].stockMicroUnits, 20_000_000n);
  assert.equal(rejected.quarantine[0].reason, "NEGATIVE_INVENTORY_MICRO_UNITS");
  assert.equal(v1.products[0].stockMicroUnits, 20_000_000n);
});
