import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
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
    settlementAllocations: [],
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

test("real HTTP 409 CAS recovery preserves Device B's cloud commit and replays Device A once", async t => {
  let cloud = baseSnapshot();
  let revision = "REV-1";
  let deviceBCommitted = false;
  let observedDeviceAConflictStatus = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET" && req.url === "/snapshot") {
      send(200, { data: cloud, revision });
      return;
    }
    if (req.method !== "POST" || req.url !== "/snapshot") {
      send(404, { error: "not found" });
      return;
    }

    if (req.headers["x-device-id"] === "device-a" && !deviceBCommitted) {
      // A second, independent HTTP client commits against REV-1 after A's pull.
      const deviceBResponse = await fetch(`http://127.0.0.1:${server.address().port}/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-id": "device-b" },
        body: JSON.stringify({
          baseRevision: "REV-1",
          data: {
            ...structuredClone(cloud),
            returns: [{
              returnId: "RET-DEVICE-B-POSTED-0001", ledgerVersion: 2, status: "POSTED",
              originalInvoiceType: "sales_invoice", originalInvoiceId: "INV-DEVICE-B",
              items: [{ productId: "prod-sync", quantityMicroUnits: 1000000 }]
            }],
            lastReverseOperationId: "device-b-reverse-op-0001",
            settlementAllocations: [{
              id: "alloc-device-b-0001", partyType: "customer", partyId: "cust-sync",
              invoiceType: "sales_invoice", invoiceId: "INV-DEVICE-B",
              sourceMovementType: "customer_debt", amountCentimes: 5000
            }]
          }
        })
      });
      assert.equal(deviceBResponse.status, 200, "Device B must commit successfully over HTTP");
      deviceBCommitted = true;
    }

    if (body?.baseRevision !== revision) {
      if (req.headers["x-device-id"] === "device-a") observedDeviceAConflictStatus = 409;
      send(409, { error: "revision conflict", currentRevision: revision });
      return;
    }
    cloud = structuredClone(body.data);
    revision = revision === "REV-1" ? "REV-2" : revision === "REV-2" ? "REV-3" : "REV-" + (Number(revision.slice(4)) + 1);
    send(200, { saved: true, revision });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  const origin = `http://127.0.0.1:${server.address().port}`;
  const storage = memoryStorage({
    [MUTATION_KEYS.appData]: baseSnapshot(),
    [MUTATION_KEYS.pending]: [collectionMutation()],
    [MUTATION_KEYS.revision]: "REV-1"
  });
  const queue = createMutationQueueOrchestrator({
    storage,
    pullCloud: async () => {
      const response = await fetch(origin + "/snapshot");
      assert.equal(response.status, 200);
      return response.json();
    },
    pushCloud: async ({ data, baseRevision }) => {
      const response = await fetch(origin + "/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-id": "device-a" },
        body: JSON.stringify({ data, baseRevision })
      });
      const payload = await response.json();
      return { status: response.status, ...payload };
    }
  });

  const result = await queue.reconcileAndSync();
  assert.equal(observedDeviceAConflictStatus, 409, "Device A must receive a real network HTTP 409");
  assert.equal(deviceBCommitted, true);
  assert.equal(result.status, "synced", JSON.stringify(result));
  assert.equal(result.attempts, 2);
  assert.equal(cloud.returns.filter(row => row.returnId === "RET-DEVICE-B-POSTED-0001").length, 1);
  assert.equal(cloud.lastReverseOperationId, "device-b-reverse-op-0001");
  assert.equal(cloud.settlementAllocations.filter(row => row.id === "alloc-device-b-0001").length, 1);
  assert.equal(cloud.settlementAllocations.find(row => row.id === "alloc-device-b-0001").amountCentimes, 5000);
  assert.equal(cloud.caisseBalance, 540);
  assert.equal(cloud.customers[0].debt, 260);
  assert.equal(cloud.cashMovements.filter(row => row.id === "cash-device-a-0001").length, 0);
  assert.deepEqual(JSON.parse(storage.getItem(MUTATION_KEYS.pending)), []);
  assert.equal(storage.getItem(MUTATION_KEYS.revision), JSON.stringify("REV-3"));

  const second = await queue.reconcileAndSync();
  assert.equal(second.status, "synced");
  assert.equal(cloud.returns.filter(row => row.returnId === "RET-DEVICE-B-POSTED-0001").length, 1);
  assert.equal(cloud.settlementAllocations.filter(row => row.id === "alloc-device-b-0001").length, 1);
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
    assert.equal(JSON.parse(storage.getItem(MUTATION_KEYS.quarantined))[0].reason, "SERVER_OWNED_FINANCIAL_MUTATION_NOT_REPLAYED_LOCALLY", type);
    assert.deepEqual(JSON.parse(storage.getItem(MUTATION_KEYS.pending)), [], type);
  }
});
