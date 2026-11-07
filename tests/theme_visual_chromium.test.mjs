import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

const ROOT = process.cwd();
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
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.webmanifest' ? 'application/manifest+json'
        : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(bytes);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function luminance(rgb) {
  const c = rgb.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert.ok(c?.length === 3, 'Expected RGB color, received: ' + rgb);
  const linear = c.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
}
function contrast(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

test('real Chromium theme acceptance: dashboard, settings, POS, WCAG contrast, persistence and cross-tab sync', async () => {
  const server = await serve();
  const baseURL = 'http://127.0.0.1:' + server.address().port + '/';
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: 'light', serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('ANAS_ERP_THEME', 'light'));
    const page = await context.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body && !document.body.inert && typeof window.openView === 'function', { timeout: 20000 });

    const initial = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-anas-theme'),
      modules: document.querySelectorAll('#view-dashboard .grid-card-item').length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }));
    assert.equal(initial.theme, 'light');
    assert.ok(initial.modules >= 10, 'real ERP dashboard modules must render');
    assert.equal(initial.overflow, false, 'dashboard must not overflow at 390px');

    await page.locator('#anasThemeQuickToggle').click();
    await page.waitForFunction(() => document.documentElement.getAttribute('data-anas-theme') === 'dark');
    const visual = await page.evaluate(() => {
      const card = document.querySelector('#view-dashboard .grid-card-item');
      const title = card.querySelector('.card-title-text');
      const brand = document.querySelector('.top-navbar .app-brand-name');
      return {
        cardText: getComputedStyle(title).color,
        brandText: getComputedStyle(brand).color,
        cardGradient: getComputedStyle(card).backgroundImage,
        navGradient: getComputedStyle(document.querySelector('.top-navbar')).backgroundImage,
        pressed: document.querySelector('#anasThemeQuickToggle').getAttribute('aria-pressed'),
        stored: localStorage.getItem('ANAS_ERP_THEME')
      };
    });
    assert.equal(visual.pressed, 'true');
    assert.equal(visual.stored, 'dark');
    assert.match(visual.cardGradient, /rgb\\(27,\\s*41,\\s*64\\)/i, 'dark dashboard card gradient must be active');
    assert.match(visual.navGradient, /rgb\\(5,\\s*39,\\s*71\\)/i, 'dark navy navigation gradient must be active');
    assert.ok(contrast(visual.cardText, 'rgb(27, 41, 64)') >= 4.5, 'dashboard title must meet WCAG AA against its rendered gradient stop');
    assert.ok(contrast(visual.brandText, 'rgb(5, 39, 71)') >= 4.5, 'navigation brand must meet WCAG AA against its rendered gradient stop');

    await page.evaluate(() => window.openView('settings'));
    await page.locator('#view-settings').waitFor({ state: 'visible' });
    const field = await page.locator('#cfgAppName').evaluate(el => {
      const css = getComputedStyle(el); return { background: css.backgroundColor, color: css.color };
    });
    assert.ok(!/255,\s*255,\s*255/.test(field.background), 'settings input must not remain white in dark mode');
    assert.ok(contrast(field.color, field.background) >= 4.5, 'settings input text must meet WCAG AA contrast');

    await page.evaluate(() => window.openView('pos'));
    await page.locator('#view-pos').waitFor({ state: 'visible' });
    const pos = await page.evaluate(() => {
      const root = document.documentElement, view = document.getElementById('view-pos');
      const controls = [...view.querySelectorAll('input,select,textarea,button')].filter(el => {
        const css = getComputedStyle(el), rect = el.getBoundingClientRect();
        return css.display !== 'none' && css.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
      return { active: view.classList.contains('active'), count: controls.length, overflow: root.scrollWidth > root.clientWidth };
    });
    assert.equal(pos.active, true);
    assert.ok(pos.count >= 5, 'POS interactive controls must remain available');
    assert.equal(pos.overflow, false, 'POS must not overflow horizontally on mobile');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body && !document.body.inert, { timeout: 20000 });
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-anas-theme')), 'dark',
      'explicit theme preference must survive a full reload');

    const second = await context.newPage();
    await second.route('https://**/*', route => route.abort());
    await second.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await second.waitForFunction(() => document.body && !document.body.inert, { timeout: 20000 });
    await second.locator('#anasThemeQuickToggle').click();
    await page.waitForFunction(() => document.documentElement.getAttribute('data-anas-theme') === 'light', { timeout: 5000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('ANAS_ERP_THEME')), 'light',
      'theme choice must synchronize across two live tabs');
    await second.close();
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body && !document.body.inert, { timeout: 20000 });
    const tablet = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      theme: document.documentElement.getAttribute('data-anas-theme'),
      dashboardVisible: document.getElementById('view-dashboard').classList.contains('active')
    }));
    assert.equal(tablet.theme, 'light');
    assert.equal(tablet.dashboardVisible, true);
    assert.ok(tablet.scrollWidth <= tablet.width, 'tablet dashboard must not overflow horizontally');
    await page.close(); await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
