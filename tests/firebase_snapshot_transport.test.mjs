import test from "node:test";
import assert from "node:assert/strict";
import { createFirebaseSnapshotTransport } from "../sync/firebase_snapshot_transport.mjs";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

test("pullCloud adapts the Worker serialized data and revision to the queue contract", async () => {
  const appData = { products: [{ id: "p1", stock: 7 }], customers: [], invoices: [] };
  let captured;
  const transport = createFirebaseSnapshotTransport({
    baseUrl: "https://snapshot.example.workers.dev",
    getIdToken: async () => "firebase-id-token",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return response({ ok: true, exists: true, data: JSON.stringify(appData), revision: "rev-1" });
    }
  });
  const result = await transport.pullCloud();
  assert.deepEqual(result, { data: appData, revision: "rev-1" });
  assert.equal(captured.url, "https://snapshot.example.workers.dev/snapshot");
  assert.equal(captured.options.headers.Authorization, "Bearer firebase-id-token");
  assert.equal(captured.options.cache, "no-store");
});

test("pushCloud maps baseRevision to Worker revision and serializes the AppData object", async () => {
  const appData = { products: [], customers: [], invoices: [], caisseBalance: 12.5 };
  let captured;
  const transport = createFirebaseSnapshotTransport({
    baseUrl: "https://snapshot.example.workers.dev/",
    getIdToken: async () => "token",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return response({ ok: true, saved: true, revision: "rev-2" });
    }
  });
  const result = await transport.pushCloud({ data: appData, baseRevision: "rev-1" });
  assert.equal(result.status, 200);
  assert.equal(result.revision, "rev-2");
  assert.equal(captured.options.method, "POST");
  assert.deepEqual(JSON.parse(captured.options.body), {
    data: JSON.stringify(appData),
    revision: "rev-1"
  });
});

test("pushCloud preserves HTTP 409 as a conflict result for the orchestrator", async () => {
  const transport = createFirebaseSnapshotTransport({
    baseUrl: "https://snapshot.example.workers.dev",
    getIdToken: async () => "token",
    fetchImpl: async () => response({ error: "Snapshot conflict", conflict: true }, 409)
  });
  const result = await transport.pushCloud({ data: { products: [], customers: [] }, baseRevision: "rev-1" });
  assert.equal(result.status, 409);
  assert.equal(result.conflict, true);
});

test("an absent cloud snapshot requires an explicit initial snapshot", async () => {
  const noInitialState = createFirebaseSnapshotTransport({
    baseUrl: "https://snapshot.example.workers.dev",
    getIdToken: async () => "token",
    fetchImpl: async () => response({ ok: true, exists: false, data: "", revision: null })
  });
  await assert.rejects(noInitialState.pullCloud(), /explicit emptySnapshot/);

  const withInitialState = createFirebaseSnapshotTransport({
    baseUrl: "https://snapshot.example.workers.dev",
    getIdToken: async () => "token",
    emptySnapshot: { products: [], customers: [], invoices: [], caisseBalance: 0 },
    fetchImpl: async () => response({ ok: true, exists: false, data: "", revision: null })
  });
  assert.deepEqual(await withInitialState.pullCloud(), {
    data: { products: [], customers: [], invoices: [], caisseBalance: 0 },
    revision: null
  });
});

test("transport rejects missing authentication and malformed cloud data", async () => {
  const noToken = createFirebaseSnapshotTransport({
    baseUrl: "https://snapshot.example.workers.dev",
    getIdToken: async () => "",
    fetchImpl: async () => response({})
  });
  await assert.rejects(noToken.pullCloud(), /ID token is missing/);

  const malformed = createFirebaseSnapshotTransport({
    baseUrl: "https://snapshot.example.workers.dev",
    getIdToken: async () => "token",
    fetchImpl: async () => response({ exists: true, data: "{bad", revision: "rev-1" })
  });
  await assert.rejects(malformed.pullCloud(), /not valid JSON/);
});

test("transport rejects insecure remote URLs and unsafe base URL components", () => {
  const base = { getIdToken: async () => "token", fetchImpl: async () => response({}) };
  assert.throws(() => createFirebaseSnapshotTransport({ ...base, baseUrl: "http://snapshot.example.workers.dev" }), /must use HTTPS/);
  assert.throws(() => createFirebaseSnapshotTransport({ ...base, baseUrl: "https://user:pass@snapshot.example.workers.dev" }), /must not contain credentials/);
});
