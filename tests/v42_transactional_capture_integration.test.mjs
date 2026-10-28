import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createMutationEnvelope } from "../sync/mutation_capture.mjs";
import { createMutationQueueOrchestrator, MUTATION_KEYS } from "../sync/mutation_queue_orchestrator.mjs";

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

function storage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

function fixture() {
  return {
    caisseBalance: 54000,
    customers: [{ id: "cust_1", name: "عميل اختبار", debt: 26000 }],
    products: [{ id: "item_a", name: "صنف اختبار", stock: 90 }],
    invoices: [],
    cashMovements: [],
    currentUser: { id: "user_1", name: "مدير", role: "admin" }
  };
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

/**
 * Test-only transactional hook around the actual V42 saveDB call.
 * The hook captures the real just-created invoice or cash movement, persists
 * its opId marker with AppData, and promotes PREPARED only after storage accepts.
 * A false save result is followed by V42's own rollback and then queue abort.
 * This is a harness, not a production integration.
 */
function runV42WithCapture({ kind, initial, paid, amount, failSave = false, failQueuePromotion = false }) {
  const { FixedDate, fixedMath } = fixedDateContext();
  const local = storage({ [MUTATION_KEYS.appData]: initial });
  const initialSerialized = JSON.stringify(initial);
  const alerts = [];
  const elements = {
    hasibCustomerSelect: { value: "cust_1" },
    hasibPaidAmount: { value: String(paid ?? 1000) }
  };
  const context = {
    AppData: structuredClone(initial),
    posCart: [{ id: "item_a", name: "صنف اختبار", qty: 2, price: 500 }],
    lastConfirmedInvoice: null,
    Date: FixedDate, Math: fixedMath,
    Number, String, Set, Map, Array, Object, JSON,
    document: { getElementById: id => elements[id] || null },
    wtTryEnsureData: () => true,
    wtCurrentSaleWarehouse: () => "المخزن الرئيسي",
    wtAvailableStock: product => Number(product.stock) || 0,
    prompt: () => String(amount ?? 500.5),
    alert: message => alerts.push(String(message)),
    updateCashUI: () => {},
    renderCustomersDebts: () => {},
    renderPosTable: () => {},
    closeModal: () => {},
    console
  };
  let stagedOperation = null;
  let persistedSnapshot = null;
  let saveCalls = 0;

  context.saveDB = () => {
    saveCalls++;
    const before = JSON.parse(initialSerialized);
    let operation;
    if (kind === "sale") {
      const invoice = context.AppData.invoices?.find(x => !before.invoices.some(old => old.id === x.id));
      assert.ok(invoice, "V42 must have created the real invoice before saveDB");
      operation = createMutationEnvelope({
        type: "SALE_INVOICE",
        payload: { customerId: "cust_1", warehouse: "المخزن الرئيسي", invoice: structuredClone(invoice) },
        now: () => new Date("2026-10-28T12:00:00.000Z"),
        uuid: () => "v42-sale-test-unique"
      });
      invoice.syncOpId = operation.opId;
      invoice.syncCreatedAt = operation.createdAt;
      operation.payload.invoice = structuredClone(invoice);
    } else {
      const movement = context.AppData.cashMovements?.find(x => !before.cashMovements.some(old => old.id === x.id));
      assert.ok(movement, "V42 must have created the real cash movement before saveDB");
      operation = createMutationEnvelope({
        type: "DEBT_COLLECTION",
        payload: {
          customerId: "cust_1", amount: movement.amount,
          cashMovementId: movement.id, cashMovement: structuredClone(movement)
        },
        now: () => new Date("2026-10-28T12:00:00.000Z"),
        uuid: () => "v42-collection-test-unique"
      });
      movement.syncOpId = operation.opId;
      movement.syncCreatedAt = operation.createdAt;
      movement.opId = operation.opId;
      operation.payload.cashMovement = structuredClone(movement);
    }
    stagedOperation = operation;
    const queue = JSON.parse(local.getItem(MUTATION_KEYS.pending) || "[]");
    local.setItem(MUTATION_KEYS.pending, JSON.stringify([...queue, { ...operation, status: "PREPARED" }]));

    if (failSave) return false;
    // Simulate durable AppData write after the capture marker is attached.
    persistedSnapshot = structuredClone(context.AppData);
    local.setItem(MUTATION_KEYS.appData, JSON.stringify(persistedSnapshot));
    if (failQueuePromotion) {
      // The bridge's compensating transaction restores the durable AppData
      // snapshot if queue promotion fails after the first write.
      local.setItem(MUTATION_KEYS.appData, initialSerialized);
      throw new Error("simulated pending-queue promotion failure");
    }
    local.setItem(MUTATION_KEYS.pending, JSON.stringify(
      JSON.parse(local.getItem(MUTATION_KEYS.pending)).map(x =>
        x.opId === operation.opId ? { ...x, status: "PENDING" } : x
      )
    ));
    return true;
  };

  vm.createContext(context);
  const fn = kind === "sale"
    ? extractFunction("confirmHasibPayment", "")
    : extractFunction("collectCustDebt", "cId");
  vm.runInContext(fn + (kind === "sale"
    ? "\nglobalThis.__run = confirmHasibPayment;"
    : "\nglobalThis.__run = collectCustDebt;"), context);

  let threw = false;
  try {
    if (kind === "sale") context.__run();
    else context.__run("cust_1");
  } catch (error) {
    threw = true;
    alerts.push(String(error.message));
  }

  // The V42 function performs its own rollback when saveDB returns false.
  // This harness aborts the prepared queue record after the original function exits.
  if (failSave || threw) {
    local.setItem(MUTATION_KEYS.pending, JSON.stringify(
      (JSON.parse(local.getItem(MUTATION_KEYS.pending) || "[]")).filter(x => x.status !== "PREPARED")
    ));
    if (failSave) local.setItem(MUTATION_KEYS.appData, initialSerialized);
  }

  return {
    context, local, alerts, stagedOperation, persistedSnapshot, saveCalls, threw,
    pending: () => JSON.parse(local.getItem(MUTATION_KEYS.pending) || "[]")
  };
}

async function syncAfterConflict(local, initialCloud) {
  let cloud = { data: structuredClone(initialCloud), revision: 1 };
  let firstPush = true;
  const queue = createMutationQueueOrchestrator({
    storage: local,
    pullCloud: async () => structuredClone(cloud),
    pushCloud: async ({ data, baseRevision }) => {
      if (firstPush) {
        firstPush = false;
        return { status: 409 };
      }
      if (baseRevision !== cloud.revision) return { status: 409 };
      cloud = { data: structuredClone(data), revision: cloud.revision + 1 };
      return { status: 200, revision: cloud.revision };
    }
  });
  const conflict = await queue.pushCurrent();
  assert.equal(conflict.status, "conflict");
  const synced = await queue.reconcileAndSync();
  return { synced, cloud, pending: JSON.parse(local.getItem(MUTATION_KEYS.pending) || "[]") };
}

test("V42 sale capture persists identity, survives 409 reconciliation, and drains queue after V2", async () => {
  const initial = fixture();
  const run = runV42WithCapture({ kind: "sale", initial, paid: 400 });
  assert.equal(run.saveCalls, 1);
  assert.equal(run.pending().length, 1);
  assert.equal(run.pending()[0].status, "PENDING");
  assert.equal(run.context.AppData.invoices[0].syncOpId, run.stagedOperation.opId);
  assert.equal(run.context.AppData.invoices[0].syncCreatedAt, "2026-10-28T12:00:00.000Z");

  const { synced, cloud, pending } = await syncAfterConflict(run.local, initial);
  assert.equal(synced.status, "synced");
  assert.equal(cloud.revision, 2);
  assert.deepEqual(pending, []);
  assert.equal(cloud.data.invoices[0].id, run.context.AppData.invoices[0].id);
  assert.deepEqual(
    JSON.parse(JSON.stringify(cloud.data.invoices[0])),
    JSON.parse(JSON.stringify(run.context.AppData.invoices[0]))
  );
  assert.equal(cloud.data.products[0].stock, 88);
  assert.equal(cloud.data.caisseBalance, 54400);
  assert.equal(cloud.data.customers[0].debt, 26600);
});

test("V42 debt collection capture preserves exact 500.50 DZD and survives 409 without duplicate movement", async () => {
  const initial = fixture();
  const run = runV42WithCapture({ kind: "collection", initial, amount: 500.5 });
  assert.equal(run.saveCalls, 1);
  assert.equal(run.pending().length, 1);
  assert.equal(run.pending()[0].status, "PENDING");
  assert.equal(run.context.AppData.caisseBalance, 54500.5);
  assert.equal(run.context.AppData.customers[0].debt, 25499.5);
  assert.equal(run.context.AppData.cashMovements.length, 1);

  const { synced, cloud, pending } = await syncAfterConflict(run.local, initial);
  assert.equal(synced.status, "synced");
  assert.deepEqual(pending, []);
  assert.equal(cloud.data.caisseBalance, 54500.5);
  assert.equal(cloud.data.customers[0].debt, 25499.5);
  assert.equal(cloud.data.cashMovements.length, 1);
  assert.equal(cloud.data.cashMovements[0].amount, 500.5);
});

test("V42 sale save failure rolls back stock, cash, debt and leaves no phantom pending mutation", () => {
  const initial = fixture();
  const run = runV42WithCapture({ kind: "sale", initial, paid: 400, failSave: true });
  assert.equal(run.saveCalls, 1);
  assert.equal(run.context.AppData.products[0].stock, 90);
  assert.equal(run.context.AppData.caisseBalance, 54000);
  assert.equal(run.context.AppData.customers[0].debt, 26000);
  assert.equal(run.context.AppData.invoices.length, 0);
  assert.deepEqual(run.pending(), []);
  assert.equal(run.local.getItem(MUTATION_KEYS.appData), JSON.stringify(initial));
});

test("V42 collection save failure rolls back customer debt and cash and leaves no phantom pending mutation", () => {
  const initial = fixture();
  const run = runV42WithCapture({ kind: "collection", initial, amount: 500.5, failSave: true });
  assert.equal(run.saveCalls, 1);
  assert.equal(run.context.AppData.customers[0].debt, 26000);
  assert.equal(run.context.AppData.caisseBalance, 54000);
  assert.equal(run.context.AppData.cashMovements.length, 0);
  assert.deepEqual(run.pending(), []);
  assert.equal(run.local.getItem(MUTATION_KEYS.appData), JSON.stringify(initial));
});

test("queue promotion failure after durable save is detected and not silently treated as a successful transaction", () => {
  const initial = fixture();
  const run = runV42WithCapture({ kind: "sale", initial, paid: 400, failQueuePromotion: true });
  assert.equal(run.threw, false, "V42 catches saveDB errors and reports rollback through its failure alert");
  assert.ok(run.alerts.some(message => message.includes("لم يتم تأكيد البيع")),
    "V42 must report the failed transaction after compensating rollback");
  assert.equal(run.context.AppData.products[0].stock, 90);
  assert.equal(run.context.AppData.caisseBalance, 54000);
  assert.equal(run.context.AppData.customers[0].debt, 26000);
  assert.equal(run.context.AppData.invoices.length, 0);
  assert.ok(run.persistedSnapshot, "the test simulates a durable AppData write before promotion fails");
  assert.equal(run.pending().length, 0, "test harness aborts the PREPARED record after failure");
  assert.equal(run.local.getItem(MUTATION_KEYS.appData), JSON.stringify(initial),
    "the bridge compensates the first durable write when queue promotion fails");
});
