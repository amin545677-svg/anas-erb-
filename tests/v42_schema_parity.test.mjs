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
  for (const movement of copy.cashMovements || []) delete movement.opId;
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

test("parity audit exposes the current decimal-amount contract mismatch instead of hiding it", () => {
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
  // V42 accepts two-decimal DZD amounts; current prototype only accepts safe integers.
  assert.equal(result.review[0]?.reason, "INVALID_AMOUNT");
  assert.equal(result.snapshot.caisseBalance, 1000);
  assert.equal(result.snapshot.customers[0].debt, 2000);
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
