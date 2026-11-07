import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

const ROOT = process.cwd();
function buildTextPdf(lines) {
  const escaped = lines.map(line => String(line).replace(/\\\\/g, '\\\\\\\\').replace(/\\(/g, '\\\\(').replace(/\\)/g, '\\\\)'));
  const commands = ['BT', '/F1 12 Tf', '50 760 Td'];
  escaped.forEach((line, index) => { if (index) commands.push('0 -22 Td'); commands.push('(' + line + ') Tj'); });
  commands.push('ET');
  const stream = commands.join('\\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\\nstream\\n' + stream + '\\nendstream'
  ];
  let pdf = '%PDF-1.4\\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (i + 1) + ' 0 obj\\n' + objects[i] + '\\nendobj\\n';
  }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\\n0 ' + (objects.length + 1) + '\\n0000000000 65535 f \\n';
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \\n';
  pdf += 'trailer\\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\\nstartxref\\n' + xref + '\\n%%EOF';
  return Buffer.from(pdf, 'binary');
}
function serve() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.split('/').filter(Boolean).join('/');
    const target = path.resolve(ROOT, relative);
    if (!target.startsWith(ROOT + path.sep) && target !== path.join(ROOT, 'index.html')) {
      res.writeHead(403).end('Forbidden'); return;
    }
    fs.readFile(target, (error, bytes) => {
      if (error) { res.writeHead(404).end('Not found'); return; }
      const ext = path.extname(target);
      const mime = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.wasm' ? 'application/wasm'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(bytes);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('PDF text extraction runs locally and opens the existing review-only import staging modal', async () => {
  const server = await serve();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('https://**/*', route => route.abort());
    await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.pdfjsLib?.getDocument && typeof window.handleSmartAiUpload === 'function', { timeout: 20000 });
    const pdf = buildTextPdf(['Invoice No: INV-9001', 'Supplier: Al Raqeem', 'Total: 1250.00 DA']);
    await page.locator('#smartAiPdfUpload').setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: pdf });
    await page.locator('#smartAiPdfUpload').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('#smartPdfExtractText')?.value.includes('INV-9001'), { timeout: 20000 });
    assert.match(await page.locator('#smartPdfExtractText').inputValue(), /1250\\.00/);
    await page.locator('#smartImportPreviewModal').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('#smartImportPreviewModal #smartImportTarget').count(), 1);
    assert.match(await page.locator('#smartImportPreviewModal').innerText(), /هذه معاينة فقط ولم يتم تعديل بياناتك/);
    assert.equal(await page.locator('#smartImportPreviewModal [data-smart-import-target="invoices"]').count(), 1);
    assert.match(await page.locator('#smartAiExcelStatus').innerText(), /لم يتم اعتماد أي سجل تلقائياً|لا يتم اعتماد أي سجل تلقائياً|استخراج المحلي/i);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('PDF import enforces the 10MB ceiling before invoking PDF.js', async () => {
  const server = await serve();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.handleSmartAiUpload === 'function', { timeout: 20000 });
    await page.locator('#smartAiPdfUpload').setInputFiles({
      name: 'oversized.pdf', mimeType: 'application/pdf',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x25)
    });
    await page.locator('#smartAiPdfUpload').dispatchEvent('change');
    await page.waitForFunction(() => /10MB/.test(document.querySelector('#smartAiExcelStatus')?.textContent || ''));
    assert.equal(await page.locator('#smartPdfExtractResults').evaluate(el => getComputedStyle(el).display), 'none');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('PDF review parser keeps ambiguous OCR prose review-only and includes local OCR fallback', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /async function processPDFInvoiceFile\\(file,existingDB=\\{\\}\\)/);
  assert.match(html, /if\\(!text\\)\\{\\s*ocr=await anasRecognizePdfFileLocally\\(file/);
  assert.match(html, /return \\{extractedText:text,pages:extracted\\.pages,ocr,rows,existingDB,reviewOnly:true\\}/);
  assert.match(html, /function anasPdfTextToReviewRows\\(extractedText\\)/);
  assert.match(html, /Preserve uncertain OCR\\/text as review-only rows/);
});
