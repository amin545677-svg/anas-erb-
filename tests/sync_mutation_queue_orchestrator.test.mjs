import test from "node:test";
import assert from "node:assert/strict";
import {
  MUTATION_KEYS,
  commitLocalMutation,
  createMutationQueueOrchestrator,
  recoverInterruptedLocalMutation
} from "../sync/mutation_queue_orchestrator.mjs";
import { reconcilePendingMutations } from "../sync/mutation_reconciliation.mjs";

class MemoryStorage {
  constructor(seed = {}) { this.data = new Map(Object.entries(seed)); this.failNextSet = null; }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) {
    if (this.failNextSet === key) { this.failNextSet = null; throw new Error("QuotaExceededError"); }
    this.data.set(key, String(value));
  }
  removeItem(key) { this.data.delete(key); }
  json(key, fallback = null) {
    const raw = this.getItem(key);
    return raw == null ? structuredClone(fallback) : JSON.parse(raw);
  }
}
const baseCloud = () => ({
  caisseBalance: 54000,
  customers: [{ id: "cust_s", debt: 26000 }],
  products: [{ id: "item_a", stock: 90 }],
  invoices: [{ id: "cloud-invoice" }],
  stockMovements: [{ id: "cloud-stock-movement" }],
  cashMovements: [{ id: "cloud-cash" }],
  appliedOpIds: []
});
const collection = (opId = "op-deviceB-collection-5000") => ({
  opId, type: "DEBT_COLLECTION", status: "PENDING",
  payload: { customerId: "cust_s", amount: 5000, cashMovementId: "cm_991" }
});
const sale = (quantity = 95) => ({
  opId: "op-deviceB-sale-95", type: "SALE_INVOICE", status: "PENDING",
  payload: {
    productId: "item_a", quantity,
    invoice: { id: "local-invoice-95", total: 95000 },
    stockMovement: { id: "local-stock-95", quantity: -95 }
  }
});
const seededStorage = (pending = [collection()], appData = { localOnly: true, appliedOpIds: [] }) =>
  new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(appData),
    [MUTATION_KEYS.pending]: JSON.stringify(pending),
    [MUTATION_KEYS.revision]: JSON.stringify(0),
    [MUTATION_KEYS.quarantined]: JSON.stringify([])
  });

test("full conflict cycle replays collection over V1 and clears queue only after 200", async () => {
  const storage = seededStorage();
  let serverRevision = 1;
  let server = baseCloud();
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: structuredClone(server), revision: serverRevision }),
    pushCloud: async ({ data, baseRevision }) => {
      if (baseRevision !== serverRevision) return { status: 409 };
      server = structuredClone(data);
      serverRevision++;
      return { status: 200, revision: serverRevision };
    }
  });
  const initial = await orchestrator.pushCurrent();
  assert.equal(initial.status, "conflict");
  assert.equal(storage.json(MUTATION_KEYS.pending).length, 1);

  const result = await orchestrator.reconcileAndSync();
  assert.equal(result.status, "synced");
  assert.equal(server.products[0].stock, 90);
  assert.equal(server.caisseBalance, 59000);
  assert.equal(server.customers[0].debt, 21000);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.equal(storage.getItem(MUTATION_KEYS.rescue), null);
});

test("second 409 pulls V2 and replays same op once before successful compare-and-swap push", async () => {
  const storage = seededStorage();
  let pullCount = 0;
  let pushCount = 0;
  let accepted = null;
  const v1 = baseCloud();
  const v2 = baseCloud();
  v2.caisseBalance = 55000;
  v2.customers[0].debt = 25000;
  v2.cashMovements.push({ id: "cm_other-device", amount: 1000 });
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => {
      pullCount++;
      return { data: structuredClone(pullCount === 1 ? v1 : v2), revision: pullCount === 1 ? 1 : 2 };
    },
    pushCloud: async ({ data, baseRevision }) => {
      pushCount++;
      if (pushCount === 1) return { status: 409 };
      assert.equal(baseRevision, 2);
      accepted = structuredClone(data);
      return { status: 200, revision: 3 };
    }
  });
  const result = await orchestrator.reconcileAndSync();
  assert.equal(result.status, "synced");
  assert.equal(result.attempts, 2);
  assert.equal(pullCount, 2);
  assert.equal(pushCount, 2);
  assert.equal(accepted.caisseBalance, 60000);
  assert.equal(accepted.customers[0].debt, 20000);
  assert.equal(accepted.cashMovements.filter(m => m.id === "cm_991").length, 1);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
});

test("local storage write failure restores original AppData and pending queue", async () => {
  const storage = seededStorage();
  const beforeAppData = storage.getItem(MUTATION_KEYS.appData);
  const beforePending = storage.getItem(MUTATION_KEYS.pending);
  storage.failNextSet = MUTATION_KEYS.appData;
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: baseCloud(), revision: 1 }),
    pushCloud: async () => ({ status: 200, revision: 2 })
  });
  const result = await orchestrator.reconcileAndSync();
  assert.equal(result.status, "failed");
  assert.equal(storage.getItem(MUTATION_KEYS.appData), beforeAppData);
  assert.equal(storage.getItem(MUTATION_KEYS.pending), beforePending);
  assert.equal(storage.getItem(MUTATION_KEYS.rescue), null);
});

test("successful valid replay persists quarantined sale with exact reason", async () => {
  const storage = seededStorage([sale(95), collection()]);
  let accepted = null;
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: baseCloud(), revision: 1 }),
    pushCloud: async ({ data, baseRevision }) => {
      assert.equal(baseRevision, 1);
      accepted = structuredClone(data);
      return { status: 200, revision: 2 };
    }
  });
  const result = await orchestrator.reconcileAndSync();
  assert.equal(result.status, "synced");
  assert.equal(accepted.caisseBalance, 59000);
  assert.equal(accepted.customers[0].debt, 21000);
  assert.equal(accepted.products[0].stock, 90);
  assert.equal(storage.json(MUTATION_KEYS.pending).length, 0);
  const quarantined = storage.json(MUTATION_KEYS.quarantined);
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].opId, "op-deviceB-sale-95");
  assert.equal(quarantined[0].reason, "INSUFFICIENT_CLOUD_STOCK");
});

test("ordinary push retains queue on network failure and removes only captured operations on 200", async () => {
  const storage = seededStorage();
  const failing = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: baseCloud(), revision: 1 }),
    pushCloud: async () => { throw new Error("offline"); }
  });
  assert.equal((await failing.pushCurrent()).status, "network-error");
  assert.equal(storage.json(MUTATION_KEYS.pending).length, 1);

  let release;
  const waiting = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: baseCloud(), revision: 1 }),
    pushCloud: async () => new Promise(resolve => { release = resolve; })
  });
  const push = waiting.pushCurrent();
  await new Promise(resolve => setImmediate(resolve));
  const current = storage.json(MUTATION_KEYS.pending);
  current.push({ ...collection("op-created-during-push"), status: "PENDING" });
  storage.setItem(MUTATION_KEYS.pending, JSON.stringify(current));
  release({ status: 200, revision: 1 });
  assert.equal((await push).status, "pushed");
  assert.deepEqual(storage.json(MUTATION_KEYS.pending).map(x => x.opId), ["op-created-during-push"]);
});

test("local mutation uses a recoverable write-ahead queue and adds opId to local AppData", () => {
  const storage = seededStorage([], { cash: 100, appliedOpIds: [] });
  const result = commitLocalMutation({
    storage,
    nextAppData: { cash: 150, appliedOpIds: [] },
    operation: collection("op-local-1")
  });
  assert.equal(result.appData.cash, 150);
  assert.ok(storage.json(MUTATION_KEYS.appData).appliedOpIds.includes("op-local-1"));
  assert.equal(storage.json(MUTATION_KEYS.pending)[0].status, "PENDING");
  assert.equal(storage.getItem(MUTATION_KEYS.rescue), null);
});

test("entity-level cash movement ID prevents duplicate balance changes without appliedOpIds", () => {
  const cloud = baseCloud();
  cloud.cashMovements.push({ id: "cm_991", amount: 5000, customerId: "cust_s", opId: "op-deviceB-collection-5000" });
  const result = reconcilePendingMutations(cloud, [collection()]);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.equal(result.snapshot.cashMovements.filter(x => x.id === "cm_991").length, 1);
  assert.equal(result.appliedNow[0].outcome, "already-applied");
  assert.equal(result.appliedNow[0].reason, "CASH_MOVEMENT_ENTITY_EXISTS");
  assert.deepEqual(result.review, []);
});

test("interrupted local mutation recovery restores the prior stored values", () => {
  const storage = seededStorage([], { cash: 100, appliedOpIds: [] });
  storage.setItem(MUTATION_KEYS.rescue, JSON.stringify({
    schema: 1, phase: "LOCAL_MUTATION_PREPARE",
    before: {
      [MUTATION_KEYS.appData]: JSON.stringify({ cash: 100, appliedOpIds: [] }),
      [MUTATION_KEYS.pending]: "[]",
      [MUTATION_KEYS.rescue]: null
    },
    operation: collection("op-interrupted")
  }));
  storage.setItem(MUTATION_KEYS.appData, JSON.stringify({ cash: 150, appliedOpIds: ["op-interrupted"] }));
  storage.setItem(MUTATION_KEYS.pending, JSON.stringify([collection("op-interrupted")]));
  assert.equal(recoverInterruptedLocalMutation(storage), true);
  assert.deepEqual(storage.json(MUTATION_KEYS.appData), { cash: 100, appliedOpIds: [] });
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.equal(storage.getItem(MUTATION_KEYS.rescue), null);
});


test("pre-sync barrier aborts an uncommitted PREPARED intent before ordinary push", async () => {
  const storage = seededStorage([
    collection("op-pending"),
    { ...collection("op-prepared"), status: "PREPARED" }
  ]);
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: baseCloud(), revision: 1 }),
    pushCloud: async () => ({ status: 200, revision: 2 })
  });
  const result = await orchestrator.pushCurrent();
  assert.equal(result.status, "pushed");
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), [],
    "the ordinary pending mutation is pushed and the uncommitted PREPARED intent is aborted");
});

test("recovery restores a pre-reconcile rescue snapshot after an interrupted merge", () => {
  const beforeAppData = JSON.stringify({ original: true, appliedOpIds: [] });
  const beforePending = JSON.stringify([collection("op-recover")]);
  const storage = seededStorage([collection("op-recover")], { original: true, appliedOpIds: [] });
  storage.setItem(MUTATION_KEYS.rescue, JSON.stringify({
    schema: 1,
    phase: "PRE_RECONCILE",
    before: {
      [MUTATION_KEYS.appData]: beforeAppData,
      [MUTATION_KEYS.pending]: beforePending,
      [MUTATION_KEYS.quarantined]: "[]",
      [MUTATION_KEYS.revision]: "1"
    },
    cloudRevision: 2
  }));
  storage.setItem(MUTATION_KEYS.appData, JSON.stringify({ partiallyMerged: true, appliedOpIds: ["op-recover"] }));
  storage.setItem(MUTATION_KEYS.pending, "[]");
  storage.setItem(MUTATION_KEYS.revision, "2");
  assert.equal(recoverInterruptedLocalMutation(storage), true);
  assert.deepEqual(storage.json(MUTATION_KEYS.appData), { original: true, appliedOpIds: [] });
  assert.equal(storage.getItem(MUTATION_KEYS.pending), beforePending);
  assert.equal(storage.getItem(MUTATION_KEYS.revision), "1");
  assert.equal(storage.getItem(MUTATION_KEYS.rescue), null);
});

test("first-time cloud snapshot creation accepts a null Firestore revision and pins the returned revision", async () => {
  const storage = seededStorage([], { ...baseCloud(), appliedOpIds: [] });
  const initialCloud = baseCloud();
  const accepted = [];
  const createdRevision = "2026-10-31T08:00:00.000000Z";
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: structuredClone(initialCloud), revision: null }),
    pushCloud: async ({ data, baseRevision }) => {
      accepted.push({ data: structuredClone(data), baseRevision });
      return { status: 200, revision: createdRevision };
    }
  });

  const result = await orchestrator.reconcileAndSync();

  assert.equal(result.status, "synced");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].baseRevision, null,
    "a missing Firestore document must be created with the exists=false precondition");
  assert.deepEqual(accepted[0].data.products, initialCloud.products);
  assert.equal(storage.getItem(MUTATION_KEYS.revision), JSON.stringify(createdRevision));
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.equal(storage.getItem(MUTATION_KEYS.rescue), null);
});

test("server-posted customer and supplier settlement allocations are isolated from ordinary snapshot push", async () => {
  const protectedRows = [
    { opId: "alloc-customer-0001", type: "CUSTOMER_SETTLEMENT_ALLOCATION", status: "PENDING", payload: { amountCentimes: 5000 } },
    { opId: "alloc-supplier-0001", type: "SUPPLIER_SETTLEMENT_ALLOCATION", status: "PENDING", payload: { amountCentimes: 7000 } }
  ];
  const storage = seededStorage(protectedRows, { ...baseCloud(), appliedOpIds: [] });
  let pushCalls = 0;
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: baseCloud(), revision: 7 }),
    pushCloud: async () => { pushCalls++; return { status: 200, revision: 8 }; }
  });
  const result = await orchestrator.pushCurrent();
  assert.equal(result.status, "protected-financial-pending");
  assert.equal(pushCalls, 0, "whole-snapshot writes must not replay server-posted allocations");
  assert.deepEqual(storage.json(MUTATION_KEYS.pending).map(row => row.opId),
    ["alloc-customer-0001", "alloc-supplier-0001"]);
});

test("settlement allocations survive 409 CAS reconciliation without replay, loss or duplication", async () => {
  const protectedRow = {
    opId: "alloc-server-posted-0001", type: "CUSTOMER_SETTLEMENT_ALLOCATION", status: "PENDING",
    payload: { amountCentimes: 5000 }
  };
  const posted = {
    allocationId: "ALLOC-SERVER-1", operationId: protectedRow.opId,
    partyType: "customer", invoiceId: "INV-1", amountCentimes: 5000, status: "POSTED"
  };
  const storage = seededStorage([protectedRow], { localOnly: true, appliedOpIds: [] });
  const cloud = { ...baseCloud(), settlementAllocations: [posted] };
  let pushes = 0;
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: structuredClone(cloud), revision: 12 }),
    pushCloud: async ({ data, baseRevision }) => {
      pushes++;
      assert.equal(baseRevision, 12);
      assert.equal(data.settlementAllocations.filter(row => row.operationId === protectedRow.opId).length, 1);
      if (pushes === 1) return { status: 409 };
      return { status: 200, revision: 14 };
    }
  });
  const result = await orchestrator.reconcileAndSync();
  assert.equal(result.status, "synced");
  assert.equal(pushes, 2);
  assert.equal(storage.json(MUTATION_KEYS.pending).length, 1);
  assert.equal(storage.json(MUTATION_KEYS.pending)[0].opId, protectedRow.opId);
  assert.equal(cloud.settlementAllocations.filter(row => row.operationId === protectedRow.opId).length, 1);
  assert.equal(storage.json(MUTATION_KEYS.appData).settlementAllocations
    .filter(row => row.operationId === protectedRow.opId).length, 1);
});
