/**
 * ANAS ERP — Level 27
 * Two-session last-unit race against the real Firebase Snapshot Worker.
 *
 * This proves Firestore updateTime compare-and-set on the shared user snapshot.
 * It deliberately does NOT claim to prove atomic server-side invoice/ledger posting;
 * that requires a dedicated financial mutation callable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = await readFile(resolve("cloudflare/worker_firebase_snapshot.js"), "utf8");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const { default: worker } = await import(moduleUrl);

const PROJECT = "anas-erp-staging-a25e1";
const ORIGIN = "https://anas-erp-staging-a25e1.web.app";
const INITIAL_UPDATE_TIME = "2026-11-03T12:00:00.000000Z";

function makeAppData(sales) {
  return {
    products: [{ id: "tea_alkim_01", name: "شاي الرقيم - علبة", stock: 0 }],
    customers: [],
    suppliers: [],
    invoices: sales.map(sale => ({
      id: "invoice_" + sale.id,
      total: 100,
      paid: 0,
      remaining: 100,
      items: [{ productId: "tea_alkim_01", qty: 1, price: 100 }]
    })),
    cashMovements: [],
    stockMovements: sales.map(sale => ({
      id: "stock_" + sale.id,
      productId: "tea_alkim_01",
      qty: -1,
      previousStock: 1,
      newStock: 0
    })),
    sales
  };
}

function createFirestoreHarness() {
  let updateTime = INITIAL_UPDATE_TIME;
  let payload = JSON.stringify({
    products: [{ id: "tea_alkim_01", name: "شاي الرقيم - علبة", stock: 1 }],
    customers: [],
    suppliers: [],
    invoices: [],
    cashMovements: [],
    stockMovements: [],
    sales: []
  });
  let patchCount = 0;

  return {
    get patchCount() { return patchCount; },
    get payload() { return payload; },
    async fetch(url, init = {}) {
      const target = String(url);
      if (target.includes("identitytoolkit.googleapis.com")) {
        const token = JSON.parse(init.body).idToken;
        assert.ok(token === "device-a-token" || token === "device-b-token");
        return new Response(JSON.stringify({ users: [{ localId: "shared-staging-user" }] }), { status: 200 });
      }

      assert.match(target, /documents\/users\/shared-staging-user\/snapshots\/latest/);
      if (!init.method || init.method === "GET") {
        return new Response(JSON.stringify({
          updateTime,
          fields: { payload: { stringValue: payload } }
        }), { status: 200 });
      }

      assert.equal(init.method, "PATCH");
      patchCount++;
      const urlObject = new URL(target);
      const expectedUpdateTime = urlObject.searchParams.get("currentDocument.updateTime");

      // Firestore's updateTime precondition is checked and committed atomically.
      if (expectedUpdateTime !== updateTime) {
        return new Response(JSON.stringify({
          error: { status: "FAILED_PRECONDITION", message: "The update time precondition failed." }
        }), { status: 400 });
      }

      const body = JSON.parse(init.body);
      payload = body.fields.payload.stringValue;
      updateTime = "2026-11-03T12:00:01.000000Z";
      return new Response(JSON.stringify({ updateTime }), { status: 200 });
    }
  };
}

function requestFor(token, data, revision) {
  return new Request("https://worker.test/snapshot", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ data: JSON.stringify(data), revision })
  });
}

test("Level 27 — two independent sessions cannot both commit the last-unit snapshot", async () => {
  const harness = createFirestoreHarness();
  const env = {
    FIREBASE_API_KEY: "level27-test-api-key",
    FIREBASE_PROJECT_ID: PROJECT,
    ALLOWED_ORIGINS: ORIGIN
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch.bind(harness);

  try {
    const observedRevision = INITIAL_UPDATE_TIME;
    const candidateA = makeAppData([{ id: "sale_device_A", qty: 1 }]);
    const candidateB = makeAppData([{ id: "sale_device_B", qty: 1 }]);

    // Separate authenticated request contexts, same shared Firebase UID and same
    // revision observed before either device attempts to commit.
    const [responseA, responseB] = await Promise.all([
      worker.fetch(requestFor("device-a-token", candidateA, observedRevision), env),
      worker.fetch(requestFor("device-b-token", candidateB, observedRevision), env)
    ]);

    const outcomes = await Promise.all([
      responseA.json().then(body => ({ status: responseA.status, body })),
      responseB.json().then(body => ({ status: responseB.status, body }))
    ]);
    const winners = outcomes.filter(x => x.status === 200 && x.body.saved === true);
    const conflicts = outcomes.filter(x => x.status === 409 && x.body.conflict === true);

    assert.equal(winners.length, 1, "exactly one stale-revision contender may commit");
    assert.equal(conflicts.length, 1, "the competing contender must receive HTTP 409");
    assert.equal(harness.patchCount, 2, "both devices must reach the conditional Firestore write");

    const committed = JSON.parse(harness.payload);
    assert.equal(committed.products[0].stock, 0, "winning commit must leave exactly zero stock");
    assert.ok(committed.products[0].stock >= 0, "committed stock must never be negative");
    assert.equal(committed.sales.length, 1, "only one sale may be present in the committed snapshot");
    assert.equal(committed.invoices.length, 1, "only one candidate invoice may be present");
    assert.equal(committed.stockMovements.length, 1, "only one stock movement may be present");
    assert.equal(committed.sales[0].qty, 1);
    assert.equal(committed.stockMovements[0].previousStock, 1);
    assert.equal(committed.stockMovements[0].newStock, 0);
    assert.equal(committed.sales[0].id, committed.invoices[0].id.replace("invoice_", ""));
    assert.equal(committed.sales[0].id, committed.stockMovements[0].id.replace("stock_", ""));
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Level 27 — a stale contender cannot overwrite the winning snapshot after the CAS commit", async () => {
  const harness = createFirestoreHarness();
  const env = {
    FIREBASE_API_KEY: "level27-test-api-key",
    FIREBASE_PROJECT_ID: PROJECT,
    ALLOWED_ORIGINS: ORIGIN
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = harness.fetch.bind(harness);

  try {
    const stale = INITIAL_UPDATE_TIME;
    const winner = await worker.fetch(requestFor(
      "device-a-token",
      makeAppData([{ id: "sale_winner", qty: 1 }]),
      stale
    ), env);
    assert.equal(winner.status, 200);

    const loser = await worker.fetch(requestFor(
      "device-b-token",
      makeAppData([{ id: "sale_loser", qty: 1 }]),
      stale
    ), env);
    assert.equal(loser.status, 409);

    const committed = JSON.parse(harness.payload);
    assert.deepEqual(committed.sales.map(x => x.id), ["sale_winner"]);
    assert.equal(committed.products[0].stock, 0);
    assert.equal(harness.patchCount, 2);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
