import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createMutationQueueOrchestrator, MUTATION_KEYS } from "../sync/mutation_queue_orchestrator.mjs";
import { reconcilePendingMutations } from "../sync/mutation_reconciliation.mjs";

// Domain-native V42 snapshot: stock is cartons, currency is DZD.
// Assertions convert to integer micro-units/centimes to prohibit rounding drift.
const V0 = Object.freeze({
  products: [{ id: "PRODUCT-ACCEPTANCE-1", stock: 100 }],
  customers: [{ id: "CUSTOMER-ACCEPTANCE-1", debt: 20_000 }],
  invoices: [],
  caisseBalance: 50_000,
  cashMovements: [],
  appliedOpIds: []
});
const json = value => JSON.stringify(value);
const storage = seed => {
  const map = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key)
  };
};
const cents = value => BigInt(Math.round(Number(value) * 100));
const microUnits = value => BigInt(Math.round(Number(value) * 1_000_000));

function applyWithV42BalanceEngine(snapshot, operations) {
  const result = reconcilePendingMutations(snapshot, operations);
  assert.deepEqual(result.review, [], "V42 reconciliation engine must not quarantine acceptance operations");
  return result;
}

test("isolated two-device acceptance: real V42 balance engine + queue + HTTP 409 CAS + exact integer parity", async t => {
  let cloud = structuredClone(V0);
  let revision = "V0";
  let device1Committed = false;
  let device2Observed409 = false;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && req.url === "/snapshot") {
      send(200, { data: structuredClone(cloud), revision });
      return;
    }
    if (req.method !== "POST" || req.url !== "/snapshot") {
      send(404, { error: "not found" });
      return;
    }
    if (body.baseRevision !== revision) {
      if (req.headers["x-device-id"] === "device-2") device2Observed409 = true;
      send(409, { error: "revision conflict", currentRevision: revision });
      return;
    }
    cloud = structuredClone(body.data);
    revision = revision === "V0" ? "V1" : "V2";
    send(200, { saved: true, revision });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())
  ));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const saleOperation = {
    opId: "DEVICE-1-SALE-10000-001",
    type: "SALE_INVOICE",
    status: "PENDING",
    createdAt: "2026-11-01T10:00:00.000Z",
    payload: {
      customerId: "CUSTOMER-ACCEPTANCE-1",
      invoice: {
        id: "SALE-DEVICE-1-0001",
        customerId: "CUSTOMER-ACCEPTANCE-1",
        total: 10_000,
        paid: 4_000,
        remaining: 6_000,
        items: [{ id: "PRODUCT-ACCEPTANCE-1", qty: 10 }]
      }
    }
  };
  const receiptOperation = {
    opId: "DEVICE-2-RECEIPT-5000-001",
    type: "DEBT_COLLECTION",
    status: "PENDING",
    payload: {
      customerId: "CUSTOMER-ACCEPTANCE-1",
      amount: 5_000,
      cashMovementId: "CASH-DEVICE-2-001"
    }
  };

  // Device 2 remains on V0 with a durable local receipt while Device 1 commits V1.
  const device2Storage = storage({
    [MUTATION_KEYS.appData]: json(V0),
    [MUTATION_KEYS.pending]: json([receiptOperation]),
    [MUTATION_KEYS.revision]: json("V0")
  });

  const queue = createMutationQueueOrchestrator({
    storage: device2Storage,
    maxConflictRetries: 3,
    pullCloud: async () => {
      const response = await fetch(origin + "/snapshot");
      assert.equal(response.status, 200);
      const staleV0 = await response.json();

      if (!device1Committed) {
        assert.equal(staleV0.revision, "V0");
        const sale = applyWithV42BalanceEngine(staleV0.data, [saleOperation]);
        assert.equal(sale.appliedNow[0]?.outcome, "applied");
        const device1Response = await fetch(origin + "/snapshot", {
          method: "POST",
          headers: { "content-type": "application/json", "x-device-id": "device-1" },
          body: JSON.stringify({ data: sale.snapshot, baseRevision: "V0" })
        });
        assert.equal(device1Response.status, 200);
        device1Committed = true;
      }
      return staleV0;
    },
    pushCloud: async ({ data, baseRevision }) => {
      const response = await fetch(origin + "/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-id": "device-2" },
        body: JSON.stringify({ data, baseRevision })
      });
      const payload = await response.json();
      return { status: response.status, ...payload };
    },
    reconcile: applyWithV42BalanceEngine
  });

  const result = await queue.reconcileAndSync();
  assert.equal(device1Committed, true);
  assert.equal(device2Observed409, true, "Device 2 must receive an actual HTTP 409 Conflict");
  assert.equal(result.status, "synced", JSON.stringify(result));
  assert.equal(result.attempts, 2, "CAS retry must pull V1 before committing V2");
  assert.equal(revision, "V2");

  assert.equal(cloud.invoices.filter(row => row.id === "SALE-DEVICE-1-0001").length, 1,
    "Device 1 invoice must be preserved exactly once");
  assert.equal(cloud.cashMovements.filter(row => row.id === "CASH-DEVICE-2-001").length, 1,
    "Device 2 receipt must be applied exactly once");

  const product = cloud.products.find(row => row.id === "PRODUCT-ACCEPTANCE-1");
  const customer = cloud.customers.find(row => row.id === "CUSTOMER-ACCEPTANCE-1");
  assert.equal(microUnits(product.stock), 90_000_000n, "final stock must be 90 cartons");
  assert.equal(cents(cloud.caisseBalance), 5_900_000n, "final cash must be 59,000 DZD");
  assert.equal(cents(customer.debt), 2_100_000n, "final customer debt must be 21,000 DZD");

  assert.equal(microUnits(product.stock) - 90_000_000n, 0n);
  assert.equal(cents(cloud.caisseBalance) - 5_900_000n, 0n, "cash difference must be 0 centimes");
  assert.equal(cents(customer.debt) - 2_100_000n, 0n, "debt difference must be 0 centimes");
  assert.deepEqual(JSON.parse(device2Storage.getItem(MUTATION_KEYS.pending)), []);
  assert.equal(JSON.parse(device2Storage.getItem(MUTATION_KEYS.revision)), "V2");
});
