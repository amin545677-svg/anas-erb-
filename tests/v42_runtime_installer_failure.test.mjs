import test from "node:test";
import assert from "node:assert/strict";
import { installV42RuntimeWiring } from "../sync/v42_runtime_installer.mjs";
import { MUTATION_KEYS } from "../sync/mutation_queue_orchestrator.mjs";

class MemoryStorage {
  constructor(seed = {}) { this.values = new Map(Object.entries(seed)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  json(key, fallback = null) {
    const raw = this.getItem(key);
    return raw == null ? structuredClone(fallback) : JSON.parse(raw);
  }
}

test("saveDB false removes PREPARED and reverts only bridge metadata before V42 rollback", () => {
  const before = {
    invoices: [],
    cashMovements: [],
    products: [{ id: "item_a", stock: 10 }],
    appliedOpIds: ["previous-op"]
  };
  const appData = {
    ...structuredClone(before),
    invoices: [{ id: "invoice_new", total: 100, paid: 100, remaining: 0, items: [{ id: "item_a", qty: 1, price: 100 }] }]
  };
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(before),
    [MUTATION_KEYS.pending]: "[]",
    [MUTATION_KEYS.rescue]: "null"
  });
  const windowObject = { anasFirebasePull: async () => "old-pull", anasFirebasePush: async () => "old-push" };
  let saveDB = () => false;
  const installer = installV42RuntimeWiring({
    windowObject,
    storage,
    orchestrator: { pushCurrent: async () => ({ status: "pushed" }), reconcileAndSync: async () => ({ status: "synced" }) },
    getAppData: () => appData,
    setAppData: () => {},
    getSaveDB: () => saveDB,
    setSaveDB: fn => { saveDB = fn; },
    mapMutation: ({ entity }) => ({ type: "SALE_INVOICE", payload: { invoice: entity } }),
    uuid: () => "failed-save-op",
    now: () => new Date("2026-10-28T12:00:00.000Z")
  });

  installer.install();
  assert.equal(saveDB(), false);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.deepEqual(appData.appliedOpIds, ["previous-op"]);
  assert.equal(appData.invoices[0].syncOpId, undefined);
  assert.equal(appData.invoices[0].syncCreatedAt, undefined);
  assert.equal(installer.uninstall(), true);
});


test("runtime pull entrypoint routes to reconciliation and surfaces quarantine instead of legacy snapshot replacement", async () => {
  const appData = { invoices: [], cashMovements: [], appliedOpIds: [] };
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(appData),
    [MUTATION_KEYS.pending]: "[]",
    [MUTATION_KEYS.rescue]: "null"
  });
  const order = [];
  const warnings = [];
  let saveDB = () => true;
  const windowObject = {
    anasFirebasePull: async () => { order.push("legacy-pull"); return "legacy"; },
    anasFirebasePush: async () => "legacy-push"
  };
  const installer = installV42RuntimeWiring({
    windowObject,
    storage,
    orchestrator: {
      pushCurrent: async () => ({ status: "pushed" }),
      reconcileAndSync: async () => {
        order.push("reconcile");
        return { status: "synced", quarantined: [{ opId: "op_sale_review", reason: "INSUFFICIENT_CLOUD_STOCK" }] };
      }
    },
    getAppData: () => appData,
    setAppData: () => {},
    getSaveDB: () => saveDB,
    setSaveDB: fn => { saveDB = fn; },
    mapMutation: () => null,
    uuid: () => "unused-op",
    onQuarantine: items => warnings.push(...items)
  });

  installer.install();
  const result = await windowObject.anasFirebasePull();

  assert.equal(result.status, "synced");
  assert.deepEqual(order, ["reconcile"]);
  assert.deepEqual(warnings, [{ opId: "op_sale_review", reason: "INSUFFICIENT_CLOUD_STOCK" }]);
  assert.equal(installer.uninstall(), true);
});


test("queue promotion failure after successful saveDB restores the previous AppData snapshot", () => {
  const previous = {
    invoices: [],
    cashMovements: [],
    products: [{ id: "item_a", stock: 10 }],
    appliedOpIds: ["prior-op"]
  };
  let appData = {
    ...structuredClone(previous),
    invoices: [{ id: "invoice_new", total: 100, paid: 100, remaining: 0, items: [{ id: "item_a", qty: 1, price: 100 }] }]
  };
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(previous),
    [MUTATION_KEYS.pending]: "[]",
    [MUTATION_KEYS.rescue]: "null"
  });
  const originalSetItem = storage.setItem.bind(storage);
  let injected = false;
  storage.setItem = (key, value) => {
    if (key === MUTATION_KEYS.pending && !injected) {
      const queue = JSON.parse(String(value));
      if (queue.some(item => item?.status === "PENDING")) {
        injected = true;
        throw new Error("injected PREPARED-to-PENDING promotion failure");
      }
    }
    return originalSetItem(key, value);
  };

  const statuses = [];
  let saveDB = () => {
    storage.setItem(MUTATION_KEYS.appData, JSON.stringify(appData));
    return true;
  };
  const windowObject = { anasFirebasePull: async () => "old-pull", anasFirebasePush: async () => "old-push" };
  const installer = installV42RuntimeWiring({
    windowObject,
    storage,
    orchestrator: { pushCurrent: async () => ({ status: "pushed" }), reconcileAndSync: async () => ({ status: "synced" }) },
    getAppData: () => appData,
    setAppData: value => { appData = value; },
    getSaveDB: () => saveDB,
    setSaveDB: fn => { saveDB = fn; },
    mapMutation: ({ entity }) => ({ type: "SALE_INVOICE", payload: { invoice: entity } }),
    uuid: () => "promotion-failure-op",
    now: () => new Date("2026-10-28T12:00:00.000Z"),
    onStatus: value => statuses.push(value)
  });

  installer.install();
  assert.equal(saveDB(), false, "failed queue promotion must make V42 save path report failure");
  assert.equal(injected, true, "the test must fail specifically during PREPARED -> PENDING");
  assert.deepEqual(appData, previous, "in-memory AppData must be restored");
  assert.deepEqual(storage.json(MUTATION_KEYS.appData), previous, "persisted AppData must be restored");
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), [], "the failed operation must not remain queued");
  assert.ok(statuses.some(item => item.code === "V42_QUEUE_PROMOTION_FAILED"));
  assert.equal(installer.uninstall(), true);
});

test("reconciliation save is suppressed from local mutation capture to prevent re-entrant phantom operations", async () => {
  const previous = { invoices: [], cashMovements: [], products: [{ id: "item_a", stock: 5 }], appliedOpIds: [] };
  let appData = {
    ...structuredClone(previous),
    invoices: [{ id: "cloud-merged-invoice", total: 10, paid: 10, remaining: 0, items: [{ id: "item_a", qty: 1, price: 10 }] }]
  };
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(previous),
    [MUTATION_KEYS.pending]: "[]",
    [MUTATION_KEYS.rescue]: "null"
  });
  let saveDB = () => {
    storage.setItem(MUTATION_KEYS.appData, JSON.stringify(appData));
    return true;
  };
  let mapCalls = 0;
  const windowObject = { anasFirebasePull: async () => "old-pull", anasFirebasePush: async () => "old-push" };
  const installer = installV42RuntimeWiring({
    windowObject,
    storage,
    orchestrator: {
      pushCurrent: async () => ({ status: "pushed" }),
      reconcileAndSync: async () => {
        assert.equal(saveDB(), true, "reconciliation may persist its merged snapshot");
        return { status: "synced", quarantined: [] };
      }
    },
    getAppData: () => appData,
    setAppData: value => { appData = value; },
    getSaveDB: () => saveDB,
    setSaveDB: fn => { saveDB = fn; },
    mapMutation: () => { mapCalls++; return { type: "SALE_INVOICE", payload: {} }; },
    uuid: () => "must-not-be-created",
    now: () => new Date("2026-10-28T12:00:00.000Z")
  });

  installer.install();
  const result = await windowObject.anasFirebasePull();
  assert.equal(result.status, "synced");
  assert.equal(mapCalls, 0, "saveDB called inside reconciliation must bypass operation capture");
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.equal(appData.invoices[0].syncOpId, undefined);
  assert.deepEqual(storage.json(MUTATION_KEYS.appData).invoices.map(item => item.id), ["cloud-merged-invoice"]);
  assert.equal(installer.uninstall(), true);
});
