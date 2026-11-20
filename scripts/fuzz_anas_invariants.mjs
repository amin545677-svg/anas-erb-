#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  reconcilePendingMutations
} from "../sync/mutation_reconciliation.mjs";
import {
  createMutationQueueOrchestrator,
  MUTATION_KEYS
} from "../sync/mutation_queue_orchestrator.mjs";
import settlementService from "../functions/settlement-allocation-service.js";

const { normalizeAllocationRequest, toCentimes } = settlementService;

function parsePositiveInt(value, fallback, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

const ROOT_SEED = (Number(process.env.FUZZ_SEED) >>> 0) || 0xA11CE202;
const CASES = parsePositiveInt(process.env.FUZZ_CASES, 200, 10000);
const STEPS = parsePositiveInt(process.env.FUZZ_STEPS, 40, 500);

function rngFor(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
const int = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const money = cents => (cents / 100).toFixed(2);
const shuffled = (items, rng) => {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = int(rng, 0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
const clone = value => structuredClone(value);
const snapshotMoneyCents = value => toCentimes(String(value), "snapshot money");

function baseSnapshot() {
  return {
    products: [{
      id: "FUZZ-P1",
      stock: 1000,
      warehouseStock: { "VAN-1": 1000, "STORE-2": 1000 }
    }],
    customers: [{ id: "FUZZ-C1", debt: 1000, debtDate: "2026-01-01" }],
    invoices: [],
    caisseBalance: 500,
    cashMovements: [],
    appliedOpIds: [],
    appliedOperations: []
  };
}

function buildScenario(seed) {
  const rng = rngFor(seed);
  const initial = baseSnapshot();
  const operations = [];
  const expected = {
    cashCents: 50000,
    debtCents: 100000,
    mainStock: 1000,
    vanStock: 1000,
    store2Stock: 1000,
    salesCents: 0,
    validCollectionsCents: 0,
    appliedSales: 0,
    appliedCollections: 0,
    rejectedCollections: 0
  };
  let projectedDebtCents = expected.debtCents;

  for (let index = 0; index < STEPS; index++) {
    const localSeq = index + 1;
    if (rng() < 0.62) {
      const qty = int(rng, 1, 5);
      const unitCents = int(rng, 100, 25000);
      const totalCents = qty * unitCents;
      const paidCents = int(rng, 0, totalCents);
      const remainingCents = totalCents - paidCents;
      const warehouse = ["المخزن الرئيسي", "VAN-1", "STORE-2"][int(rng, 0, 2)];
      const opId = "FUZZ-" + seed + "-SALE-" + String(index).padStart(4, "0");
      const invoiceId = "FUZZ-" + seed + "-INV-" + String(index).padStart(4, "0");
      const invoice = {
        id: invoiceId,
        customerId: "FUZZ-C1",
        total: money(totalCents),
        paid: money(paidCents),
        remaining: money(remainingCents),
        warehouse,
        items: [{ id: "FUZZ-P1", qty }]
      };
      operations.push({
        opId, type: "SALE_INVOICE", status: "PENDING", localSeq,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        payload: { customerId: "FUZZ-C1", warehouse, invoice }
      });
      expected.cashCents += paidCents;
      expected.debtCents += remainingCents;
      expected.salesCents += totalCents;
      expected.appliedSales++;
      if (warehouse === "المخزن الرئيسي") expected.mainStock -= qty;
      else if (warehouse === "VAN-1") expected.vanStock -= qty;
      else expected.store2Stock -= qty;
      projectedDebtCents += remainingCents;
    } else {
      const shouldBeValid = projectedDebtCents > 0 && rng() < 0.78;
      const amountCents = shouldBeValid
        ? int(rng, 1, projectedDebtCents)
        : projectedDebtCents + int(rng, 1, 5000);
      const valid = amountCents <= projectedDebtCents;
      const opId = "FUZZ-" + seed + "-COLLECT-" + String(index).padStart(4, "0");
      operations.push({
        opId, type: "DEBT_COLLECTION", status: "PENDING", localSeq,
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
        payload: {
          customerId: "FUZZ-C1",
          amount: money(amountCents),
          cashMovementId: "FUZZ-CASH-" + seed + "-" + index
        }
      });
      if (valid) {
        projectedDebtCents -= amountCents;
        expected.debtCents -= amountCents;
        expected.cashCents += amountCents;
        expected.validCollectionsCents += amountCents;
        expected.appliedCollections++;
      } else {
        expected.rejectedCollections++;
      }
    }
  }
  return { initial, operations, expected };
}

function assertDuplicateAllocationIsAtomic(seed) {
  const request = {
    operationId: "FUZZ-ALLOC-" + String(seed).padStart(8, "0"),
    periodId: "FY-2026-11",
    partyType: "customer",
    partyId: "FUZZ-C1",
    sourceMovementId: "FUZZ-SOURCE-" + seed,
    sourceMovementType: "customer_debt",
    allocations: [
      { invoiceId: "FUZZ-INVOICE-A", amountCentimes: 1000 },
      { invoiceId: "FUZZ-INVOICE-A", amountCentimes: 2000 }
    ]
  };
  const before = clone(request);
  assert.throws(() => normalizeAllocationRequest(request), /duplicate invoice allocation/);
  assert.deepEqual(request, before, "duplicate allocation rejection must not mutate the caller request");
}

function assertReplayAndFinancialInvariants(seed, scenario) {
  const pending = shuffled(scenario.operations, rngFor(seed ^ 0x9E3779B9));
  const first = reconcilePendingMutations(scenario.initial, pending);
  const { snapshot, appliedNow, review } = first;
  const expected = scenario.expected;

  assert.equal(snapshotMoneyCents(snapshot.caisseBalance), expected.cashCents, "cashbox centime parity");
  assert.equal(snapshotMoneyCents(snapshot.customers[0].debt), expected.debtCents, "customer debt centime parity");
  const product = snapshot.products.find(row => row.id === "FUZZ-P1");
  assert.equal(product.stock, expected.mainStock, "main warehouse stock conservation");
  assert.equal(product.warehouseStock["VAN-1"], expected.vanStock, "van stock conservation");
  assert.equal(product.warehouseStock["STORE-2"], expected.store2Stock, "secondary store stock conservation");
  assert.equal(snapshot.invoices.length, expected.appliedSales, "each accepted sale creates exactly one invoice");
  assert.equal(snapshot.cashMovements.length, expected.appliedCollections, "each accepted collection creates exactly one movement");
  assert.equal(appliedNow.filter(row => row.outcome === "applied").length,
    expected.appliedSales + expected.appliedCollections, "applied operation count");
  assert.equal(review.length, expected.rejectedCollections, "only deliberately over-collection operations are quarantined");

  const netFinancialDelta = (expected.cashCents + expected.debtCents) - 150000;
  assert.equal(netFinancialDelta, expected.salesCents,
    "cash plus receivables must increase only by recognized sale value; collections are balance transfers");

  // Operations returned in review are quarantined by the orchestrator after a
  // successful cloud commit. They are deliberately NOT replayed against a later
  // snapshot: a previously rejected collection could become payable after a
  // subsequent sale increases debt, which would silently change its outcome.
  const quarantinedIds = new Set(review.map(item => item.opId));
  const replayable = pending.filter(op => !quarantinedIds.has(op.opId));
  assert.equal(replayable.length, expected.appliedSales + expected.appliedCollections,
    "only accepted operations remain eligible for idempotent replay");
  const replay = reconcilePendingMutations(snapshot, replayable);
  assert.deepEqual(replay.snapshot, snapshot, "replaying accepted operations after a simulated process boundary must not mutate posted state");
  assert.equal(replay.appliedNow.filter(row => row.outcome === "folded-duplicate").length,
    replayable.length, "every accepted operation folds as a duplicate exactly once");

  const postedSale = pending.find(op => op.type === "SALE_INVOICE" &&
    snapshot.appliedOperations.some(record => record.opId === op.opId));
  if (postedSale) {
    const tampered = clone(postedSale);
    tampered.payload.invoice.total = money(snapshotMoneyCents(tampered.payload.invoice.total) + 1);
    assert.throws(
      () => reconcilePendingMutations(snapshot, [tampered]),
      error => error?.code === "IDEMPOTENCY_PAYLOAD_MISMATCH"
    );
  }
  return first;
}

function memoryStorage(seed) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

async function assertOfflineRestartAndCas(seed, scenario) {
  let cloud = clone(scenario.initial);
  let revision = "REV-" + seed + "-0";
  let injectedConcurrentCommit = false;
  const storage = memoryStorage({
    [MUTATION_KEYS.appData]: scenario.initial,
    [MUTATION_KEYS.pending]: scenario.operations.map(op => ({ ...clone(op), status: "PENDING" })),
    [MUTATION_KEYS.revision]: revision,
    [MUTATION_KEYS.quarantined]: []
  });

  const makeQueue = () => createMutationQueueOrchestrator({
    storage,
    maxConflictRetries: 3,
    pullCloud: async () => {
      const response = { data: clone(cloud), revision };
      if (!injectedConcurrentCommit) {
        injectedConcurrentCommit = true;
        cloud = { ...cloud, concurrentDeviceMarker: "DEVICE-B-" + seed };
        revision = "REV-" + seed + "-B";
      }
      return response;
    },
    pushCloud: async ({ data, baseRevision }) => {
      if (baseRevision !== revision) return { status: 409, currentRevision: revision };
      cloud = clone(data);
      revision = "REV-" + seed + "-SYNCED";
      return { status: 200, revision };
    }
  });

  const firstQueue = makeQueue();
  const first = await firstQueue.reconcileAndSync();
  assert.equal(first.status, "synced", "offline queue must recover after a concurrent CAS conflict");
  assert.equal(first.attempts, 2, "the stale first revision must be rejected and replayed against the fresh revision");
  assert.equal(cloud.concurrentDeviceMarker, "DEVICE-B-" + seed, "concurrent device commit must survive replay");
  assert.deepEqual(JSON.parse(storage.getItem(MUTATION_KEYS.pending)), [], "accepted and quarantined work leaves the active queue");
  assert.equal(first.quarantined.length, scenario.expected.rejectedCollections,
    "every rejected collection is explicitly reported as quarantined");
  const persistedQuarantine = JSON.parse(storage.getItem(MUTATION_KEYS.quarantined));
  assert.equal(persistedQuarantine.length, scenario.expected.rejectedCollections,
    "rejected collections are durably quarantined after the cloud commit");
  assert.ok(persistedQuarantine.every(item =>
    item.status === "QUARANTINED" &&
    item.reason === "COLLECTION_EXCEEDS_RECORDED_DEBT_OR_INVALID_DEBT"
  ), "quarantine records retain an explicit reason and terminal status");

  // Simulate app close/reopen: rebuild the orchestrator around the same durable storage.
  const reopenedQueue = makeQueue();
  const second = await reopenedQueue.reconcileAndSync();
  assert.equal(second.status, "synced");
  assert.equal(cloud.invoices.length, scenario.expected.appliedSales, "restart must not duplicate invoices");
  assert.equal(cloud.cashMovements.length, scenario.expected.appliedCollections, "restart must not duplicate receipts");
  assert.equal(snapshotMoneyCents(cloud.caisseBalance), scenario.expected.cashCents);
  assert.equal(snapshotMoneyCents(cloud.customers[0].debt), scenario.expected.debtCents);
}

async function main() {
  let operationsChecked = 0;
  for (let index = 0; index < CASES; index++) {
    const seed = (ROOT_SEED + Math.imul(index, 0x9E3779B1)) >>> 0;
    const scenario = buildScenario(seed);
    const trace = scenario.operations.map(op => ({
      localSeq: op.localSeq, opId: op.opId, type: op.type, payload: op.payload
    }));
    try {
      assertDuplicateAllocationIsAtomic(seed);
      assertReplayAndFinancialInvariants(seed, scenario);
      if (index < Math.min(CASES, 32)) await assertOfflineRestartAndCas(seed, scenario);
      operationsChecked += scenario.operations.length;
    } catch (error) {
      console.error(JSON.stringify({
        failure: String(error?.stack || error),
        rootSeed: ROOT_SEED,
        caseIndex: index,
        failingSeed: seed,
        steps: STEPS,
        replayTrace: trace
      }, null, 2));
      process.exitCode = 1;
      return;
    }
  }
  console.log(JSON.stringify({
    engine: "ANAS ERP deterministic invariant fuzz V2",
    rootSeed: ROOT_SEED,
    cases: CASES,
    stepsPerCase: STEPS,
    generatedOperations: operationsChecked,
    offlineRestartCasCases: Math.min(CASES, 32),
    assertions: [
      "main/van/secondary-store stock conservation",
      "cash and receivables ledger parity in integer centimes",
      "duplicate invoice allocation rejection without input mutation",
      "same-payload replay idempotency",
      "different-payload same-operation rejection",
      "out-of-order offline replay by stable local sequence",
      "restart persistence and CAS conflict recovery"
    ],
    status: "PASS"
  }, null, 2));
}

await main();
