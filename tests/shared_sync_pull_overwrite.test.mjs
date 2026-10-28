import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

// Run the production V42 function bodies from index.html in an isolated DOM.
// Only location.reload is replaced: jsdom cannot perform real page navigation.
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const storageKey = "ANAS_THE_ENTERPRISE_V11_OFFLINE";

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Production marker missing: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Production end marker missing: ${endMarker}`);
  return source.slice(start, end).trim();
}

const backupFn = between(html, "function exportDataBackup() {", "function anasValidateBackupData(incoming)");
const validatorFn = between(html, "function anasValidateBackupData(incoming)", "function importDataBackup(event)");
const pushFn = between(html, "window.anasFirebasePush=async function(){", ";\n  window.anasFirebasePull");
const pullFn = between(html, "window.anasFirebasePull=async function(){", "\n  };\n})();").replace(
  "location.reload();", "window.__reloadCalled = true;"
);

function localSnapshot() {
  return {
    appName: "ANAS", caisseBalance: 55000,
    products: [{ id: "item-a", name: "Item A", stock: 100 }],
    customers: [{ id: "customer-s", name: "Customer S", debt: 15000 }],
    suppliers: [], invoices: [], purchases: [], expenses: [], users: [], trucks: [],
    returns: [], warehouseTransfers: [], stockMovements: [], purchaseInvoices: [],
    alerts: [], truckTrips: [],
    cashMovements: [{ id: "collection-5000", type: "debt_collection", amount: 5000 }],
    stocktakeRecords: [], posScreensCarts: { 1: [], 2: [], 3: [], 4: [] },
    activePosScreenTab: 1, syncUrl: "https://worker.test"
  };
}

function cloudSnapshot() {
  return {
    appName: "ANAS", caisseBalance: 54000,
    products: [{ id: "item-a", name: "Item A", stock: 90 }],
    customers: [{ id: "customer-s", name: "Customer S", debt: 26000 }],
    suppliers: [], invoices: [{ id: "invoice-sale-10000", total: 10000 }],
    purchases: [], expenses: [], users: [], trucks: [], returns: [],
    warehouseTransfers: [],
    stockMovements: [{ id: "sale-stock-10", productId: "item-a", quantity: -10 }],
    purchaseInvoices: [], alerts: [], truckTrips: [],
    cashMovements: [{ id: "sale-cash-4000", type: "sale", amount: 4000 }],
    stocktakeRecords: [], posScreensCarts: { 1: [], 2: [], 3: [], 4: [] },
    activePosScreenTab: 1, syncUrl: "https://worker.test"
  };
}

function buildHarness() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://amin545677-svg.github.io/", runScripts: "outside-only"
  });
  const { window } = dom;
  const NativeBlob = window.Blob;
  let capturedBackupJson = null;
  let capturedDownloadFilename = null;
  const requests = [];
  const cloud = cloudSnapshot();

  window.confirm = () => true;
  window.alert = () => {};
  window.URL.createObjectURL = () => "blob:https://test.invalid/backup";
  window.URL.revokeObjectURL = () => {};
  window.Blob = function CapturingBlob(parts, options) {
    const text = Array.from(parts ?? []).map(part => typeof part === "string" ? part : String(part)).join("");
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && Object.hasOwn(parsed, "caisseBalance")) capturedBackupJson = parsed;
    } catch {}
    return new NativeBlob(parts, options);
  };
  window.HTMLAnchorElement.prototype.click = function interceptDownload() {
    if (this.download) capturedDownloadFilename = this.download;
  };

  window.AppData = localSnapshot();
  window.posCart = [];
  window.anasStartupIntegrityIssues = [];
  window.anasStartupFatalLoadError = false;
  window.saveDB = function saveDBHarness() {
    window.localStorage.setItem(storageKey, JSON.stringify(window.AppData));
    return true;
  };
  window.workerRequest = async function workerRequestHarness(method, body, options = {}) {
    requests.push({ method, body, options });
    if (method === "POST") {
      throw new Error("409: تغيّرت النسخة السحابية منذ آخر قراءة؛ اجلب أحدث نسخة ثم أعد المحاولة.");
    }
    return { data: JSON.stringify(cloud), revision: "V1" };
  };
  window.eval(backupFn + "\n" + validatorFn + "\n" + pushFn + "\n" + pullFn);
  return {
    dom, window, requests,
    get capturedBackupJson() { return capturedBackupJson; },
    get capturedDownloadFilename() { return capturedDownloadFilename; }
  };
}

test("V42 conflict then pull captures local collection in downloaded backup before snapshot overwrite", async t => {
  const h = buildHarness();
  t.after(() => h.dom.window.close());
  const { window } = h;
  window.localStorage.setItem(storageKey, JSON.stringify(window.AppData));

  const before = JSON.parse(window.localStorage.getItem(storageKey));
  assert.equal(before.caisseBalance, 55000);
  assert.equal(before.customers[0].debt, 15000);
  assert.ok(before.cashMovements.some(m => m.id === "collection-5000"));

  await window.anasFirebasePush();
  assert.ok(h.requests.some(r => r.method === "POST"), "push should attempt the stale snapshot upload");

  await window.anasFirebasePull();

  assert.match(h.capturedDownloadFilename ?? "", /_Backup_\d{4}-\d{2}-\d{2}\.json$/);
  assert.ok(h.capturedBackupJson, "must capture JSON passed to the production Blob");
  assert.equal(h.capturedBackupJson.caisseBalance, 55000);
  assert.equal(h.capturedBackupJson.customers[0].debt, 15000);
  assert.ok(h.capturedBackupJson.cashMovements.some(m => m.id === "collection-5000" && m.amount === 5000));

  const active = JSON.parse(window.localStorage.getItem(storageKey));
  assert.equal(active.caisseBalance, 54000);
  assert.equal(active.customers[0].debt, 26000);
  assert.equal(active.products[0].stock, 90);
  assert.equal(active.cashMovements.some(m => m.id === "collection-5000"), false);
  assert.equal(window.__reloadCalled, true);
  assert.ok(h.requests.some(r => r.method === "GET"), "pull should fetch the mocked cloud snapshot");
});

test("V42 pull aborts before network access if backup creation fails", async t => {
  const h = buildHarness();
  t.after(() => h.dom.window.close());
  const { window } = h;
  const before = JSON.stringify(window.AppData);
  window.exportDataBackup = () => false;
  await window.anasFirebasePull();
  assert.equal(JSON.stringify(window.AppData), before);
  assert.equal(window.localStorage.getItem(storageKey), null);
  assert.equal(h.requests.length, 0);
});
