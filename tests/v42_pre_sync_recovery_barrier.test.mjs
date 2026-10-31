import test from "node:test";
import assert from "node:assert/strict";
import { createMutationQueueOrchestrator, MUTATION_KEYS } from "../sync/mutation_queue_orchestrator.mjs";

class MemoryStorage {
  constructor(seed = {}) { this.data = new Map(Object.entries(seed)); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
  json(key, fallback = null) {
    const raw = this.getItem(key);
    return raw == null ? structuredClone(fallback) : JSON.parse(raw);
  }
}

const operation = {
  opId: "op-pre-pull-collection-5000",
  type: "DEBT_COLLECTION",
  status: "PREPARED",
  createdAt: "2026-10-28T12:00:00.000Z",
  payload: {
    customerId: "cust_1",
    amount: 5000,
    cashMovementId: "cm_pre_pull_001",
    cashMovement: { id: "cm_pre_pull_001", amount: 5000, customerId: "cust_1" }
  }
};

const cloudV1 = () => ({
  caisseBalance: 54000,
  customers: [{ id: "cust_1", name: "عميل اختبار", debt: 26000 }],
  products: [{ id: "item_a", name: "صنف اختبار", stock: 90 }],
  invoices: [],
  cashMovements: [],
  appliedOpIds: []
});

function interruptedAfterAppDataSave() {
  const localAppData = {
    caisseBalance: 59000,
    customers: [{ id: "cust_1", name: "عميل اختبار", debt: 21000 }],
    products: [{ id: "item_a", name: "صنف اختبار", stock: 90 }],
    invoices: [],
    cashMovements: [{ id: "cm_pre_pull_001", amount: 5000, customerId: "cust_1", opId: operation.opId }],
    appliedOpIds: [operation.opId]
  };
  return new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(localAppData),
    [MUTATION_KEYS.pending]: JSON.stringify([operation]),
    [MUTATION_KEYS.rescue]: null,
    [MUTATION_KEYS.quarantined]: JSON.stringify([]),
    [MUTATION_KEYS.revision]: JSON.stringify(0)
  });
}

test("pre-pull barrier recovers PREPARED before pulling V1 and reaches expected V2 balances", async () => {
  const storage = interruptedAfterAppDataSave();
  const order = [];
  let cloud = { data: cloudV1(), revision: 1 };

  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => {
      order.push("pull");
      assert.equal(storage.json(MUTATION_KEYS.pending)[0]?.status, "PENDING",
        "PREPARED must be promoted before the first cloud pull");
      return structuredClone(cloud);
    },
    pushCloud: async ({ data, baseRevision }) => {
      order.push("push");
      assert.equal(storage.json(MUTATION_KEYS.pending)[0]?.status, "PENDING",
        "recovered operation must remain queued until cloud accepts");
      if (baseRevision !== cloud.revision) return { status: 409 };
      cloud = { data: structuredClone(data), revision: cloud.revision + 1 };
      return { status: 200, revision: cloud.revision };
    }
  });

  // Deliberately call the sync coordinator directly; no boot helper is invoked by the test.
  const result = await orchestrator.reconcileAndSync();

  assert.equal(result.status, "synced");
  assert.deepEqual(order, ["pull", "push"]);
  assert.deepEqual(result.applied, [operation.opId]);
  assert.equal(cloud.data.products[0].stock, 90);
  assert.equal(cloud.data.caisseBalance, 59000);
  assert.equal(cloud.data.customers[0].debt, 21000);
  assert.equal(cloud.data.cashMovements.filter(item => item.id === "cm_pre_pull_001").length, 1);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
});

test("pre-push barrier also resolves a PREPARED operation before an ordinary upload", async () => {
  const storage = interruptedAfterAppDataSave();
  let observedQueue = null;
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: cloudV1(), revision: 1 }),
    pushCloud: async ({ data }) => {
      observedQueue = storage.json(MUTATION_KEYS.pending);
      assert.equal(observedQueue[0]?.status, "PENDING");
      return { status: 200, revision: 2 };
    }
  });

  const result = await orchestrator.pushCurrent();

  assert.equal(result.status, "pushed");
  assert.equal(observedQueue[0].opId, operation.opId);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
});
