import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildStagingHosting } from '../scripts/build-staging-hosting.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  await context.setOffline(true);
  await context.addInitScript(() => localStorage.removeItem('anasErpAiGatewayUrlV1'));
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  // Deliberately deny all external requests: all five controls must retain useful local behavior.
  await page.route('https://**/*', route => route.abort());
  await page.goto(`http://127.0.0.1:${address.port}/erp/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { if (typeof openView === 'function') openView('ai-excel-hub'); });
  await page.locator('#view-ai-excel-hub').waitFor({ state: 'visible' });

  // 1) Ask Anas AI: actual HTMLElement.click(), then verify a local answer appears.
  await page.locator('#anasAiQuestion').fill('كيف أراجع المخزون؟');
  await page.locator('#anasAiAskBtn').evaluate(button => button.click());
  await page.waitForFunction(() => {
    const log = document.querySelector('#anasAiChatLog');
    return !!log && /وضع محلي|تحليل محلي|المخزون/.test(log.textContent || '');
  });

  // 2) Safe Excel/CSV import: click the actual action button and choose a CSV file.
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /استيراد Excel\/CSV بأمان/ }).evaluate(button => button.click());
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'ai-smoke.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,qty\\nTest,2')
  });
  await page.waitForFunction(() => /ai-smoke|تم فتح الملف|صفوف/.test(
    document.querySelector('#smartAiExcelStatus')?.textContent || ''
  ));

  // 3) Generate a blank, safe template and assert the browser download.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /توليد بيانات جاهزة/ }).evaluate(button => button.click());
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /قالب_.*\\.csv/);

  // 4) Invoice OCR: clicking the action must open the actual OCR modal.
  await page.getByRole('button', { name: /مسح الفواتير بالذكاء الاصطناعي/ }).evaluate(button => button.click());
  await page.locator('#invoiceOcrModal').waitFor({ state: 'visible' });

  // 5) ChatGPT helper: opening and sending must both work without cloud services.
  const fab = page.locator('#anasContextAiFab');
  await fab.evaluate(button => button.click());
  await page.locator('#anasContextAiPanel').waitFor({ state: 'visible' });
  assert.equal(await fab.getAttribute('aria-expanded'), 'true');
  await page.locator('#anasContextAiQuestion').fill('اشرح هذه الشاشة');
  await page.locator('#anasContextAiSend').evaluate(button => button.click());
  await page.waitForFunction(() => {
    const answer = document.querySelector('#anasContextAiAnswer');
    return !!answer && /وضع محلي/.test(answer.textContent || '');
  });

  const builtConfig = await fs.readFile(path.join(siteRoot, 'erp/index.html'), 'utf8');
  assert.match(builtConfig, /"projectId":"anas-erp-staging-a25e1"/);
  await fs.access(path.join(siteRoot, 'erp/sync/mutation_queue_orchestrator.mjs'));
});
