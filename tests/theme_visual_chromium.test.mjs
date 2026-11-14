import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
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

test('real Chromium theme acceptance: eight-module dashboard, purchase OCR, settings, POS, WCAG contrast, persistence and cross-tab sync', async () => {
  const server = await serve();
  const baseURL = 'http://127.0.0.1:' + server.address().port + '/';
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: 'light', serviceWorkers: 'block' });
    await context.addInitScript(() => { if (localStorage.getItem('ANAS_ERP_THEME') === null) localStorage.setItem('ANAS_ERP_THEME', 'light'); });
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
    assert.equal(initial.modules, 8, 'r39 dashboard must render all eight primary operational modules');
    assert.equal(initial.overflow, false, 'dashboard must not overflow at 390px');

    const moduleRoutes = ['pos','inventory','cash','purchases','suppliers','customers','reports','reports'];
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const grid = await page.locator('#view-dashboard .dashboard-grid-8').evaluate(el => ({
        overflow: el.scrollWidth > el.clientWidth,
        cards: [...el.querySelectorAll('.grid-card-item')].map(card => {
          const title = card.querySelector('.card-title-text');
          return { width: card.getBoundingClientRect().width, titleWidth: title.clientWidth,
            titleScrollWidth: title.scrollWidth, titleHeight: title.clientHeight, titleScrollHeight: title.scrollHeight };
        })
      }));
      assert.equal(grid.cards.length, 8, 'all eight primary modules must render at ' + width + 'px');
      assert.equal(grid.overflow, false, 'primary module grid must not overflow at ' + width + 'px');
      for (const card of grid.cards) {
        assert.ok(card.width >= 100, 'primary module card must remain tappable at ' + width + 'px');
        assert.ok(card.titleScrollWidth <= card.titleWidth + 1, 'module title must not be clipped at ' + width + 'px');
        assert.ok(card.titleScrollHeight <= card.titleHeight + 2, 'module title must not be vertically clipped at ' + width + 'px');
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (let index = 0; index < moduleRoutes.length; index++) {
      const route = moduleRoutes[index];
      await page.locator('#view-dashboard .grid-card-item').nth(index).click();
      await page.locator('#view-' + route).waitFor({ state: 'visible' });
      assert.equal(await page.locator('#view-' + route).evaluate(el => el.classList.contains('active')), true,
        'dashboard module must open its matching screen: ' + route);
      await page.evaluate(() => window.openView('dashboard'));
    }
    await page.evaluate(() => { window.openView('purchases'); window.openInvoiceOcr('purchases'); });
    await page.locator('#invoiceOcrModal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#invoiceOcrCategory').inputValue(), 'purchases',
      'purchase OCR must default to purchase classification');
    assert.match(await page.locator('#invoiceOcrModal').innerText(),
      /لا تُنشئ فاتورة ولا تغيّر المخزون أو الديون تلقائي/,
      'OCR must remain review-only and must not auto-post inventory or supplier balances');
    await page.evaluate(() => { window.closeInvoiceOcr(); window.openView('dashboard'); });
    const lightDashboardContrast = await page.evaluate(() => {
      const card = document.querySelector('#view-dashboard .grid-card-item');
      const title = card?.querySelector('.card-title-text');
      const value = card?.querySelector('strong, b, .card-value');
      const css = node => node ? { color:getComputedStyle(node).color, background:getComputedStyle(card).backgroundColor } : null;
      const action = document.querySelector('#view-dashboard .menu-action-card');
      return { title:css(title), value:css(value), action:action ? {
        color:getComputedStyle(action).color, background:getComputedStyle(action).backgroundColor
      } : null };
    });
    assert.ok(lightDashboardContrast.title, 'dashboard KPI title must exist');
    assert.ok(contrast(lightDashboardContrast.title.color, lightDashboardContrast.title.background) >= 4.5,
      'light dashboard KPI title must meet WCAG AA');
    if (lightDashboardContrast.value) assert.ok(
      contrast(lightDashboardContrast.value.color, lightDashboardContrast.value.background) >= 4.5,
      'light dashboard KPI value must meet WCAG AA');
    if (lightDashboardContrast.action) assert.ok(
      contrast(lightDashboardContrast.action.color, lightDashboardContrast.action.background) >= 4.5,
      'sky-blue action control text must meet WCAG AA');


    await page.locator('#anasThemeQuickToggle').click();
    await page.waitForFunction(() => document.documentElement.getAttribute('data-anas-theme') === 'dark');
    await page.evaluate(() => { window.openView('purchases'); window.openInvoiceOcr('purchases'); });
    await page.locator('#invoiceOcrModal').waitFor({ state: 'visible' });
    const darkOcrVisual = await page.locator('#invoiceOcrModal > div').evaluate(panel => {
      const label = panel.querySelector('label');
      const field = panel.querySelector('#invoiceOcrCategory');
      const panelCss = getComputedStyle(panel), labelCss = label ? getComputedStyle(label) : null;
      const fieldCss = field ? getComputedStyle(field) : null;
      return { background: panelCss.backgroundColor, text: panelCss.color,
        labelColor: labelCss?.color, fieldBackground: fieldCss?.backgroundColor, fieldColor: fieldCss?.color };
    });
    assert.ok(darkOcrVisual.background && darkOcrVisual.background !== 'rgba(0, 0, 0, 0)',
      'dark purchase OCR modal must have an explicit surface');
    assert.equal(darkOcrVisual.background, 'rgb(24, 36, 56)',
      'dark purchase OCR modal must use the existing unified dark surface');
    assert.equal(darkOcrVisual.fieldBackground, 'rgb(16, 26, 43)',
      'dark purchase OCR category field must use the dark input surface');
    assert.ok(contrast(darkOcrVisual.text, darkOcrVisual.background) >= 4.5,
      'dark purchase OCR modal text must meet WCAG AA');
    assert.ok(contrast(darkOcrVisual.labelColor, darkOcrVisual.background) >= 4.5,
      'dark purchase OCR labels must meet WCAG AA');
    assert.ok(contrast(darkOcrVisual.fieldColor, darkOcrVisual.fieldBackground) >= 4.5,
      'dark purchase OCR category field must meet WCAG AA');
    await page.evaluate(() => { window.closeInvoiceOcr(); window.openView('dashboard'); });
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const darkGrid = await page.locator('#view-dashboard .dashboard-grid-8').evaluate(el => ({
        overflow: el.scrollWidth > el.clientWidth,
        cards: [...el.querySelectorAll('.grid-card-item')].map(card => {
          const title = card.querySelector('.card-title-text');
          return { width: card.getBoundingClientRect().width, color: getComputedStyle(title).color,
            titleWidth: title.clientWidth, titleScrollWidth: title.scrollWidth,
            titleHeight: title.clientHeight, titleScrollHeight: title.scrollHeight };
        })
      }));
      assert.equal(darkGrid.cards.length, 8, 'dark dashboard must retain all eight modules at ' + width + 'px');
      assert.equal(darkGrid.overflow, false, 'dark dashboard must not overflow at ' + width + 'px');
      for (const card of darkGrid.cards) {
        assert.ok(card.width >= 100, 'dark module card must remain tappable at ' + width + 'px');
        assert.ok(card.titleScrollWidth <= card.titleWidth + 1, 'dark module title must not be clipped at ' + width + 'px');
        assert.ok(card.titleScrollHeight <= card.titleHeight + 2, 'dark module title must not be vertically clipped at ' + width + 'px');
        assert.ok(contrast(card.color, 'rgb(27, 41, 64)') >= 4.5,
          'dark module title must meet WCAG AA at ' + width + 'px');
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of moduleRoutes) {
      await page.evaluate(view => window.openView(view), route);
      await page.locator('#view-' + route).waitFor({ state: 'visible' });
      const overflow = await page.locator('#view-' + route).evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(overflow, false, 'dark operational screen must not overflow horizontally: ' + route);
    }
    await page.evaluate(() => window.openView('dashboard'));
    const visual = await page.evaluate(() => {
      const card = document.querySelector('#view-dashboard .grid-card-item');
      const title = card.querySelector('.card-title-text');
      const brand = document.querySelector('.top-navbar .app-brand-name');
      return {
        cardText: getComputedStyle(title).color,
        brandText: getComputedStyle(brand).color,
        cardGradient: getComputedStyle(card).backgroundImage,
        navGradient: getComputedStyle(document.querySelector('.top-navbar')).backgroundImage,
        navBackground: (() => {
          const nav = document.querySelector('.top-navbar');
          const color = getComputedStyle(nav).backgroundColor;
          return color === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : color;
        })(),
        pressed: document.querySelector('#anasThemeQuickToggle').getAttribute('aria-pressed'),
        stored: localStorage.getItem('ANAS_ERP_THEME')
      };
    });
    assert.equal(visual.pressed, 'true');
    assert.equal(visual.stored, 'dark');
    assert.match(visual.cardGradient, /rgb\(27,\s*41,\s*64\)/i, 'dark dashboard card gradient must be active');
    assert.equal(visual.navGradient, 'none', 'navigation must use the calm solid theme surface, not a distracting cyan gradient');
    assert.ok(contrast(visual.cardText, 'rgb(27, 41, 64)') >= 4.5, 'dashboard title must meet WCAG AA against its rendered gradient stop');
    assert.ok(contrast(visual.brandText, visual.navBackground) >= 4.5, 'navigation brand must meet WCAG AA against its actual rendered surface');

    const arabicControl = await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'anasArabicThemeFixture';
      fixture.style.cssText = 'width:100%;min-width:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;';
      fixture.innerHTML = '<button class="menu-action-card" type="button">المنتجات</button><button class="menu-action-card" type="button">مراجعة المخزون</button>';
      document.getElementById('view-dashboard').appendChild(fixture);
      return [...fixture.querySelectorAll('button')].map(el => {
        el.style.width = '100%';
        el.style.minWidth = '0';
        el.style.boxSizing = 'border-box';
        const css = getComputedStyle(el);
        return { text: el.textContent.trim(), color: css.color, background: css.backgroundColor,
          letterSpacing: css.letterSpacing, wordBreak: css.wordBreak, direction: css.direction,
          width: el.clientWidth, scrollWidth: el.scrollWidth };
      });
    });
    for (const control of arabicControl) {
      assert.ok(contrast(control.color, control.background) >= 4.5,
        'dark-mode Arabic button text must meet WCAG AA: ' + control.text);
      assert.equal(control.letterSpacing, 'normal', 'Arabic letters must not be artificially spaced');
      assert.equal(control.wordBreak, 'normal', 'Arabic words must not be split character by character');
      assert.ok(control.width > 0 && control.scrollWidth <= control.width + 1,
        'Arabic button label must fit its mobile control: ' + control.text);
    }
    await page.locator('#anasArabicThemeFixture').evaluate(el => el.remove());


    await page.evaluate(() => {
      const probe = { id:'ANAS_THEME_CONTRAST_PROBE', name:'اختبار وضوح المنتج', barcode:'THEME-PROBE', price1:1234, stock:4, unit:'كغ' };
      AppData.products = [...AppData.products.filter(item => item.id !== probe.id), probe];
      document.getElementById('productPickerSearch').value = 'THEME-PROBE';
      window.openProductPickerModal();
    });
    const lightPicker = await page.locator('#productPickerModal .menu-action-card').evaluate(card => {
      const backgroundOf = node => {
        for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
          const value = getComputedStyle(current).backgroundColor;
          if (value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') return value;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const css = node => ({ color:getComputedStyle(node).color, background:backgroundOf(node) });
      return { card:css(card), name:css(card.querySelector('strong')), meta:css(card.querySelector('small')), add:css(card.querySelector(':scope > span')),
        panel:css(document.querySelector('#productPickerModal .picker-dialog-scroll')) };
    });
    for (const [label,pair] of Object.entries(lightPicker)) {
      assert.ok(contrast(pair.color,pair.background) >= 4.5, 'light product picker ' + label + ' must meet WCAG AA: ' + JSON.stringify(pair));
    }
    await page.evaluate(() => {
      window.closeModal('productPickerModal');
      AppData.products = AppData.products.filter(item => item.id !== 'ANAS_THEME_CONTRAST_PROBE');
    });

    await page.evaluate(() => window.openView('ai-excel-hub'));
    await page.locator('#view-ai-excel-hub').waitFor({ state: 'visible' });
    const pdfUploadTile = page.locator('#view-ai-excel-hub label[data-anas-ai-action="pdf"]');
    await pdfUploadTile.waitFor({ state: 'visible' });
    const pdfTileVisual = await pdfUploadTile.evaluate(el => {
      const css = getComputedStyle(el);
      const title = el.querySelector('b'), detail = el.querySelector('span');
      return {
        text: el.innerText,
        color: css.color,
        titleColor: title ? getComputedStyle(title).color : '',
        detailColor: detail ? getComputedStyle(detail).color : '',
        background: css.backgroundColor,
        titleBackground: title ? getComputedStyle(title).backgroundColor : '',
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
        visibility: css.visibility,
        opacity: css.opacity
      };
    });
    assert.match(pdfTileVisual.text, /PDF/, 'PDF upload tile label must be rendered');
    assert.match(pdfTileVisual.text, /استخراج النص/, 'PDF upload tile instructions must be rendered');
    assert.ok(pdfTileVisual.width >= 100 && pdfTileVisual.height >= 76,
      'PDF upload tile must remain a usable mobile touch target');
    assert.equal(pdfTileVisual.visibility, 'visible');
    assert.equal(pdfTileVisual.opacity, '1');
    assert.ok(contrast(pdfTileVisual.titleColor,
      pdfTileVisual.titleBackground === 'rgba(0, 0, 0, 0)' ? pdfTileVisual.background : pdfTileVisual.titleBackground) >= 4.5,
      'PDF tile title must meet WCAG AA on its actual rendered surface');
    assert.ok(contrast(pdfTileVisual.detailColor,
      pdfTileVisual.background) >= 4.5,
      'PDF tile instructions must meet WCAG AA on the actual rendered surface');
    const pdfChooserPromise = page.waitForEvent('filechooser');
    await pdfUploadTile.click();
    const pdfChooser = await pdfChooserPromise;
    assert.equal(await pdfChooser.element().evaluate(el => el.id), 'smartAiPdfUpload',
      'PDF tile must open its dedicated PDF file input');

    const darkAiPills = await page.locator('#view-ai-excel-hub > .pills-group-row > .pill-select-btn').evaluateAll(items =>
      items.map(el => {
        const css = getComputedStyle(el), rect = el.getBoundingClientRect();
        return { text: el.textContent.trim(), color: css.color, background: css.backgroundColor,
          height: rect.height, width: rect.width, letterSpacing: css.letterSpacing,
          wordBreak: css.wordBreak, display: css.display };
      }));
    assert.equal(darkAiPills.length, 5, 'all five AI Center category filters must render');
    for (const pill of darkAiPills) {
      assert.ok(contrast(pill.color, pill.background) >= 4.5,
        'dark AI category pill must meet WCAG AA: ' + pill.text);
      assert.ok(pill.height >= 44 && pill.height <= 72,
        'AI category pill must keep a compact touch target: ' + pill.text);
      assert.ok(pill.width > 0, 'AI category pill must remain visible: ' + pill.text);
      assert.equal(pill.letterSpacing, 'normal', 'Arabic AI pill text must retain natural letter spacing');
      assert.equal(pill.wordBreak, 'normal', 'Arabic AI pill text must not split into characters');
    }

    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const layout = await page.locator('#view-ai-excel-hub > .pills-group-row').evaluate(el => ({
        clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
        children: [...el.children].map(child => ({
          width: child.getBoundingClientRect().width,
          height: child.getBoundingClientRect().height,
          scrollWidth: child.scrollWidth,
          clientWidth: child.clientWidth
        }))
      }));
      assert.ok(layout.clientWidth > 0 && layout.scrollWidth <= layout.clientWidth + 1,
        'AI category grid must not overflow at ' + width + 'px');
      for (const pill of layout.children) {
        assert.ok(pill.width >= 90 && pill.height >= 44 && pill.height <= 72,
          'AI category touch target must stay usable at ' + width + 'px');
        assert.ok(pill.scrollWidth <= pill.clientWidth + 1,
          'AI category label must not be clipped at ' + width + 'px');
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });

    await page.evaluate(() => window.openView('settings'));
    await page.locator('#view-settings').waitFor({ state: 'visible' });
    const field = await page.locator('#cfgAppName').evaluate(el => {
      const css = getComputedStyle(el); return { background: css.backgroundColor, color: css.color };
    });
    assert.ok(!/255,\s*255,\s*255/.test(field.background), 'settings input must not remain white in dark mode');
    assert.ok(contrast(field.color, field.background) >= 4.5, 'settings input text must meet WCAG AA contrast');

    await page.evaluate(() => window.openAddCustomerModal());
    const customerModal = page.locator('#addCustomerModal');
    await customerModal.waitFor({ state: 'visible' });
    const modalVisual = await page.locator('#addCustomerModal .picker-dialog-scroll').evaluate(el => {
      const css = getComputedStyle(el);
      const input = el.querySelector('#newCustNameInput');
      const field = input ? getComputedStyle(input) : null;
      return { surface: css.backgroundColor, text: css.color,
        inputBackground: field?.backgroundColor, inputText: field?.color };
    });
    assert.ok(!/255,\s*255,\s*255/.test(modalVisual.surface), 'customer modal surface must use the dark palette');
    assert.ok(contrast(modalVisual.text, modalVisual.surface) >= 4.5, 'customer modal text must meet WCAG AA contrast');
    assert.ok(modalVisual.inputBackground && !/255,\s*255,\s*255/.test(modalVisual.inputBackground),
      'customer modal fields must use the dark input surface');
    assert.ok(contrast(modalVisual.inputText, modalVisual.inputBackground) >= 4.5,
      'customer modal input text must meet WCAG AA contrast');
    await page.evaluate(() => window.closeModal('addCustomerModal'));

    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'anasThemeTableFixture';
      fixture.innerHTML = '<table><thead><tr><th>المنتج</th><th>الرصيد</th></tr></thead><tbody><tr><td>منتج تجريبي</td><td>12</td></tr></tbody></table>';
      document.getElementById('view-settings').appendChild(fixture);
    });
    const tableVisual = await page.locator('#anasThemeTableFixture th').first().evaluate(el => {
      const css = getComputedStyle(el);
      return { background: css.backgroundColor, color: css.color };
    });
    assert.ok(!/255,\s*255,\s*255/.test(tableVisual.background), 'table headers must not retain a white background in dark mode');
    assert.ok(contrast(tableVisual.color, tableVisual.background) >= 4.5, 'table header text must meet WCAG AA contrast');
    await page.locator('#anasThemeTableFixture').evaluate(el => el.remove());

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

    await page.evaluate(() => {
      const probe = { id:'ANAS_THEME_CONTRAST_PROBE', name:'اختبار وضوح المنتج', barcode:'THEME-PROBE', price1:1234, stock:4, unit:'كغ' };
      AppData.products = [...AppData.products.filter(item => item.id !== probe.id), probe];
      document.getElementById('productPickerSearch').value = 'THEME-PROBE';
      window.openProductPickerModal();
    });
    const darkPicker = await page.locator('#productPickerModal .menu-action-card').evaluate(card => {
      const backgroundOf = node => {
        for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
          const value = getComputedStyle(current).backgroundColor;
          if (value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') return value;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const css = node => ({ color:getComputedStyle(node).color, background:backgroundOf(node) });
      return { card:css(card), name:css(card.querySelector('strong')), meta:css(card.querySelector('small')), add:css(card.querySelector(':scope > span')),
        panel:css(document.querySelector('#productPickerModal .picker-dialog-scroll')) };
    });
    for (const [label,pair] of Object.entries(darkPicker)) {
      assert.ok(contrast(pair.color,pair.background) >= 4.5, 'dark product picker ' + label + ' must meet WCAG AA: ' + JSON.stringify(pair));
    }
    await page.evaluate(() => window.closeModal('productPickerModal'));


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

    await page.evaluate(() => window.openView('ai-excel-hub'));
    await page.locator('#view-ai-excel-hub').waitFor({ state: 'visible' });
    const lightAiPills = await page.locator('#view-ai-excel-hub > .pills-group-row > .pill-select-btn').evaluateAll(items =>
      items.map(el => {
        const css = getComputedStyle(el);
        return { text: el.textContent.trim(), color: css.color, background: css.backgroundColor };
      }));
    assert.equal(lightAiPills.length, 5, 'all AI Center category filters must remain in light mode');
    for (const pill of lightAiPills) {
      assert.ok(contrast(pill.color, pill.background) >= 4.5,
        'light AI category pill must meet WCAG AA: ' + pill.text);
    }
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


test('video-driven shared controls, product-search popups and AI import surfaces meet WCAG AA in both themes', async () => {
  const server = await serve();
  const baseURL = 'http://127.0.0.1:' + server.address().port + '/';
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 800 }, serviceWorkers: 'block' });
    await page.route('https://**/*', route => route.abort());
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body && !document.body.inert);
    await page.evaluate(() => {
      const fixture = document.createElement('section');
      fixture.id = 'anas-video-theme-fixture';
      fixture.innerHTML = `
        <button id="plain-action" type="button">تأكيد البيع</button>
        <button id="menu-action" class="menu-action-card" type="button"><span>إضافة منتج</span></button>
        <section class="anas-ai-import-pro" id="ai-import-surface">
          <div class="anas-ai-import-benefits">
            <div><b id="ai-import-label">Excel / CSV</b><small id="ai-import-detail">استيراد الجداول</small></div>
            <div><b id="ai-import-smart">ذكي</b><small id="ai-import-smart-detail">تعرّف تلقائي على الأعمدة</small></div>
            <div><b id="ai-import-precise">دقيق</b><small id="ai-import-precise-detail">مراجعة قبل الحفظ</small></div>
            <div><b id="ai-import-safe">آمن</b><small id="ai-import-safe-detail">لا حفظ جزئي</small></div>
          </div>
          <div class="anas-ai-import-types">
            <button id="ai-import-type" class="anas-ai-import-type is-active" type="button">منتجات</button>
            <button id="ai-import-type-secondary" class="anas-ai-import-type" type="button">عملاء</button>
          </div>
          <div class="anas-ai-import-drop" id="ai-import-drop"><p id="ai-import-drop-text">اختر الملف</p><button id="ai-import-primary" class="anas-ai-import-primary" type="button">اختيار الملف</button></div>
        </section>
        <div id="hasibModal"><div class="anas-quick-payment-actions">
          <button id="payment-full" type="button">الدفع الكامل</button>
          <button id="payment-partial" type="button">الدفع الجزئي</button>
          <button id="payment-debt" type="button">الدين</button>
        </div></div>
        <div id="legalInvoiceA4Area"><p id="print-text">فاتورة البيع</p></div>`;
      document.body.appendChild(fixture);
      const settings=document.getElementById('view-settings');
      const settingsGroup=document.createElement('div');
      settingsGroup.className='field-group';
      settingsGroup.setAttribute('style','background:#eff6ff;border:1px solid #cbd5e1;padding:8px');
      settingsGroup.innerHTML='<h3 id="theme-settings-title">حفظ الإعدادات</h3><button id="theme-settings-button" type="button">حفظ الإعدادات</button>';
      settings.appendChild(settingsGroup);
      const aiHost=document.getElementById('aiHubTabContent');
      const aiActions=document.createElement('div');
      aiActions.className='anas-ai-quick-actions';
      aiActions.innerHTML='<button id="theme-ai-action" type="button">مراجعة المخزون</button>';
      aiHost.appendChild(aiActions);
      const invoiceHost=document.getElementById('view-invoices-list');
      const invoiceButton=document.createElement('button');
      invoiceButton.id='theme-invoice-action';invoiceButton.type='button';invoiceButton.textContent='عرض قبل الطباعة';
      invoiceHost.appendChild(invoiceButton);
      const bottomNav=document.getElementById('anasQuickBottomNav');
      const bottomButton=document.createElement('button');
      bottomButton.id='theme-bottom-action';bottomButton.className='active';bottomButton.type='button';bottomButton.textContent='المبيعات';
      bottomNav.appendChild(bottomButton);
    });
    // Exercise the actual product picker modal (including its real dialog surface),
    // rather than a detached .picker-dialog-scroll fragment with no modal ancestor.
    await page.evaluate(() => {
      const probe = { id:'ANAS_VIDEO_PICKER_PROBE', name:'اختبار نافذة اختيار المنتج', barcode:'VIDEO-PICKER-PROBE', price1:1234, stock:4, unit:'كغ' };
      AppData.products = [...AppData.products.filter(item => item.id !== probe.id), probe];
      const search = document.getElementById('productPickerSearch');
      if (search) search.value = 'VIDEO-PICKER-PROBE';
      window.openProductPickerModal();
    });
    await page.locator('#productPickerModal .picker-dialog-scroll').waitFor({ state:'visible' });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.setAttribute('data-anas-theme', value), theme);
      const pickerVisual = await page.locator('#productPickerModal .menu-action-card').evaluate(card => {
        const backgroundOf = node => {
          for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
            const value = getComputedStyle(current).backgroundColor;
            if (value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') return value;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        const pair = node => ({ color:getComputedStyle(node).color, background:backgroundOf(node) });
        const panel = document.querySelector('#productPickerModal .picker-dialog-scroll');
        const name = card.querySelector('strong');
        const meta = card.querySelector('small');
        return { panel:pair(panel), card:pair(card), name:pair(name), meta:pair(meta) };
      });
      for (const [name, pair] of Object.entries(pickerVisual)) {
        assert.ok(contrast(pair.color, pair.background) >= 4.5,
          'real product picker ' + name + ' must meet WCAG AA in ' + theme + ': ' + JSON.stringify(pair));
      }
    }
    await page.evaluate(() => {
      window.closeModal('productPickerModal');
      AppData.products = AppData.products.filter(item => item.id !== 'ANAS_VIDEO_PICKER_PROBE');
    });

    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.setAttribute('data-anas-theme', value), theme);
      const snapshot = await page.evaluate(() => {
        const backgroundOf = node => {
          for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
            const value = getComputedStyle(current).backgroundColor;
            if (value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') return value;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        const pair = id => {
          const node = document.getElementById(id);
          const css = getComputedStyle(node);
          const rules = [...document.styleSheets].flatMap(sheet => {
            try { return [...sheet.cssRules].filter(rule => rule.selectorText && node.matches(rule.selectorText) &&
              (rule.style?.getPropertyValue('background') || rule.style?.getPropertyValue('background-color')))
              .map(rule => ({ selector:rule.selectorText, background:rule.style.getPropertyValue('background'),
                backgroundColor:rule.style.getPropertyValue('background-color'),
                important:rule.style.getPropertyPriority('background-color') })); }
            catch (_) { return []; }
          });
          return { color: css.color, background: backgroundOf(node), border: css.borderColor,
            className:node.className, ariaPressed:node.getAttribute('aria-pressed'),
            videoToken:getComputedStyle(document.documentElement).getPropertyValue('--anas-video-control-bg').trim(),
            matchedBackgroundRules:rules };
        };
        return {
          plain: pair('plain-action'),
          menu: pair('menu-action'),
          ai: pair('ai-import-surface'),
          aiLabel: pair('ai-import-label'),
          aiDetail: pair('ai-import-detail'),
          aiSmart: pair('ai-import-smart'),
          aiSmartDetail: pair('ai-import-smart-detail'),
          aiPrecise: pair('ai-import-precise'),
          aiPreciseDetail: pair('ai-import-precise-detail'),
          aiSafe: pair('ai-import-safe'),
          aiSafeDetail: pair('ai-import-safe-detail'),
          aiDrop: pair('ai-import-drop'),
          aiDropText: pair('ai-import-drop-text'),
          aiType: pair('ai-import-type'),
          aiTypeSecondary: pair('ai-import-type-secondary')
        };
      });
      for (const [name, item] of Object.entries(snapshot)) {
        assert.ok(item.background !== 'rgba(0, 0, 0, 0)', name + ' must have a defined surface in ' + theme);
        assert.ok(contrast(item.color, item.background) >= 4.5,
          name + ' foreground/background must meet WCAG AA in ' + theme + ': ' + JSON.stringify(item));
      }
      const paymentColors = await page.locator('#anas-video-theme-fixture #hasibModal .anas-quick-payment-actions button').evaluateAll(nodes =>
        nodes.map(node => ({ background:getComputedStyle(node).backgroundColor, color:getComputedStyle(node).color })));
      assert.deepEqual(paymentColors.map(item => item.background),
        ['rgb(220, 252, 231)', 'rgb(239, 246, 255)', 'rgb(254, 226, 226)'],
        'full payment stays green, partial payment blue and debt red in ' + theme);
      for (const item of paymentColors) {
        assert.ok(contrast(item.color, item.background) >= 4.5,
          'POS payment action colors must meet WCAG AA in ' + theme + ': ' + JSON.stringify(item));
      }
      const targetVisuals=await page.evaluate(()=>{
        const backgroundOf=node=>{
          for(let current=node;current&&current!==document.documentElement;current=current.parentElement){
            const value=getComputedStyle(current).backgroundColor;
            if(value&&value!=='transparent'&&value!=='rgba(0, 0, 0, 0)')return value;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        const pair=id=>{const node=document.getElementById(id),css=getComputedStyle(node);return{color:css.color,background:backgroundOf(node)};};
        const nav=document.getElementById('anasQuickBottomNav');
        return {
          aiQuickAction:pair('theme-ai-action'),
          settingsGroup:pair('theme-settings-title'),
          settingsAction:pair('theme-settings-button'),
          invoiceAction:pair('theme-invoice-action'),
          bottomNavAction:pair('theme-bottom-action'),
          bottomNavSurface:getComputedStyle(nav).backgroundColor,
          bottomNavBorder:getComputedStyle(nav).borderTopColor
        };
      });
      for(const [name,item] of Object.entries(targetVisuals)){
        if(name==='bottomNavSurface')continue;
        assert.ok(contrast(item.color,item.background)>=4.5,
          name+' must meet WCAG AA in '+theme+': '+JSON.stringify(item));
      }
      if(theme==='dark'){
        assert.equal(targetVisuals.settingsGroup.background,'rgb(30, 41, 59)','settings field group must use the dark surface');
        assert.equal(targetVisuals.bottomNavSurface,'rgb(15, 23, 42)','bottom navigation surface must use #0f172a');
        assert.equal(targetVisuals.bottomNavBorder,'rgb(30, 41, 59)','bottom navigation border must use #1e293b');
        assert.equal(targetVisuals.bottomNavAction.background,'rgb(30, 41, 59)','active bottom navigation action must use #1e293b');
      }
    }
    const darkPrimary = await page.locator('#ai-import-primary').evaluate(node => {
      const css=getComputedStyle(node);
      return {color:css.color,background:css.backgroundColor,backgroundImage:css.backgroundImage};
    });
    assert.equal(darkPrimary.background,'rgb(29, 78, 216)','dark AI import primary action must use the contrast-safe blue surface');
    assert.equal(darkPrimary.backgroundImage,'none','dark AI import primary action must not retain the low-contrast gradient');
    assert.ok(contrast(darkPrimary.color,darkPrimary.background)>=4.5,'dark AI import primary action must meet WCAG AA');

    await page.emulateMedia({ media: 'print' });
    const print = await page.locator('#anas-video-theme-fixture #legalInvoiceA4Area').evaluate(node => ({
      background: getComputedStyle(node).backgroundColor,
      color: getComputedStyle(node.querySelector('p')).color
    }));
    assert.equal(print.background, 'rgb(255, 255, 255)', 'invoice print surface must remain white regardless of screen theme');

    assert.equal(print.color, 'rgb(17, 17, 17)', 'invoice print text must remain black regardless of screen theme');
    await page.locator('#anas-video-theme-fixture #legalInvoiceA4Area').evaluate(node => {
      node.innerHTML = '<div style="direction:rtl;width:100%;min-height:240mm;box-sizing:border-box;padding:4mm;background:#fff;font-size:12px"><h2>فاتورة اختبار الطباعة</h2><table style="width:100%;border-collapse:collapse"><thead><tr><th>المنتج</th><th>الكمية</th><th>الإجمالي</th></tr></thead><tbody><tr><td>منتج تجريبي</td><td>2</td><td>4000 دج</td></tr></tbody></table><p>إجمالي الفاتورة: 4000 دج</p></div>';
      node.classList.add('printable');
    });
    const pdf = await page.pdf({ format:'A4', printBackground:true, preferCSSPageSize:true });
    const pdfText = Buffer.from(pdf).toString('latin1');
    const pageCount = (pdfText.match(/\/Type\s*\/Page\b/g) || []).length;
    assert.equal(pageCount, 1, 'a short A4 invoice must not generate a trailing blank page');

  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});


test('video-matched inquiries workspace: date range, grouped reports, invoice archive and both themes', async () => {
  const server = await serve();
  const baseURL = 'http://127.0.0.1:' + server.address().port + '/';
  let browser;
  try {
    browser = await chromium.launch({ headless:true });
    const context = await browser.newContext({
      viewport:{ width:390, height:844 }, colorScheme:'light', serviceWorkers:'block'
    });
    await context.addInitScript(() => localStorage.setItem('ANAS_ERP_THEME','light'));
    const page = await context.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(baseURL,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.body && !document.body.inert && typeof window.openView === 'function',{timeout:20000});

    await page.locator('#view-dashboard [data-erp-module="inquiries"]').click();
    await page.locator('#view-reports').waitFor({state:'visible'});
    const structure = await page.evaluate(() => ({
      active:document.getElementById('view-reports').classList.contains('active'),
      title:document.querySelector('#view-reports .sub-header-title')?.textContent.trim(),
      rows:[...document.querySelectorAll('#view-reports .anas-query-row')].length,
      buttons:[...document.querySelectorAll('#view-reports .anas-query-row')].every(node => node.tagName==='BUTTON' && node.type==='button'),
      groups:[...document.querySelectorAll('#view-reports .anas-query-group-heading')].map(node => node.textContent.trim()),
      toggles:[...document.querySelectorAll('#view-reports .anas-query-toggle input')].length,
      saveButton:!!document.getElementById('anasSaveReportDateRange'),
      from:document.getElementById('reportDateFrom')?.value,
      to:document.getElementById('reportDateTo')?.value,
      statsCollapsed:document.querySelector('#view-reports .anas-query-stats')?.open===false
    }));
    assert.equal(structure.active,true);
    assert.equal(structure.title,'الاستعلامات');
    assert.equal(structure.rows,50,'all grouped report destinations must render');
    assert.equal(structure.buttons,true,'each report row must be a real keyboard-operable button');
    assert.equal(structure.toggles,8,'all report option switches must be present');
    assert.equal(structure.saveButton,true,'date range save action must be present');
    assert.deepEqual(structure.groups,['المتجر','المبيعات','العملاء','المشتريات','الموردين','الصندوق','المصروفات','المخازن']);
    assert.ok(structure.from && structure.to,'both date controls must initialize');
    assert.equal(structure.statsCollapsed,true,'statistics must not push the report list below the initial viewport');

    for (const width of [320,360,390]) {
      await page.setViewportSize({width,height:844});
      const layout=await page.evaluate(() => {
        const root=document.documentElement;
        const datebar=document.querySelector('#view-reports .anas-query-datebar');
        const rows=[...document.querySelectorAll('#view-reports .anas-query-row')];
        return {
          viewport:root.clientWidth, documentWidth:root.scrollWidth,
          dateWidth:datebar.clientWidth,dateScrollWidth:datebar.scrollWidth,
          rowWidths:rows.map(row=>({client:row.clientWidth,scroll:row.scrollWidth,height:row.getBoundingClientRect().height}))
        };
      });
      assert.ok(layout.documentWidth<=layout.viewport+1,'inquiries page must not overflow horizontally at '+width+'px');
      assert.ok(layout.dateScrollWidth<=layout.dateWidth+1,'date strip must fit at '+width+'px');
      for(const row of layout.rowWidths){
        assert.ok(row.scroll<=row.client+1,'report text must wrap instead of overflow at '+width+'px');
        assert.ok(row.height>=44,'each report row must remain an accessible touch target');
      }
    }

    for (const themeName of ['light','dark']) {
      await page.evaluate(value=>document.documentElement.setAttribute('data-anas-theme',value),themeName);
      const visual=await page.evaluate(() => {
        const pair=node=>({color:getComputedStyle(node).color,background:getComputedStyle(node).backgroundColor});
        const row=document.querySelector('#view-reports .anas-query-row');
        const heading=document.querySelector('#view-reports .anas-query-group-heading');
        const date=document.getElementById('reportDateFrom');
        const arrow=row?.querySelector('.anas-query-arrow');
        return {row:pair(row.querySelector('.anas-query-row-label')),rowSurface:getComputedStyle(row).backgroundColor,
          heading:pair(heading),date:pair(date),arrow:{color:getComputedStyle(arrow).color,background:getComputedStyle(row).backgroundColor},
          toggle:{color:getComputedStyle(document.querySelector('#view-reports .anas-query-toggle span')).color,background:getComputedStyle(document.querySelector('#view-reports .anas-query-options')).backgroundColor}};
      });
      assert.ok(contrast(visual.row.color,visual.rowSurface)>=4.5,'report row text must meet WCAG AA in '+themeName);
      assert.ok(contrast(visual.heading.color,visual.heading.background)>=4.5,'group heading must meet WCAG AA in '+themeName);
      assert.ok(contrast(visual.date.color,visual.date.background)>=4.5,'date field must meet WCAG AA in '+themeName);
      assert.ok(contrast(visual.arrow.color,visual.arrow.background)>=4.5,'navigation arrow must meet WCAG AA in '+themeName);
      assert.ok(contrast(visual.toggle.color,visual.toggle.background)>=4.5,'report option labels must meet WCAG AA in '+themeName);
    }

    await page.evaluate(()=>document.documentElement.setAttribute('data-anas-theme','light'));
    await page.locator('#reportDateFrom').fill('2026-11-01');
    await page.locator('#reportDateTo').fill('2026-11-14');
    await page.locator('#anasSaveReportDateRange').click();
    const savedRange=await page.evaluate(()=>JSON.parse(localStorage.getItem('ANAS_REPORT_RANGE_V1')||'null'));
    assert.deepEqual(savedRange,{from:'2026-11-01',to:'2026-11-14'});

    await page.locator('#anasCustomerDetailed').check();
    await page.locator('#anasCustomerHideBalance').check();
    await page.locator('#anasCustomerHideOpening').check();
    await page.locator('#anasCustomerShowCash').check();
    await page.locator('#anasCashShowAdds').check();
    await page.locator('#anasCashShowScreen').check();
    await page.locator('#anasWarehouseShowAvailable').check();
    const optionsState=await page.evaluate(()=>({
      customer:window.ANAS_QUERY_OPTIONS.customer,
      cash:window.ANAS_QUERY_OPTIONS.cash,
      stock:window.ANAS_QUERY_OPTIONS.stock
    }));
    assert.equal(optionsState.customer.detailed,true);
    assert.equal(optionsState.customer.hideBalance,true);
    assert.equal(optionsState.customer.hideOpening,true);
    assert.equal(optionsState.customer.showCashInvoices,true);
    assert.equal(optionsState.cash.showAdds,true);
    assert.equal(optionsState.cash.showCashScreen,true);
    assert.equal(optionsState.stock.showAvailable,true);

    await page.evaluate(() => {
      window.AppData.customers=[{id:'C-TEST',name:'عميل اختبار',phone:'0550000000',debt:50}];
      window.AppData.clientMovements=[
        {id:'OPEN-TEST',clientId:'C-TEST',type:'opening_balance',direction:'debit',amountCentimes:10000,referenceType:'opening_balance',referenceId:'C-TEST',createdAt:'2026-11-02T10:00:00.000Z'},
        {id:'INV-TEST-MOV',clientId:'C-TEST',type:'invoice_debit',direction:'debit',amountCentimes:5000,referenceType:'sales_invoice',referenceId:'INV-TEST',createdAt:'2026-11-03T10:00:00.000Z'}
      ];
      window.AppData.invoices=[{id:'INV-CASH',customer:'عميل اختبار',total:100,paid:100,remaining:0,date:'2026-11-04'}];
      window.AppData.cashMovements=[
        {id:'CASH-MANUAL',type:'add',amount:50,description:'حركة يدوية',date:'2026-11-05T10:00:00.000Z'},
        {id:'CASH-SALE',type:'add',amount:100,description:'تحصيل فاتورة',referenceType:'sales_invoice',referenceId:'INV-CASH',date:'2026-11-06T10:00:00.000Z'},
        {id:'CASH-OUT',type:'subtract',amount:20,description:'حركة خصم',referenceType:'purchase_invoice',referenceId:'PUR-1',date:'2026-11-07T10:00:00.000Z'}
      ];
      window.AppData.products=[
        {id:'P-AVAILABLE',name:'منتج متوفر',stock:5,buyPrice:10,sellPrice:15,unit:'قطعة'},
        {id:'P-EMPTY',name:'منتج نافد',stock:0,buyPrice:10,sellPrice:15,unit:'قطعة'}
      ];
    });
    await page.locator('#view-reports .anas-query-row').filter({hasText:'كشف حساب عميل'}).click();
    await page.locator('#customReportModal').waitFor({state:'visible'});
    const customerReport=await page.evaluate(()=>({
      headers:[...document.querySelectorAll('#customReportContent thead th')].map(x=>x.textContent.trim()),
      rows:[...document.querySelectorAll('#customReportContent tbody tr')].map(x=>x.textContent)
    }));
    assert.equal(customerReport.rows.length,2,'opening balance must be hidden while the invoice movement and cash invoice remain');
    assert.equal(customerReport.headers.includes('الرصيد الحالي'),false,'hide-balance option must remove the balance column');
    assert.ok(customerReport.rows.some(x=>x.includes('فاتورة نقدية')));
    await page.evaluate(()=>window.closeModal('customReportModal'));

    await page.locator('#view-reports .anas-query-row').filter({hasText:'تقرير بحركة الصندوق'}).click();
    await page.locator('#customReportModal').waitFor({state:'visible'});
    const cashReport=await page.locator('#customReportContent').innerText();
    assert.ok(cashReport.includes('حركة يدوية') && cashReport.includes('تحصيل فاتورة'));
    assert.equal(cashReport.includes('حركة خصم'),false,'add-only option must exclude deductions');
    await page.evaluate(()=>window.closeModal('customReportModal'));

    await page.getByRole('button',{name:'جرد مخزني',exact:true}).click();
    await page.locator('#customReportModal').waitFor({state:'visible'});
    const stockReport=await page.locator('#customReportContent').innerText();
    assert.ok(stockReport.includes('منتج متوفر'));
    assert.equal(stockReport.includes('منتج نافد'),false,'available-quantities option must filter zero-stock items');
    await page.evaluate(()=>window.closeModal('customReportModal'));
    await page.locator('#reportDateFrom').fill('2026-11-01');
    await page.locator('#reportDateTo').fill('2026-11-14');
    assert.match(await page.locator('#reportDateRangeStatus').textContent(),/الفترة المحددة/);
    await page.locator('#reportDateFrom').fill('2026-11-15');
    await page.locator('#reportDateTo').fill('2026-11-14');
    assert.match(await page.locator('#reportDateRangeStatus').textContent(),/تاريخ البداية/);

    await page.locator('#reportDateFrom').fill('2026-11-01');
    await page.locator('#reportDateTo').fill('2026-11-14');
    await page.locator('#view-reports .anas-query-row').filter({hasText:'تقرير بالمبيعات'}).click();
    await page.locator('#customReportModal').waitFor({state:'visible'});
    assert.equal((await page.locator('#customReportTitle').textContent()).trim(),'تقرير المبيعات');
    await page.evaluate(()=>window.closeModal('customReportModal'));

    await page.locator('#view-reports .anas-query-row').filter({hasText:'سجل فواتير المبيعات'}).click();
    await page.locator('#view-invoices-list').waitFor({state:'visible'});
    assert.equal(await page.locator('#view-invoices-list').evaluate(node=>node.classList.contains('active')),true);
    await page.locator('#view-invoices-list button').filter({hasText:'فتح التقارير والإحصائيات'}).click();
    await page.locator('#view-reports').waitFor({state:'visible'});
    assert.equal(await page.locator('#view-reports').evaluate(node=>node.classList.contains('active')),true);

    await page.close();
    await context.close();
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
});


test('r40 source-level regression: strict calendar, ledger math, POS single bar and semantic colors', () => {
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  const cart=fs.readFileSync(path.join(ROOT,'anas-pos-floating-cart.js'),'utf8');
  const cartCss=fs.readFileSync(path.join(ROOT,'anas-pos-floating-cart.css'),'utf8');
  const themeCss=fs.readFileSync(path.join(ROOT,'anas-erp-ui-safe-enhancements.css'),'utf8');
  const parser=html.match(/function reportParseDate\(value\) \{[\s\S]*?\n        \}/);
  assert.ok(parser,'strict report date parser must exist');
  const parse=vm.runInNewContext('('+parser[0]+')');
  assert.equal(parse('2026-02-31'),null,'impossible calendar date must be rejected');
  assert.equal(parse('2026-02-28')?.toISOString().slice(0,10),'2026-02-28');
  assert.match(html,/الرصيد التراكمي/,'customer statement must show a running balance');
  assert.match(html,/BigInt\(m\.amountCentimes\)/,'customer ledger uses integer centimes');
  assert.match(html,/renderQueryTable\(\['الحساب','عدد الحركات','الإجمالي'/,'expenses must be grouped by account');
  assert.match(html,/postedSaleReturns/,'posted sales returns must reduce profit');
  assert.match(html,/incompleteCostLines/,'missing cost lines must be disclosed');
  assert.match(html,/رسم بياني لحركة المتجر/,'store movement report must render an SVG chart');
  assert.match(cart,/computeLineTotalCentimesBigInt/,'cart totals must use BigInt centime arithmetic');
  assert.match(cart,/QUICK_WEIGHT_MILLIS_MAP/,'fractional quick weights must be represented as integer milligrams');
  assert.match(cart,/anas-pos-unified-checkout/,'cart must use the single unified checkout surface');
  assert.doesNotMatch(cart,/createElement\('aside'\);sticky/,'legacy independent sticky checkout must not be mounted');
  assert.match(cartCss,/#anas-sticky-checkout-bar\{display:none!important\}/,'legacy sticky bar is hidden');
  assert.match(themeCss,/:root\[data-anas-theme="dark"\] #hasibModal/,'dark mode must retain semantic payment colors');
  assert.match(themeCss,/#anasQuickBottomNav/,'bottom navigation must have an explicit dark surface');
});
