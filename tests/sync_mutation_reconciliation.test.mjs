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
  assert.deepEqual(twice.appliedNow, [{ opId: "op-deviceB-collection-5000", outcome: "already-applied" }]);
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
