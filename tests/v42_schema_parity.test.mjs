import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { reconcilePendingMutations } from "../sync/mutation_reconciliation.mjs";

// Execute the actual, unchanged V42 function extracted from index.html.
// This is a source-level differential harness, not a production integration.
const v42Source = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function extractFunction(name, signature) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = v42Source.match(new RegExp(
    "^        function " + escaped + "\\(" + signature + "\\) \\{[\\s\\S]*?^        \\}",
    "m"
  ));
  assert.ok(match, `Could not extract V42 function: ${name}`);
  return match[0];
}

function fixedDateContext() {
  const fixedNow = Date.UTC(2026, 9, 28, 12, 0, 0);
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  const fixedMath = Object.create(Math);
  fixedMath.random = () => 0.12345;
  return { FixedDate, fixedMath };
}

function runV42Collection(initial, amount) {
  const { FixedDate, fixedMath } = fixedDateContext();
  const alerts = [];
  const context = {
    AppData: structuredClone(initial),
    Date: FixedDate,
    Math: fixedMath,
    Number, String, Set, Array, Object, JSON,
    prompt: () => String(amount),
    alert: message => alerts.push(String(message)),
    saveDB: () => true,
    updateCashUI: () => {},
    renderCustomersDebts: () => {},
    console
  };
  vm.createContext(context);
  const source = extractFunction("collectCustDebt", "cId");
  vm.runInContext(source + "\nglobalThis.__run = collectCustDebt;", context);
  context.__run("cust_1");
  return { snapshot: context.AppData, alerts };
}

function stripSyncMetadata(value) {
  const copy = structuredClone(value);
  delete copy.appliedOpIds;
  for (const invoice of copy.invoices || []) {
    delete invoice.syncOpId;
    delete invoice.syncCreatedAt;
  }
  for (const movement of copy.cashMovements || []) {
    delete movement.opId;
    delete movement.syncOpId;
    delete movement.syncCreatedAt;
  }
  return copy;
}

test("DEBT_COLLECTION matches the actual V42 collectCustDebt ledger for a whole-DZD fixture", () => {
  const initial = {
    caisseBalance: 54000,
    customers: [{ id: "cust_1", name: "عميل اختبار", debt: 26000 }],
    cashMovements: [],
    currentUser: { id: "user_1", name: "مدير" }
  };
  const original = runV42Collection(initial, 5000);
  assert.deepEqual(original.alerts, ["تم تسجيل قبض الدين وحركة الصندوق بنجاح ✅"]);
  assert.equal(original.snapshot.customers[0].debt, 21000);
  assert.equal(original.snapshot.caisseBalance, 59000);
  assert.equal(original.snapshot.cashMovements.length, 1);

  const v42Movement = original.snapshot.cashMovements[0];
  const operation = {
    opId: "parity-collection-5000",
    type: "DEBT_COLLECTION",
    payload: {
      customerId: "cust_1",
      amount: 5000,
      cashMovementId: v42Movement.id,
      cashMovement: structuredClone(v42Movement)
    }
  };
  const reconciled = reconcilePendingMutations(structuredClone(initial), [operation]);
  assert.deepEqual(reconciled.review, []);
  assert.deepEqual(
    stripSyncMetadata(reconciled.snapshot),
    stripSyncMetadata(original.snapshot),
    "reconciled customer debt, caisse balance, and full cash movement must match V42"
  );
});

test("DEBT_COLLECTION matches V42 for a two-decimal DZD amount", () => {
  const initial = {
    caisseBalance: 1000,
    customers: [{ id: "cust_1", name: "عميل اختبار", debt: 2000 }],
    cashMovements: [],
    currentUser: null
  };
  const original = runV42Collection(initial, "500,50");
  assert.equal(original.snapshot.customers[0].debt, 1499.5);
  assert.equal(original.snapshot.caisseBalance, 1500.5);

  const movement = original.snapshot.cashMovements[0];
  const result = reconcilePendingMutations(initial, [{
    opId: "parity-decimal-collection",
    type: "DEBT_COLLECTION",
    payload: {
      customerId: "cust_1",
      amount: movement.amount,
      cashMovementId: movement.id,
      cashMovement: movement
    }
  }]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.caisseBalance, original.snapshot.caisseBalance);
  assert.equal(result.snapshot.customers[0].debt, original.snapshot.customers[0].debt);
  assert.deepEqual(
    stripSyncMetadata(result.snapshot).cashMovements,
    stripSyncMetadata(original.snapshot).cashMovements
  );
});

test("sale parity audit documents the real V42 side-effect boundary", () => {
  const saleSource = extractFunction("confirmHasibPayment", "");
  assert.match(saleSource, /p\.stock\s*=\s*\(Number\(p\.stock\)\|\|0\)-qty/);
  assert.match(saleSource, /p\.warehouseStock\[saleWarehouse\]\s*=\s*\(Number\(p\.warehouseStock\[saleWarehouse\]\)\|\|0\)-qty/);
  assert.match(saleSource, /AppData\.invoices\.unshift\(invObj\)/);
  assert.match(saleSource, /AppData\.caisseBalance\s*=\s*oldCaisse\s*\+\s*paid/);
  assert.match(saleSource, /cust\.debt\s*=\s*oldDebt\s*\+\s*remaining/);
  // The V42 sale function itself does not write these ledgers; do not fabricate them in replay.
  assert.doesNotMatch(saleSource, /AppData\.stockMovements/);
  assert.doesNotMatch(saleSource, /AppData\.cashMovements/);
});

function runV42Sale(initial, { warehouse = "المخزن الرئيسي", paid, cart = [{ id: "item_a", name: "صنف اختبار", qty: 2, price: 500 }], customerId = "cust_1" } = {}) {
  const { FixedDate, fixedMath } = fixedDateContext();
  const alerts = [];
  const elements = {
    hasibCustomerSelect: { value: customerId },
    hasibPaidAmount: { value: String(paid ?? cart.reduce((sum, item) => sum + Number(item.qty) * Number(item.price), 0)) }
  };
  const context = {
    AppData: structuredClone(initial),
    posCart: structuredClone(cart),
    lastConfirmedInvoice: null,
    Date: FixedDate,
    Math: fixedMath,
    Number, String, Set, Map, Array, Object, JSON,
    document: { getElementById: id => elements[id] || null },
    wtTryEnsureData: () => true,
    wtCurrentSaleWarehouse: () => warehouse,
    wtAvailableStock: (product, selectedWarehouse) => selectedWarehouse === "المخزن الرئيسي"
      ? Number(product.stock) || 0
      : Number(product.warehouseStock?.[selectedWarehouse]) || 0,
    saveDB: () => true,
    renderPosTable: () => {},
    closeModal: () => {},
    alert: message => alerts.push(String(message)),
    console
  };
  vm.createContext(context);
  const source = extractFunction("confirmHasibPayment", "");
  vm.runInContext(source + "\nglobalThis.__run = confirmHasibPayment;", context);
  context.__run();
  return { snapshot: context.AppData, alerts, cart: context.posCart, invoice: context.lastConfirmedInvoice };
}

function paritySnapshot(value) {
  const copy = structuredClone(value);
  delete copy.appliedOpIds;
  for (const invoice of copy.invoices || []) {
    delete invoice.syncOpId;
    delete invoice.syncCreatedAt;
  }
  for (const movement of copy.cashMovements || []) {
    delete movement.opId;
    delete movement.syncOpId;
    delete movement.syncCreatedAt;
  }
  return copy;
}

function assertDeepSaleParity({ warehouse, paid, total = 1000, customerId = "cust_1", secondaryStock = 15 }) {
  const initial = {
    caisseBalance: 54000,
    customers: [{ id: "cust_1", name: "عميل اختبار", debt: 26000 }],
    products: [{
      id: "item_a", name: "صنف اختبار", stock: 90,
      ...(warehouse && warehouse !== "المخزن الرئيسي" ? { warehouseStock: { [warehouse]: secondaryStock } } : {})
    }],
    invoices: [],
    currentUser: { id: "user_1", name: "مدير", role: "admin" }
  };
  const cart = [{ id: "item_a", name: "صنف اختبار", qty: 2, price: total / 2 }];
  const original = runV42Sale(initial, { warehouse, paid, cart, customerId });
  assert.ok(original.invoice, "V42 must produce a confirmed invoice");
  assert.equal(original.snapshot.invoices.length, 1);
  assert.equal(original.snapshot.products[0].stock, warehouse && warehouse !== "المخزن الرئيسي" ? 90 : 88);
  if (warehouse && warehouse !== "المخزن الرئيسي") {
    assert.equal(original.snapshot.products[0].warehouseStock[warehouse], secondaryStock - 2);
  }

  const remaining = Math.round((total - paid + Number.EPSILON) * 100) / 100;
  const operation = {
    opId: "deep-parity-" + (warehouse || "main") + "-" + paid,
    type: "SALE_INVOICE",
    createdAt: "2026-10-28T12:00:00.000Z",
    payload: {
      customerId,
      warehouse: warehouse || "المخزن الرئيسي",
      invoice: structuredClone(original.invoice)
    }
  };
  const reconciled = reconcilePendingMutations(structuredClone(initial), [operation]);
  assert.deepEqual(reconciled.review, [], "valid V42 sale must not be quarantined");
  assert.equal(reconciled.snapshot.caisseBalance, original.snapshot.caisseBalance);
  assert.equal(reconciled.snapshot.customers[0].debt, original.snapshot.customers[0].debt);
  assert.deepEqual(
    paritySnapshot(reconciled.snapshot),
    paritySnapshot(original.snapshot),
    "entire V42 AppData snapshot, including invoice keys, nested customerObj, item order, user/date metadata, balances and stock, must match"
  );
  assert.deepEqual(Object.keys(reconciled.snapshot.invoices[0]), Object.keys(original.snapshot.invoices[0]));
  assert.equal(reconciled.snapshot.invoices[0].customerObj?.id, original.snapshot.invoices[0].customerObj?.id);
  assert.equal(reconciled.snapshot.invoices[0].userId, original.snapshot.invoices[0].userId);
  assert.equal(reconciled.snapshot.invoices[0].date, original.snapshot.invoices[0].date);
  assert.equal(reconciled.snapshot.invoices[0].remaining, remaining);
}

test("DEEP PARITY: SALE_INVOICE matches the actual V42 function for a full cash sale", () => {
  assertDeepSaleParity({ warehouse: "المخزن الرئيسي", paid: 1000 });
});

test("DEEP PARITY: SALE_INVOICE matches the actual V42 function for a full credit sale", () => {
  assertDeepSaleParity({ warehouse: "المخزن الرئيسي", paid: 0 });
});

test("DEEP PARITY: SALE_INVOICE matches the actual V42 function for a mixed sale from a secondary warehouse", () => {
  assertDeepSaleParity({ warehouse: "شاحنة 1", paid: 400 });
});


test("V42 Deep Parity: opId markers on existing entities do not change ledger behavior", () => {
  const base = {
    caisseBalance: 54000,
    customers: [{ id: "cust_1", name: "عميل اختبار", debt: 26000 }],
    products: [{ id: "item_a", name: "صنف اختبار", stock: 90 }],
    invoices: [{ id: "historical_invoice", total: 200, paid: 200, remaining: 0, items: [] }],
    cashMovements: [{ id: "historical_cash", amount: 200, type: "historical" }],
    currentUser: { id: "user_1", name: "مدير", role: "admin" }
  };
  const annotated = structuredClone(base);
  annotated.appliedOpIds = ["op_historical_invoice", "op_historical_cash"];
  annotated.invoices[0].syncOpId = "op_historical_invoice";
  annotated.invoices[0].syncCreatedAt = "2026-10-28T12:00:00.000Z";
  annotated.cashMovements[0].opId = "op_historical_cash";
  annotated.cashMovements[0].syncOpId = "op_historical_cash";
  annotated.cashMovements[0].syncCreatedAt = "2026-10-28T12:00:00.000Z";

  const cleanRun = runV42Sale(base, { warehouse: "المخزن الرئيسي", paid: 400 });
  const markedRun = runV42Sale(annotated, { warehouse: "المخزن الرئيسي", paid: 400 });

  assert.equal(cleanRun.snapshot.caisseBalance, 54400);
  assert.equal(markedRun.snapshot.caisseBalance, 54400);
  assert.equal(cleanRun.snapshot.customers[0].debt, 26600);
  assert.equal(markedRun.snapshot.customers[0].debt, 26600);
  assert.equal(cleanRun.snapshot.products[0].stock, 88);
  assert.equal(markedRun.snapshot.products[0].stock, 88);
  assert.deepEqual(
    paritySnapshot(markedRun.snapshot),
    paritySnapshot(cleanRun.snapshot),
    "sync metadata must not alter V42 invoice, customer, cash or stock calculations"
  );

  const jsonRoundTrip = JSON.parse(JSON.stringify(markedRun.snapshot));
  assert.equal(jsonRoundTrip.invoices.find(x => x.id === "historical_invoice").syncOpId, "op_historical_invoice");
  assert.equal(jsonRoundTrip.cashMovements.find(x => x.id === "historical_cash").opId, "op_historical_cash");
  assert.ok(jsonRoundTrip.appliedOpIds.includes("op_historical_invoice"));
});
