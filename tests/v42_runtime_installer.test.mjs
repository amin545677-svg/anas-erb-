import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { installV42RuntimeWiring } from "../sync/v42_runtime_installer.mjs";
import { createMutationQueueOrchestrator, MUTATION_KEYS } from "../sync/mutation_queue_orchestrator.mjs";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function extractFunction(name, signature = "") {
  const escaped = name;
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


test("runtime wiring: actual V42 collectCustDebt captures exact 500.50 DZD movement and reconciles once after 409", async () => {
  const initial = fixture();
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(initial),
    [MUTATION_KEYS.pending]: "[]",
    [MUTATION_KEYS.rescue]: "null",
    [MUTATION_KEYS.quarantined]: "[]",
    [MUTATION_KEYS.revision]: "0"
  });
  const alerts = [];
  const elements = {};
  const context = {
    AppData: structuredClone(initial),
    Date, Math, Number, String, Set, Map, Array, Object, JSON,
    document: { getElementById: id => elements[id] || null },
    prompt: () => "500.50",
    alert: message => alerts.push(String(message)),
    console,
    updateCashUI: () => {},
    renderCustomersDebts: () => {},
    saveDB: () => {
      storage.setItem(MUTATION_KEYS.appData, JSON.stringify(context.AppData));
      return true;
    }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("collectCustDebt", "cId") + "\nglobalThis.runActualV42Collection = collectCustDebt;", context);

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
  const mapped = [];
  const windowObject = {
    anasFirebasePull: async () => "legacy-pull",
    anasFirebasePush: async () => "legacy-push"
  };
  const installer = installV42RuntimeWiring({
    windowObject, storage, orchestrator,
    getAppData: () => context.AppData,
    setAppData: value => { context.AppData = value; },
    getSaveDB: () => context.saveDB,
    setSaveDB: fn => { context.saveDB = fn; },
    mapMutation: ({ entity, kind, current, previous }) => {
      assert.equal(kind, "collection");
      const delta = current.cashMovements.filter(item =>
        !previous.cashMovements.some(old => String(old.id) === String(item.id)));
      assert.equal(delta.length, 1, "exactly one newly appended cash movement must be captured");
      assert.equal(delta[0].id, entity.id);
      assert.equal(Number(delta[0].amount), 500.5);
      assert.equal(String(delta[0].referenceId), "cust_1");
      const payload = {
        customerId: String(delta[0].referenceId),
        amount: Number(delta[0].amount),
        cashMovementId: String(delta[0].id),
        cashMovement: structuredClone(delta[0])
      };
      mapped.push(structuredClone(payload));
      return { type: "DEBT_COLLECTION", payload };
    },
    uuid: () => "runtime-collection-50050",
    now: () => new Date("2026-10-28T12:00:00.000Z")
  });

  installer.install();
  context.runActualV42Collection("cust_1");
  const pending = storage.json(MUTATION_KEYS.pending);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "PENDING");
  assert.equal(pending[0].payload.amount, 500.5);
  assert.equal(pending[0].payload.cashMovementId, context.AppData.cashMovements[0].id);
  assert.equal(context.AppData.cashMovements[0].opId, pending[0].opId);
  assert.equal(mapped.length, 1);

  const result = await windowObject.anasFirebasePush();
  assert.equal(result.status, "synced");
  assert.deepEqual(eventOrder, ["push", "pull", "push"]);
  assert.equal(cloud.revision, 2);
  assert.equal(cloud.data.caisseBalance, 54500.5);
  assert.equal(cloud.data.customers[0].debt, 25499.5);
  assert.equal(cloud.data.cashMovements.filter(m => m.id === pending[0].payload.cashMovementId).length, 1);
  assert.equal(cloud.data.cashMovements.find(m => m.id === pending[0].payload.cashMovementId).amount, 500.5);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.equal(alerts.some(message => message.includes("تم تسجيل قبض الدين")), true);
  assert.equal(installer.uninstall(), true);
});

test("runtime wrapper passes every invoice line to reconciliation and quarantines the whole sale atomically", async () => {
  const initial = {
    caisseBalance: 0,
    customers: [],
    products: [{ id: "item_a", stock: 5 }, { id: "item_b", stock: 0 }],
    invoices: [],
    cashMovements: [],
    stockMovements: [],
    appliedOpIds: []
  };
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(initial),
    [MUTATION_KEYS.pending]: "[]",
    [MUTATION_KEYS.rescue]: "null",
    [MUTATION_KEYS.quarantined]: "[]",
    [MUTATION_KEYS.revision]: "0"
  });
  let appData = structuredClone(initial);
  const invoice = {
    id: "invoice-multi-line-atomic",
    items: [
      { id: "item_a", qty: 2, price: 10 },
      { id: "item_b", qty: 1, price: 10 }
    ],
    total: 30, paid: 30, remaining: 0,
    warehouse: "المخزن الرئيسي",
    warehouseName: "المخزن الرئيسي"
  };
  appData.invoices.push(invoice);
  const cloudSeed = structuredClone(initial);
  let cloud = { data: cloudSeed, revision: 1 };
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => structuredClone(cloud),
    pushCloud: async ({ data, baseRevision }) => {
      if (baseRevision !== cloud.revision) return { status: 409 };
      cloud = { data: structuredClone(data), revision: cloud.revision + 1 };
      return { status: 200, revision: cloud.revision };
    }
  });
  let mappedLines = 0;
  const windowObject = {
    anasFirebasePull: async () => "legacy-pull",
    anasFirebasePush: async () => "legacy-push"
  };
  const installer = installV42RuntimeWiring({
    windowObject, storage, orchestrator,
    getAppData: () => appData,
    setAppData: value => { appData = value; },
    getSaveDB: () => () => {
      storage.setItem(MUTATION_KEYS.appData, JSON.stringify(appData));
      return true;
    },
    setSaveDB: () => {},
    mapMutation: ({ entity, kind }) => {
      assert.equal(kind, "sale");
      mappedLines = entity.items.length;
      return {
        type: "SALE_INVOICE",
        payload: { warehouse: entity.warehouse, invoice: structuredClone(entity) }
      };
    },
    uuid: () => "multi-line-atomic-op",
    now: () => new Date("2026-10-28T12:00:00.000Z")
  });

  installer.install();
  const saveDB = installer.wrappedSaveDB;
  assert.equal(saveDB(), true);
  assert.equal(mappedLines, 2, "both invoice lines must reach mapMutation");
  assert.equal(storage.json(MUTATION_KEYS.pending)[0].status, "PENDING");

  const result = await windowObject.anasFirebasePull();
  assert.equal(result.status, "synced");
  assert.ok(result.quarantined.some(item =>
    item.opId === storage.json(MUTATION_KEYS.quarantined)[0]?.opId &&
    item.reason === "INSUFFICIENT_CLOUD_STOCK"));
  assert.equal(cloud.data.products.find(item => item.id === "item_a").stock, 5,
    "first line must not be deducted when the second line lacks stock");
  assert.equal(cloud.data.products.find(item => item.id === "item_b").stock, 0);
  assert.deepEqual(cloud.data.invoices, [], "a quarantined invoice must not be partially committed");
  assert.equal(cloud.data.caisseBalance, 0, "cash must not be applied for a quarantined invoice");
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.equal(storage.json(MUTATION_KEYS.quarantined)[0].reason, "INSUFFICIENT_CLOUD_STOCK");
  assert.equal(installer.uninstall(), true);
});
