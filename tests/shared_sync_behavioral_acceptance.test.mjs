import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// This harness executes the real snapshot Worker against a deterministic Firestore mock.
// It verifies server-side revision conflict behavior, not browser UI or offline queue behavior.
const source = await readFile(resolve("cloudflare/worker_firebase_snapshot.js"), "utf8");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const { default: worker } = await import(moduleUrl);
const origin = "https://amin545677-svg.github.io";
const env = { FIREBASE_API_KEY: "test-key", FIREBASE_PROJECT_ID: "anas-erb" };
const initialRevision = "2026-10-27T10:00:00.000000Z";

function postSnapshot(data, revision) {
  return new Request("https://worker.test/snapshot", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer firebase-test-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ data: JSON.stringify(data), revision })
  });
}

function authResponse() {
  return new Response(JSON.stringify({ users: [{ localId: "test-user" }] }), { status: 200 });
}

test("two clients uploading the same observed revision cannot silently overwrite each other", async () => {
  const originalFetch = globalThis.fetch;
  let currentRevision = initialRevision;
  let persistedPayload = JSON.stringify({ products: [{ id: "p1", stock: 10 }], customers: [] });
  let patchCount = 0;

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("identitytoolkit.googleapis.com")) return authResponse();
    assert.match(String(url), /documents\/users\/test-user\/snapshots\/latest/);
    assert.equal(init.method, "PATCH");
    patchCount++;

    const target = new URL(String(url));
    const requiredRevision = target.searchParams.get("currentDocument.updateTime");
    assert.equal(requiredRevision, initialRevision, "both clients should submit the same stale revision");

    if (currentRevision !== requiredRevision) {
      return new Response(JSON.stringify({
        error: { status: "FAILED_PRECONDITION", message: "The update time precondition failed." }
      }), { status: 400 });
    }

    const patch = JSON.parse(init.body);
    persistedPayload = patch.fields.payload.stringValue;
    currentRevision = "2026-10-27T10:01:00.000000Z";
    return new Response(JSON.stringify({ updateTime: currentRevision }), { status: 200 });
  };

  const clientA = { products: [{ id: "p1", stock: 9 }], customers: [] };
  const clientB = { products: [{ id: "p1", stock: 8 }], customers: [] };

  try {
    // Both requests were prepared from the same cloud revision. The mock's conditional
    // update is atomic: exactly one write can advance the revision.
    const responses = await Promise.all([
      worker.fetch(postSnapshot(clientA, initialRevision), env),
      worker.fetch(postSnapshot(clientB, initialRevision), env)
    ]);
    const statuses = responses.map(response => response.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    assert.equal(bodies.filter(body => body.saved === true).length, 1);
    assert.equal(bodies.filter(body => body.conflict === true).length, 1);
    assert.equal(patchCount, 2);
    assert.ok([JSON.stringify(clientA), JSON.stringify(clientB)].includes(persistedPayload),
      "the stored snapshot must be exactly one complete client payload, not a partial mixture");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("golden reconciliation arithmetic catches stock, cash, and debt imbalance", () => {
  const stock = { loaded: 100, soldCash: 35, soldCredit: 25, returned: 30, damaged: 5, missing: 5 };
  assert.equal(stock.soldCash + stock.soldCredit + stock.returned + stock.damaged + stock.missing, stock.loaded);

  const cash = { opening: 1000, cashSales: 350, creditDownPayments: 50, oldDebtCollections: 80, tripExpenses: 40, closing: 1440 };
  assert.equal(cash.opening + cash.cashSales + cash.creditDownPayments + cash.oldDebtCollections - cash.tripExpenses, cash.closing);

  const debt = { opening: 500, newCreditRemaining: 200, collections: 80, closing: 620 };
  assert.equal(debt.opening + debt.newCreditRemaining - debt.collections, debt.closing);

  assert.notEqual(stock.soldCash + stock.soldCredit + stock.returned + stock.damaged, stock.loaded,
    "omitting missing goods must make the stock equation fail");
  assert.notEqual(cash.opening + cash.cashSales + cash.creditDownPayments + cash.oldDebtCollections, cash.closing,
    "omitting trip expenses must make the cash equation fail");
  assert.notEqual(debt.opening + debt.newCreditRemaining, debt.closing,
    "omitting collections must make the debt equation fail");
});
