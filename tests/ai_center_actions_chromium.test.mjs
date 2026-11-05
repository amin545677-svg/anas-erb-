import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

const ROOT = process.cwd();

function startServer() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\\/+/, '');
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
        : ext === '.mjs' ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
      res.end(bytes);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('AI Center actions remain delegated across rerender and local import works without cloud access', async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.route('https://**/*', route => route.abort());
    await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.triggerAiGeneration === 'function'
      && typeof window.handleSmartAiUpload === 'function', null, { timeout: 15000 });

    const delegation = await page.evaluate(() => ({
      bound: document.body.dataset.anasAiActionsBound,
      bodyListenerReady: !!document.body
    }));
    assert.equal(delegation.bound, '1', 'delegated action listener must bind to persistent body');

    // Replace the action container after initial binding: the delegated listener must survive.
    await page.evaluate(() => {
      const original = document.querySelector('[data-anas-ai-action="generate"]');
      if (!original) throw new Error('AI generation button missing');
      const replacement = original.cloneNode(true);
      original.replaceWith(replacement);
    });
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-anas-ai-action="generate"]').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /قالب_المنتجات\.csv/);
    assert.ok(dialogs.some(message => message.includes('تم تنزيل')), 'generation should confirm local template creation');

    // File import must remain local: no Worker, token, or external request is required.
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-anas-ai-action="import"]').click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'ai-center-local.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('الرقم,اسم المنتج,المخزون\n1,اختبار محلي,5', 'utf8')
    });
    await page.waitForFunction(() => /تم فتح الملف بنجاح/.test(
      document.getElementById('smartAiExcelStatus')?.textContent || ''
    ), null, { timeout: 10000 });
    assert.equal(await page.locator('#smartAiExcelUpload').inputValue(), '');

    await page.locator('[data-anas-ai-action="ocr"]').click();
    await page.waitForSelector('#invoiceOcrModal', { state: 'visible' });

    assert.deepEqual(errors, [], 'AI Center interaction must not produce uncaught browser errors');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
