import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePendingMutations } from "../sync/mutation_reconciliation.mjs";

function cloud() {
  return {
    caisseBalance: 54000,
    customers: [{ id: "cust_s", debt: 26000 }],
    products: [{ id: "item_a", stock: 90 }],
    invoices: [{ id: "cloud-invoice" }],
    stockMovements: [{ id: "cloud-stock-movement" }],
    cashMovements: [{ id: "cloud-cash" }],
    appliedOpIds: []
  };
}
function collection(opId = "op-deviceB-collection-5000") {
  return {
    opId, type: "DEBT_COLLECTION", baseCloudRevision: "V0",
    createdAt: "2026-10-28T14:00:00.000Z",
    payload: { customerId: "cust_s", amount: 5000, cashMovementId: "cm_991" }
  };
}

test("replays an unacknowledged debt collection over cloud V1 without changing the source snapshot", () => {
  const original = cloud();
  const result = reconcilePendingMutations(original, [collection()]);
  assert.equal(result.snapshot.products[0].stock, 90);
  assert.equal(result.snapshot.caisseBalance, 59000);
  assert.equal(result.snapshot.customers[0].debt, 21000);
  assert.ok(result.snapshot.cashMovements.some(m => m.id === "cm_991" && m.amount === 5000));
  assert.ok(result.snapshot.appliedOpIds.includes("op-deviceB-collection-5000"));
  assert.deepEqual(original, cloud(), "reconciliation must not mutate the supplied cloud snapshot");
  assert.deepEqual(result.review, []);
});

test("replaying the same operation ID is idempotent", () => {
  const once = reconcilePendingMutations(cloud(), [collection()]);
  const twice = reconcilePendingMutations(once.snapshot, [collection()]);
  assert.equal(twice.snapshot.caisseBalance, 59000);
  assert.equal(twice.snapshot.customers[0].debt, 21000);
  assert.equal(twice.snapshot.cashMovements.filter(m => m.id === "cm_991").length, 1);
  assert.deepEqual(twice.appliedNow, [{ opId: "op-deviceB-collection-5000", outcome: "already-applied", reason: "CASH_MOVEMENT_ENTITY_EXISTS" }]);
});

test("quarantines a sale when cloud stock is insufficient but still replays a safe collection", () => {
  const sale = {
    opId: "op-deviceB-sale-10", type: "SALE_INVOICE",
    payload: {
      productId: "item_a", quantity: 10,
      invoice: { id: "local-invoice-10", total: 10000 },
      stockMovement: { id: "local-stock-10", quantity: -10 }
    }
  };
  const result = reconcilePendingMutations(cloud(), [
    { ...sale, payload: { ...sale.payload, quantity: 95 } },
    collection()
  ]);
  assert.equal(result.snapshot.products[0].stock, 90);
  assert.equal(result.snapshot.caisseBalance, 59000);
  assert.equal(result.snapshot.customers[0].debt, 21000);
  assert.ok(result.review.some(item => item.opId === sale.opId && item.reason === "INSUFFICIENT_CLOUD_STOCK"));
  assert.ok(result.snapshot.appliedOpIds.includes(collection().opId));
});

test("quarantines unsafe collections instead of creating negative customer debt", () => {
  const op = { ...collection(), payload: { ...collection().payload, amount: 30000 } };
  const result = reconcilePendingMutations(cloud(), [op]);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.equal(result.review[0].reason, "COLLECTION_EXCEEDS_RECORDED_DEBT_OR_INVALID_DEBT");
});

test("unknown operation types remain in review and are not silently discarded", () => {
  const result = reconcilePendingMutations(cloud(), [{ opId: "op-future", type: "TRUCK_SETTLEMENT", payload: {} }]);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.review[0].reason, "UNSUPPORTED_OPERATION_TYPE");
});

function saleOp({ opId, warehouse = "المخزن الرئيسي", total = 1000, paid = total, quantity = 2, customerId = null }) {
  const remaining = Math.round((total - paid + Number.EPSILON) * 100) / 100;
  return {
    opId,
    type: "SALE_INVOICE",
    createdAt: "2026-10-28T12:00:00.000Z",
    payload: {
      ...(customerId ? { customerId } : {}),
      invoice: {
        id: `inv-${opId}`,
        date: "2026-10-28",
        customer: customerId ? "عميل آجل" : "عميل نقدي عابر",
        items: [{ id: "item_a", name: "صنف اختبار", qty: quantity, price: total / quantity }],
        total, paid, remaining, warehouse, warehouseName: warehouse,
        paymentMethod: paid <= 0 ? "credit" : (remaining > 0 ? "partial" : "cash")
      }
    }
  };
}

test("V42 parity: full cash sale reduces main stock and increases cash without synthetic movements", () => {
  const initial = cloud();
  const op = saleOp({ opId: "sale-cash", total: 1000, paid: 1000 });
  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.products[0].stock, 88);
  assert.equal(result.snapshot.caisseBalance, 55000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.equal(result.snapshot.invoices[0].id, "inv-sale-cash");
  assert.equal(result.snapshot.cashMovements.length, initial.cashMovements.length);
  assert.equal(result.snapshot.stockMovements.length, initial.stockMovements.length);
});

test("V42 parity: full credit sale keeps cash fixed and increases registered customer debt", () => {
  const initial = cloud();
  initial.customers[0].name = "عميل آجل";
  const op = saleOp({ opId: "sale-credit", total: 1000, paid: 0, customerId: "cust_s" });
  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.products[0].stock, 88);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 27000);
  assert.equal(result.snapshot.invoices[0].paymentMethod, "credit");
  assert.equal(result.snapshot.cashMovements.length, initial.cashMovements.length);
  assert.equal(result.snapshot.stockMovements.length, initial.stockMovements.length);
});

test("V42 parity: mixed sale from a secondary warehouse updates only that warehouse, cash paid and debt remaining", () => {
  const initial = cloud();
  initial.products[0].warehouseStock = { "شاحنة 1": 15 };
  initial.customers[0].name = "عميل مختلط";
  const op = saleOp({ opId: "sale-mixed", warehouse: "شاحنة 1", total: 1000, paid: 400, customerId: "cust_s" });
  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.products[0].stock, 90);
  assert.equal(result.snapshot.products[0].warehouseStock["شاحنة 1"], 13);
  assert.equal(result.snapshot.caisseBalance, 54400);
  assert.equal(result.snapshot.customers[0].debt, 26600);
  assert.equal(result.snapshot.invoices[0].paymentMethod, "partial");
  assert.equal(result.snapshot.cashMovements.length, initial.cashMovements.length);
  assert.equal(result.snapshot.stockMovements.length, initial.stockMovements.length);
});

test("rejects fractional-cent collection amounts instead of silently rounding them", () => {
  const op = { ...collection(), payload: { ...collection().payload, amount: 500.555 } };
  const result = reconcilePendingMutations(cloud(), [op]);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.equal(result.review[0].reason, "INVALID_AMOUNT");
});

test("quarantines a cash movement ID collision when the existing amount differs", () => {
  const initial = cloud();
  initial.cashMovements.push({ id: "cm_991", amount: 4000, customerId: "cust_s" });
  const result = reconcilePendingMutations(initial, [collection()]);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.equal(result.review[0].reason, "CASH_MOVEMENT_ID_COLLISION");
  assert.deepEqual(result.appliedNow, []);
});

test("quarantines collection when adding its cents would overflow the safe integer range", () => {
  const initial = cloud();
  initial.caisseBalance = Number.MAX_SAFE_INTEGER / 100;
  const result = reconcilePendingMutations(initial, [collection()]);
  assert.equal(result.snapshot.caisseBalance, initial.caisseBalance);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.equal(result.review[0].reason, "CASH_BALANCE_OVERFLOW");
});

test("quarantines credit sales when customer debt would overflow safe integer cents", () => {
  const initial = cloud();
  initial.customers[0].debt = Number.MAX_SAFE_INTEGER / 100;
  const op = saleOp({ opId: "sale-debt-overflow", total: 1, paid: 0, customerId: "cust_s", quantity: 1 });
  const result = reconcilePendingMutations(initial, [op]);
  assert.equal(result.snapshot.customers[0].debt, initial.customers[0].debt);
  assert.equal(result.review[0].reason, "INVALID_CUSTOMER_DEBT");
});


test("existing invoice is skipped only when its operation marker and full payload match", () => {
  const op = saleOp({ opId: "invoice-marker-verified", total: 1000, paid: 1000 });
  const initial = cloud();
  const existing = structuredClone(op.payload.invoice);
  existing.syncOpId = op.opId;
  existing.syncCreatedAt = "2026-10-28T12:00:00.000Z";
  initial.invoices.unshift(existing);

  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.deepEqual(result.appliedNow, [{
    opId: op.opId,
    outcome: "already-applied",
    reason: "VERIFIED_INVOICE_OPERATION_MARKER"
  }]);
  assert.equal(result.snapshot.products[0].stock, 90, "verified duplicate must not deduct stock twice");
  assert.equal(result.snapshot.caisseBalance, 54000, "verified duplicate must not add cash twice");
  assert.equal(result.snapshot.invoices.filter(item => item.id === op.payload.invoice.id).length, 1);
});

test("invoice ID collisions without the exact operation marker or with changed payload are quarantined", () => {
  const cases = [
    {
      label: "legacy/unmarked invoice",
      mutate: invoice => { delete invoice.syncOpId; }
    },
    {
      label: "invoice marked by another operation",
      mutate: invoice => { invoice.syncOpId = "different-operation"; }
    },
    {
      label: "same marker but changed financial payload",
      mutate: invoice => { invoice.syncOpId = "invoice-collision-guard"; invoice.total = 999; }
    }
  ];

  for (const scenario of cases) {
    const op = saleOp({ opId: "invoice-collision-guard", total: 1000, paid: 1000 });
    const initial = cloud();
    const existing = structuredClone(op.payload.invoice);
    existing.syncOpId = op.opId;
    scenario.mutate(existing);
    initial.invoices.unshift(existing);

    const result = reconcilePendingMutations(initial, [op]);
    assert.equal(result.review.length, 1, scenario.label);
    assert.equal(result.review[0].reason, "INVOICE_ID_COLLISION", scenario.label);
    assert.deepEqual(result.appliedNow, [], scenario.label);
    assert.equal(result.snapshot.products[0].stock, 90, scenario.label + ": stock must remain unchanged");
    assert.equal(result.snapshot.caisseBalance, 54000, scenario.label + ": cash must remain unchanged");
    assert.equal(result.snapshot.invoices[0].total, existing.total, scenario.label + ": existing audit data must remain unchanged");
  }
});


test("does not accept an unmarked cash movement as proof of an already-applied collection", () => {
  const initial = cloud();
  initial.cashMovements.push({ id: "cm_991", amount: 5000, customerId: "cust_s" });
  const result = reconcilePendingMutations(initial, [collection()]);
  assert.equal(result.review[0].reason, "CASH_MOVEMENT_ID_COLLISION");
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
});

test("quarantines appliedOpIds markers when their durable business entity is missing", () => {
  const collectionSnapshot = cloud();
  collectionSnapshot.appliedOpIds = [collection().opId];
  const collectionResult = reconcilePendingMutations(collectionSnapshot, [collection()]);
  assert.equal(collectionResult.review[0].reason, "APPLIED_OPERATION_ENTITY_MISSING");
  assert.equal(collectionResult.snapshot.caisseBalance, 54000);
  assert.equal(collectionResult.snapshot.customers[0].debt, 26000);

  const sale = saleOp({ opId: "sale-marker-without-invoice", total: 1000, paid: 1000 });
  const saleSnapshot = cloud();
  saleSnapshot.appliedOpIds = [sale.opId];
  const saleResult = reconcilePendingMutations(saleSnapshot, [sale]);
  assert.equal(saleResult.review[0].reason, "APPLIED_OPERATION_ENTITY_MISSING");
  assert.equal(saleResult.snapshot.products[0].stock, 90);
  assert.equal(saleResult.snapshot.caisseBalance, 54000);
  assert.equal(saleResult.snapshot.invoices.some(item => item.id === sale.payload.invoice.id), false);
});
