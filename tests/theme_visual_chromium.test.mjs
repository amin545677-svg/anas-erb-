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

    const moduleRoutes = ['pos','inventory','cash','purchases','suppliers','customers','invoices-list','reports'];
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
