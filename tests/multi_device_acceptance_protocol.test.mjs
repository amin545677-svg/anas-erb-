import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createMutationQueueOrchestrator, MUTATION_KEYS } from "../sync/mutation_queue_orchestrator.mjs";

const V0 = Object.freeze({
  revision: "V0",
  stockMicroUnits: 100_000_000n,
  cashCentimes: 5_000_000n,
  customerDebtCentimes: 2_000_000n,
  invoices: [],
  cashMovements: [],
  appliedOpIds: []
});
const json = value => JSON.parse(JSON.stringify(value, (_key, item) =>
  typeof item === "bigint" ? item.toString() : item
));
const fromWire = value => ({
  ...value,
  stockMicroUnits: BigInt(value.stockMicroUnits),
  cashCentimes: BigInt(value.cashCentimes),
  customerDebtCentimes: BigInt(value.customerDebtCentimes)
});
function storage(seed) {
  const map = new Map(Object.entries(seed).map(([k,v]) => [k, JSON.stringify(v)]));
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key,value) => map.set(key,String(value)),
    removeItem: key => map.delete(key)
  };
}
function applySaleV1(snapshot) {
  const next = structuredClone(snapshot);
  if (!next.invoices.some(row => row.id === "SALE-DEVICE-1-0001")) {
    next.stockMicroUnits = (BigInt(next.stockMicroUnits) - 10_000_000n).toString();
    next.cashCentimes = (BigInt(next.cashCentimes) + 400_000n).toString();
    next.customerDebtCentimes = (BigInt(next.customerDebtCentimes) + 600_000n).toString();
    next.invoices.push({
      id: "SALE-DEVICE-1-0001", quantityMicroUnits: "10_000_000",
      totalCentimes: "1_000_000", paidCentimes: "400_000", debtCentimes: "600_000"
    });
  }
  return next;
}
function reconcileReceipt(snapshot, operations) {
  const next = structuredClone(snapshot);
  const applied = new Set(next.appliedOpIds || []);
  const appliedNow = [];
  for (const operation of operations) {
    if (applied.has(operation.opId)) {
      appliedNow.push({ opId: operation.opId, outcome: "already-applied" });
      continue;
    }
    assert.equal(operation.type, "DEBT_COLLECTION");
    assert.equal(operation.payload.customerId, "CUSTOMER-ACCEPTANCE-1");
    const amount = BigInt(operation.payload.amountCentimes);
    next.cashCentimes = (BigInt(next.cashCentimes) + amount).toString();
    next.customerDebtCentimes = (BigInt(next.customerDebtCentimes) - amount).toString();
    next.cashMovements.push({ id: operation.payload.cashMovementId, amountCentimes: amount.toString() });
    applied.add(operation.opId);
    appliedNow.push({ opId: operation.opId, outcome: "applied" });
  }
  next.appliedOpIds = [...applied];
  return { snapshot: next, review: [], appliedNow };
}

test("isolated two-device acceptance: V0 -> V1 -> real HTTP 409 -> CAS -> exact centime parity", async t => {
  let cloud = json(V0);
  let revision = "V0";
  let device1Committed = false;
  let device2Observed409 = false;
  const server = createServer(async (req,res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const send = (status,payload) => {
      res.writeHead(status, { "content-type":"application/json", "cache-control":"no-store" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && req.url === "/snapshot") {
      send(200, { data: structuredClone(cloud), revision });
      return;
    }
    if (req.method !== "POST" || req.url !== "/snapshot") {
      send(404, { error:"not found" });
      return;
    }
    if (body.baseRevision !== revision) {
      if (req.headers["x-device-id"] === "device-2") device2Observed409 = true;
      send(409, { error:"revision conflict", currentRevision:revision });
      return;
    }
    cloud = structuredClone(body.data);
    revision = "V1";
    send(200, { saved:true, revision });
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  t.after(() => new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // Device 2 starts on V0 and has a local receipt queued while offline.
  const device2Storage = storage({
    [MUTATION_KEYS.appData]: json(V0),
    [MUTATION_KEYS.pending]: [{
      opId:"DEVICE-2-RECEIPT-500000-001", type:"DEBT_COLLECTION", status:"PENDING",
      payload:{ customerId:"CUSTOMER-ACCEPTANCE-1", amountCentimes:"500000", cashMovementId:"CASH-DEVICE-2-001" }
    }],
    [MUTATION_KEYS.revision]:"V0"
  });

  const queue = createMutationQueueOrchestrator({
    storage:device2Storage,
    maxConflictRetries:3,
    pullCloud:async () => {
      const response = await fetch(origin+"/snapshot");
      assert.equal(response.status,200);
      const staleV0 = await response.json();
      // Device 1 commits the 10-carton split-payment sale after Device 2 reads V0,
      // forcing Device 2's subsequent compare-and-swap write to receive HTTP 409.
      if (!device1Committed) {
        assert.equal(staleV0.revision,"V0");
        const sale = applySaleV1(staleV0.data);
        const device1Response = await fetch(origin+"/snapshot",{
          method:"POST",
          headers:{ "content-type":"application/json", "x-device-id":"device-1" },
          body:JSON.stringify({ data:sale, baseRevision:"V0" })
        });
        assert.equal(device1Response.status,200);
        device1Committed = true;
      }
      return staleV0;
    },
    pushCloud:async ({data,baseRevision}) => {
      const response = await fetch(origin+"/snapshot",{
        method:"POST",
        headers:{ "content-type":"application/json", "x-device-id":"device-2" },
        body:JSON.stringify({ data, baseRevision })
      });
      const payload = await response.json();
      return { status:response.status, ...payload };
    },
    reconcile:reconcileReceipt
  });

  const result = await queue.reconcileAndSync();
  assert.equal(device1Committed,true);
  assert.equal(device2Observed409,true,"Device 2 must receive a real HTTP 409 Conflict");
  assert.equal(result.status,"synced",JSON.stringify(result));
  assert.equal(result.attempts,2,"CAS retry must pull V1 and then commit");
  assert.equal(revision,"V1");
  assert.equal(cloud.invoices.filter(row => row.id==="SALE-DEVICE-1-0001").length,1,"Device 1 sale must not be lost or duplicated");
  assert.equal(cloud.cashMovements.filter(row => row.id==="CASH-DEVICE-2-001").length,1,"Device 2 receipt must be applied exactly once");

  const final = fromWire(cloud);
  assert.equal(final.stockMicroUnits,90_000_000n);
  assert.equal(final.cashCentimes,5_900_000n);
  assert.equal(final.customerDebtCentimes,2_100_000n);
  assert.equal(final.stockMicroUnits,90_000_000n,"90 cartons");
  assert.equal(final.cashCentimes,5_900_000n,"59,000 DZD");
  assert.equal(final.customerDebtCentimes,2_100_000n,"21,000 DZD");
  assert.equal(final.cashCentimes - 5_900_000n,0n,"cash delta must be 0 centimes");
  assert.equal(final.customerDebtCentimes - 2_100_000n,0n,"debt delta must be 0 centimes");
  assert.deepEqual(JSON.parse(device2Storage.getItem(MUTATION_KEYS.pending)),[]);
  assert.equal(device2Storage.getItem(MUTATION_KEYS.revision),JSON.stringify("V1"));
});
