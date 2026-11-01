import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMutationQueueOrchestrator
} from "../sync/mutation_queue_orchestrator.mjs";
import { MUTATION_KEYS } from "../sync/mutation_keys.mjs";

class MemoryStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const json = value => JSON.stringify(value);
const read = (storage, key, fallback = []) => {
  const raw = storage.getItem(key);
  return raw == null ? fallback : JSON.parse(raw);
};

test("legacy reconciliation never replays the five server-owned financial mutation types", async () => {
  const types = [
    "SALE_RETURN",
    "PURCHASE_RETURN",
    "INVOICE_CANCEL",
    "CUSTOMER_SETTLEMENT_ALLOCATION",
    "SUPPLIER_SETTLEMENT_ALLOCATION"
  ];
  const pending = [
    ...types.map((type, index) => ({ opId: "server-" + index, type, status: "PENDING", payload: {} })),
    { opId: "safe-local", type: "DEBT_COLLECTION", status: "PENDING", payload: {} }
  ];
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: json({ customers: [], cashMovements: [], appliedOpIds: [] }),
    [MUTATION_KEYS.pending]: json(pending),
    [MUTATION_KEYS.revision]: json("rev-1")
  });
  let receivedByReconciler;
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: { customers: [], cashMovements: [], appliedOpIds: [] }, revision: "rev-1" }),
    pushCloud: async () => ({ status: 200, revision: "rev-2" }),
    reconcile: (snapshot, operations) => {
      receivedByReconciler = operations.map(item => item.type);
      return { snapshot, review: [], appliedNow: [] };
    }
  });

  const result = await orchestrator.reconcileAndSync();
  assert.equal(result.status, "synced");
  assert.deepEqual(receivedByReconciler, ["DEBT_COLLECTION"]);
  assert.deepEqual(result.blockedServerOwned.map(item => item.type), types);
  assert.equal(read(storage, MUTATION_KEYS.pending).length, 0);
  const quarantine = read(storage, MUTATION_KEYS.quarantined);
  assert.equal(quarantine.length, 5);
  assert.ok(quarantine.every(item =>
    item.status === "QUARANTINED" &&
    item.reason === "SERVER_OWNED_FINANCIAL_MUTATION_NOT_REPLAYED_LOCALLY"
  ));
});

test("PREPARED operations are recovered from durable AppData markers before reconciliation", async () => {
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: json({ customers: [], cashMovements: [], appliedOpIds: ["persisted-op"] }),
    [MUTATION_KEYS.pending]: json([
      { opId: "persisted-op", type: "DEBT_COLLECTION", status: "PREPARED", payload: {} },
      { opId: "not-persisted", type: "DEBT_COLLECTION", status: "PREPARED", payload: {} }
    ]),
    [MUTATION_KEYS.revision]: json("rev-1")
  });
  let reconciledIds = [];
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: { customers: [], cashMovements: [], appliedOpIds: [] }, revision: "rev-1" }),
    pushCloud: async () => ({ status: 200, revision: "rev-2" }),
    reconcile: (snapshot, operations) => {
      reconciledIds = operations.map(item => item.opId);
      return { snapshot, review: [], appliedNow: [] };
    }
  });

  const result = await orchestrator.reconcileAndSync();
  assert.equal(result.status, "synced");
  assert.deepEqual(reconciledIds, ["persisted-op"]);
  assert.deepEqual(read(storage, MUTATION_KEYS.pending), []);
});

test("server-owned queue entries remain pending when cloud CAS returns 409", async () => {
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: json({ customers: [], cashMovements: [], appliedOpIds: [] }),
    [MUTATION_KEYS.pending]: json([
      { opId: "cancel-1", type: "INVOICE_CANCEL", status: "PENDING", payload: {} }
    ]),
    [MUTATION_KEYS.revision]: json("rev-1")
  });
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    maxConflictRetries: 1,
    pullCloud: async () => ({ data: { customers: [], cashMovements: [], appliedOpIds: [] }, revision: "rev-1" }),
    pushCloud: async () => ({ status: 409 }),
    reconcile: snapshot => ({ snapshot, review: [], appliedNow: [] })
  });
  const result = await orchestrator.reconcileAndSync();
  assert.equal(result.status, "conflict-limit");
  assert.equal(read(storage, MUTATION_KEYS.pending)[0].opId, "cancel-1");
  assert.deepEqual(read(storage, MUTATION_KEYS.quarantined), []);
});


test("pushCurrent restores PREPARED intent then blocks all five server-owned financial types", async () => {
  const types = [
    "SALE_RETURN",
    "PURCHASE_RETURN",
    "INVOICE_CANCEL",
    "CUSTOMER_SETTLEMENT_ALLOCATION",
    "SUPPLIER_SETTLEMENT_ALLOCATION"
  ];
  const pending = types.map((type, index) => ({
    opId: "server-owned-" + index,
    ...(index === 4 ? { operationType: type } : { type }),
    status: index === 0 ? "PREPARED" : "PENDING",
    payload: {}
  }));
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: json({
      customers: [], cashMovements: [], appliedOpIds: ["server-owned-0"]
    }),
    [MUTATION_KEYS.pending]: json(pending),
    [MUTATION_KEYS.revision]: json("rev-1")
  });
  let pushCalls = 0;
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => { throw new Error("pushCurrent must not pull or replay"); },
    pushCloud: async () => { pushCalls++; return { status: 200, revision: "rev-2" }; }
  });

  const result = await orchestrator.pushCurrent();
  assert.equal(result.status, "protected-server-owned");
  assert.equal(result.retained, 5);
  assert.deepEqual(result.blockedServerOwned.map(item => item.type), types);
  assert.equal(pushCalls, 0);
  const persisted = read(storage, MUTATION_KEYS.pending);
  assert.equal(persisted.length, 5);
  assert.ok(persisted.every(item => item.status === "PENDING"));
});
