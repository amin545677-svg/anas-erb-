'use strict';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const DB_KEY = 'ANAS_THE_ENTERPRISE_V11_OFFLINE';
const PORT = 4173;

function startServer() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.resolve(ROOT, relative);
    if (!target.startsWith(ROOT + path.sep) && target !== path.join(ROOT, 'index.html')) {
      res.writeHead(403).end('Forbidden'); return;
    }
    fs.readFile(target, (error, bytes) => {
      if (error) { res.writeHead(404).end('Not found'); return; }
      const ext = path.extname(target);
      const mime = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.webmanifest' || ext === '.json' ? 'application/json; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(bytes);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function initialData() {
  return {
    appName: 'Anas ERP',
    storeConfig: { name: 'ANAS ERP Chromium Staging', footer: 'Staging-only test data' },
    currentUser: { id: 'CI-CHROMIUM', name: 'Staging Chromium', role: 'مدير عام', warehouse: 'المخزن الرئيسي' },
    activePosScreenTab: 1,
    posScreensCarts: { 1: [], 2: [], 3: [], 4: [], quote: [] },
    caisseBalance: 100000.00,
    products: [{
      id: 'STG-TEA-001', name: 'شاي اختبار Chromium', stock: 0, buyPrice: 0,
      lastPurchaseCost: 0, price1: 0, barcode: 'STGTEA001', unit: 'قطعة', supplierId: ''
    }],
    customers: [], suppliers: [], supplierMovements: [], purchases: [], purchaseInvoices: [],
    invoices: [], cashMovements: [], stockMovements: [], expenses: [], users: [], alerts: [],
    warehouseTransfers: [], warehouses: [], truckTrips: [], trucks: [], returns: [],
    stocktakeRecords: [], syncUrl: ''
  };
}

test('ANAS ERP real DOM purchase, supplier settlement, reload and restore parity', async () => {
  const server = await startServer();
  let browser;
  const pageErrors = [];
  const dialogs = [];
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, locale: 'fr-DZ', viewport: { width: 1365, height: 900 } });
    // Seed only the first origin load. addInitScript runs again on page.reload();
    // unconditional seeding would overwrite the persisted ledger and invalidate the durability test.
    await context.addInitScript(({ key, data }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(data));
    }, { key: DB_KEY, data: initialData() });
    await context.addInitScript(() => {
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        window.__anasLastExportBlob = blob;
        return createObjectURL(blob);
      };
      const anchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) window.__anasBackupFilename = this.download;
        return anchorClick.call(this);
      };
    });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', async dialog => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === 'prompt') await dialog.accept('0.20');
      else await dialog.accept();
    });

    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-view.active', { timeout: 15000 });
    assert.deepEqual(pageErrors, [], 'application must boot without uncaught page errors');

    // Create supplier through the real modal and Save button.
    await page.evaluate(() => openView('suppliers'));
    await page.locator('#view-suppliers .menu-action-card').first().click();
    await page.locator('#newSuppNameInput').fill('مورد اختبار Chromium');
    await page.locator('#newSuppPhoneInput').fill('0550000000');
    await page.locator('#newSuppDebtInput').fill('15000.00');
    await page.locator('#addSupplierModal .btn-full-submit').first().click();

    let state = await page.evaluate(() => JSON.parse(JSON.stringify(AppData)));
    assert.equal(state.suppliers.length, 1, 'supplier must be created by the UI');
    const supplierId = String(state.suppliers[0].id);
    assert.equal(state.suppliers[0].balance, 15000.00);
    assert.equal(state.supplierMovements.length, 1);
    assert.equal(state.supplierMovements[0].type, 'opening_balance');
    assert.equal(state.supplierMovements[0].amount, 15000.00);

    // Register a purchase using the rendered form and its Save button.
    await page.evaluate(() => openView('purchases'));
    await page.locator('#purSupplierSelect').selectOption(supplierId);
    await page.locator('#purProductName').fill('شاي اختبار Chromium');
    await page.locator('#purBuyCost').fill('0.10');
    await page.locator('#purBuyQty').fill('3');
    await page.locator('#purPaidAmount').fill('0.10');
    await page.locator('#view-purchases button[onclick="savePurchaseItem()"]').click();

    state = await page.evaluate(() => JSON.parse(JSON.stringify(AppData)));
    assert.equal(state.purchases.length, 1, 'purchase must be posted through the DOM');
    const purchase = state.purchases[0];
    assert.equal(purchase.total, 0.30, '3 x 0.10 must equal exactly 0.30 DZD');
    assert.equal(purchase.paid, 0.10);
    assert.equal(purchase.remaining, 0.20);
    assert.equal(state.products.find(p => p.id === purchase.productId).stock, 3);
    assert.equal(state.products.find(p => p.id === purchase.productId).buyPrice, 0.10);
    assert.equal(state.suppliers[0].balance, 15000.20);
    assert.equal(state.caisseBalance, 99999.90);
    assert.equal(state.stockMovements.filter(m => m.referenceType === 'purchase_invoice' && m.referenceId === purchase.id).length, 1);
    assert.equal(state.cashMovements.filter(m => m.referenceType === 'purchase_invoice' && m.referenceId === purchase.id)[0].amount, 0.10);
    assert.equal(state.supplierMovements.filter(m => m.referenceType === 'purchase_invoice' && m.referenceId === purchase.id && m.type === 'purchase')[0].amount, 0.30);
    assert.equal(state.supplierMovements.filter(m => m.referenceType === 'purchase_invoice' && m.referenceId === purchase.id && m.type === 'payment')[0].amount, 0.10);
    assert.match(await page.locator('#purchasesTableBody').innerText(), /شاي اختبار Chromium/);

    // Settle only the invoice remainder, preserving the supplier opening balance.
    await page.evaluate(() => openView('supp-debts'));
    await page.getByRole('button', { name: /تسديد مبلغ للمورد/ }).click();
    state = await page.evaluate(() => JSON.parse(JSON.stringify(AppData)));
    assert.equal(state.suppliers[0].balance, 15000.00);
    assert.equal(state.caisseBalance, 99999.70);
    const supplierPayment = state.supplierMovements.find(m => m.referenceType === 'supplier_payment');
    const cashPayment = state.cashMovements.find(m => m.referenceType === 'supplier_payment');
    assert.ok(supplierPayment && cashPayment);
    assert.equal(supplierPayment.amount, 0.20);
    assert.equal(cashPayment.amount, 0.20);
    assert.equal(supplierPayment.referenceId, cashPayment.referenceId);

    await page.evaluate(() => openView('cash'));
    const cashDom = await page.locator('#cashCurrentBalanceDisplay').innerText();
    const expectedCashDom = await page.evaluate(() => AppData.caisseBalance.toLocaleString() + ' د.ج');
    assert.equal(cashDom, expectedCashDom);
    await page.evaluate(() => openView('supp-debts'));
    assert.match(await page.locator('#suppDebtsContainer').innerText(), /15[\s,.]?000/);

    // Export a real JSON backup through the Sync/Backup UI and verify its contents.
    const beforeReload = await page.evaluate(() => JSON.parse(localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE')));
    await page.evaluate(() => openView('sync'));
    await page.locator('#view-sync button[onclick="exportDataBackup()"]').click();
    await page.waitForFunction(() => window.__anasLastExportBlob instanceof Blob && !!window.__anasBackupFilename);
    const exportedJson = await page.evaluate(() => window.__anasLastExportBlob.text());
    const validBackup = Buffer.from(exportedJson, 'utf8');
    assert.match(await page.evaluate(() => window.__anasBackupFilename), /_Backup_.*\.json$/);
    assert.deepEqual(JSON.parse(validBackup.toString('utf8')), beforeReload, 'exported JSON must match the persisted ledger snapshot');

    // Reload the real browser page and verify durable persistence.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-view.active', { timeout: 15000 });
    state = await page.evaluate(() => JSON.parse(JSON.stringify(AppData)));
    assert.equal(state.caisseBalance, 99999.70);
    assert.equal(state.suppliers[0].balance, 15000.00);
    assert.equal(state.products.find(p => p.id === 'STG-TEA-001').stock, 3);
    assert.equal(state.purchases[0].id, purchase.id);
    assert.deepEqual(state, beforeReload, 'reload must preserve the complete application state exactly');

    // Exercise the real backup import control with a valid JSON backup.
    await page.evaluate(() => openView('cash'));
    await page.locator('#restoreJsonFile').setInputFiles({
      name: 'anas-erp-chromium-staging-backup.json',
      mimeType: 'application/json',
      buffer: validBackup
    });
    await page.waitForFunction(() => document.getElementById('view-dashboard')?.classList.contains('active'), null, { timeout: 10000 });
    state = await page.evaluate(() => JSON.parse(JSON.stringify(AppData)));
    assert.equal(state.caisseBalance, 99999.70);
    assert.equal(state.suppliers[0].balance, 15000.00);
    assert.equal(state.purchases[0].id, purchase.id);

    // Both restore validators must accept good data and reject orphan cash/stock links.
    const validatorResult = await page.evaluate(snapshot => {
      const acceptedBackup = anasValidateBackupData(snapshot);
      const acceptedCloud = anasValidateIncomingSyncData(snapshot);
      const orphanStock = JSON.parse(JSON.stringify(snapshot));
      orphanStock.stockMovements = orphanStock.stockMovements.filter(m =>
        !(m.referenceType === 'purchase_invoice' && m.referenceId === snapshot.purchases[0].id));
      const orphanCash = JSON.parse(JSON.stringify(snapshot));
      orphanCash.cashMovements = orphanCash.cashMovements.filter(m =>
        !(m.referenceType === 'purchase_invoice' && m.referenceId === snapshot.purchases[0].id));
      const beforeState = JSON.stringify(AppData);
      const beforeStorage = localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE');
      const failures = [];
      for (const [label, corrupt] of [
        ['backup-orphan-stock', orphanStock], ['cloud-orphan-stock', orphanStock],
        ['backup-orphan-cash', orphanCash], ['cloud-orphan-cash', orphanCash]
      ]) {
        try {
          if (label.startsWith('backup')) anasValidateBackupData(corrupt);
          else anasValidateIncomingSyncData(corrupt);
          failures.push(label + ': accepted corrupt ledger');
        } catch (_) {}
      }
      return {
        backupAccepted: !!acceptedBackup, cloudAccepted: !!acceptedCloud, failures,
        stateUnchanged: JSON.stringify(AppData) === beforeState,
        storageUnchanged: localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE') === beforeStorage
      };
    }, beforeReload);
    assert.equal(validatorResult.backupAccepted, true);
    assert.equal(validatorResult.cloudAccepted, true);
    assert.deepEqual(validatorResult.failures, []);
    assert.equal(validatorResult.stateUnchanged, true);
    assert.equal(validatorResult.storageUnchanged, true);

    // Attempt the corrupt backup through the real file input; rejection must happen before any write.
    const orphanBackup = JSON.parse(JSON.stringify(beforeReload));
    orphanBackup.stockMovements = orphanBackup.stockMovements.filter(m =>
      !(m.referenceType === 'purchase_invoice' && m.referenceId === purchase.id));
    await page.locator('#restoreJsonFile').setInputFiles({
      name: 'anas-erp-chromium-orphan-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(orphanBackup))
    });
    await page.waitForTimeout(250);
    const afterRejectedImport = await page.evaluate(() => JSON.parse(localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE')));
    assert.deepEqual(afterRejectedImport, beforeReload);
    state = await page.evaluate(() => JSON.parse(JSON.stringify(AppData)));
    assert.equal(state.caisseBalance, 99999.70);
    assert.equal(state.suppliers[0].balance, 15000.00);
    assert.equal(state.products.find(p => p.id === 'STG-TEA-001').stock, 3);
    assert.ok(dialogs.some(d => d.message.includes('خطأ في ملف النسخة')), 'corrupt backup must produce the application rejection alert');
    assert.deepEqual(pageErrors, [], 'no uncaught browser exceptions are allowed during the workflow');

    console.log('CHROMIUM_LEDGER_REPORT ' + JSON.stringify({
      purchase: { totalDZD: purchase.total, paidDZD: purchase.paid, remainingDZD: purchase.remaining, quantity: 3, unitCostDZD: 0.10 },
      stock: { productId: 'STG-TEA-001', quantity: state.products.find(p => p.id === 'STG-TEA-001').stock, weightedCostDZD: state.products.find(p => p.id === 'STG-TEA-001').buyPrice },
      supplier: { openingBalanceDZD: 15000.00, finalBalanceDZD: state.suppliers[0].balance },
      cash: { openingBalanceDZD: 100000.00, finalBalanceDZD: state.caisseBalance },
      ledgers: { purchases: state.purchases.length, cashMovements: state.cashMovements.length, stockMovements: state.stockMovements.length, supplierMovements: state.supplierMovements.length },
      reload: 'PASS', backupRestore: 'PASS', cloudValidator: 'PASS', orphanInjection: 'REJECTED_WITHOUT_MUTATION'
    }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
