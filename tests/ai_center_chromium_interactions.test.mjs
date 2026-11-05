import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const htmlPath = path.join(root, 'index.html');
const cssPath = path.join(root, 'anas-erp-ui-safe-enhancements.css');

function startErpServer() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/erp/' || pathname === '/erp/index.html' || pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }
    if (pathname === '/erp/anas-erp-ui-safe-enhancements.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      fs.createReadStream(cssPath).pipe(res);
      return;
    }
    res.writeHead(404); res.end('Not found');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('built /erp/ AI Center controls respond to real Chromium clicks with local fallback', async t => {
  const server = await startErpServer();
  const address = server.address();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('dialog', dialog => dialog.accept());
  // Cloud services are deliberately unavailable: this proves local UI behavior is independent of them.
  await page.route('https://**/*', route => route.abort());
  await page.goto(`http://127.0.0.1:${address.port}/erp/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { if (typeof openView === 'function') openView('ai-excel-hub'); });
  await page.locator('#view-ai-excel-hub').waitFor({ state: 'visible' });

  const ask = page.locator('#anasAiAskBtn');
  await ask.waitFor({ state: 'visible' });
  await page.locator('#anasAiQuestion').fill('كيف أراجع المخزون؟');
  await ask.click();
  await assertEventually(page, '#anasAiChatLog', /وضع محلي|محلي|المخزون/);

  const importButton = page.getByRole('button', { name: /استيراد Excel[\\/]CSV بأمان/ });
  const chooserPromise = page.waitForEvent('filechooser');
  await importButton.click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'ai-smoke.csv', mimeType: 'text/csv', buffer: Buffer.from('name,qty\\nTest,2') });
  await assertEventually(page, '#smartAiExcelStatus', /ai-smoke|تم|قراءة|استيراد/);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /توليد بيانات جاهزة/ }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /قالب_.*\\.csv/);

  await page.getByRole('button', { name: /مسح الفواتير بالذكاء الاصطناعي/ }).click();
  await page.locator('#invoiceOcrModal').waitFor({ state: 'visible' });

  const fab = page.locator('#anasContextAiFab');
  await fab.click();
  await page.locator('#anasContextAiPanel').waitFor({ state: 'visible' });
  assert.equal(await fab.getAttribute('aria-expanded'), 'true');
});

async function assertEventually(page, selector, pattern) {
  await page.waitForFunction(({ selector, pattern }) => {
    const el = document.querySelector(selector);
    return !!el && new RegExp(pattern.source, pattern.flags).test(el.textContent || '');
  }, { selector, pattern: { source: pattern.source, flags: pattern.flags } }, { timeout: 5000 });
}
