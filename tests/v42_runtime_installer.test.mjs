import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { installV42RuntimeWiring } from "../sync/v42_runtime_installer.mjs";
import { createMutationQueueOrchestrator, MUTATION_KEYS } from "../sync/mutation_queue_orchestrator.mjs";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const reverseLedgerSource = readFileSync(new URL("../reverse-ledger/reverse-ledger.js", import.meta.url), "utf8");

function extractFunction(name, signature = "") {
  const escaped = name;
  const match = source.match(new RegExp(
    "^        (?:async\\s+)?function " + escaped + "\\(" + signature + "\\) \\{[\\s\\S]*?^        \\}",
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

function collectionFixture() {
  const data = fixture();
  data.invoices = [{ id: "inv_1", customerId: "cust_1", total: 26000, paid: 0, remaining: 26000, invoiceLedgerVersion: 2 }];
  return data;
}

function collectionCloudV1() {
  const data = cloudV1();
  data.invoices = [{ id: "inv_1", customerId: "cust_1", total: 26000, paid: 0, remaining: 26000, invoiceLedgerVersion: 2 }];
  return data;
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

test("runtime wiring captures actual V42 cash sale and reconciles all ledgers atomically after 409", async () => {
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
    hasibCustomerSelect: { value: "" },
    hasibPaidAmount: { value: "1000" }
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
    },
    saveDBDurably: async () => true
  };
  vm.createContext(context);
  vm.runInContext([reverseLedgerSource, extractFunction("anasDecimalToScaledInteger", "value, decimalPlaces"), extractFunction("anasToCents", "value"), extractFunction("anasToQtyUnits", "value"), extractFunction("anasCentsToCurrency", "cents"), extractFunction("anasQtyFromUnits", "units"),
      extractFunction("anasLineTotalCents", "qtyUnits, priceCents"), "const ANAS_QTY_SCALE = 1000000;", extractFunction("confirmHasibPayment"), "globalThis.runActualV42Sale = confirmHasibPayment;"].join("\n"), context);

  let cloud = { data: collectionCloudV1(), revision: 1 };
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
    anasFirebasePush: async () => "legacy-snapshot-push",
    anasFirebaseSyncPull: async () => "legacy-sync-pull",
    anasFirebaseSyncPush: async () => "legacy-sync-push"
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
    getSaveDBDurably: () => context.saveDBDurably,
    setSaveDBDurably: fn => { context.saveDBDurably = fn; },
    mapMutation: ({ entity, kind }) => {
      assert.equal(kind, "sale");
      return {
        type: "SALE_INVOICE",
        payload: {
          customerId: entity.customerObj?.id ?? null,
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
  assert.equal(await windowObject.anasFirebasePush(), "legacy-snapshot-push",
    "manual backup upload must not be replaced by operational sync");
  assert.equal(await windowObject.anasFirebasePull(), "legacy-destructive-pull",
    "manual snapshot restore must remain a separate explicit action");
  context.runActualV42Sale();

  let pending = storage.json(MUTATION_KEYS.pending);
  assert.equal(pending.length, 1, "the real V42 invoice must be captured as one prepared operation");
  assert.equal(pending[0].status, "PREPARED", "the queue must not become replayable before durable AppData acknowledgement");
  await context.saveDBDurably();
  pending = storage.json(MUTATION_KEYS.pending);
  assert.equal(pending[0].type, "SALE_INVOICE");
  assert.equal(pending[0].status, "PENDING");
  assert.equal(pending[0].payload.v42Ledger.cashMovements.length, 1);
  assert.equal(pending[0].payload.v42Ledger.stockMovements.length, 1);
  assert.equal(context.AppData.invoices.length, 1);
  assert.equal(context.AppData.products[0].stock, 88);
  assert.equal(context.AppData.caisseBalance, 55000);
  assert.equal(context.AppData.cashMovements.length, 1);
  assert.equal(context.AppData.stockMovements.length, 1);
  assert.equal(alerts.some(message => message.includes("لم يتم تأكيد الفاتورة")), false);

  const result = await windowObject.anasFirebaseSyncPush();
  assert.equal(result.status, "synced");
  assert.deepEqual(eventOrder, ["push", "pull", "push"]);
  assert.equal(cloud.revision, 2);
  assert.equal(cloud.data.products[0].stock, 88);
  assert.equal(cloud.data.caisseBalance, 55000);
  assert.equal(cloud.data.invoices.filter(row => row?.syncOpId === pending[0].opId).length, 1);
  assert.equal(cloud.data.cashMovements.filter(row => row.referenceId === pending[0].payload.invoice.id).length, 1);
  assert.equal(cloud.data.stockMovements.filter(row => row.referenceId === pending[0].payload.invoice.id).length, 1);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.equal(installer.uninstall(), true);
  assert.equal(await windowObject.anasFirebasePull(), "legacy-destructive-pull");
  assert.equal(await windowObject.anasFirebaseSyncPull(), "legacy-sync-pull",
    "uninstall restores the prior operational sync function");
});


test("runtime wiring: actual V42 collectCustDebt captures exact 500.50 DZD movement and reconciles once after 409", async () => {
  const initial = collectionFixture();
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
    },
    saveDBDurably: async () => true
  };
  vm.createContext(context);
  vm.runInContext([reverseLedgerSource, extractFunction("anasDecimalToScaledInteger", "value, decimalPlaces"), extractFunction("anasToCents", "value"), extractFunction("anasCentsToCurrency", "cents"), "const ANAS_QTY_SCALE = 1000000;", extractFunction("collectCustDebt", "cId"), "globalThis.runActualV42Collection = collectCustDebt;"].join("\n"), context);

  let cloud = { data: collectionCloudV1(), revision: 1 };
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
    getSaveDBDurably: () => context.saveDBDurably,
    setSaveDBDurably: fn => { context.saveDBDurably = fn; },
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
  await context.runActualV42Collection("cust_1");
  const pending = storage.json(MUTATION_KEYS.pending);
  assert.equal(pending.length, 1, JSON.stringify({
    alerts, mapped, cashMovements: context.AppData.cashMovements,
    clientMovements: context.AppData.clientMovements,
    settlementAllocations: context.AppData.settlementAllocations
  }));
  assert.equal(pending[0].status, "PENDING");
  assert.equal(pending[0].payload.amount, 500.5);
  assert.equal(pending[0].payload.v42Ledger.clientMovements.length, 2);
  assert.equal(pending[0].payload.v42Ledger.settlementAllocations.length, 1);
  assert.equal(pending[0].payload.cashMovementId, context.AppData.cashMovements[0].id);
  assert.equal(context.AppData.cashMovements[0].opId, pending[0].opId);
  assert.equal(mapped.length, 1);

  const result = await windowObject.anasFirebaseSyncPush();
  assert.equal(result.status, "synced");
  assert.deepEqual(eventOrder, ["push", "pull", "push"]);
  assert.equal(cloud.revision, 2);
  assert.equal(cloud.data.caisseBalance, 54500.5);
  assert.equal(cloud.data.customers[0].debt, 25499.5);
  assert.equal(cloud.data.cashMovements.filter(m => m.id === pending[0].payload.cashMovementId).length, 1);
  assert.equal(cloud.data.cashMovements.find(m => m.id === pending[0].payload.cashMovementId).amount, 500.5);
  assert.equal(cloud.data.clientMovements.filter(m => m.type === "receipt" && m.amountCentimes === 50050).length, 1);
  assert.equal(cloud.data.clientMovements.filter(m => m.type === "opening_balance" && m.amountCentimes === 2600000).length, 1);
  assert.equal(cloud.data.settlementAllocations.filter(a => a.sourceMovementId === pending[0].payload.cashMovementId).length, 1);
  assert.equal(cloud.data.customers[0].ledgerVersion, 2);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.equal(alerts.some(message => message.includes("تم تسجيل سند القبض وتوزيعه تلقائياً FIFO")), true);
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

  const result = await windowObject.anasFirebaseSyncPull();
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


test("runtime wiring keeps unsupported cash movements local and blocks cloud sync", async () => {
  const initial = fixture();
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(initial),
    [MUTATION_KEYS.pending]: "[]"
  });
  const current = structuredClone(initial);
  current.caisseBalance -= 250;
  current.cashMovements.push({
    id: "expense-001", type: "subtract", referenceType: "expense",
    referenceId: "supplier_1", amount: 250
  });
  let persisted = false;
  const windowObject = {};
  const orchestrator = {
    pushCurrent: async () => ({ status: "pushed" }),
    reconcileAndSync: async () => ({ status: "synced" })
  };
  const installer = installV42RuntimeWiring({
    windowObject, storage, orchestrator,
    getAppData: () => current,
    setAppData: () => {},
    getSaveDB: () => () => { persisted = true; storage.setItem(MUTATION_KEYS.appData, JSON.stringify(current)); return true; },
    setSaveDB: () => {},
    mapMutation: () => { throw new Error("mapper must not classify an expense as a collection"); }
  });
  installer.install();
  assert.equal(installer.wrappedSaveDB(), true);
  assert.equal(persisted, true, "unsupported business movements must remain usable in local mode");
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.equal(JSON.parse(storage.getItem(MUTATION_KEYS.appData)).cashMovements.length, 1);
  assert.ok(storage.getItem(MUTATION_KEYS.unsupported), "the local-only sync barrier must persist across reloads");
  assert.equal((await windowObject.anasFirebaseSyncPush()).status, "blocked-unsupported-local-mutations");
  assert.equal((await windowObject.anasFirebaseSyncPull()).status, "blocked-unsupported-local-mutations");
  installer.uninstall();
});

test("runtime wiring keeps multi-invoice batches local and blocks unsafe cloud replay", async () => {
  const initial = fixture();
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(initial),
    [MUTATION_KEYS.pending]: "[]"
  });
  const current = structuredClone(initial);
  current.invoices.push({ id: "invoice-1", items: [], total: 10 });
  current.invoices.push({ id: "invoice-2", items: [], total: 20 });
  let persisted = false;
  const installer = installV42RuntimeWiring({
    windowObject: {}, storage,
    orchestrator: { pushCurrent: async () => ({}), reconcileAndSync: async () => ({}) },
    getAppData: () => current, setAppData: () => {},
    getSaveDB: () => () => { persisted = true; return true; }, setSaveDB: () => {},
    mapMutation: () => ({ type: "SALE_INVOICE", payload: { invoice: {} } })
  });
  installer.install();
  assert.equal(installer.wrappedSaveDB(), true);
  assert.equal(persisted, true);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.ok(storage.getItem(MUTATION_KEYS.unsupported));
  assert.equal((await installer.wrappedPush()).status, "blocked-unsupported-local-mutations");
  installer.uninstall();
});


test("runtime wiring preserves unsupported financial changes locally and persists a cloud-sync barrier", async () => {
  for (const mutate of [
    data => { data.products[0].stock -= 3; },
    data => { data.products[0].warehouseStock = { "مخزن ثانوي": 3 }; },
    data => { data.caisseBalance += 75; },
    data => { data.customers[0].debt -= 75; },
    data => { data.purchases = [...(data.purchases || []), { id: "purchase-untracked" }]; },
    data => { data.expenses = [...(data.expenses || []), { id: "expense-untracked" }]; },
    data => { data.truckTrips = [...(data.truckTrips || []), { id: "trip-untracked" }]; },
    data => { data.warehouseTransfers = [...(data.warehouseTransfers || []), { id: "transfer-untracked" }]; },
    data => { data.suppliers = [...(data.suppliers || []), { id: "supplier-untracked", balance: 25 }]; },
    data => { data.stocktakeRecords = [...(data.stocktakeRecords || []), { id: "stocktake-untracked" }]; }
  ]) {
    const initial = fixture();
    const current = structuredClone(initial);
    mutate(current);
    const storage = new MemoryStorage({
      [MUTATION_KEYS.appData]: JSON.stringify(initial),
      [MUTATION_KEYS.pending]: "[]"
    });
    let persisted = false;
    const installer = installV42RuntimeWiring({
      windowObject: {}, storage,
      orchestrator: { pushCurrent: async () => ({}), reconcileAndSync: async () => ({}) },
      getAppData: () => current, setAppData: () => {},
      getSaveDB: () => () => { persisted = true; return true; }, setSaveDB: () => {},
      mapMutation: () => null
    });
    installer.install();
    assert.equal(installer.wrappedSaveDB(), true);
    assert.equal(persisted, true, "existing local ERP modules must not be disabled by missing sync adapters");
    assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
    assert.ok(storage.getItem(MUTATION_KEYS.unsupported));
    assert.equal((await installer.wrappedPush()).status, "blocked-unsupported-local-mutations");
    installer.uninstall();
  }
});

test("runtime wiring still permits nonfinancial settings persistence", () => {
  const initial = fixture();
  const current = structuredClone(initial);
  current.settings = { theme: "classic", language: "ar" };
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(initial),
    [MUTATION_KEYS.pending]: "[]"
  });
  let persisted = false;
  const installer = installV42RuntimeWiring({
    windowObject: {}, storage,
    orchestrator: { pushCurrent: async () => ({}), reconcileAndSync: async () => ({}) },
    getAppData: () => current, setAppData: () => {},
    getSaveDB: () => () => { persisted = true; storage.setItem(MUTATION_KEYS.appData, JSON.stringify(current)); return true; },
    setSaveDB: () => {},
    mapMutation: () => null
  });
  installer.install();
  assert.equal(installer.wrappedSaveDB(), true);
  assert.equal(persisted, true);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  installer.uninstall();
});


test("runtime wiring rejects unrelated business writes bundled with a supported sale or collection", () => {
  {
    const initial = fixture();
    const current = structuredClone(initial);
    current.invoices.push({
      id: "invoice-with-extra-purchase",
      items: [{ id: "item_a", qty: 1, price: 100 }],
      total: 100, paid: 100, remaining: 0
    });
    current.purchases = [{ id: "purchase-unrelated-to-sale", qty: 1, cost: 50, total: 50 }];
    const storage = new MemoryStorage({
      [MUTATION_KEYS.appData]: JSON.stringify(initial),
      [MUTATION_KEYS.pending]: "[]"
    });
    let persisted = false;
    const installer = installV42RuntimeWiring({
      windowObject: {}, storage,
      orchestrator: { pushCurrent: async () => ({}), reconcileAndSync: async () => ({}) },
      getAppData: () => current, setAppData: () => {},
      getSaveDB: () => () => { persisted = true; return true; }, setSaveDB: () => {},
      mapMutation: ({ entity }) => ({ type: "SALE_INVOICE", payload: { invoice: structuredClone(entity) } })
    });
    installer.install();
    assert.throws(() => installer.wrappedSaveDB(), /Unsupported additional business collection change/);
    assert.equal(persisted, false, "sale must not persist alongside an unsupported purchase");
    assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
    installer.uninstall();
  }

  {
    const initial = fixture();
    const current = structuredClone(initial);
    current.caisseBalance += 50;
    current.customers[0].debt -= 50;
    current.cashMovements.push({
      id: "collection-with-extra-stock-change",
      type: "add",
      referenceType: "customer_debt",
      referenceId: "cust_1",
      amount: 50
    });
    current.products[0].warehouseStock = { "مخزن ثانوي": 4 };
    const storage = new MemoryStorage({
      [MUTATION_KEYS.appData]: JSON.stringify(initial),
      [MUTATION_KEYS.pending]: "[]"
    });
    let persisted = false;
    const installer = installV42RuntimeWiring({
      windowObject: {}, storage,
      orchestrator: { pushCurrent: async () => ({}), reconcileAndSync: async () => ({}) },
      getAppData: () => current, setAppData: () => {},
      getSaveDB: () => () => { persisted = true; return true; }, setSaveDB: () => {},
      mapMutation: ({ entity }) => ({
        type: "DEBT_COLLECTION",
        payload: {
          customerId: entity.referenceId,
          amount: entity.amount,
          cashMovementId: entity.id,
          cashMovement: structuredClone(entity)
        }
      })
    });
    installer.install();
    assert.throws(() => installer.wrappedSaveDB(), /Unsupported additional business collection change/);
    assert.equal(persisted, false, "collection must not persist alongside an unsupported warehouse-stock change");
    assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
    installer.uninstall();
  }
});

test("runtime wiring posts actual V42 partial and credit sales as complete composite mutations after HTTP 409", async () => {
  for (const scenario of [
    { name: "partial", paid: "400", expectedCash: 54400, expectedDebt: 26600, paidCentimes: 40000, remainingCentimes: 60000 },
    { name: "credit", paid: "0", expectedCash: 54000, expectedDebt: 27000, paidCentimes: 0, remainingCentimes: 100000 }
  ]) {
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
      hasibPaidAmount: { value: scenario.paid },
      hasibPaymentChannel: { value: "cash" }
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
      },
      saveDBDurably: async () => true
    };
    vm.createContext(context);
    vm.runInContext([
      reverseLedgerSource,
      extractFunction("anasDecimalToScaledInteger", "value, decimalPlaces"),
      extractFunction("anasToCents", "value"),
      extractFunction("anasToQtyUnits", "value"),
      extractFunction("anasCentsToCurrency", "cents"),
      extractFunction("anasQtyFromUnits", "units"),
      extractFunction("anasLineTotalCents", "qtyUnits, priceCents"),
      "const ANAS_QTY_SCALE = 1000000;",
      extractFunction("confirmHasibPayment"),
      "globalThis.runActualV42Sale = confirmHasibPayment;"
    ].join("\n"), context);

    let cloud = { data: cloudV1(), revision: 1 };
    let firstPush = true;
    const eventOrder = [];
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
    const windowObject = {};
    const installer = installV42RuntimeWiring({
      windowObject,
      storage,
      orchestrator,
      getAppData: () => context.AppData,
      setAppData: value => { context.AppData = value; },
      getSaveDB: () => context.saveDB,
      setSaveDB: fn => { context.saveDB = fn; },
      getSaveDBDurably: () => context.saveDBDurably,
      setSaveDBDurably: fn => { context.saveDBDurably = fn; },
      mapMutation: ({ entity, kind }) => {
        assert.equal(kind, "sale");
        return {
          type: "SALE_INVOICE",
          payload: {
            customerId: entity.customerObj?.id ?? null,
            warehouse: entity.warehouse,
            invoice: entity
          }
        };
      },
      uuid: () => "runtime-sale-" + scenario.name,
      now: () => new Date("2026-10-28T12:00:00.000Z")
    });

    installer.install();
    context.runActualV42Sale();
    assert.equal(await context.saveDBDurably(), true);
    const pending = storage.json(MUTATION_KEYS.pending);
    assert.equal(pending.length, 1, scenario.name + ": exactly one operation must be journaled");
    assert.equal(pending[0].status, "PENDING");
    assert.equal(pending[0].type, "SALE_INVOICE");
    assert.equal(pending[0].payload.invoice.total, 1000);
    assert.equal(pending[0].payload.invoice.paid, scenario.paidCentimes / 100);
    assert.equal(pending[0].payload.invoice.remaining, scenario.remainingCentimes / 100);
    assert.equal(pending[0].payload.v42Ledger.cashMovements.length, scenario.paidCentimes > 0 ? 1 : 0);
    assert.equal(pending[0].payload.v42Ledger.stockMovements.length, 1);
    assert.equal(pending[0].payload.v42Ledger.clientMovements.filter(row => row.type === "invoice_debit").length, 1);
    assert.equal(pending[0].payload.v42Ledger.clientMovements.find(row => row.type === "invoice_debit").amountCentimes, scenario.remainingCentimes);
    assert.equal(pending[0].payload.v42Ledger.settlementAllocations.length, scenario.paidCentimes > 0 ? 1 : 0);
    assert.equal(pending[0].payload.v42Ledger.auditTrail.length, 1);
    assert.equal(pending[0].payload.v42Ledger.auditTrail[0].eventType, "SALE_COMMITTED");
    assert.equal(pending[0].payload.v42Ledger.auditTrail[0].opId, pending[0].opId);
    assert.equal(pending[0].payload.v42Ledger.auditTrail[0].amountCentimes, 100000);
    const stableOpId = pending[0].opId;

    const result = await windowObject.anasFirebaseSyncPush();
    assert.equal(result.status, "synced", scenario.name + ": 409 must reconcile and safely retry");
    assert.deepEqual(eventOrder, ["push", "pull", "push"]);
    assert.equal(cloud.revision, 2);
    assert.equal(cloud.data.products[0].stock, 88);
    assert.equal(cloud.data.caisseBalance, scenario.expectedCash);
    assert.equal(cloud.data.customers[0].debt, scenario.expectedDebt);
    assert.equal(cloud.data.invoices.filter(row => row?.syncOpId === stableOpId).length, 1);
    assert.equal(cloud.data.auditTrail.filter(row => row?.opId === stableOpId).length, 1);
    assert.equal(cloud.data.stockMovements.filter(row => row.referenceId === pending[0].payload.invoice.id).length, 1);
    assert.equal(cloud.data.cashMovements.filter(row => row.referenceId === pending[0].payload.invoice.id).length, scenario.paidCentimes > 0 ? 1 : 0);
    assert.equal(cloud.data.clientMovements.filter(row => row.type === "invoice_debit" && row.referenceId === pending[0].payload.invoice.id && row.amountCentimes === scenario.remainingCentimes).length, 1);
    assert.equal(cloud.data.settlementAllocations.filter(row => row.sourceMovementId === (pending[0].payload.v42Ledger.cashMovements[0]?.id ?? "")).length, scenario.paidCentimes > 0 ? 1 : 0);
    assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
    assert.equal(alerts.some(message => message.includes("لم يتم تأكيد الفاتورة")), false);
    assert.equal(installer.uninstall(), true);
  }
});

test("actual V42 durable truck sale reconciles only warehouseStock after HTTP 409 and commits opId audit", async () => {
  const initial = fixture();
  initial.products[0].warehouseStock = { "شاحنة 1": 12 };
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(initial),
    [MUTATION_KEYS.pending]: "[]",
    [MUTATION_KEYS.rescue]: "null",
    [MUTATION_KEYS.quarantined]: "[]",
    [MUTATION_KEYS.revision]: "0"
  });
  const alerts = [];
  const elements = {
    hasibCustomerSelect: { value: "" },
    hasibPaidAmount: { value: "1000" },
    hasibPaymentChannel: { value: "cash" }
  };
  const context = {
    AppData: structuredClone(initial),
    posCart: [{ id: "item_a", name: "صنف اختبار", qty: 2, price: 500 }],
    lastConfirmedInvoice: null,
    Date, Math, Number, String, Set, Map, Array, Object, JSON, BigInt, structuredClone,
    document: { getElementById: id => elements[id] || null },
    wtTryEnsureData: () => true,
    wtCurrentSaleWarehouse: () => "شاحنة 1",
    wtAvailableStock: (product, warehouse) => Number(product.warehouseStock?.[warehouse] ?? 0),
    anasGetPosCartDiscountCents: () => 0,
    alert: message => alerts.push(String(message)),
    updateCashUI: () => {},
    renderCustomersDebts: () => {},
    renderPosTable: () => {},
    closeModal: () => {},
    showInvoicePostSaveActions: () => {},
    console,
    saveDB: () => {
      storage.setItem(MUTATION_KEYS.appData, JSON.stringify(context.AppData));
      return true;
    },
    saveDBDurably: async () => true
  };
  vm.createContext(context);
  vm.runInContext([
    reverseLedgerSource,
    extractFunction("anasDecimalToScaledInteger", "value, decimalPlaces"),
    extractFunction("anasToCents", "value"),
    extractFunction("anasToQtyUnits", "value"),
    extractFunction("anasCentsToCurrency", "cents"),
    extractFunction("anasQtyFromUnits", "units"),
    extractFunction("anasLineTotalCents", "qtyUnits, priceCents"),
    "const ANAS_QTY_SCALE = 1000000;",
    extractFunction("confirmHasibPaymentDurable"),
    "globalThis.runActualV42Sale = confirmHasibPaymentDurable;"
  ].join("\n"), context);

  let cloud = { data: cloudV1(), revision: 1 };
  cloud.data.products[0].warehouseStock = { "شاحنة 1": 12 };
  let firstPush = true;
  const eventOrder = [];
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
  const windowObject = {};
  const installer = installV42RuntimeWiring({
    windowObject, storage, orchestrator,
    getAppData: () => context.AppData,
    setAppData: value => { context.AppData = value; },
    getSaveDB: () => context.saveDB,
    setSaveDB: fn => { context.saveDB = fn; },
    getSaveDBDurably: () => context.saveDBDurably,
    setSaveDBDurably: fn => { context.saveDBDurably = fn; },
    mapMutation: ({ entity, kind }) => {
      assert.equal(kind, "sale");
      return {
        type: "SALE_INVOICE",
        payload: {
          customerId: entity.customerObj?.id ?? null,
          warehouse: entity.warehouse,
          invoice: entity
        }
      };
    },
    uuid: () => "runtime-truck-sale-001",
    now: () => new Date("2026-10-28T12:00:00.000Z")
  });
  installer.install();

  assert.equal(await context.runActualV42Sale(), true);
  const pending = storage.json(MUTATION_KEYS.pending);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "PENDING");
  assert.equal(pending[0].type, "SALE_INVOICE");
  assert.equal(pending[0].payload.invoice.warehouse, "شاحنة 1");
  assert.equal(pending[0].payload.v42Ledger.stockMovements.length, 1);
  assert.equal(pending[0].payload.v42Ledger.stockMovements[0].warehouse, "شاحنة 1");
  assert.equal(pending[0].payload.v42Ledger.auditTrail.length, 1);
  const opId = pending[0].opId;
  assert.equal(pending[0].payload.v42Ledger.auditTrail[0].opId, opId);
  assert.equal(context.AppData.auditTrail[0].opId, opId);
  assert.equal(context.AppData.products[0].stock, 90, "main warehouse stock must not be changed by a truck sale");
  assert.equal(context.AppData.products[0].warehouseStock["شاحنة 1"], 10);

  const result = await windowObject.anasFirebaseSyncPush();
  assert.equal(result.status, "synced");
  assert.deepEqual(eventOrder, ["push", "pull", "push"]);
  assert.equal(cloud.revision, 2);
  assert.equal(cloud.data.products[0].stock, 90, "cloud main warehouse stock must remain unchanged");
  assert.equal(cloud.data.products[0].warehouseStock["شاحنة 1"], 10, "cloud truck stock must be decremented exactly once");
  assert.equal(cloud.data.caisseBalance, 55000);
  assert.equal(cloud.data.invoices.filter(row => row?.syncOpId === opId).length, 1);
  assert.equal(cloud.data.stockMovements.filter(row => row.referenceId === pending[0].payload.invoice.id && row.warehouse === "شاحنة 1").length, 1);
  assert.equal(cloud.data.auditTrail.filter(row => row?.opId === opId && row.eventType === "SALE_COMMITTED").length, 1);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.equal(alerts.some(message => message.includes("لم يتم تأكيد الفاتورة")), false);
  assert.equal(installer.uninstall(), true);
});

test("actual V42 sale rollback removes audit, invoice, truck stock and cash changes when saveDB rejects", async () => {
  const initial = fixture();
  initial.products[0].warehouseStock = { "شاحنة 1": 12 };
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify(initial),
    [MUTATION_KEYS.pending]: "[]",
    [MUTATION_KEYS.rescue]: "null",
    [MUTATION_KEYS.quarantined]: "[]",
    [MUTATION_KEYS.revision]: "0"
  });
  const alerts = [];
  const elements = {
    hasibCustomerSelect: { value: "" },
    hasibPaidAmount: { value: "1000" },
    hasibPaymentChannel: { value: "cash" }
  };
  const context = {
    AppData: structuredClone(initial),
    posCart: [{ id: "item_a", name: "صنف اختبار", qty: 2, price: 500 }],
    lastConfirmedInvoice: null,
    Date, Math, Number, String, Set, Map, Array, Object, JSON, BigInt, structuredClone,
    document: { getElementById: id => elements[id] || null },
    wtTryEnsureData: () => true,
    wtCurrentSaleWarehouse: () => "شاحنة 1",
    wtAvailableStock: (product, warehouse) => Number(product.warehouseStock?.[warehouse] ?? 0),
    anasGetPosCartDiscountCents: () => 0,
    alert: message => alerts.push(String(message)),
    updateCashUI: () => {},
    renderCustomersDebts: () => {},
    renderPosTable: () => {},
    closeModal: () => {},
    showInvoicePostSaveActions: () => {},
    console,
    saveDB: () => false,
    saveDBDurably: async () => true
  };
  vm.createContext(context);
  vm.runInContext([
    reverseLedgerSource,
    extractFunction("anasDecimalToScaledInteger", "value, decimalPlaces"),
    extractFunction("anasToCents", "value"),
    extractFunction("anasToQtyUnits", "value"),
    extractFunction("anasCentsToCurrency", "cents"),
    extractFunction("anasQtyFromUnits", "units"),
    extractFunction("anasLineTotalCents", "qtyUnits, priceCents"),
    "const ANAS_QTY_SCALE = 1000000;",
    extractFunction("confirmHasibPaymentDurable"),
    "globalThis.runActualV42Sale = confirmHasibPaymentDurable;"
  ].join("\n"), context);

  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: cloudV1(), revision: 1 }),
    pushCloud: async () => ({ status: 200, revision: 2 })
  });
  const installer = installV42RuntimeWiring({
    windowObject: {}, storage, orchestrator,
    getAppData: () => context.AppData,
    setAppData: value => { context.AppData = value; },
    getSaveDB: () => context.saveDB,
    setSaveDB: fn => { context.saveDB = fn; },
    getSaveDBDurably: () => context.saveDBDurably,
    setSaveDBDurably: fn => { context.saveDBDurably = fn; },
    mapMutation: ({ entity }) => ({
      type: "SALE_INVOICE",
      payload: { customerId: null, warehouse: entity.warehouse, invoice: entity }
    }),
    uuid: () => "runtime-truck-rollback-001",
    now: () => new Date("2026-10-28T12:00:00.000Z")
  });
  installer.install();

  assert.equal(await context.runActualV42Sale(), false);
  assert.equal(Object.prototype.hasOwnProperty.call(context.AppData, "auditTrail"), false);
  assert.deepEqual(context.AppData.invoices, []);
  assert.deepEqual(context.AppData.cashMovements, []);
  assert.deepEqual(context.AppData.stockMovements, []);
  assert.equal(context.AppData.caisseBalance, 54000);
  assert.equal(context.AppData.products[0].stock, 90);
  assert.equal(context.AppData.products[0].warehouseStock["شاحنة 1"], 12);
  assert.equal(context.AppData.customers[0].debt, 26000);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.deepEqual(storage.json(MUTATION_KEYS.appData), initial);
  assert.ok(alerts.some(message => message.includes("لم يتم تأكيد الفاتورة")));
  assert.equal(installer.uninstall(), true);
});
