import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

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

test('ANAS ERP mobile RTL auth and cloud action controls remain readable and reachable', async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 1 });
    await page.route('https://**/*', route => route.abort());
    await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      if (typeof window.openView !== 'function') throw new Error('openView is unavailable');
      window.openView('sync', true);
    });
    const metrics = await page.evaluate(async () => {
      const activeSyncView = document.querySelector('#view-sync.active');
      if (!activeSyncView) throw new Error('Sync view did not become active');
      const card = activeSyncView.querySelector('.anas-firebase-auth-card');
      const auth = activeSyncView.querySelector('.anas-firebase-auth-actions');
      const cloud = activeSyncView.querySelector('.anas-firebase-cloud-actions');
      const fab = document.getElementById('anasContextAiFab');
      if (!card || !auth || !cloud || !fab) throw new Error('Required settings controls are missing');
      const buttons = [...auth.querySelectorAll('button'), ...cloud.querySelectorAll('button')];
      const style = getComputedStyle(auth);
      const buttonMetrics = buttons.map(button => {
        const rect = button.getBoundingClientRect();
        const computed = getComputedStyle(button);
        return {
          text: button.innerText,
          width: rect.width,
          height: rect.height,
          writingMode: computed.writingMode,
          direction: computed.direction,
          display: computed.display
        };
      });
      const fabRect = fab.getBoundingClientRect();
      const lastButton = cloud.querySelector('button:last-child');
      // Remove the floating assistant from hit-testing for this layout-only acceptance pass.
      fab.style.pointerEvents = 'none';
      window.scrollTo(0, lastButton.offsetTop);
      const lastRect = lastButton.getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        authColumns: style.gridTemplateColumns,
        buttons: buttonMetrics,
        fabTop: fabRect.top,
        lastButtonBottom: lastRect.bottom,
        lastButtonTop: lastRect.top,
        mainPaddingBottom: getComputedStyle(document.querySelector('.main-container')).paddingBottom
      };
    });
    assert.ok(metrics.buttons.length >= 7, 'expected all authentication and cloud actions');
    for (const button of metrics.buttons) {
      assert.ok(button.width >= metrics.viewportWidth * 0.72, 'button became too narrow for the mobile viewport: ' + button.text + ' (' + button.width + 'px)');
      assert.equal(button.writingMode, 'horizontal-tb', 'button text must remain horizontal: ' + button.text);
      assert.equal(button.direction, 'rtl', 'button text direction must remain RTL: ' + button.text);
      assert.ok(button.height >= 48, 'button touch target is too small: ' + button.text);
    }
    assert.ok(metrics.lastButtonTop >= 0 && metrics.lastButtonBottom <= 800,
      'last cloud action must be 100% inside the visible viewport after immediate window.scrollTo');
    assert.ok(metrics.lastButtonBottom <= metrics.fabTop - 8,
      'floating assistant must not cover the last cloud action after scrolling');
    assert.ok(parseFloat(metrics.mainPaddingBottom) >= 150,
      'main content must reserve a safe scroll area for the floating assistant');

    // Exercise real pointer hit-testing and inline DOM handlers, not only CSS metrics.
    await page.evaluate(() => {
      window.__anasMobileClicks = [];
      for (const name of [
        'anasTestWorker', 'anasDiagnoseCloudLink', 'anasFirebaseLogin',
        'anasFirebaseGoogleLogin', 'anasFirebaseLogout',
        'anasFirebasePush', 'anasFirebasePull'
      ]) window[name] = () => window.__anasMobileClicks.push(name);
    });
    const actionButtons = await page.locator(
      '#view-sync.active .anas-firebase-auth-actions > button, ' +
      '#view-sync.active .anas-firebase-cloud-actions > button'
    ).all();
    for (const buttonPromise of actionButtons) {
      const button = await buttonPromise;
      const hit = await button.evaluate(el => {
        window.scrollTo(0, el.offsetTop);
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        return {
          pointerEvents: getComputedStyle(el).pointerEvents,
          visibility: getComputedStyle(el).visibility,
          hitTarget: !!top && (top === el || el.contains(top)),
          fullyInViewport: r.top >= 0 && r.bottom <= innerHeight,
          label: el.innerText.trim()
        };
      });
      assert.notEqual(hit.pointerEvents, 'none', 'button must accept pointer input: ' + hit.label);
      assert.equal(hit.visibility, 'visible', 'button must be visible: ' + hit.label);
      assert.equal(hit.hitTarget, true, 'no overlay may intercept button clicks: ' + hit.label);
      assert.equal(hit.fullyInViewport, true, 'button must be 100% inside viewport before click: ' + hit.label);
      await button.click({ noWaitAfter: true });
    }
    const clicked = await page.evaluate(() => window.__anasMobileClicks);
    assert.deepEqual(clicked, [
      'anasTestWorker', 'anasDiagnoseCloudLink', 'anasFirebaseLogin',
      'anasFirebaseGoogleLogin', 'anasFirebaseLogout',
      'anasFirebasePush', 'anasFirebasePull'
    ], 'all Firebase actions must receive a real Chromium click exactly once');

    const fabButton = page.locator('#anasContextAiFab');
    await fabButton.click();
    assert.equal(await fabButton.getAttribute('aria-expanded'), 'true',
      'floating AI assistant must open from a real mobile pointer click');
    await page.locator('#anasContextAiPanel').waitFor({ state: 'visible' });
    await page.locator('#anasContextAiClose').click();
    assert.equal(await fabButton.getAttribute('aria-expanded'), 'false',
      'floating AI assistant must close without a blocked click');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
