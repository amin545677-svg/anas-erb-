import test from "node:test";
import assert from "node:assert/strict";
import { createMutationQueueOrchestrator, MUTATION_KEYS } from "../sync/mutation_queue_orchestrator.mjs";

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}
function baseSnapshot() {
  return {
    caisseBalance: 540,
    customers: [{ id: "cust-sync", debt: 260 }],
    products: [{ id: "prod-sync", stock: 90 }],
    invoices: [],
    purchases: [],
    returns: [],
    stockMovements: [],
    cashMovements: [],
    appliedOpIds: []
  };
}
function collectionMutation() {
  return {
    opId: "device-a-collection-0001",
    type: "DEBT_COLLECTION",
    status: "PENDING",
    createdAt: "2026-10-31T10:00:00.000Z",
    payload: { customerId: "cust-sync", amount: 50, cashMovementId: "cash-device-a-0001" }
  };
}

test("409 CAS recovery preserves a concurrently POSTED reverse-ledger return and replays a safe device mutation once", async () => {
  const storage = memoryStorage({
    [MUTATION_KEYS.appData]: baseSnapshot(),
    [MUTATION_KEYS.pending]: [collectionMutation()],
    [MUTATION_KEYS.revision]: "REV-1"
  });
  let cloud = baseSnapshot();
  let revision = "REV-1";
  let pushes = 0;
  const queue = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => ({ data: structuredClone(cloud), revision }),
    pushCloud: async ({ data, baseRevision }) => {
      pushes++;
      if (pushes === 1) {
        assert.equal(baseRevision, "REV-1");
        // Device B commits its reverse-ledger callable transaction after Device A's pull.
        // The snapshot Worker advances its revision, so Device A's stale CAS must fail.
        cloud = structuredClone(cloud);
        cloud.returns.push({
          returnId: "RET-DEVICE-B-POSTED-0001",
          ledgerVersion: 2,
          status: "POSTED",
          originalInvoiceType: "sales_invoice",
          originalInvoiceId: "INV-DEVICE-B",
          items: [{ productId: "prod-sync", quantityMicroUnits: 1000000 }]
        });
        cloud.lastReverseOperationId = "device-b-reverse-op-0001";
        revision = "REV-2";
        return { status: 409, error: "revision conflict" };
      }
      assert.equal(baseRevision, "REV-2");
      assert.equal(data.returns.filter(row => row.returnId === "RET-DEVICE-B-POSTED-0001").length, 1);
      cloud = structuredClone(data);
      revision = "REV-3";
      return { status: 200, saved: true, revision };
    }
  });

  const result = await queue.reconcileAndSync();
  assert.equal(result.status, "synced");
  assert.equal(result.attempts, 2);
  assert.equal(pushes, 2);
  assert.equal(cloud.returns.filter(row => row.returnId === "RET-DEVICE-B-POSTED-0001").length, 1);
  assert.equal(cloud.lastReverseOperationId, "device-b-reverse-op-0001");
  assert.equal(cloud.caisseBalance, 590);
  assert.equal(cloud.customers[0].debt, 210);
  assert.equal(cloud.cashMovements.filter(row => row.id === "cash-device-a-0001").length, 1);
  assert.deepEqual(JSON.parse(storage.getItem(MUTATION_KEYS.pending)), []);
  assert.equal(storage.getItem(MUTATION_KEYS.revision), JSON.stringify("REV-3"));

  const second = await queue.reconcileAndSync();
  assert.equal(second.status, "synced");
  assert.equal(cloud.returns.filter(row => row.returnId === "RET-DEVICE-B-POSTED-0001").length, 1);
  assert.equal(cloud.cashMovements.filter(row => row.id === "cash-device-a-0001").length, 1);
});

test("legacy mutation queue quarantines SALE_RETURN, PURCHASE_RETURN and INVOICE_CANCEL instead of replaying financial postings", async () => {
  for (const type of ["SALE_RETURN", "PURCHASE_RETURN", "INVOICE_CANCEL"]) {
    const operation = {
      opId: "device-a-" + type.toLowerCase() + "-0001",
      type,
      status: "PENDING",
      payload: { invoiceId: "INV-DO-NOT-REPLAY" }
    };
    let cloud = baseSnapshot();
    const storage = memoryStorage({
      [MUTATION_KEYS.appData]: baseSnapshot(),
      [MUTATION_KEYS.pending]: [operation],
      [MUTATION_KEYS.revision]: "REV-1"
    });
    const queue = createMutationQueueOrchestrator({
      storage,
      pullCloud: async () => ({ data: structuredClone(cloud), revision: "REV-1" }),
      pushCloud: async ({ data }) => { cloud = structuredClone(data); return { status: 200, revision: "REV-2" }; }
    });
    const result = await queue.reconcileAndSync();
    assert.equal(result.status, "synced", type);
    assert.deepEqual(cloud.returns, [], type + " must not be replayed by the legacy snapshot queue");
    assert.equal(JSON.parse(storage.getItem(MUTATION_KEYS.quarantined))[0].reason, "UNSUPPORTED_OPERATION_TYPE", type);
    assert.deepEqual(JSON.parse(storage.getItem(MUTATION_KEYS.pending)), [], type);
  }
});
