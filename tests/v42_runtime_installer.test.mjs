import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { installV42RuntimeWiring } from "../sync/v42_runtime_installer.mjs";
import { createMutationQueueOrchestrator, MUTATION_KEYS } from "../sync/mutation_queue_orchestrator.mjs";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function extractFunction(name, signature = "") {
  const escaped = name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\const escaped = name.replace(/[.*+?^${}()|[]\\]/g, "\\$&");");
  const match = source.match(new RegExp(
    "^        function " + escaped + "\\(" + signature + "\\) \\{[\\s\\S]*?^        \\}",
    "m"
  ));
  assert.ok(match, `Could not extract V42 function: ${name}`);
  return match[0];
}

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

function fixture() {
  return {
    caisseBalance: 54000,
    customers: [{ id: "cust_1", name: "عميل اختبار", debt: 26000 }],
    products: [{ id: "item_a", name: "صنف اختبار", stock: 90 }],
    invoices: [],
    cashMovements: [],
    stockMovements: [],
    appliedOpIds: [],
    currentUser: { id: "user_1", name: "مدير", role: "admin" }
  };
}

function cloudV1() {
  return {
    caisseBalance: 54000,
    customers: [{ id: "cust_1", name: "عميل اختبار", debt: 26000 }],
    products: [{ id: "item_a", name: "صنف اختبار", stock: 90 }],
    invoices: [],
    cashMovements: [],
    stockMovements: [],
    appliedOpIds: []
  };
}

test("runtime wiring: actual V42 sale -> PREPARED/saveDB/PENDING -> 409 -> pull/reconcile -> V2 push", async () => {
  const initial = fixture();
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(initial),
    [MUTATION_KEYS.pending]: "[]",
    [MUTATION_KEYS.rescue]: "null",
    [MUTATION_KEYS.quarantined]: "[]",
    [MUTATION_KEYS.revision]: "0"
  });
  const alerts = [];
  const elements = {
    hasibCustomerSelect: { value: "cust_1" },
    hasibPaidAmount: { value: "400" }
  };
  const context = {
    AppData: structuredClone(initial),
    posCart: [{ id: "item_a", name: "صنف اختبار", qty: 2, price: 500 }],
    lastConfirmedInvoice: null,
    Date, Math, Number, String, Set, Map, Array, Object, JSON,
    document: { getElementById: id => elements[id] || null },
    wtTryEnsureData: () => true,
    wtCurrentSaleWarehouse: () => "المخزن الرئيسي",
    wtAvailableStock: product => Number(product.stock) || 0,
    alert: message => alerts.push(String(message)),
    updateCashUI: () => {},
    renderCustomersDebts: () => {},
    renderPosTable: () => {},
    closeModal: () => {},
    console,
    saveDB: () => {
      storage.setItem(MUTATION_KEYS.appData, JSON.stringify(context.AppData));
      return true;
    }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("confirmHasibPayment") + "\nglobalThis.runActualV42Sale = confirmHasibPayment;", context);

  let cloud = { data: cloudV1(), revision: 1 };
  const eventOrder = [];
  let firstPush = true;
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => {
      eventOrder.push("pull");
      return structuredClone(cloud);
    },
    pushCloud: async ({ data, baseRevision }) => {
      eventOrder.push("push");
      if (firstPush) {
        firstPush = false;
        return { status: 409 };
      }
      if (baseRevision !== cloud.revision) return { status: 409 };
      cloud = { data: structuredClone(data), revision: cloud.revision + 1 };
      return { status: 200, revision: cloud.revision };
    }
  });

  const windowObject = {
    anasFirebasePull: async () => "legacy-destructive-pull",
    anasFirebasePush: async () => "legacy-snapshot-push"
  };
  const statuses = [];
  const installer = installV42RuntimeWiring({
    windowObject,
    storage,
    orchestrator,
    getAppData: () => context.AppData,
    setAppData: value => { context.AppData = value; },
    getSaveDB: () => context.saveDB,
    setSaveDB: fn => { context.saveDB = fn; },
    mapMutation: ({ entity, kind }) => {
      assert.equal(kind, "sale");
      return {
        type: "SALE_INVOICE",
        payload: {
          customerId: entity.customerObj?.id ?? "cust_1",
          warehouse: entity.warehouse,
          invoice: entity
        }
      };
    },
    uuid: () => "runtime-sale-001",
    now: () => new Date("2026-10-28T12:00:00.000Z"),
    onStatus: value => statuses.push(value)
  });

  installer.install();
  context.runActualV42Sale();

  const queueAfterSave = storage.json(MUTATION_KEYS.pending);
  assert.equal(queueAfterSave.length, 1);
  assert.equal(queueAfterSave[0].status, "PENDING");
  assert.equal(context.AppData.invoices[0].syncOpId, queueAfterSave[0].opId);
  assert.equal(storage.json(MUTATION_KEYS.appData).invoices[0].syncOpId, queueAfterSave[0].opId);

  const result = await windowObject.anasFirebasePush();

  assert.equal(result.status, "synced");
  assert.deepEqual(eventOrder, ["push", "pull", "push"]);
  assert.equal(cloud.revision, 2);
  assert.equal(cloud.data.products[0].stock, 88);
  assert.equal(cloud.data.caisseBalance, 54400);
  assert.equal(cloud.data.customers[0].debt, 26600);
  assert.equal(cloud.data.invoices.length, 1);
  assert.equal(cloud.data.invoices[0].syncOpId, queueAfterSave[0].opId);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.ok(statuses.some(item => item.code === "V42_SYNC_CONFLICT_RECONCILING"));

  assert.equal(installer.uninstall(), true);
  assert.equal(await windowObject.anasFirebasePull(), "legacy-destructive-pull",
    "uninstall restores the legacy pull function; staging must keep restore distinct from operational reconcile");
});
