import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { buildStagingHosting } from '../scripts/build-staging-hosting.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function buildTextPdf() {
  const stream = [
    'BT', '/F1 12 Tf', '50 760 Td',
    '(Invoice No: INV-9001) Tj', '0 -22 Td',
    '(Supplier: Al Raqeem) Tj', '0 -22 Td',
    '(Total: 1250.00 DA) Tj', 'ET'
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(pdf, 'binary');
}

async function createBuiltSite() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anas-pdf-e2e-'));
  const siteRoot = path.join(tempRoot, 'site');
  await buildStagingHosting({
    rootDir: ROOT,
    outDir: siteRoot,
    env: {
      FIREBASE_STAGING_WEB_API_KEY: 'STAGING_PUBLIC_API_KEY',
      FIREBASE_STAGING_WEB_APP_ID: '1:123456:web:staging'
    }
  });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/erp' || pathname === '/erp/') pathname = '/erp/index.html';
      const target = path.resolve(siteRoot, '.' + pathname);
      if (!target.startsWith(path.resolve(siteRoot) + path.sep)) {
        res.writeHead(403).end('Forbidden'); return;
      }
      const bytes = await fs.readFile(target);
      const ext = path.extname(target);
      const mime = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' || ext === '.mjs' ? 'text/javascript; charset=utf-8'
        : ext === '.wasm' ? 'application/wasm'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(bytes);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { tempRoot, server, url: 'http://127.0.0.1:' + server.address().port + '/erp/' };
}

async function openAiImportView(page, url) {
  await page.route('https://**/*', route => route.abort());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.AppData && typeof openView === 'function', { timeout: 20000 });
  await page.evaluate(() => openView('ai-excel-hub'));
  await page.locator('#view-ai-excel-hub').waitFor({ state: 'visible' });
  await page.waitForFunction(() => typeof window.handleSmartAiUpload === 'function');
}

test('real PDF.js extraction opens review-only staging from the built offline /erp/ bundle', async t => {
  const site = await createBuiltSite();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => site.server.close(resolve));
    await fs.rm(site.tempRoot, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await openAiImportView(page, site.url);
  await page.waitForFunction(() => window.pdfjsLib?.getDocument, { timeout: 20000 });
  await page.locator('#smartAiPdfUpload').setInputFiles({
    name: 'invoice.pdf', mimeType: 'application/pdf', buffer: buildTextPdf()
  });
  await page.locator('#smartAiPdfUpload').dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('#smartPdfExtractText')?.value.includes('INV-9001'), { timeout: 20000 });
  assert.match(await page.locator('#smartPdfExtractText').inputValue(), /1250\.00/);
  await page.locator('#smartImportPreviewModal').waitFor({ state: 'visible', timeout: 10000 });
  assert.match(await page.locator('#smartImportPreviewModal').innerText(), /هذه معاينة فقط ولم يتم تعديل بياناتك/);
  assert.equal(await page.locator('#smartImportPreviewModal [data-smart-import-target="invoices"]').count(), 1);
  assert.match(await page.locator('#smartAiExcelStatus').innerText(), /لا يتم اعتماد أي سجل تلقائياً/);
});

test('10MB PDF limit is enforced before parsing in the built offline bundle', async t => {
  const site = await createBuiltSite();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => site.server.close(resolve));
    await fs.rm(site.tempRoot, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await openAiImportView(page, site.url);
  await page.locator('#smartAiPdfUpload').setInputFiles({
    name: 'oversized.pdf', mimeType: 'application/pdf',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x25)
  });
  await page.locator('#smartAiPdfUpload').dispatchEvent('change');
  await page.waitForFunction(() => /10MB/.test(document.querySelector('#smartAiExcelStatus')?.textContent || ''));
  assert.equal(await page.locator('#smartPdfExtractResults').evaluate(el => getComputedStyle(el).display), 'none');
});

test('extensionless Android PDF with generic MIME is recognized by its PDF signature', async t => {
  const site = await createBuiltSite();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => site.server.close(resolve));
    await fs.rm(site.tempRoot, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await openAiImportView(page, site.url);
  await page.locator('#smartAiPdfUpload').setInputFiles({
    name: 'android-provider-document', mimeType: 'application/octet-stream', buffer: buildTextPdf()
  });
  await page.locator('#smartAiPdfUpload').dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('#smartPdfExtractText')?.value.includes('INV-9001'), { timeout: 20000 });
  assert.match(await page.locator('#smartAiExcelStatus').innerText(), /اكتمل الاستخراج المحلي/);
});

test('PDF review parser keeps ambiguous OCR prose review-only and includes local OCR fallback', async () => {
  const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('async function processPDFInvoiceFile(file,existingDB={})'));
  assert.ok(html.includes('ocr=await anasRecognizePdfFileLocally(file'));
  assert.ok(html.includes('reviewOnly:true'));
  assert.ok(html.includes('function anasPdfTextToReviewRows(extractedText)'));
  assert.ok(html.includes('Preserve uncertain OCR/text as review-only rows'));
});
