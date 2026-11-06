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
      // Force the root scroller to be synchronous even if application CSS requests smooth scrolling.
      document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
      document.body.style.setProperty('scroll-behavior', 'auto', 'important');
      const activeSyncView = document.querySelector('#view-sync.active');
      if (!activeSyncView) throw new Error('Sync view did not become active');
      const card = activeSyncView.querySelector('.anas-firebase-auth-card');
      const auth = activeSyncView.querySelector('.anas-firebase-auth-actions');
      const cloud = activeSyncView.querySelector('.anas-firebase-cloud-actions');
      const fab = document.getElementById('anasContextAiFab');
      const toast = document.getElementById('anasActionToast');
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
      const panel = document.getElementById('anasContextAiPanel');
      const lastButton = cloud.querySelector('button:last-child');
      // Remove both floating assistant layers from hit-testing for the duration of the
      // layout acceptance check. The assistant itself is tested again below.
      fab.style.pointerEvents = 'none';
      if (panel) panel.style.pointerEvents = 'none';
      // The external-library failure toast is expected because this test blocks network
      // requests. It is a transient overlay, not the control under test; keep it out of
      // hit-testing for the complete pointer-acceptance phase so it cannot cover the FAB.
      if (toast) toast.style.pointerEvents = 'none';
      // offsetTop is relative to offsetParent, so accumulate the offset chain to obtain
      // the document coordinate; every scroll remains immediate and CSS smooth scrolling
      // is explicitly disabled above.
      const documentOffsetTop = element => {
        let top = 0;
        for (let node = element; node && node !== document.body; node = node.offsetParent) {
          top += node.offsetTop;
        }
        return top;
      };
      const scrollElementToViewport = element => {
        // First apply the requested immediate offsetTop scroll, then correct for
        // nested offsetParent coordinates using the verified document offset.
        window.scrollTo(0, element.offsetTop);
        window.scrollTo(0, documentOffsetTop(element));
        let rect = element.getBoundingClientRect();
        if (rect.bottom > window.innerHeight || rect.top < 0) {
          const correctedTop = rect.top + window.scrollY - Math.max(0, window.innerHeight - rect.height);
          window.scrollTo(0, correctedTop);
          rect = element.getBoundingClientRect();
        }
        return rect;
      };
      const lastRect = scrollElementToViewport(lastButton);
      return {
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        scrollY,
        documentScrollHeight: document.documentElement.scrollHeight,
        authColumns: style.gridTemplateColumns,
        buttons: buttonMetrics,
        fabTop: fabRect.top,
        lastButtonBottom: lastRect.bottom,
        lastButtonTop: lastRect.top,
        lastButtonHeight: lastRect.height,
        lastButtonDocumentTop: documentOffsetTop(lastButton),
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
    assert.ok(metrics.lastButtonTop >= 0 && metrics.lastButtonBottom <= metrics.viewportHeight,
      'last cloud action must be 100% inside the visible viewport after immediate window.scrollTo: ' + JSON.stringify(metrics));
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
        document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
        document.body.style.setProperty('scroll-behavior', 'auto', 'important');
        const documentOffsetTop = element => {
          let top = 0;
          for (let node = element; node && node !== document.body; node = node.offsetParent) top += node.offsetTop;
          return top;
        };
        window.scrollTo(0, el.offsetTop);
        window.scrollTo(0, documentOffsetTop(el));
        let r = el.getBoundingClientRect();
        if (r.top < 0 || r.bottom > window.innerHeight) {
          window.scrollTo(0, r.top + window.scrollY - Math.max(0, window.innerHeight - r.height));
          r = el.getBoundingClientRect();
        }
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

    // Restore the assistant's real hit target before separately testing its controls.
    await page.locator('#anasContextAiFab').evaluate(el => { el.style.pointerEvents = ''; });
    await page.locator('#anasContextAiPanel').evaluate(el => { el.style.pointerEvents = ''; });
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
      window.openView('ai-excel-hub', true);
    });

    const excel = page.locator('[data-anas-ai-action="excel"]');
    const pdf = page.locator('[data-anas-ai-action="pdf"]');
    const security = page.locator('[data-anas-ai-action="security"]');
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

    const excelChooserPromise = page.waitForEvent('filechooser');
    await excel.locator('b').click();
    const excelChooser = await excelChooserPromise;
    assert.match(await excelChooser.element().getAttribute('accept'), /\.xlsx/);
    await excelChooser.setFiles({
      name: 'mobile-preview.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name,quantity\\nItem A,4\\nItem B,7', 'utf8')
    });
    await page.locator('#smartAiExcelStatus').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /تم فتح الملف بنجاح/.test(document.getElementById('smartAiExcelStatus')?.textContent || ''));
    assert.equal(await page.locator('#smartImportPreviewModal').count() > 0, true,
      'Excel/CSV click must produce a local import preview');

    const pdfChooserPromise = page.waitForEvent('filechooser');
    await pdf.locator('span').click();
    const pdfChooser = await pdfChooserPromise;
    assert.equal(pdfChooser.element().id, 'smartAiPdfUpload',
      'PDF card must open its dedicated DOM file input');
    assert.match(await pdfChooser.element().getAttribute('accept'), /\.pdf/);

    await security.click();
    const panel = page.locator('#anasAiDataProtectionPanel');
    await panel.waitFor({ state: 'visible' });
    assert.match(await page.locator('#anasAiDataProtectionDetails').innerText(), /IndexedDB/);
    await page.locator('#anasAiDataProtectionRefresh').click();
    assert.equal(await security.getAttribute('aria-expanded'), 'true');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
