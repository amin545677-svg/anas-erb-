import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));

function bootTheme({ saved = null, systemDark = false, storageThrows = false } = {}) {
  const values = new Map(saved ? [['ANAS_ERP_THEME', saved]] : []);
  const handlers = {};
  const mediaHandlers = {};
  const root = { attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] || null; } };
  const meta = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  function makeButton(id) {
    const listeners = {};
    const icon = { textContent: '' };
    const label = { textContent: '' };
    return {
      id, attrs: {}, listeners, icon, label,
      querySelector(selector) { return selector.includes('.theme-label') ? label : icon; },
      addEventListener(type, fn) { listeners[type] = fn; },
      setAttribute(k, v) { this.attrs[k] = v; }
    };
  }
  const settingsButton = makeButton('anasThemeToggle');
  const quickButton = makeButton('anasThemeQuickToggle');
  const media = {
    matches: systemDark,
    addEventListener(type, fn) { mediaHandlers[type] = fn; },
    addListener(fn) { mediaHandlers.change = fn; }
  };
  const context = {
    document: {
      documentElement: root,
      querySelectorAll() { return [settingsButton, quickButton]; },
      querySelector(selector) { return selector === 'meta[name="theme-color"]' ? meta : null; }
    },
    window: {
      matchMedia() { return media; },
      addEventListener(type, fn) { handlers[type] = fn; }
    },
    localStorage: {
      getItem(key) { if (storageThrows) throw new Error('storage unavailable'); return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { if (storageThrows) throw new Error('storage unavailable'); values.set(key, value); }
    }
  };
  const marker = "  'use strict';\n  const KEY = 'ANAS_ERP_THEME';";
  const markerIndex = html.indexOf(marker);
  assert.notEqual(markerIndex, -1, 'theme controller exists');
  const scriptStart = html.lastIndexOf('<script>', markerIndex);
  const scriptEnd = html.indexOf('</script>', markerIndex);
  assert.ok(scriptStart !== -1 && scriptEnd > markerIndex, 'theme controller is a complete inline script');
  vm.runInNewContext(html.slice(scriptStart + 8, scriptEnd), context);
  return { values, handlers, mediaHandlers, root, meta, settingsButton, quickButton, media };
}

test('theme bootstrap is applied before the application stylesheet to avoid a flash', () => {
  const bootstrap = html.indexOf('id="anasThemeBootstrap"');
  const stylesheet = html.indexOf('<style>');
  assert.ok(bootstrap > -1 && stylesheet > -1 && bootstrap < stylesheet);
});

test('saved dark preference is applied and synchronized to both theme controls', () => {
  const app = bootTheme({ saved: 'dark', systemDark: false });
  assert.equal(app.root.attrs['data-anas-theme'], 'dark');
  assert.equal(app.root.style.colorScheme, 'dark');
  assert.equal(app.settingsButton.attrs['aria-pressed'], 'true');
  assert.equal(app.quickButton.icon.textContent, '☀️');
  assert.equal(app.meta.attrs.content, '#0b1120');
});

test('quick toggle changes theme immediately and persists the explicit choice', () => {
  const app = bootTheme({ saved: 'light' });
  app.quickButton.listeners.click();
  assert.equal(app.root.attrs['data-anas-theme'], 'dark');
  assert.equal(app.values.get('ANAS_ERP_THEME'), 'dark');
  assert.equal(app.settingsButton.label.textContent, 'الوضع النهاري');
  app.settingsButton.listeners.click();
  assert.equal(app.root.attrs['data-anas-theme'], 'light');
  assert.equal(app.values.get('ANAS_ERP_THEME'), 'light');
});

test('system preference is used until the user chooses a theme', () => {
  const app = bootTheme({ systemDark: true });
  assert.equal(app.root.attrs['data-anas-theme'], 'dark');
  app.media.matches = false;
  app.mediaHandlers.change({ matches: false });
  assert.equal(app.root.attrs['data-anas-theme'], 'light');
});

test('theme changes from another open tab are synchronized', () => {
  const app = bootTheme({ saved: 'light' });
  app.handlers.storage({ key: 'ANAS_ERP_THEME', newValue: 'dark' });
  assert.equal(app.root.attrs['data-anas-theme'], 'dark');
  assert.equal(app.quickButton.attrs['aria-pressed'], 'true');
});

test('invalid stored values fall back to the operating-system preference', () => {
  const app = bootTheme({ saved: 'unexpected', systemDark: true });
  assert.equal(app.root.attrs['data-anas-theme'], 'dark');
});

test('theme remains usable when localStorage is unavailable', () => {
  const app = bootTheme({ systemDark: true, storageThrows: true });
  assert.equal(app.root.attrs['data-anas-theme'], 'dark');
  assert.doesNotThrow(() => app.quickButton.listeners.click());
  assert.equal(app.root.attrs['data-anas-theme'], 'light');
});

test('early bootstrap applies the saved theme before the stylesheet is parsed', () => {
  const match = html.match(/<script id="anasThemeBootstrap">([\s\S]*?)<\/script>/);
  assert.ok(match, 'early theme bootstrap must exist');
  const root = { attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const context = {
    document: { documentElement: root },
    localStorage: { getItem() { return 'dark'; } },
    window: { matchMedia() { return { matches: false }; } }
  };
  vm.runInNewContext(match[1], context);
  assert.equal(root.attrs['data-anas-theme'], 'dark');
  assert.equal(root.style.colorScheme, 'dark');
});

test('early bootstrap falls back safely when storage access is blocked', () => {
  const match = html.match(/<script id="anasThemeBootstrap">([\s\S]*?)<\/script>/);
  assert.ok(match, 'early theme bootstrap must exist');
  const root = { attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const context = {
    document: { documentElement: root },
    localStorage: { getItem() { throw new Error('storage unavailable'); } },
    window: { matchMedia() { return { matches: true }; } }
  };
  vm.runInNewContext(match[1], context);
  assert.equal(root.attrs['data-anas-theme'], 'dark');
});

test('installed PWA theme colors match the light application palette', () => {
  assert.equal(manifest.background_color, '#f5f7fb');
  assert.equal(manifest.theme_color, '#1e3a6d');
  assert.match(html, /<meta name="theme-color" content="#1e3a6d">/);
});

test('dark theme compatibility layer loads after the premium dashboard stylesheet', () => {
  const linkIndex = html.indexOf('anas-erp-ui-safe-enhancements.css');
  const bridgeIndex = html.indexOf('id="anasThemeCompatibility"');
  const bodyIndex = html.indexOf('<body>');
  assert.ok(linkIndex >= 0 && bridgeIndex > linkIndex, 'theme bridge must load after the external premium stylesheet');
  assert.ok(bodyIndex > bridgeIndex, 'theme bridge must load in the document head before first paint');
});

test('dark dashboard preserves readable cards, icon surfaces, and footer contrast', () => {
  const bridge = html.split('id="anasThemeCompatibility"', 2)[1] || '';
  for (const selector of [
    ':root[data-anas-theme="dark"] .grid-card-item',
    ':root[data-anas-theme="dark"] .grid-card-item .card-icon-box',
    ':root[data-anas-theme="dark"] .grid-card-item .card-title-text',
    ':root[data-anas-theme="dark"] .system-footer-status'
  ]) assert.ok(bridge.includes(selector), 'missing dark compatibility selector: ' + selector);
  assert.match(bridge, /-webkit-text-fill-color:#f3f6fc!important/);
});

test('dark compatibility layer normalizes common pale panels and neutral inline text', () => {
  const bridge = html.split('id="anasThemeCompatibility"', 2)[1] || '';
  for (const token of [
    '[style*="background:#f8fafc"]',
    '[style*="background:#eff6ff"]',
    '[style*="background:#f0fdf4"]',
    '[style*="background:#fff7ed"]',
    '[style*="background:#fee2e2"]',
    '[style*="color:#64748b"]'
  ]) assert.ok(bridge.includes(token), 'missing dark palette normalization: ' + token);
});

test('legacy and modern theme variables resolve from the same palette', () => {
  const start = html.indexOf('/* ANAS ERP unified appearance layer');
  const end = html.indexOf('</style>', start);
  const palette = html.slice(start, end);
  for (const token of [
    '--mp-card:var(--anas-surface)',
    '--mp-input-bg:var(--anas-input)',
    '--mp-text:var(--anas-text)',
    '--text-muted:var(--anas-muted)',
    '--card-bg:var(--anas-surface)',
    '--border-color:var(--anas-border)'
  ]) assert.ok(palette.includes(token), 'missing shared theme token: ' + token);
  assert.match(palette, /--mp-light:var\(--anas-surface-raised\)/);
});
