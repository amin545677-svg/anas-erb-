import test from "node:test";
import assert from "node:assert/strict";
import { createFirebaseSnapshotTransport } from "../sync/firebase_snapshot_transport.mjs";
import {
  MUTATION_KEYS,
  createMutationQueueOrchestrator
} from "../sync/mutation_queue_orchestrator.mjs";

class MemoryStorage {
  constructor(seed = {}) { this.data = new Map(Object.entries(seed)); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
  json(key, fallback = null) {
    const raw = this.getItem(key);
    return raw == null ? structuredClone(fallback) : JSON.parse(raw);
  }
}

const initialSnapshot = () => ({
  caisseBalance: 54000,
  customers: [{ id: "cust_s", name: "Client test", debt: 26000 }],
  products: [{ id: "item_a", name: "Produit test", stock: 90 }],
  suppliers: [],
  invoices: [{ id: "invoice-seed", total: 0, paid: 0, remaining: 0, items: [] }],
  purchases: [], expenses: [], cashMovements: [], stockMovements: [],
  appliedOpIds: []
});

function createMockFirebaseWorker() {
  let document = null;
  let revisionCounter = 0;
  const requests = [];
  const nextRevision = () => "2026-10-28T00:00:" + String(++revisionCounter).padStart(2, "0") + ".000Z";
  const response = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  });

  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url);
    const method = options.method || "GET";
    requests.push({ method, pathname: parsed.pathname, search: parsed.search, body: options.body || null });
    if (!String(options.headers?.Authorization || "").startsWith("Bearer ")) {
      return response({ error: "Missing Firebase bearer token" }, 401);
    }
    if (parsed.pathname !== "/snapshot") return response({ error: "Not found" }, 404);

    if (method === "GET") {
      if (!document) {
        return response(parsed.searchParams.get("metadata") === "1"
          ? { ok: true, exists: false, revision: null }
          : { ok: true, exists: false, data: "", revision: null });
      }
      if (parsed.searchParams.get("metadata") === "1") {
        return response({ ok: true, exists: true, revision: document.revision });
      }
      return response({
        ok: true, exists: true, data: JSON.stringify(document.data), parts: 1, revision: document.revision
      });
    }

    if (method !== "POST") return response({ error: "Method not allowed" }, 405);
    let body;
    try { body = JSON.parse(options.body || ""); }
    catch { return response({ error: "Invalid JSON" }, 400); }
    if (typeof body.data !== "string" || !body.data) return response({ error: "Expected serialized data" }, 400);
    let data;
    try { data = JSON.parse(body.data); }
    catch { return response({ error: "Invalid serialized snapshot" }, 400); }

    // Mirrors the Worker/Firestore revision precondition: null means create-only;
    // a string revision means update only if that exact revision is still current.
    const matches = document
      ? typeof body.revision === "string" && body.revision === document.revision
      : body.revision === null;
    if (!matches) return response({ error: "Snapshot conflict", conflict: true }, 409);
    document = { data: structuredClone(data), revision: nextRevision() };
    return response({ ok: true, saved: true, revision: document.revision });
  }

  return {
    fetchImpl, requests,
    read: () => document ? structuredClone(document) : null
  };
}

const collectionOperation = () => ({
  opId: "op-device-b-collection-5000",
  type: "DEBT_COLLECTION",
  status: "PENDING",
  createdAt: "2026-10-28T00:00:05.000Z",
  payload: { customerId: "cust_s", amount: 5000, cashMovementId: "cm-device-b-001" }
});

test("E2E mock: device A publishes V1, device B gets 409, reconciles V1, and publishes V2", async () => {
  const worker = createMockFirebaseWorker();
  const transportA = createFirebaseSnapshotTransport({
    baseUrl: "https://firebase-snapshot.mock",
    getIdToken: async () => "token-device-a",
    fetchImpl: worker.fetchImpl
  });
  const transportB = createFirebaseSnapshotTransport({
    baseUrl: "https://firebase-snapshot.mock",
    getIdToken: async () => "token-device-b",
    fetchImpl: worker.fetchImpl
  });

  const v1Source = initialSnapshot();
  const v1Upload = await transportA.pushCloud({ data: v1Source, baseRevision: null });
  assert.equal(v1Upload.status, 200);
  const v1 = await transportB.pullCloud();
  assert.equal(v1.revision, v1Upload.revision);
  assert.equal(v1.data.caisseBalance, 54000);

  // Device B has stale V0 locally and a durable pending collection operation.
  const storageB = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify({ ...initialSnapshot(), localDeviceMarker: "V0" }),
    [MUTATION_KEYS.pending]: JSON.stringify([collectionOperation()]),
    [MUTATION_KEYS.rescue]: null,
    [MUTATION_KEYS.quarantined]: JSON.stringify([]),
    [MUTATION_KEYS.revision]: JSON.stringify(null)
  });
  const orchestratorB = createMutationQueueOrchestrator({
    storage: storageB,
    pullCloud: () => transportB.pullCloud(),
    pushCloud: args => transportB.pushCloud(args),
    maxConflictRetries: 3
  });

  const staleAttempt = await orchestratorB.pushCurrent();
  assert.equal(staleAttempt.status, "conflict");
  assert.equal(storageB.json(MUTATION_KEYS.pending).length, 1);

  const reconciled = await orchestratorB.reconcileAndSync();
  assert.equal(reconciled.status, "synced");
  assert.equal(reconciled.attempts, 1);
  assert.deepEqual(reconciled.applied, ["op-device-b-collection-5000"]);

  const v2 = worker.read();
  assert.ok(v2);
  assert.notEqual(v2.revision, v1.revision);
  assert.equal(v2.data.caisseBalance, 59000);
  assert.equal(v2.data.customers[0].debt, 21000);
  assert.equal(v2.data.products[0].stock, 90);
  assert.equal(v2.data.cashMovements.filter(m => m.id === "cm-device-b-001").length, 1);
  assert.deepEqual(storageB.json(MUTATION_KEYS.pending), []);
  assert.equal(storageB.getItem(MUTATION_KEYS.rescue), null);

  // A retry/replay against the already-accepted V2 must not duplicate the entity.
  const replay = await orchestratorB.reconcileAndSync();
  assert.equal(replay.status, "synced");
  const v2AfterReplay = worker.read();
  assert.equal(v2AfterReplay.data.caisseBalance, 59000);
  assert.equal(v2AfterReplay.data.customers[0].debt, 21000);
  assert.equal(v2AfterReplay.data.cashMovements.filter(m => m.id === "cm-device-b-001").length, 1);
  assert.ok(worker.requests.some(r => r.method === "POST"));
  assert.ok(worker.requests.some(r => r.method === "GET" && r.search === ""));
});

test("E2E mock: first cloud initialization accepts a null revision and uses create-only compare-and-swap", async () => {
  const worker = createMockFirebaseWorker();
  const empty = initialSnapshot();
  const transport = createFirebaseSnapshotTransport({
    baseUrl: "https://firebase-snapshot.mock",
    getIdToken: async () => "token-first-device",
    emptySnapshot: empty,
    fetchImpl: worker.fetchImpl
  });
  const storage = new MemoryStorage({
    [MUTATION_KEYS.appData]: JSON.stringify({ ...initialSnapshot(), localDeviceMarker: "offline-v0" }),
    [MUTATION_KEYS.pending]: JSON.stringify([collectionOperation()]),
    [MUTATION_KEYS.rescue]: null,
    [MUTATION_KEYS.quarantined]: JSON.stringify([]),
    [MUTATION_KEYS.revision]: JSON.stringify(null)
  });
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: () => transport.pullCloud(),
    pushCloud: args => transport.pushCloud(args),
    maxConflictRetries: 3
  });

  const result = await orchestrator.reconcileAndSync();
  assert.equal(result.status, "synced");
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.applied, ["op-device-b-collection-5000"]);
  assert.equal(worker.read().data.caisseBalance, 59000);
  assert.equal(worker.read().data.customers[0].debt, 21000);
  assert.equal(worker.read().data.cashMovements.filter(m => m.id === "cm-device-b-001").length, 1);
  assert.deepEqual(storage.json(MUTATION_KEYS.pending), []);
  assert.equal(storage.getItem(MUTATION_KEYS.rescue), null);
  assert.equal(worker.requests.filter(request => request.method === "POST").length, 1);
  assert.equal(JSON.parse(worker.requests.find(request => request.method === "POST").body).revision, null);
});
