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

function decimalToScaledBigInt(value, scale) {
  const raw = String(value);
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(raw);
  assert.ok(match, `invalid exact decimal value: ${raw}`);
  const fraction = match[3] || '';
  assert.ok(fraction.length <= scale || /^0*$/.test(fraction.slice(scale)), `excess precision in ${raw}`);
  const whole = BigInt(match[2]);
  const fractional = BigInt((fraction.slice(0, scale) + '0'.repeat(scale)).slice(0, scale) || '0');
  const result = whole * (10n ** BigInt(scale)) + fractional;
  return match[1] === '-' ? -result : result;
}

function ledgerArrays(snapshot) {
  return Object.fromEntries(['purchases', 'cashMovements', 'stockMovements', 'supplierMovements']
    .map(key => [key, snapshot[key] || []]));
}

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
      window.__anasFileReaderCompletions = [];
      const originalReadAsText = FileReader.prototype.readAsText;
      FileReader.prototype.readAsText = function (...args) {
        this.addEventListener('load', () => {
          window.__anasFileReaderCompletions.push({ status: 'load', resultLength: String(this.result || '').length });
        }, { once: true });
        this.addEventListener('error', () => {
          window.__anasFileReaderCompletions.push({ status: 'error' });
        }, { once: true });
        return originalReadAsText.apply(this, args);
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

    // Exercise the actual backup/cloud validators before any restore assignment.
    const reverseGuardProof = await page.evaluate(() => {
      const rawBefore = localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE');
      const appBefore = JSON.stringify(AppData);
      const legacy = JSON.parse(JSON.stringify(AppData));
      const legacyBackupAccepted = anasValidateBackupData(legacy) === legacy;
      anasValidateIncomingSyncData(JSON.parse(JSON.stringify(legacy)));

      const valid = JSON.parse(JSON.stringify(AppData));
      valid.customers = [{ id: 'C-NEW', name: 'Ledger test client', debt: 19992.75 }];
      valid.invoices = [{
        id: 'INV-NEW', customerId: 'C-NEW', customerObj: { id: 'C-NEW' },
        total: 20000, paid: 7.25, remaining: 19992.75,
        items: [{ id: 'P-NEW', qty: 2, price: 10000 }]
      }];
      valid.cashMovements = [{
        id: 'CM-NEW', type: 'add', referenceType: 'customer_debt',
        referenceId: 'C-NEW', amount: 7.25
      }];
      valid.settlementAllocations = [{
        allocationId: 'A-NEW', partyType: 'customer', partyId: 'C-NEW',
        invoiceType: 'sales_invoice', invoiceId: 'INV-NEW',
        sourceMovementId: 'CM-NEW', sourceMovementType: 'customer_debt',
        amountCentimes: 725, createdAt: '2026-10-30T12:00:00Z', ledgerVersion: 2
      }];
      const validBackupAccepted = anasValidateBackupData(JSON.parse(JSON.stringify(valid))) !== false;
      anasValidateIncomingSyncData(JSON.parse(JSON.stringify(valid)));

      const orphan = JSON.parse(JSON.stringify(valid));
      orphan.settlementAllocations[0].invoiceId = 'MISSING-INVOICE';
      let orphanBackupRejected = false, orphanCloudRejected = false;
      try { anasValidateBackupData(orphan); } catch (e) { orphanBackupRejected = /orphan|ambiguous settlement allocation invoice/i.test(e.message); }
      try { anasValidateIncomingSyncData(JSON.parse(JSON.stringify(orphan))); } catch (e) { orphanCloudRejected = /orphan|ambiguous settlement allocation invoice/i.test(e.message); }

      const overReturn = JSON.parse(JSON.stringify(valid));
      overReturn.returns = [{
        returnId: 'R-OVER', ledgerVersion: 2, originalInvoiceId: 'INV-NEW',
        originalInvoiceType: 'sales_invoice', returnType: 'SALE_RETURN', status: 'POSTED',
        items: [{ productId: 'P-NEW', quantityMicroUnits: 2000001, unitPriceCentimes: 1000000, lineTotalCentimes: 2000001 }],
        totalCentimes: 2000001, debtReductionCentimes: 0, cashRefundCentimes: 0,
        stockMovementIds: [], financialMovementIds: []
      }];
      let overReturnBackupRejected = false, overReturnCloudRejected = false;
      try { anasValidateBackupData(overReturn); } catch (e) { overReturnBackupRejected = /return exceeds remaining returnable micro-units/i.test(e.message); }
      try { anasValidateIncomingSyncData(JSON.parse(JSON.stringify(overReturn))); } catch (e) { overReturnCloudRejected = /return exceeds remaining returnable micro-units/i.test(e.message); }

      const rawAfter = localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE');
      const appAfter = JSON.stringify(AppData);
      return {
        legacyBackupAccepted, validBackupAccepted,
        orphanBackupRejected, orphanCloudRejected,
        overReturnBackupRejected, overReturnCloudRejected,
        appUnchanged: appBefore === appAfter,
        localStorageUnchanged: rawBefore === rawAfter
      };
    });
    assert.deepEqual(reverseGuardProof, {
      legacyBackupAccepted: true, validBackupAccepted: true,
      orphanBackupRejected: true, orphanCloudRejected: true,
      overReturnBackupRejected: true, overReturnCloudRejected: true,
      appUnchanged: true, localStorageUnchanged: true
    }, 'backup and cloud validators must accept V42/valid v2 data and reject corruption before mutation');
    console.log('CHROMIUM_REVERSE_RESTORE_GUARD_REPORT ' + JSON.stringify(reverseGuardProof));

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

    // Prove AppData and the bytes persisted by saveDB are identical before reload.
    const beforeReloadProof = await page.evaluate(() => {
      const raw = localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE');
      if (raw === null) throw new Error('persisted ERP snapshot is missing before reload');
      const stored = JSON.parse(raw);
      const memory = JSON.parse(JSON.stringify(AppData));
      if (JSON.stringify(stored) !== JSON.stringify(memory)) throw new Error('AppData/localStorage mismatch before reload');
      return { raw, stored, memory };
    });
    const beforeReload = beforeReloadProof.stored;
    assert.deepEqual(beforeReloadProof.memory, beforeReload);
    const expectedCentimes = {
      cash: decimalToScaledBigInt(beforeReload.caisseBalance, 2),
      supplier: decimalToScaledBigInt(beforeReload.suppliers[0].balance, 2),
      stockMicroUnits: decimalToScaledBigInt(beforeReload.products.find(p => p.id === 'STG-TEA-001').stock, 6),
      unitCostCentimes: decimalToScaledBigInt(beforeReload.products.find(p => p.id === 'STG-TEA-001').buyPrice, 2)
    };
    assert.equal(expectedCentimes.cash, 9999970n);
    assert.equal(expectedCentimes.supplier, 1500000n);
    assert.equal(expectedCentimes.stockMicroUnits, 3000000n);
    assert.equal(expectedCentimes.unitCostCentimes, 10n);
    const ledgerArraysBeforeRestore = ledgerArrays(beforeReload);

    // Export a real JSON backup through the Sync/Backup UI and verify its contents.
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
    const afterReloadProof = await page.evaluate(() => {
      const raw = localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE');
      if (raw === null) throw new Error('persisted ERP snapshot is missing after reload');
      const stored = JSON.parse(raw);
      const memory = JSON.parse(JSON.stringify(AppData));
      if (JSON.stringify(stored) !== JSON.stringify(memory)) throw new Error('AppData/localStorage mismatch after reload');
      return { raw, stored, memory };
    });
    state = afterReloadProof.memory;
    assert.deepEqual(state, beforeReload, 'reload must preserve the complete application state exactly');
    assert.deepEqual(afterReloadProof.stored, beforeReload, 'localStorage must retain the exact persisted snapshot after reload');
    assert.equal(decimalToScaledBigInt(state.caisseBalance, 2), 9999970n);
    assert.equal(decimalToScaledBigInt(state.suppliers[0].balance, 2), 1500000n);
    assert.equal(decimalToScaledBigInt(state.products.find(p => p.id === 'STG-TEA-001').stock, 6), 3000000n);
    assert.equal(decimalToScaledBigInt(state.products.find(p => p.id === 'STG-TEA-001').buyPrice, 2), 10n);
    assert.equal(state.purchases[0].id, purchase.id);

    await page.evaluate(() => openView('cash'));
    const cashDomAfterReload = await page.locator('#cashCurrentBalanceDisplay').innerText();
    const expectedCashDomAfterReload = await page.evaluate(() => AppData.caisseBalance.toLocaleString() + ' د.ج');
    assert.equal(cashDomAfterReload, expectedCashDomAfterReload,
      'cash DOM must render the exact BigInt-verified persisted balance using the active locale');
    await page.evaluate(() => openView('supp-debts'));
    const supplierDomAfterReload = await page.locator('#suppDebtsContainer').innerText();
    assert.match(supplierDomAfterReload, /15[\s,.]?000/, 'supplier DOM must show the persisted 15,000 DZD balance');
    await page.evaluate(() => openView('inventory'));
    await page.locator('#view-inventory .menu-action-card').nth(1).click();
    const stockDomAfterReload = await page.locator('#inventoryItemsContainer').innerText();
    assert.match(stockDomAfterReload, /شاي اختبار Chromium/);
    assert.match(stockDomAfterReload, /3/);

    // Exercise the real backup import control with a valid JSON backup.
    await page.evaluate(() => openView('cash'));
    await page.locator('#restoreJsonFile').setInputFiles({
      name: 'anas-erp-chromium-staging-backup.json',
      mimeType: 'application/json',
      buffer: validBackup
    });
    await page.waitForFunction(() => document.getElementById('view-dashboard')?.classList.contains('active'), null, { timeout: 10000 });
    state = await page.evaluate(() => JSON.parse(JSON.stringify(AppData)));
    assert.equal(decimalToScaledBigInt(state.caisseBalance, 2), 9999970n);
    assert.equal(decimalToScaledBigInt(state.suppliers[0].balance, 2), 1500000n);
    assert.equal(state.purchases[0].id, purchase.id);
    assert.deepEqual(ledgerArrays(state), ledgerArraysBeforeRestore,
      'valid backup restore must preserve all four ledger arrays exactly');

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
    await page.evaluate(() => openView('cash'));
    const beforeRejectedImportProof = await page.evaluate(() => ({
      storageRaw: localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE'),
      memoryRaw: JSON.stringify(AppData),
      domRaw: document.body.innerHTML
    }));
    const readerCompletionCount = await page.evaluate(() => window.__anasFileReaderCompletions.length);
    const dialogCountBeforeOrphan = dialogs.length;
    await page.locator('#restoreJsonFile').setInputFiles({
      name: 'anas-erp-chromium-orphan-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(orphanBackup))
    });
    await page.waitForFunction(count =>
      (window.__anasFileReaderCompletions || []).length > count,
      readerCompletionCount, { timeout: 10000 });
    await page.waitForFunction(() => {
      const input = document.getElementById('restoreJsonFile');
      return !!input && input.value === '';
    }, null, { timeout: 5000 });
    const orphanDialog = dialogs.slice(dialogCountBeforeOrphan).find(d =>
      d.type === 'alert' && d.message.includes('خطأ في ملف النسخة'));
    assert.ok(orphanDialog, 'orphan restore must produce the application rejection alert');
    assert.match(orphanDialog.message, /حركة المخزون لا تطابق كمية أو صنف فاتورة الشراء/,
      'orphan rejection must identify the exact Purchase Ledger Parity stock-link failure');
    const afterRejectedImportProof = await page.evaluate(() => ({
      storageRaw: localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE'),
      memoryRaw: JSON.stringify(AppData),
      domRaw: document.body.innerHTML
    }));
    assert.equal(afterRejectedImportProof.storageRaw, beforeRejectedImportProof.storageRaw,
      'rejected orphan restore must not change even one localStorage byte');
    assert.equal(afterRejectedImportProof.memoryRaw, beforeRejectedImportProof.memoryRaw,
      'rejected orphan restore must not mutate AppData');
    assert.equal(afterRejectedImportProof.domRaw, beforeRejectedImportProof.domRaw,
      'rejected orphan restore must not mutate the rendered DOM');
    state = JSON.parse(afterRejectedImportProof.memoryRaw);
    assert.equal(decimalToScaledBigInt(state.caisseBalance, 2), 9999970n);
    assert.equal(decimalToScaledBigInt(state.suppliers[0].balance, 2), 1500000n);
    assert.equal(decimalToScaledBigInt(state.products.find(p => p.id === 'STG-TEA-001').stock, 6), 3000000n);
    assert.deepEqual(pageErrors, [], 'no uncaught browser exceptions are allowed during the workflow');

    console.log('CHROMIUM_LEDGER_REPORT ' + JSON.stringify({
      purchase: { totalDZD: purchase.total, paidDZD: purchase.paid, remainingDZD: purchase.remaining, quantity: 3, unitCostDZD: 0.10 },
      exactUnitsBigInt: {
        cashCentimes: decimalToScaledBigInt(state.caisseBalance, 2).toString(),
        supplierCentimes: decimalToScaledBigInt(state.suppliers[0].balance, 2).toString(),
        stockMicroUnits: decimalToScaledBigInt(state.products.find(p => p.id === 'STG-TEA-001').stock, 6).toString(),
        weightedUnitCostCentimes: decimalToScaledBigInt(state.products.find(p => p.id === 'STG-TEA-001').buyPrice, 2).toString()
      },
      triad: { beforeReload: 'AppData=localStorage PASS', afterReload: 'AppData=localStorage=DOM PASS' },
      stock: { productId: 'STG-TEA-001', quantity: state.products.find(p => p.id === 'STG-TEA-001').stock, weightedCostDZD: state.products.find(p => p.id === 'STG-TEA-001').buyPrice },
      supplier: { openingBalanceDZD: 15000.00, finalBalanceDZD: state.suppliers[0].balance },
      cash: { openingBalanceDZD: 100000.00, finalBalanceDZD: state.caisseBalance },
      ledgers: { purchases: state.purchases.length, cashMovements: state.cashMovements.length, stockMovements: state.stockMovements.length, supplierMovements: state.supplierMovements.length, deepRestoreEquality: 'PASS' },
      reload: 'PASS', backupRestore: 'PASS', cloudValidator: 'PASS',
      orphanInjection: 'REJECTED_WITHOUT_MUTATION',
      orphanReason: 'Purchase Ledger Parity: stock movement does not match purchase invoice'
    }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});


test('Chromium customer sale and explicit debt allocation: exact centimes, rollback and reload', async () => {
  const server = await startServer();
  let browser;
  const dialogs = [];
  const queuedPrompts = [];
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, locale: 'fr-DZ', viewport: { width: 1365, height: 900 } });
    await context.addInitScript(() => {
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        window.__anasCustomerBackupBlob = blob;
        return createObjectURL(blob);
      };
      const anchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) window.__anasCustomerBackupFilename = this.download;
        return anchorClick.call(this);
      };
    });
    const seed = initialData();
    seed.products[0].stock = 3;
    seed.customers = [{ id: 'C-CUSTOMER-1', name: 'عميل دفتر الاختبار', debt: 10000.00 }];
    await context.addInitScript(({ key, data }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(data));
    }, { key: DB_KEY, data: seed });
    const page = await context.newPage();
    page.on('dialog', async dialog => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === 'prompt') await dialog.accept(queuedPrompts.shift() ?? '');
      else await dialog.accept();
    });
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-view.active', { timeout: 15000 });
    await page.evaluate(() => {
      posCart = [{ id: 'STG-TEA-001', name: 'شاي اختبار Chromium', qty: 3, price: 0.10, unit: 'قطعة' }];
      openHasibModal();
    });
    await page.locator('#hasibCustomerSelect').selectOption('C-CUSTOMER-1');
    await page.locator('#hasibPaidAmount').fill('0.10');
    await page.locator('#hasibModal button[onclick="confirmHasibPayment()"]').click();
    let state = await page.evaluate(() => JSON.parse(JSON.stringify(AppData)));
    const invoice = state.invoices.find(x => x.total === 0.30);
    assert.ok(invoice, 'new sales invoice must be posted through the real payment modal');
    assert.equal(invoice.paid, 0.10);
    assert.equal(invoice.remaining, 0.20);
    assert.equal(state.customers[0].debt, 10000.20);
    assert.equal(state.customers[0].ledgerVersion, 2);
    assert.equal(state.clientMovements.find(x => x.type === 'opening_balance').amountCentimes, 1000000);
    assert.equal(state.clientMovements.find(x => x.type === 'invoice_debit').amountCentimes, 20);
    assert.equal(state.settlementAllocations.filter(x => x.invoiceId === invoice.id)[0].amountCentimes, 10);
    assert.equal(state.clientMovements.reduce((sum, x) => sum + (x.direction === 'debit' ? x.amountCentimes : -x.amountCentimes), 0), 1000020);
    assert.equal(state.cashMovements.find(x => x.referenceType === 'sales_invoice' && x.referenceId === invoice.id).amount, 0.10);

    queuedPrompts.push('0.15', JSON.stringify([{ invoiceId: invoice.id, amount: '0.15' }]));
    await page.evaluate(() => collectCustDebt('C-CUSTOMER-1'));
    state = await page.evaluate(() => JSON.parse(JSON.stringify(AppData)));
    const updatedInvoice = state.invoices.find(x => x.id === invoice.id);
    assert.equal(updatedInvoice.paid, 0.10, 'posted invoice original paid amount must not be rewritten');
    assert.equal(updatedInvoice.remaining, 0.20, 'posted invoice original remaining snapshot must not be rewritten');
    const laterAllocatedCentimes = state.settlementAllocations
      .filter(x => x.invoiceId === invoice.id && x.sourceMovementType === 'customer_debt')
      .reduce((sum, x) => sum + x.amountCentimes, 0);
    assert.equal(Math.round(updatedInvoice.total * 100) - Math.round(updatedInvoice.paid * 100) - laterAllocatedCentimes, 5,
      'current invoice outstanding must be derived from immutable original values and later allocations');
    assert.equal(state.customers[0].debt, 10000.05);
    assert.equal(state.clientMovements.find(x => x.type === 'receipt').amountCentimes, 15);
    assert.equal(state.settlementAllocations.filter(x => x.invoiceId === invoice.id).reduce((sum, x) => sum + x.amountCentimes, 0), 25);
    assert.equal(state.clientMovements.reduce((sum, x) => sum + (x.direction === 'debit' ? x.amountCentimes : -x.amountCentimes), 0), 1000005);

    const beforeOver = await page.evaluate(() => ({
      app: JSON.stringify(AppData), storage: localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE')
    }));
    queuedPrompts.push('0.06', JSON.stringify([{ invoiceId: invoice.id, amount: '0.06' }]));
    await page.evaluate(() => collectCustDebt('C-CUSTOMER-1'));
    const afterOver = await page.evaluate(() => ({
      app: JSON.stringify(AppData), storage: localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE')
    }));
    assert.deepEqual(afterOver, beforeOver, 'over-allocation must leave memory and persistent storage byte-identical');

    const beforeFailedSave = await page.evaluate(() => ({
      app: JSON.stringify(AppData), storage: localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE')
    }));
    queuedPrompts.push('0.05', JSON.stringify([{ invoiceId: invoice.id, amount: '0.05' }]));
    await page.evaluate(() => { window.__realSaveDBForRollback = saveDB; saveDB = () => false; });
    await page.evaluate(() => collectCustDebt('C-CUSTOMER-1'));
    await page.evaluate(() => { saveDB = window.__realSaveDBForRollback; delete window.__realSaveDBForRollback; });
    const afterFailedSave = await page.evaluate(() => ({
      app: JSON.stringify(AppData), storage: localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE')
    }));
    assert.deepEqual(afterFailedSave, beforeFailedSave, 'failed save must restore all AppData and preserve localStorage');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloadProof = await page.evaluate(() => {
      const raw = localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE');
      const persisted = JSON.parse(raw);
      return {
        appMatchesStorage: JSON.stringify(AppData) === JSON.stringify(persisted),
        customerDebtCentimes: Math.round(Number(AppData.customers[0].debt) * 100),
        invoiceRemainingCentimes: Math.round(Number(AppData.invoices[0].total) * 100) -
          Math.round(Number(AppData.invoices[0].paid) * 100) -
          AppData.settlementAllocations.filter(x => x.invoiceId === AppData.invoices[0].id && x.sourceMovementType === 'customer_debt')
            .reduce((sum, x) => sum + x.amountCentimes, 0),
        opening: AppData.clientMovements.find(x => x.type === 'opening_balance')?.amountCentimes,
        debit: AppData.clientMovements.find(x => x.type === 'invoice_debit')?.amountCentimes,
        receipt: AppData.clientMovements.find(x => x.type === 'receipt')?.amountCentimes
      };
    });
    assert.equal(reloadProof.appMatchesStorage, true);
    assert.equal(reloadProof.customerDebtCentimes, 1000005);
    assert.equal(reloadProof.invoiceRemainingCentimes, 5);
    assert.equal(reloadProof.opening, 1000000);
    assert.equal(reloadProof.debit, 20);
    assert.equal(reloadProof.receipt, 15);
    const domProof = await page.evaluate(() => {
      renderCustomersDebts();
      const card = Array.from(document.querySelectorAll('#custDebtsContainer article'))
        .find(node => node.innerText.includes('عميل دفتر الاختبار'));
      const amountText = Array.from(card?.querySelectorAll('strong') || [])
        .find(node => node.textContent.includes('د.ج'))?.textContent || '';
      const numeric = amountText.replace(/[^0-9,.-]/g, '');
      const normalized = numeric.includes(',')
        ? numeric.replace(/\./g, '').replace(',', '.') : numeric.replace(/,/g, '');
      return { customerVisible: !!card, displayedDebt: Number(normalized), hasCurrency: amountText.includes('د.ج') };
    });
    assert.equal(domProof.customerVisible, true);
    assert.equal(domProof.displayedDebt, 10000.05);
    assert.equal(domProof.hasCurrency, true);

    // Export the customer v2 ledgers through the actual Sync/Backup UI.
    await page.evaluate(() => openView('sync'));
    await page.locator('#view-sync button[onclick="exportDataBackup()"]').click();
    await page.waitForFunction(() => window.__anasCustomerBackupBlob instanceof Blob && !!window.__anasCustomerBackupFilename);
    const exportedCustomerJson = await page.evaluate(() => window.__anasCustomerBackupBlob.text());
    const exportedCustomerBackup = Buffer.from(exportedCustomerJson, 'utf8');
    const exportedCustomerState = JSON.parse(exportedCustomerBackup.toString('utf8'));
    assert.match(await page.evaluate(() => window.__anasCustomerBackupFilename), /_Backup_.*\\.json$/);
    assert.equal(exportedCustomerState.customers[0].debt, 10000.05);
    assert.equal(exportedCustomerState.clientMovements.length, 3);
    assert.equal(exportedCustomerState.settlementAllocations.length, 2);

    // Restore the exported customer snapshot using the real file input and verify the ledgers survive.
    await page.evaluate(() => openView('cash'));
    await page.locator('#restoreJsonFile').setInputFiles({
      name: 'anas-erp-customer-ledger-backup.json',
      mimeType: 'application/json',
      buffer: exportedCustomerBackup
    });
    await page.waitForFunction(() => document.getElementById('view-dashboard')?.classList.contains('active'), null, { timeout: 10000 });
    const customerRestoreProof = await page.evaluate(() => {
      const raw = localStorage.getItem('ANAS_THE_ENTERPRISE_V11_OFFLINE');
      const stored = JSON.parse(raw);
      return {
        appMatchesStorage: JSON.stringify(AppData) === JSON.stringify(stored),
        debt: AppData.customers[0].debt,
        movements: AppData.clientMovements.map(x => [x.type, x.amountCentimes]),
        allocations: AppData.settlementAllocations.map(x => [x.sourceMovementType, x.amountCentimes]),
        invoicePaid: AppData.invoices[0].paid,
        invoiceRemainingSnapshot: AppData.invoices[0].remaining
      };
    });
    assert.equal(customerRestoreProof.appMatchesStorage, true);
    assert.equal(customerRestoreProof.debt, 10000.05);
    assert.deepEqual(customerRestoreProof.movements, [['opening_balance', 1000000], ['invoice_debit', 20], ['receipt', 15]]);
    assert.deepEqual(customerRestoreProof.allocations, [['sales_invoice', 10], ['customer_debt', 15]]);
    assert.equal(customerRestoreProof.invoicePaid, 0.10);
    assert.equal(customerRestoreProof.invoiceRemainingSnapshot, 0.20);
    console.log('CHROMIUM_CUSTOMER_BACKUP_RESTORE_REPORT ' + JSON.stringify({
      exported: 'PASS', restored: 'PASS', appDataLocalStorage: 'PASS',
      invoiceImmutable: 'PASS', customerDebtCentimes: '1000005'
    }));
    console.log('CHROMIUM_CUSTOMER_LEDGER_REPORT ' + JSON.stringify({
      openingBalanceCentimes: '1000000', invoiceDebitCentimes: '20',
      immediateAllocationCentimes: '10', laterReceiptCentimes: '15',
      finalDebtCentimes: '1000005', finalInvoiceRemainingCentimes: '5',
      overAllocation: 'REJECTED_WITHOUT_MUTATION', failedSaveRollback: 'PASS',
      reloadAppDataLocalStorage: 'PASS'
    }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
