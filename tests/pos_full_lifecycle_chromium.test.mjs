'use strict';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const DB_KEY = 'ANAS_THE_ENTERPRISE_V11_OFFLINE';
const PORT = 4174;
const PRODUCT_ID = 'STG-POS-LIFECYCLE-001';
const PRODUCT_NAME = 'منتج اختبار دورة POS';

function initialData() {
  return {
    appName: 'Anas ERP',
    storeConfig: { name: 'ANAS ERP POS Lifecycle Staging', footer: 'Staging-only test data' },
    currentUser: { id: 'CI-POS-LIFECYCLE', name: 'POS Lifecycle Chromium', role: 'مدير عام', warehouse: 'المخزن الرئيسي' },
    activePosScreenTab: 1,
    activePriceTier: 1,
    posScreensCarts: { 1: [], 2: [], 3: [], 4: [], quote: [] },
    caisseBalance: 100000,
    products: [{
      id: PRODUCT_ID, name: PRODUCT_NAME, stock: 10, buyPrice: 10,
      lastPurchaseCost: 10, price1: 25, price2: 25, price3: 25,
      barcode: 'STGPOSLIFE001', unit: 'قطعة', supplierId: '', cat: 'عام'
    }],
    customers: [], suppliers: [], supplierMovements: [], purchases: [], purchaseInvoices: [],
    invoices: [], cashMovements: [], stockMovements: [], expenses: [], users: [], alerts: [],
    warehouseTransfers: [], warehouses: [], truckTrips: [], trucks: [], returns: [],
    stocktakeRecords: [], syncUrl: ''
  };
}

function startServer() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.resolve(ROOT, relative);
    if (!target.startsWith(ROOT + path.sep) && target !== path.join(ROOT, 'index.html')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(target, (error, bytes) => {
      if (error) { res.writeHead(404).end('Not found'); return; }
      const ext = path.extname(target);
      const mime = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.json' || ext === '.webmanifest' ? 'application/json; charset=utf-8'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(bytes);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function readCommittedSale(page, invoiceId) {
  return page.evaluate(({ id, productId }) => {
    const storage = window.ANASResilientStorage;
    if (!storage || !storage.ready()) throw new Error('ANAS_STORAGE_NOT_READY_AFTER_HYDRATION');
    const snapshot = storage.getCommittedSnapshot();
    if (!snapshot || !Array.isArray(snapshot.invoices)) throw new Error('COMMITTED_INVOICE_SNAPSHOT_MISSING');
    const invoiceRows = snapshot.invoices.filter(row => row && String(row.id) === String(id));
    const invoice = invoiceRows[0] || null;
    const cash = (snapshot.cashMovements || []).filter(row =>
      row && row.referenceType === 'sales_invoice' && String(row.referenceId) === String(id));
    const stock = (snapshot.stockMovements || []).filter(row =>
      row && row.referenceType === 'sales_invoice' && String(row.referenceId) === String(id));
    const product = (snapshot.products || []).find(row => row && String(row.id) === String(productId));
    return {
      invoiceCount: invoiceRows.length,
      invoice: invoice && {
        id: String(invoice.id), total: invoice.total, paid: invoice.paid,
        remaining: invoice.remaining, paymentMethod: invoice.paymentMethod
      },
      cash: cash.map(row => ({
        id: String(row.id), type: row.type, amount: row.amount,
        referenceType: row.referenceType, referenceId: String(row.referenceId)
      })),
      stock: stock.map(row => ({
        id: String(row.id), type: row.type, qty: row.qty,
        referenceType: row.referenceType, referenceId: String(row.referenceId)
      })),
      productStock: product && product.stock,
      caisseBalance: snapshot.caisseBalance,
      revision: storage.status().revision,
      mode: storage.status().mode
    };
  }, { id: invoiceId, productId: PRODUCT_ID });
}

test('ANAS ERP real POS checkout commits invoice and ledgers and survives page reload', async () => {
  const server = await startServer();
  let browser;
  const pageErrors = [];
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: 'fr-DZ', viewport: { width: 1365, height: 900 } });
    // Seed once only. Re-seeding on reload would overwrite the state being verified.
    await context.addInitScript(({ key, data }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(data));
    }, { key: DB_KEY, data: initialData() });

    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', async dialog => { await dialog.accept(); });

    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-view.active', { timeout: 15000 });
    await page.waitForFunction(() =>
      window.ANASResilientStorage?.ready() === true &&
      window.AppData && Array.isArray(window.AppData.products),
      null, { timeout: 15000 }
    );
    assert.deepEqual(pageErrors, [], 'application must boot without uncaught browser errors');

    // Use the rendered POS product button, not a fabricated selector or direct storage write.
    await page.evaluate(() => openView('pos'));
    const productButton = page.locator('#quickProductsContainer button').filter({ hasText: PRODUCT_NAME });
    await productButton.waitFor({ state: 'visible', timeout: 10000 });
    await productButton.click();

    const cartProof = await page.evaluate(() => ({
      count: Array.isArray(posCart) ? posCart.length : -1,
      id: posCart[0] && String(posCart[0].id),
      qty: posCart[0] && posCart[0].qty
    }));
    assert.equal(cartProof.count, 1, 'real POS product interaction must add exactly one cart line');
    assert.equal(cartProof.id, PRODUCT_ID);
    assert.equal(cartProof.qty, 1);

    // Open the original Hasib modal through its actual toolbar control.
    await page.locator('#view-pos .sales-toolbar button[onclick="openHasibModal()"]').click();
    await page.locator('#hasibModal.active').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#hasibPaymentMethod').inputValue(), 'cash');
    const revisionBeforePayment = await page.evaluate(() => ANASResilientStorage.status().revision);

    // Confirm through the actual modal button; never call the payment function directly.
    await page.locator('#hasibModal button[onclick="confirmHasibPaymentDurable()"]').click();
    await page.waitForFunction(({ beforeRevision, productId }) => {
      const storage = window.ANASResilientStorage;
      const snapshot = storage && storage.getCommittedSnapshot();
      const invoice = snapshot && Array.isArray(snapshot.invoices) &&
        snapshot.invoices.find(row => row && row.items && row.items.some(item => String(item.id) === productId));
      if (!storage || !snapshot || !invoice) return false;
      const cash = (snapshot.cashMovements || []).filter(row =>
        row && row.referenceType === 'sales_invoice' && String(row.referenceId) === String(invoice.id));
      const stock = (snapshot.stockMovements || []).filter(row =>
        row && row.referenceType === 'sales_invoice' && String(row.referenceId) === String(invoice.id));
      return storage.ready() && storage.status().revision > beforeRevision &&
        !document.getElementById('hasibModal')?.classList.contains('active') &&
        cash.length === 1 && stock.length === 1;
    }, { beforeRevision: revisionBeforePayment, productId: PRODUCT_ID }, { timeout: 15000 });

    const invoiceId = await page.evaluate((productId) => {
      const matches = AppData.invoices.filter(row =>
        row && Array.isArray(row.items) && row.items.some(item => String(item.id) === productId));
      if (matches.length !== 1) throw new Error('EXPECTED_EXACTLY_ONE_POS_INVOICE_BEFORE_RELOAD');
      return String(matches[0].id);
    }, PRODUCT_ID);

    const beforeReload = await readCommittedSale(page, invoiceId);
    assert.equal(beforeReload.invoiceCount, 1);
    assert.deepEqual(beforeReload.invoice, {
      id: invoiceId, total: 25, paid: 25, remaining: 0, paymentMethod: 'cash'
    });
    assert.equal(beforeReload.cash.length, 1, 'cash ledger must contain exactly one movement linked to the invoice');
    assert.deepEqual(beforeReload.cash[0], {
      id: 'SALE-CASH-' + invoiceId, type: 'add', amount: 25,
      referenceType: 'sales_invoice', referenceId: invoiceId
    });
    assert.equal(beforeReload.stock.length, 1, 'stock ledger must contain exactly one movement linked to the invoice');
    assert.equal(beforeReload.stock[0].type, 'SALE_OUT');
    assert.equal(beforeReload.stock[0].qty, -1);
    assert.equal(beforeReload.stock[0].referenceType, 'sales_invoice');
    assert.equal(beforeReload.stock[0].referenceId, invoiceId);
    assert.equal(beforeReload.productStock, 9);
    assert.equal(beforeReload.caisseBalance, 100025);
    assert.ok(beforeReload.revision > revisionBeforePayment);

    // Fresh navigation validates hydration from persistence rather than the previous JS heap.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-view.active', { timeout: 15000 });
    await page.waitForFunction(() =>
      window.ANASResilientStorage?.ready() === true &&
      window.AppData && Array.isArray(window.AppData.invoices),
      null, { timeout: 15000 }
    );
    assert.deepEqual(pageErrors, [], 'reload must not introduce uncaught browser errors');

    const afterReload = await readCommittedSale(page, invoiceId);
    assert.deepEqual(
      {
        invoiceCount: afterReload.invoiceCount, invoice: afterReload.invoice,
        cash: afterReload.cash, stock: afterReload.stock,
        productStock: afterReload.productStock, caisseBalance: afterReload.caisseBalance
      },
      {
        invoiceCount: beforeReload.invoiceCount, invoice: beforeReload.invoice,
        cash: beforeReload.cash, stock: beforeReload.stock,
        productStock: beforeReload.productStock, caisseBalance: beforeReload.caisseBalance
      },
      'invoice, cash ledger, stock ledger and balances must survive reload unchanged'
    );

    const runtimeParity = await page.evaluate(() => ({
      invoices: AppData.invoices.length,
      cashMovements: AppData.cashMovements.filter(row => row && row.referenceType === 'sales_invoice').length,
      stockMovements: AppData.stockMovements.filter(row => row && row.referenceType === 'sales_invoice').length,
      cartLines: Array.isArray(posCart) ? posCart.length : -1,
      modalOpen: document.getElementById('hasibModal')?.classList.contains('active') === true
    }));
    assert.equal(runtimeParity.invoices, 1, 'reload must not duplicate invoice');
    assert.equal(runtimeParity.cashMovements, 1, 'reload must not duplicate cash movement');
    assert.equal(runtimeParity.stockMovements, 1, 'reload must not duplicate stock movement');
    assert.equal(runtimeParity.cartLines, 0, 'committed cart must remain cleared after reload');
    assert.equal(runtimeParity.modalOpen, false, 'payment modal must remain closed after reload');

    console.log('POS_FULL_LIFECYCLE_CHROMIUM_REPORT ' + JSON.stringify({
      checkout: 'PASS', durableCommit: 'PASS', invoiceCashStockParity: 'PASS',
      reloadHydration: 'PASS', noDuplicatePosting: 'PASS', invoiceId,
      revisionBeforePayment, revisionAfterPayment: afterReload.revision, storageMode: afterReload.mode
    }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
