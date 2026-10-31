import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_KEY = "ANAS_THE_ENTERPRISE_V11_OFFLINE";
const PENDING_KEY = "ANAS_PENDING_MUTATIONS_V1";
const QUARANTINE_KEY = "ANAS_QUARANTINED_MUTATIONS_V1";
const REVISION_KEY = "ANAS_CLOUD_REVISION_V1";
const RESCUE_KEY = "ANAS_CONFLICT_RESCUE_SNAPSHOT";

let server;
let origin;
let browser;

function mime(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".mjs") || file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

test.before(async () => {
  server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const target = path.resolve(ROOT, "." + pathname);
    if (!target.startsWith(ROOT + path.sep) && target !== path.join(ROOT, "index.html")) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(target, (error, bytes) => {
      if (error) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": mime(target), "cache-control": "no-store" });
      res.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openIsolatedPage(t) {
  const page = await browser.newPage();
  const errors = [];
  const externalRequests = [];
  const dialogs = [];
  page.on("pageerror", error => errors.push(String(error?.stack || error)));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("dialog", async dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      await route.continue();
    } else {
      externalRequests.push(route.request().url());
      await route.abort("blockedbyclient");
    }
  });
  await page.goto(origin + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof AppData !== "undefined" && typeof saveDB === "function", null, { timeout: 15000 });
  // Use the application's own initialized schema, then overwrite only isolated test ledgers.
  await page.evaluate(() => {
    anasStartupIntegrityIssues = [];
    anasStartupFatalLoadError = false;
    const seed = structuredClone(AppData);
    seed.caisseBalance = 50000;
    seed.customers = [{ id: "cust-browser-1", name: "عميل اختبار المتصفح", debt: 20000, debtDate: "2026-10-28" }];
    seed.products = [
      { id: "browser-item-a", name: "صنف A", stock: 100, warehouseStock: {} },
      { id: "browser-item-b", name: "صنف B", stock: 100, warehouseStock: {} }
    ];
    seed.invoices = [];
    seed.cashMovements = [];
    seed.stockMovements = [];
    seed.appliedOpIds = [];
    AppData = seed;
    if (!Array.isArray(posCart)) posCart = [];
    localStorage.setItem("ANAS_THE_ENTERPRISE_V11_OFFLINE", JSON.stringify(seed));
    localStorage.setItem("ANAS_PENDING_MUTATIONS_V1", "[]");
    localStorage.setItem("ANAS_CONFLICT_RESCUE_SNAPSHOT", "null");
    localStorage.setItem("ANAS_QUARANTINED_MUTATIONS_V1", "[]");
    localStorage.setItem("ANAS_CLOUD_REVISION_V1", JSON.stringify(0));
    renderCustomersDebts();
  });
  t.after(async () => page.close());
  return { page, errors, externalRequests, dialogs };
}

async function installHarness(page, { firstPushConflict = false, cloudV1 = null } = {}) {
  await page.evaluate(async ({ firstPushConflict, cloudV1 }) => {
    const { createMutationQueueOrchestrator } = await import("/sync/mutation_queue_orchestrator.mjs");
    const { installV42RuntimeWiring } = await import("/sync/v42_runtime_installer.mjs");
    const state = {
      cloud: cloudV1 || { data: structuredClone(AppData), revision: 1 },
      firstPushConflict,
      posts: 0,
      pulls: 0
    };
    window.__browserSyncState = state;
    const pushCloud = async ({ data, baseRevision }) => {
      const response = await fetch("/__mock-cloud/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data, baseRevision })
      });
      return response.json();
    };
    const pullCloud = async () => {
      const response = await fetch("/__mock-cloud/pull");
      return response.json();
    };
    const orchestrator = createMutationQueueOrchestrator({ storage: localStorage, pullCloud, pushCloud });
    const onQuarantine = items => {
      let node = document.getElementById("sync-quarantine-alert");
      if (!node) {
        node = document.createElement("div");
        node.id = "sync-quarantine-alert";
        node.setAttribute("role", "alert");
        document.body.appendChild(node);
      }
      node.textContent = "تم عزل " + items.length + " عملية للمراجعة";
    };
    window.__browserInstaller = installV42RuntimeWiring({
      windowObject: window,
      storage: localStorage,
      orchestrator,
      getAppData: () => AppData,
      setAppData: value => { AppData = value; },
      getSaveDB: () => saveDB,
      setSaveDB: fn => { saveDB = fn; },
      mapMutation: ({ entity, kind }) => {
        if (kind === "collection") {
          return {
            type: "DEBT_COLLECTION",
            payload: {
              customerId: String(entity.referenceId),
              amount: Number(entity.amount),
              cashMovementId: String(entity.id),
              cashMovement: structuredClone(entity)
            }
          };
        }
        if (kind === "sale") {
          return { type: "SALE_INVOICE", payload: { warehouse: entity.warehouse || "المخزن الرئيسي", invoice: structuredClone(entity) } };
        }
        throw new Error("Unsupported browser test mutation kind: " + kind);
      },
      uuid: () => "browser-op-" + Date.now() + "-" + Math.random().toString(16).slice(2),
      now: () => new Date("2026-10-28T12:00:00.000Z"),
      onQuarantine,
      onStatus: status => { window.__lastSyncStatus = status; }
    });
    window.__browserInstaller.install();
    window.__browserSyncState = state;
  }, { firstPushConflict, cloudV1 });
}

async function setMockCloudRoutes(page, state) {
  await page.route("**/__mock-cloud/**", async route => {
    const request = route.request();
    if (request.url().endsWith("/pull")) {
      state.pulls++;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(structuredClone(state.cloud)) });
      return;
    }
    if (request.url().endsWith("/push")) {
      state.posts++;
      const body = request.postDataJSON();
      if (state.firstPushConflict) {
        state.firstPushConflict = false;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: 409 }) });
        return;
      }
      if (body.baseRevision !== state.cloud.revision) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: 409 }) });
        return;
      }
      state.cloud = { data: body.data, revision: state.cloud.revision + 1 };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: 200, revision: state.cloud.revision }) });
      return;
    }
    await route.abort("blockedbyclient");
  });
}

async function seedCollectionV1(page) {
  return page.evaluate(() => {
    const v1 = structuredClone(AppData);
    v1.caisseBalance = 50500;
    v1.customers[0].debt = 19500;
    v1.cashMovements = [{ id: "cloud-movement-v1", type: "add", amount: 500, referenceId: "cloud-seed" }];
    return v1;
  });
}

test("browser DOM boot, installer wiring, 409 reconciliation, and exact decimal ledger", async t => {
  const { page, errors, externalRequests } = await openIsolatedPage(t);
  const v1 = await seedCollectionV1(page);
  const cloud = { data: v1, revision: 1 };
  const mock = { cloud, firstPushConflict: true, posts: 0, pulls: 0 };
  await setMockCloudRoutes(page, mock);
  await installHarness(page, { firstPushConflict: true, cloudV1: cloud });
  await page.evaluate(() => {
    window.prompt = () => "500.50";
    window.alert = () => {};
    collectCustDebt("cust-browser-1");
  });
  const beforeSync = await page.evaluate(() => ({
    app: JSON.parse(localStorage.getItem("ANAS_THE_ENTERPRISE_V11_OFFLINE")),
    queue: JSON.parse(localStorage.getItem("ANAS_PENDING_MUTATIONS_V1"))
  }));
  assert.equal(beforeSync.queue.length, 1);
  assert.equal(beforeSync.queue[0].status, "PENDING");
  assert.equal(beforeSync.queue[0].payload.amount, 500.5);
  const sync = await page.evaluate(() => window.anasFirebasePush());
  assert.equal(sync.status, "synced");
  const finalState = await page.evaluate(() => ({
    app: JSON.parse(localStorage.getItem("ANAS_THE_ENTERPRISE_V11_OFFLINE")),
    queue: JSON.parse(localStorage.getItem("ANAS_PENDING_MUTATIONS_V1")),
    renderedDebt: document.getElementById("custDebtsContainer")?.textContent || ""
  }));
  assert.equal(finalState.app.caisseBalance, 51000.5);
  assert.equal(finalState.app.customers[0].debt, 18999.5);
  assert.equal(finalState.app.cashMovements.filter(x => x.id === beforeSync.queue[0].payload.cashMovementId).length, 1);
  assert.deepEqual(finalState.queue, []);
  assert.ok(mock.pulls >= 1);
  assert.ok(mock.posts >= 2);
  assert.ok(finalState.renderedDebt.includes("18,999.5") || finalState.renderedDebt.includes("18999.5"));
  assert.ok(externalRequests.every(url => !url.startsWith(origin)), "all attempted external requests must be blocked by the browser route");
  assert.equal(errors.some(x => /v42_runtime_installer|mutation_queue_orchestrator/.test(x) && /ReferenceError|SyntaxError/.test(x)), false);
});

test("real page reload recovers PREPARED mutation before reconciliation", async t => {
  const { page, errors, externalRequests } = await openIsolatedPage(t);
  const cloud = await seedCollectionV1(page);
  const mock = { cloud: { data: cloud, revision: 1 }, firstPushConflict: false, posts: 0, pulls: 0 };
  await setMockCloudRoutes(page, mock);
  await page.evaluate(() => {
    const app = structuredClone(AppData);
    app.customers[0].debt = 19499.5;
    app.caisseBalance = 50500.5;
    const opId = "browser-prepared-reload-op";
    app.cashMovements.push({
      id: "browser-prepared-reload-movement", type: "add", amount: 500.5,
      referenceType: "customer_debt", referenceId: "cust-browser-1",
      opId, syncOpId: opId, syncCreatedAt: "2026-10-28T12:00:00.000Z"
    });
    app.appliedOpIds = [opId];
    AppData = app;
    localStorage.setItem("ANAS_THE_ENTERPRISE_V11_OFFLINE", JSON.stringify(app));
    localStorage.setItem("ANAS_PENDING_MUTATIONS_V1", JSON.stringify([{
      opId, type: "DEBT_COLLECTION", status: "PREPARED",
      createdAt: "2026-10-28T12:00:00.000Z",
      payload: {
        customerId: "cust-browser-1", amount: 500.5,
        cashMovementId: "browser-prepared-reload-movement",
        cashMovement: app.cashMovements[0]
      }
    }]));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof AppData !== "undefined" && typeof saveDB === "function");
  await installHarness(page, { cloudV1: mock.cloud });
  const result = await page.evaluate(() => window.anasFirebasePush());
  assert.equal(result.status, "synced");
  const recovered = await page.evaluate(() => ({
    app: JSON.parse(localStorage.getItem("ANAS_THE_ENTERPRISE_V11_OFFLINE")),
    queue: JSON.parse(localStorage.getItem("ANAS_PENDING_MUTATIONS_V1"))
  }));
  assert.equal(recovered.app.caisseBalance, 51000.5);
  assert.equal(recovered.app.customers[0].debt, 18999.5);
  assert.ok(recovered.app.appliedOpIds.includes("browser-prepared-reload-op"));
  assert.deepEqual(recovered.queue, []);
  assert.ok(externalRequests.every(url => !url.startsWith(origin)), "all attempted external requests must be blocked by the browser route");
  assert.equal(errors.some(x => /v42_runtime_installer|mutation_queue_orchestrator/.test(x) && /ReferenceError|SyntaxError/.test(x)), false);
});

test("multi-line sale is quarantined atomically and browser DOM shows quarantine feedback", async t => {
  const { page, errors, externalRequests } = await openIsolatedPage(t);
  const cloud = await page.evaluate(() => {
    const v1 = structuredClone(AppData);
    v1.products.find(p => p.id === "browser-item-a").stock = 5;
    v1.products.find(p => p.id === "browser-item-b").stock = 0;
    return v1;
  });
  const mock = { cloud: { data: cloud, revision: 1 }, firstPushConflict: false, posts: 0, pulls: 0 };
  await setMockCloudRoutes(page, mock);
  await installHarness(page, { cloudV1: mock.cloud });
  await page.evaluate(() => {
    AppData.invoices.push({
      id: "browser-multi-line-invoice",
      items: [
        { id: "browser-item-a", qty: 2, price: 10 },
        { id: "browser-item-b", qty: 1, price: 10 }
      ],
      total: 30, paid: 30, remaining: 0,
      warehouse: "المخزن الرئيسي", warehouseName: "المخزن الرئيسي"
    });
    saveDB();
  });
  const result = await page.evaluate(() => window.anasFirebasePull());
  assert.equal(result.status, "synced");
  const state = await page.evaluate(() => ({
    app: JSON.parse(localStorage.getItem("ANAS_THE_ENTERPRISE_V11_OFFLINE")),
    quarantine: JSON.parse(localStorage.getItem("ANAS_QUARANTINED_MUTATIONS_V1")),
    alert: document.getElementById("sync-quarantine-alert")?.textContent || ""
  }));
  assert.equal(state.app.products.find(p => p.id === "browser-item-a").stock, 5);
  assert.equal(state.app.products.find(p => p.id === "browser-item-b").stock, 0);
  assert.equal(state.app.invoices.some(x => x.id === "browser-multi-line-invoice"), false);
  assert.equal(state.app.caisseBalance, 50000);
  assert.equal(state.quarantine.length, 1);
  assert.match(state.quarantine[0].reason, /INSUFFICIENT_CLOUD_STOCK/);
  assert.match(state.alert, /عزل.*عملية للمراجعة/);
  assert.ok(externalRequests.every(url => !url.startsWith(origin)), "all attempted external requests must be blocked by the browser route");
  assert.equal(errors.some(x => /v42_runtime_installer|mutation_queue_orchestrator/.test(x) && /ReferenceError|SyntaxError/.test(x)), false);
});

test("browser localStorage accepts and reloads the real serialized AppData snapshot", async t => {
  const { page, errors, externalRequests } = await openIsolatedPage(t);
  const before = await page.evaluate(() => localStorage.getItem("ANAS_THE_ENTERPRISE_V11_OFFLINE"));
  assert.doesNotThrow(() => JSON.parse(before));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof AppData !== "undefined");
  const after = await page.evaluate(() => ({
    key: localStorage.getItem("ANAS_THE_ENTERPRISE_V11_OFFLINE"),
    customerId: AppData.customers?.[0]?.id,
    cash: AppData.caisseBalance
  }));
  assert.doesNotThrow(() => JSON.parse(after.key));
  assert.equal(after.customerId, "cust-browser-1");
  assert.equal(after.cash, 50000);
  assert.ok(externalRequests.every(url => !url.startsWith(origin)), "all attempted external requests must be blocked by the browser route");
  assert.equal(errors.some(x => /v42_runtime_installer|mutation_queue_orchestrator/.test(x) && /ReferenceError|SyntaxError/.test(x)), false);
});
