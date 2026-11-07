import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

const ROOT = process.cwd();
const PORT = 4175;

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
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8'
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

test('ANAS ERP mobile UI hides the floating assistant and suppresses external-script overlays', async () => {
  const server = await startServer();
  let browser;
  const startupDialogs = [];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 1 });
    page.on('dialog', async dialog => {
      startupDialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.dismiss();
    });
    await page.route('https://**/*', route => route.abort());
    await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body && !document.body.inert, { timeout: 15000 });
    const startup = await page.evaluate(() => ({
      fabDisplay: getComputedStyle(document.getElementById('anasContextAiFab')).display,
      fabVisibility: getComputedStyle(document.getElementById('anasContextAiFab')).visibility,
      fabPointerEvents: getComputedStyle(document.getElementById('anasContextAiFab')).pointerEvents,
      diagnosticText: document.body.innerText.includes('تشخيص أخطاء ANAS ERP — V23'),
      storedDiagnostics: localStorage.getItem('ANAS_ERP_DIAGNOSTICS_V1'),
      storedDiagnosticBuild: localStorage.getItem('ANAS_ERP_DIAGNOSTICS_BUILD'),
      externalToastVisible: !!document.querySelector('#anasActionToast.show')
    }));
    assert.equal(startup.fabDisplay, 'none');
    assert.equal(startup.fabVisibility, 'visible');
    assert.equal(startup.fabPointerEvents, 'none');
    assert.equal(startup.diagnosticText, false);
    assert.equal(startup.storedDiagnostics, null);
    assert.equal(startup.storedDiagnosticBuild, null);
    assert.deepEqual(startupDialogs, [], 'no native alert/confirm/prompt may appear during startup');
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.src = 'https://invalid.example.test/anas-external-failure.js';
      document.head.appendChild(script);
    });
    await page.waitForTimeout(250);
    const afterFailure = await page.evaluate(() => ({
      diagnosticText: document.body.innerText.includes('تشخيص أخطاء ANAS ERP — V23'),
      toastVisible: !!document.querySelector('#anasActionToast.show'),
      toastText: document.getElementById('anasActionToast')?.innerText || ''
    }));
    assert.equal(afterFailure.diagnosticText, false);
    assert.equal(afterFailure.toastVisible, false);
    assert.doesNotMatch(afterFailure.toastText, /تعذر تحميل مكتبة خارجية/);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});



test('ANAS ERP ignores late customer GPS callbacks after saving or closing the form', async () => {
  const server = await startServer();
  let browser;
  const dialogs = [];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('dialog', async dialog => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await page.route('https://**/*', route => route.abort());
    await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.openAddCustomerModal === 'function' &&
      typeof window.detectCustomerGPS === 'function' && typeof window.closeModal === 'function');
    await page.evaluate(() => {
      let lateError;
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: { getCurrentPosition(_success, error) { lateError = error; } }
      });
      window.__triggerLateGpsError = () => lateError && lateError({ code: 3 });
      window.openAddCustomerModal();
      window.detectCustomerGPS();
      window.closeModal('addCustomerModal');
      window.__triggerLateGpsError();
    });
    await page.waitForTimeout(50);
    assert.deepEqual(dialogs, [], 'a cancelled GPS request must not alert after the customer form closes');
    const requestState = await page.evaluate(() => ({
      location: document.getElementById('newCustLocationInput').value,
      modalOpen: document.getElementById('addCustomerModal').classList.contains('active')
    }));
    assert.equal(requestState.location, '', 'late GPS callbacks must not mutate a closed customer form');
    assert.equal(requestState.modalOpen, false);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('ANAS AI data cards execute file-picker and data-protection actions on mobile', async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await page.route('https://**/*', route => route.abort());
    await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body && !document.body.inert, { timeout: 15000 });
    await page.evaluate(() => {
      if (typeof window.openView !== 'function') throw new Error('openView is unavailable');
      if (document.body.inert) throw new Error('ERP shell is still inert before opening the AI Center');
      window.openView('ai-excel-hub', true);
    });

    const hub = page.locator('#view-ai-excel-hub');
    const excel = page.locator('label[data-anas-ai-action="excel"]');
    const pdf = page.locator('label[data-anas-ai-action="pdf"]');
    const security = page.locator('[data-anas-ai-action="security"]');
    await hub.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const view = document.getElementById('view-ai-excel-hub');
      return !!view && view.classList.contains('active') && getComputedStyle(view).display !== 'none' && !document.body.inert;
    });
    await excel.waitFor({ state: 'visible' });
    await pdf.waitFor({ state: 'visible' });
    await security.waitFor({ state: 'visible' });

    const inputState = await page.evaluate(() => {
      const excelInput = document.getElementById('smartAiExcelUpload');
      const pdfInput = document.getElementById('smartAiPdfUpload');
      return {
        excel: !!excelInput && excelInput.isConnected && excelInput.type === 'file' && !excelInput.disabled && excelInput.accept.includes('.xlsx') && excelInput.accept.includes('.csv'),
        pdf: !!pdfInput && pdfInput.isConnected && pdfInput.type === 'file' && !pdfInput.disabled && pdfInput.accept.includes('.pdf')
      };
    });
    assert.deepEqual(inputState, { excel: true, pdf: true },
      'both dedicated file inputs must exist in the live DOM and remain enabled');

    await security.click();
    const panel = page.locator('#anasAiDataProtectionPanel');
    await panel.waitFor({ state: 'visible' });
    assert.match(await page.locator('#anasAiDataProtectionDetails').innerText(), /IndexedDB/);
    await page.locator('#anasAiDataProtectionRefresh').click();
    assert.equal(await security.getAttribute('aria-expanded'), 'true');

    // Exercise PDF first: the Excel import preview is a modal and must not obscure sibling cards.
    const pdfChooserPromise = page.waitForEvent('filechooser');
    await pdf.locator('span').click();
    const pdfChooser = await pdfChooserPromise;
    assert.equal(await pdfChooser.element().evaluate((el) => el.id), 'smartAiPdfUpload',
      'PDF label must natively open its associated DOM file input');
    assert.match(await pdfChooser.element().getAttribute('accept'), /\.pdf/);

    const excelChooserPromise = page.waitForEvent('filechooser');
    await excel.locator('b').click();
    const excelChooser = await excelChooserPromise;
    assert.equal(await excelChooser.element().evaluate((el) => el.id), 'smartAiExcelUpload',
      'Excel/CSV label must natively open its associated DOM file input');
    assert.match(await excelChooser.element().getAttribute('accept'), /\.xlsx/);
    await excelChooser.setFiles({
      name: 'mobile-preview.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('"الكود";"الباركود";"اسم المنتج";"سعر الشراء";"سعر البيع";"المخزون";"الفئة";"الوحدة";"الحد الأدنى";"الوصف"\n"CSV-001";"611000000101";"قهوة, ممتازة";80;120;6;"مشروبات, ساخنة";"علبة";2;"وصف تجريبي"', 'utf8')
    });
    await page.locator('#smartAiExcelStatus').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /تم فتح الملف بنجاح/.test(document.getElementById('smartAiExcelStatus')?.textContent || ''));
    assert.match(await page.locator('#smartAiExcelStatus').innerText(), /الفاصل المكتشف: ;/,
      'CSV delimiter detection must ignore quoted commas and identify the true semicolon separator');
    assert.equal(await page.locator('#smartImportPreviewModal table tr:first-child td').count(), 10,
      'quoted commas in product name and description must not be mistaken for CSV field separators');
    assert.equal(await page.locator('#smartImportTarget').inputValue(), 'products',
      'CSV product headers must auto-select the products import target');
    assert.equal(await page.locator('#smartImportPreviewModal').count() > 0, true,
      'Excel/CSV click must produce a local import preview');
    await page.locator('#smartImportConfirm').click();
    await page.locator('#smartImportPreviewModal').waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.AppData?.products?.some(p => p.id === 'CSV-001'));
    const csvSaved = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('anas_erp_v42_resilient_db', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const request = db.transaction('snapshots', 'readonly').objectStore('snapshots')
        .get('ANAS_THE_ENTERPRISE_V11_OFFLINE');
      const record = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return String(record?.payload || '');
    });
    assert.ok(csvSaved.includes('قهوة, ممتازة') && csvSaved.includes('مشروبات, ساخنة'),
      'CSV import must durably persist quoted commas in supported product name and category fields');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.AppData?.products?.some(p =>
      p.id === 'CSV-001' && p.name === 'قهوة, ممتازة'
    ), { timeout: 10000 });
    const csvRestored = await page.evaluate(() => {
      const product = window.AppData.products.find(p => p.id === 'CSV-001');
      return product ? { name: product.name, stock: product.stock, price1: product.price1, cat: product.cat } : null;
    });
    assert.deepEqual(csvRestored, { name: 'قهوة, ممتازة', stock: 6, price1: 120, cat: 'مشروبات, ساخنة' },
      'CSV import must survive a full browser reload from durable local storage');

    await page.evaluate(async () => {
      if (!window.AppData) throw new Error('live AppData bridge is unavailable');
      window.AppData.products = [];
      window.AppData.invoices = [];
      window.AppData.purchases = [];
      if (typeof window.saveDB === 'function') {
        const saved = window.saveDB();
        if (saved !== true) throw new Error('test fixture did not persist');
      }
    });
    const rows = [
      ['الكود','الباركود','اسم المنتج','سعر الشراء','سعر البيع','المخزون','الفئة','الوحدة','الحد الأدنى','الوصف'],
      ['TEA-001','611000000001','أريشا كرستال 200غ',100,150,12,'مشروبات','علبة',2,''],
      ['TEA-002','611000000002','توارف ساشي 200غ',110,165,10,'مشروبات','علبة',2,''],
      ['TEA-003','611000000003','الرقيم 500غ',120,180,8,'مشروبات','علبة',1,''],
      ['TEA-004','611000000004','توارف ساشي 200غ',90,140,15,'مشروبات','علبة',3,''],
      ['TEA-005','611000000005','شاي أخضر 200غ',80,130,20,'مشروبات','علبة',4,'']
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[]]), 'Empty');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['ملاحظات'], ['هذه الورقة ليست بيانات منتجات']]), 'Notes');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Products');
    const xlsxBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    await page.locator('#smartAiExcelUpload').setInputFiles({
      name: 'ANAS_ERP_5_products.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: xlsxBuffer
    });
    await page.locator('#smartImportSheetPicker').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#smartImportSheetChoice option').count(), 2,
      'Excel import must expose every non-empty sheet when multiple sheets contain data');
    await page.locator('#smartImportSheetChoice').selectOption({ label: 'Products — 6 صف' });
    await page.locator('#smartImportSheetContinue').click();
    await page.locator('#smartImportPreviewModal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#smartImportTarget').inputValue(), 'products',
      'product columns must auto-select products and inventory');
    assert.equal(await page.locator('#smartImportBackupAck').isChecked(), true,
      'local backup must be enabled by default');
    const importBrowserErrors = [];
    page.on('pageerror', error => importBrowserErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') importBrowserErrors.push(message.text());
    });
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#smartImportConfirm').click();
    await page.waitForTimeout(1200);
    const importCommitState = await page.evaluate(() => ({
      modalPresent: !!document.getElementById('smartImportPreviewModal'),
      validation: document.getElementById('smartImportValidation')?.textContent || '',
      status: document.getElementById('smartAiExcelStatus')?.textContent || '',
      productCount: Array.isArray(window.AppData?.products) ? window.AppData.products.length : null
    }));
    assert.equal(importCommitState.modalPresent, false,
      'confirmed import must close its preview only after durable commit; state=' +
      JSON.stringify(importCommitState) + '; browserErrors=' + JSON.stringify(importBrowserErrors));
    await page.waitForFunction(() => window.AppData && window.AppData.products.length === 5);
    await page.evaluate(() => window.openView('pos', true));
    await page.locator('#posSearchField').fill('أريشا');
    await page.waitForFunction(() => {
      const results = document.getElementById('posSearchResults');
      return !!results && !results.hidden && results.querySelectorAll('.pos-search-result').length >= 1;
    });
    const acceptance = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('anas_erp_v42_resilient_db', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const backupRecord = await new Promise((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readonly');
        const request = tx.objectStore('snapshots').get('ANAS_ERP_PRE_IMPORT_BACKUP_V1');
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
      const appRecord = await new Promise((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readonly');
        const request = tx.objectStore('snapshots').get('ANAS_THE_ENTERPRISE_V11_OFFLINE');
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
      const backup = backupRecord?.payload ? JSON.parse(backupRecord.payload) : null;
      const savedPayload = String(appRecord?.payload || '');
      db.close();
      return {
        productCount: window.AppData.products.length,
        searchNames: [...document.querySelectorAll('#posSearchResults .pos-search-result-name')].map(el => el.textContent),
        floatingAssistantDisplay: getComputedStyle(document.getElementById('anasContextAiFab')).display,
        diagnosticVisible: document.body.innerText.includes('تشخيص أخطاء ANAS ERP — V23'),
        backupRecordPresent: !!backup && Array.isArray(backup.data?.products),
        importedProductsPersisted: ['أريشا كرستال 200غ','توارف ساشي 200غ','الرقيم 500غ','شاي أخضر 200غ'].every(name => savedPayload.includes(name)),
        backupPreImportProductCount: backup?.recordCount
      };
    });
    assert.equal(acceptance.productCount, 5);
    assert.ok(acceptance.searchNames.some(name => name.includes('أريشا كرستال 200غ')));
    assert.equal(acceptance.floatingAssistantDisplay, 'none');
    assert.equal(acceptance.diagnosticVisible, false);
    assert.equal(acceptance.backupRecordPresent, true);
    assert.equal(acceptance.importedProductsPersisted, true, 'all five imported product rows must be durably represented (including the intentional duplicate name)');
    assert.equal(acceptance.backupPreImportProductCount, 0, 'backup must be captured before the first product is added');

    // Prove the XLSX import survives a real browser reload, not only the in-memory AppData bridge.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.AppData?.products?.length === 5, { timeout: 10000 });
    const xlsxRestored = await page.evaluate(() => (window.AppData.products || [])
      .map(product => ({ id: product.id, name: product.name, stock: product.stock }))
      .sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual(xlsxRestored, [
      { id: 'TEA-001', name: 'أريشا كرستال 200غ', stock: 12 },
      { id: 'TEA-002', name: 'توارف ساشي 200غ', stock: 10 },
      { id: 'TEA-003', name: 'الرقيم 500غ', stock: 8 },
      { id: 'TEA-004', name: 'توارف ساشي 200غ', stock: 15 },
      { id: 'TEA-005', name: 'شاي أخضر 200غ', stock: 20 }
    ], 'XLSX import must restore all five selected-sheet rows and stock values after a full browser reload');

    // Re-import the same product identity with changed catalog fields and a different file stock.
    // The importer must update the catalog but never overwrite an already-posted live balance/cost basis.
    await page.evaluate(async () => {
      window.AppData.products[0].stock = 777;
      window.AppData.products[0].buyPrice = 100;
      if (typeof window.saveDBDurably === 'function') await window.saveDBDurably();
    });
    const updateWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(updateWorkbook, XLSX.utils.aoa_to_sheet([
      ['الكود','الباركود','اسم المنتج','سعر الشراء','سعر البيع','المخزون','الفئة','الوحدة','الحد الأدنى','الوصف'],
      ['TEA-001','611000000001','أريشا كرستال تحديث',999,999,999,'مشروبات','علبة',99,'']
    ]), 'Products');
    await page.locator('#smartAiExcelUpload').setInputFiles({
      name: 'ANAS_ERP_Product_Update.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: XLSX.write(updateWorkbook, { type:'buffer', bookType:'xlsx' })
    });
    await page.locator('#smartImportPreviewModal').waitFor({ state:'visible' });
    assert.equal(await page.locator('#smartImportTarget').inputValue(), 'products');
    await page.locator('#smartImportConfirm').click();
    await page.locator('#smartImportPreviewModal').waitFor({ state:'detached' });
    await page.waitForFunction(() => window.AppData.products[0]?.name === 'أريشا كرستال تحديث');
    const upsert = await page.evaluate(() => ({
      count:window.AppData.products.length,
      name:window.AppData.products[0].name,
      stock:window.AppData.products[0].stock,
      buyPrice:window.AppData.products[0].buyPrice,
      price1:window.AppData.products[0].price1
    }));
    assert.deepEqual(upsert, {
      count:5, name:'أريشا كرستال تحديث', stock:777, buyPrice:100, price1:999
    }, 'product upsert must update catalog fields while preserving live stock and its current cost basis');

  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
