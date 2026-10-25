import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = await readFile(resolve("cloudflare/worker_firebase_snapshot.js"), "utf8");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const { default: worker } = await import(moduleUrl);
const allowedOrigin = "https://amin545677-svg.github.io";
const env = { FIREBASE_API_KEY: "test-key", FIREBASE_PROJECT_ID: "anas-erb" };

function request(path, { method = "GET", body, auth = true } = {}) {
  const headers = new Headers({ Origin: allowedOrigin });
  if (auth) headers.set("Authorization", "Bearer firebase-test-token");
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request("https://worker.test" + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function mockFirebaseLookup() {
  return new Response(JSON.stringify({ users: [{ localId: "test-user" }] }), { status: 200 });
}

test("metadata GET returns the Firestore updateTime without returning business data", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("identitytoolkit.googleapis.com")) return mockFirebaseLookup();
    assert.match(String(url), /documents\/users\/test-user\/snapshots\/latest$/);
    return new Response(JSON.stringify({
      updateTime: "2026-10-25T12:00:00.000000Z",
      fields: { payload: { stringValue: JSON.stringify({ products: [] }) } }
    }), { status: 200 });
  };
  try {
    const response = await worker.fetch(request("/snapshot?metadata=1"), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true, exists: true, revision: "2026-10-25T12:00:00.000000Z"
    });
  } finally { globalThis.fetch = oldFetch; }
});

test("stale revision is rejected instead of overwriting a newer snapshot", async () => {
  const oldFetch = globalThis.fetch;
  let patchUrl = "";
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("identitytoolkit.googleapis.com")) return mockFirebaseLookup();
    patchUrl = String(url);
    assert.equal(init.method, "PATCH");
    return new Response(JSON.stringify({
      error: { status: "FAILED_PRECONDITION", message: "The update time precondition failed." }
    }), { status: 400 });
  };
  try {
    const response = await worker.fetch(request("/snapshot", {
      method: "POST",
      body: { data: JSON.stringify({ products: [], customers: [] }), revision: "2026-10-25T12:00:00.000000Z" }
    }), env);
    assert.equal(new URL(patchUrl).searchParams.get("currentDocument.updateTime"), "2026-10-25T12:00:00.000000Z");
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.conflict, true);
    assert.match(result.error, /changed after it was read/i);
  } finally { globalThis.fetch = oldFetch; }
});

test("first snapshot upload uses an atomic create-only precondition", async () => {
  const oldFetch = globalThis.fetch;
  let patchUrl = "";
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("identitytoolkit.googleapis.com")) return mockFirebaseLookup();
    patchUrl = String(url);
    assert.equal(init.method, "PATCH");
    return new Response(JSON.stringify({ updateTime: "2026-10-25T13:00:00.000000Z" }), { status: 200 });
  };
  try {
    const response = await worker.fetch(request("/snapshot", {
      method: "POST", body: { data: JSON.stringify({ products: [], customers: [] }), revision: null }
    }), env);
    assert.equal(new URL(patchUrl).searchParams.get("currentDocument.exists"), "false");
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.saved, true);
    assert.equal(result.revision, "2026-10-25T13:00:00.000000Z");
  } finally { globalThis.fetch = oldFetch; }
});


test("malformed stock magnitudes are rejected before any Firestore write", async () => {
  const oldFetch = globalThis.fetch;
  let firestoreCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("identitytoolkit.googleapis.com")) return mockFirebaseLookup();
    firestoreCalls++;
    throw new Error("invalid snapshot must not reach Firestore");
  };
  try {
    const response = await worker.fetch(request("/snapshot", {
      method: "POST",
      body: { data: JSON.stringify({
        products: [{ id: "p1", stock: Number.MAX_SAFE_INTEGER + 1 }],
        customers: []
      }) }
    }), env);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /integrity validation/i);
    assert.equal(firestoreCalls, 0, "invalid stock magnitudes must not be persisted");
  } finally { globalThis.fetch = oldFetch; }
});

test("malformed truck loads and warehouse transfers are rejected before persistence", async () => {
  const oldFetch = globalThis.fetch;
  let firestoreCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("identitytoolkit.googleapis.com")) return mockFirebaseLookup();
    firestoreCalls++;
    throw new Error("invalid operational snapshot must not reach Firestore");
  };
  try {
    const badSnapshots = [
      { products: [{ id: "p1", stock: 1 }], customers: [{ id: "C1" }, { id: "C1" }] },
      { products: [{ id: "p1", stock: 1 }], customers: [], suppliers: [{ id: "S1" }, { id: "S1" }] },
      { products: [{ id: "p1", stock: 1 }], customers: [], truckTrips: [
        { id: "T1", stockItems: [{ productId: "p1", qty: true }] }
      ] },
      { products: [{ id: "p1", stock: 1 }], customers: [], truckTrips: [
        { id: "T1", stockItems: [{ productId: "p1", qty: 1 }, { productId: "p1", qty: 2 }] }
      ] },
      { products: [{ id: "p1", stock: 1 }], customers: [], warehouseTransfers: [
        { id: "WT1", quantity: 0 }
      ] }
    ];
    for (const data of badSnapshots) {
      const response = await worker.fetch(request("/snapshot", {
        method: "POST", body: { data: JSON.stringify(data) }
      }), env);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /integrity validation/i);
    }
    assert.equal(firestoreCalls, 0, "invalid truck/transfer records must not be persisted");
  } finally { globalThis.fetch = oldFetch; }
});

test("missing Firebase bearer token is rejected before any external request", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected external request"); };
  try {
    const response = await worker.fetch(request("/snapshot", { auth: false }), env);
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /Missing Firebase bearer token/i);
  } finally { globalThis.fetch = oldFetch; }
});

test("disallowed origins cannot use CORS preflight", async () => {
  const headers = new Headers({ Origin: "https://attacker.example" });
  const response = await worker.fetch(new Request("https://worker.test/snapshot", {
    method: "OPTIONS", headers
  }), env);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});
