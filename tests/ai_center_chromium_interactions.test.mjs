import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
import { chromium } from 'playwright';
import { buildStagingHosting } from '../scripts/build-staging-hosting.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createMinimalPdf(text) {
  const escaped = String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\\\(').replace(/\)/g, '\\\\)');
  const stream = 'BT /F1 18 Tf 72 720 Td (' + escaped + ') Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(stream, 'ascii') + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF';
  return Buffer.from(pdf, 'ascii');
}

async function startStaticServer(rootDir) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml'
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/erp' || pathname === '/erp/') pathname = '/erp/index.html';
      const filePath = path.resolve(rootDir, '.' + pathname);
      if (!filePath.startsWith(path.resolve(rootDir) + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      const body = await fs.readFile(filePath);
      res.writeHead(200, {
        'content-type': types[path.extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      res.end(body);
    } catch (_) {
      res.writeHead(404); res.end('Not found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('built /erp/ AI Center controls respond to real Chromium DOM clicks with local fallback', async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anas-ai-center-built-'));
  const siteRoot = path.join(tempRoot, 'site');
  await buildStagingHosting({
    rootDir: repoRoot,
    outDir: siteRoot,
    env: {
      FIREBASE_STAGING_WEB_API_KEY: 'STAGING_PUBLIC_API_KEY',
      FIREBASE_STAGING_WEB_APP_ID: '1:123456:web:staging'
    }
  });
  const server = await startStaticServer(siteRoot);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const address = server.address();
  const context = await browser.newContext({ acceptDownloads: true });
  // Keep loopback HTTP available while presenting the browser as offline to the app.
  await context.addInitScript(() => {
    try { localStorage.removeItem('anasErpAiGatewayUrlV1'); } catch (_) {}
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  });
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  // Deliberately deny all external requests: all five controls must retain useful local behavior.
  await page.route('https://**/*', route => route.abort());
  await page.goto('http://127.0.0.1:' + address.port + '/erp/', { waitUntil: 'domcontentloaded' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    if (!window.AppData) throw new Error('hydrated AppData bridge is unavailable');
    window.AppData.products = [{ id:'AI-P-1', name:'أريشا كرستال 200غ', stock:2, buyPrice:100, price1:250 }];
    window.AppData.customers = [{ id:'AI-C-1', name:'عمر شريفي', debt:0 }];
    if (typeof openView === 'function') openView('ai-excel-hub');
  });
  await page.locator('#view-ai-excel-hub').waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.__anasLastAudit &&
    window.__anasLastAudit.summary.stockCost === 200 &&
    window.__anasLastAudit.summary.stockSell === 500,
    { timeout: 5000 });
  const aiScroll = await page.locator('#aiHubTabContent').evaluate(node => ({
    overflowY: getComputedStyle(node).overflowY,
    maxHeight: getComputedStyle(node).maxHeight,
    viewportHeight: window.innerHeight
  }));
  assert.equal(aiScroll.overflowY, 'auto');
  assert.ok(parseFloat(aiScroll.maxHeight) <= aiScroll.viewportHeight * 0.86,
    'AI Center content must remain scrollable within the 85dvh mobile viewport');
  await page.locator('#anasAiQuestion').fill('بيع 3 أريشا للعميل عمر شريفي بسعر 250');
  await page.evaluate(() => anasPrepareNaturalLanguageDraft());
  const parsedDraft = await page.evaluate(() => ({
    transaction: document.querySelector('#anasAiNaturalDraft [data-draft-field="transaction"]')?.value,
    quantity: document.querySelector('#anasAiNaturalDraft [data-draft-field="quantity"]')?.value,
    item: document.querySelector('#anasAiNaturalDraft [data-draft-field="item"]')?.value,
    customer: document.querySelector('#anasAiNaturalDraft [data-draft-field="customer"]')?.value,
    unitPrice: document.querySelector('#anasAiNaturalDraft [data-draft-field="unitPrice"]')?.value,
    convertButton: [...document.querySelectorAll('#anasAiNaturalDraft button')].some(button => button.textContent.includes('تحويل إلى فاتورة مبيعات جاهزة'))
  }));
  assert.deepEqual(parsedDraft, {
    transaction: 'بيع (مستنتج من النص)',
    quantity: '3',
    item: 'أريشا كرستال 200غ',
    customer: 'عمر شريفي',
    unitPrice: '250',
    convertButton: true
  });

  // 1) Ask Anas AI: actual HTMLElement.click(), then verify a local answer appears.
  await page.locator('#anasAiQuestion').fill('كيف أراجع المخزون؟');
  await page.locator('#anasAiAskBtn').evaluate(button => button.click());
  await page.waitForFunction(() => {
    const log = document.querySelector('#anasAiChatLog');
    return !!log && /وضع محلي|تحليل محلي|المخزون/.test(log.textContent || '');
  });

  // Android document providers can return a PDF without its suffix and with a generic MIME type.
  // The dedicated PDF input must still route it to PDF.js, not the Excel/CSV rejection branch.
  await page.locator('#smartAiPdfUpload').setInputFiles({
    name: 'android-provider-document',
    mimeType: 'application/octet-stream',
    buffer: createMinimalPdf('ANAS ERP PDF Smoke Test')
  });
  await page.waitForFunction(() => /تم استخراج النص محليًا/.test(
    document.querySelector('#smartAiExcelStatus')?.textContent || ''
  ), { timeout: 10000 });
  assert.match(await page.locator('#smartPdfExtractText').inputValue(), /ANAS ERP PDF Smoke Tes/,
    'PDF text must be extracted locally even when Android omits the extension and reports generic MIME');

  // Scanned-PDF OCR: exercise page rendering, local OCR handoff, page labels and review output.
  await page.evaluate(() => {
    window.pdfjsLib = {
      GlobalWorkerOptions: {},
      getDocument: () => ({ promise: Promise.resolve({
        numPages: 2,
        getPage: async pageNumber => ({
          getViewport: () => ({ width: 612, height: 792 }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup() {}
        }),
        destroy: async () => {}
      }) })
    };
    window.anasGetInvoiceOcrWorker = async () => ({
      recognize: async () => ({ data: { text: 'OCR PAGE TEXT VERIFIED' } })
    });
  });
  await page.locator('#smartPdfOcrButton').evaluate(button => button.click());
  await page.waitForFunction(() => /اكتمل OCR محلياً/.test(
    document.querySelector('#smartAiExcelStatus')?.textContent || ''
  ));
  const scannedPdfText = await page.locator('#smartPdfExtractText').inputValue();
  assert.match(scannedPdfText, /الصفحة 1 \(OCR\)/);
  assert.match(scannedPdfText, /الصفحة 2 \(OCR\)/);
  assert.equal(await page.locator('#smartPdfExtractText').isEditable(), true,
    'OCR output must be editable for human correction before export or AI analysis');
  await page.locator('#smartPdfOcrButton').evaluate(button => button.click());
  await page.waitForFunction(() => /اكتمل OCR محلياً/.test(
    document.querySelector('#smartAiExcelStatus')?.textContent || ''
  ));
  const repeatedOcrText = await page.locator('#smartPdfExtractText').inputValue();
  assert.equal((repeatedOcrText.match(/الصفحة 1 \(OCR\)/g)||[]).length,1,
    're-running OCR must replace the previous OCR segment instead of duplicating it');

  // 2) Safe Excel/CSV import: click the actual action button and choose a CSV file.
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /استيراد Excel\/CSV بأمان/ }).evaluate(button => button.click());
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'ai-smoke.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,qty\nTest,2')
  });
  await page.waitForFunction(() => /ai-smoke|تم فتح الملف|صفوف/.test(
    document.querySelector('#smartAiExcelStatus')?.textContent || ''
  ));

  // Local header heuristic must still propose a category when cloud AI is unavailable.
  await page.locator('#smartImportAiAnalyze').evaluate(button => button.click());
  await page.waitForFunction(() => {
    const status = document.querySelector('#smartImportAiStatus')?.textContent || '';
    return /اقتراح محلي/.test(status) && document.querySelector('#smartImportTarget')?.value === 'products';
  });

  // Real XLSX upload path: multiple non-empty sheets must be selectable before preview.
  await page.locator('#smartImportCancel').evaluate(button => button.click());
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,
    XLSX.utils.aoa_to_sheet([['name','stock','price'],['Widget XLSX',5,12]]), 'Products');
  XLSX.utils.book_append_sheet(workbook,
    XLSX.utils.aoa_to_sheet([['memo'],['not an import sheet']]), 'Notes');
  const xlsxBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const xlsxChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /استيراد Excel\/CSV بأمان/ }).evaluate(button => button.click());
  const xlsxChooser = await xlsxChooserPromise;
  await xlsxChooser.setFiles({
    name: 'multi-sheet-smoke.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: xlsxBuffer
  });
  await page.locator('#smartImportSheetPicker').waitFor({ state: 'visible' });
  await page.locator('#smartImportSheetChoice').selectOption('0');
  await page.locator('#smartImportSheetContinue').evaluate(button => button.click());
  await page.locator('#smartImportPreviewModal').waitFor({ state: 'visible' });
  assert.match(await page.locator('#smartImportPreviewModal').innerText(), /Widget XLSX/);

  // Commit the reviewed XLSX preview through the real import confirmation path.
  // This proves the AI Center does more than parse and display a spreadsheet:
  // the row must enter AppData, be acknowledged by durable storage, and have a
  // verified pre-import snapshot before the modal reports success.
  await page.locator('#smartImportTarget').selectOption('products');
  await page.locator('#smartImportConfirm').evaluate(button => button.click());
  await page.locator('#smartImportReview').getByText('Widget XLSX').waitFor({ state: 'visible' });
  assert.match(await page.locator('#smartImportReview').innerText(), /مطابقة كل البنود تلقائياً/);
  await page.locator('#smartImportConfirm').evaluate(button => button.click());
  await page.waitForFunction(() => /اكتمل الاستيراد المحلي/.test(
    document.querySelector('#smartAiExcelStatus')?.textContent || ''
  ), { timeout: 15000 });
  await page.waitForFunction(() => {
    const snapshot = window.ANASResilientStorage?.getCommittedSnapshot?.();
    return Array.isArray(snapshot?.products) &&
      snapshot.products.some(product => product.name === 'Widget XLSX' &&
        Number(product.stock) === 5 && Number(product.price1) === 12);
  }, { timeout: 15000 });
  const importProof = await page.evaluate(async () => {
    const snapshot = window.ANASResilientStorage.getCommittedSnapshot();
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('anas_erp_v42_resilient_db', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const backup = await new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readonly');
      const request = tx.objectStore('snapshots').get('ANAS_ERP_PRE_IMPORT_BACKUP_V1');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const payload = backup?.payload ? JSON.parse(backup.payload) : null;
    return {
      imported: snapshot.products.filter(product => product.name === 'Widget XLSX').length,
      stock: snapshot.products.find(product => product.name === 'Widget XLSX')?.stock,
      price1: snapshot.products.find(product => product.name === 'Widget XLSX')?.price1,
      backupExists: !!payload,
      backupTarget: payload?.target,
      backupRecordCount: payload?.recordCount,
      backupDidNotContainNewRow: !payload?.data?.products?.some(product => product.name === 'Widget XLSX')
    };
  });
  assert.deepEqual(importProof, {
    imported: 1, stock: 5, price1: 12,
    backupExists: true, backupTarget: 'products',
    backupRecordCount: 1, backupDidNotContainNewRow: true
  }, 'XLSX import must persist exactly once and retain a verified pre-import backup');

  // 3) Generate a blank, safe template and assert the browser download.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /توليد بيانات جاهزة/ }).evaluate(button => button.click());
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /قالب_.*\.xlsx/);

  // 4) Invoice OCR: clicking the action must open the actual OCR modal.
  await page.getByRole('button', { name: /مسح الفواتير بالذكاء الاصطناعي/ }).evaluate(button => button.click());
  await page.locator('#invoiceOcrModal').waitFor({ state: 'visible' });

  // 5) Floating contextual assistant must not cover the ERP work surface.
  const assistantState = await page.evaluate(() => ({
    fabDisplay: getComputedStyle(document.getElementById('anasContextAiFab')).display,
    panelDisplay: getComputedStyle(document.getElementById('anasContextAiPanel')).display
  }));
  assert.equal(assistantState.fabDisplay, 'none');
  assert.equal(assistantState.panelDisplay, 'none');

  // Verify both parsers are present in the built /erp/ bundle and usable with external network denied.
  await page.evaluate(async () => {
    if (!window.XLSX || typeof window.XLSX.read !== 'function') throw new Error('Local SheetJS did not initialize');
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.aoa_to_sheet([['name'], ['Local']]), 'Smoke');
    const bytes = window.XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    const parsed = window.XLSX.read(bytes, { type: 'array' });
    if (parsed.SheetNames[0] !== 'Smoke') throw new Error('Local XLSX round-trip failed');
    if (!window.pdfjsLib || typeof window.pdfjsLib.getDocument !== 'function') throw new Error('Local PDF.js did not initialize');
    const worker = new URL('./vendor/pdfjs/pdf.worker.min.js', document.baseURI);
    if (!worker.pathname.endsWith('/erp/vendor/pdfjs/pdf.worker.min.js')) throw new Error('PDF worker path escaped /erp/');
  });
  await fs.access(path.join(siteRoot, 'erp/vendor/xlsx/xlsx.full.min.js'));
  await fs.access(path.join(siteRoot, 'erp/vendor/pdfjs/pdf.min.js'));
  await fs.access(path.join(siteRoot, 'erp/vendor/pdfjs/pdf.worker.min.js'));

  const builtConfig = await fs.readFile(path.join(siteRoot, 'erp/index.html'), 'utf8');
  assert.match(builtConfig, /"projectId":"anas-erp-staging-a25e1"/);
  await fs.access(path.join(siteRoot, 'erp/sync/mutation_queue_orchestrator.mjs'));
});


test('built /erp/ scanned PDF path runs the real local Tesseract OCR engine on rendered page pixels', async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anas-real-pdf-ocr-'));
  const siteRoot = path.join(tempRoot, 'site');
  await buildStagingHosting({
    rootDir: repoRoot,
    outDir: siteRoot,
    env: {
      FIREBASE_STAGING_WEB_API_KEY: 'STAGING_PUBLIC_API_KEY',
      FIREBASE_STAGING_WEB_APP_ID: '1:123456:web:staging'
    }
  });
  const server = await startStaticServer(siteRoot);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error') t.diagnostic('Browser console: ' + message.text());
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/erp/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.AppData, { timeout: 15000 });
  await page.evaluate(() => { if (typeof openView === 'function') openView('ai-excel-hub'); });
  await page.evaluate(() => {
    window.anasCurrentPdfFile = new File(['scanned-pdf-ocr-fixture'], 'scanned-fixture.pdf', { type: 'application/pdf' });
    window.anasPdfExtractedBaseText = '';
    window.anasPdfExtractedBaseMeta = 'scanned-fixture.pdf — 1 page';
    // This isolated OCR test injects an already-selected PDF fixture instead of
    // exercising the upload handler; reveal the same results panel that the
    // production PDF upload flow reveals after extraction.
    const results = document.getElementById('smartPdfExtractResults');
    if (results) results.style.display = 'block';
    window.pdfjsLib = {
      GlobalWorkerOptions: {},
      getDocument: () => ({ promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getViewport: () => ({ width: 612, height: 792 }),
          render: ({ canvasContext }) => ({
            promise: Promise.resolve().then(() => {
              canvasContext.fillStyle = '#fff';
              canvasContext.fillRect(0, 0, canvasContext.canvas.width, canvasContext.canvas.height);
              canvasContext.fillStyle = '#000';
              canvasContext.font = 'bold 64px Arial';
              canvasContext.fillText('INVOICE 12345', 60, 170);
              canvasContext.fillText('TOTAL 1250 DZD', 60, 270);
            })
          }),
          cleanup() {}
        }),
        destroy: async () => {}
      }) })
    };
  });
  await page.locator('#smartPdfOcrButton').waitFor({ state: 'visible' });

  await page.locator('#smartPdfOcrButton').evaluate(button => button.click());
  await page.waitForFunction(() => /اكتمل OCR محلياً/.test(
    document.querySelector('#smartAiExcelStatus')?.textContent || ''
  ), { timeout: 120000 });
  const recognized = await page.locator('#smartPdfExtractText').inputValue();
  assert.match(recognized, /INVOICE/i, 'real OCR must recognize the invoice heading from rendered pixels');
  assert.match(recognized, /12345/, 'real OCR must recognize the invoice number');
  assert.match(recognized, /1250/, 'real OCR must recognize the amount');
  assert.equal(await page.locator('#smartPdfExtractText').isEditable(), true);
  await context.close();
});
