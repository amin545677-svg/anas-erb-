import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const safeCss = fs.readFileSync(new URL('../anas-erp-ui-safe-enhancements.css', import.meta.url), 'utf8');
const importCss = fs.readFileSync(new URL('../ai-excel-import-ui.css', import.meta.url), 'utf8');

function contrast(foreground, background) {
  const channel = value => {
    value /= 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const rgb = value => value.match(/[\\d.]+/g).slice(0, 3).map(Number);
  const lum = value => {
    const [r, g, b] = rgb(value).map(channel);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(foreground), b = lum(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('scoped dark-mode actions and semantic payment controls meet WCAG AA in Chromium', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ colorScheme: 'dark' });
    await page.setContent(`<!doctype html><html data-anas-theme="dark"><head></head><body>
      <section id="view-ai-excel-hub"><section class="anas-ai-import-pro">
        <div class="anas-ai-import-drop"><span>منطقة سحب الملف</span></div>
        <button class="anas-ai-import-type is-active">Excel / CSV</button>
      </section></section>
      <section id="aiHubTabContent"><section class="anas-ai-section">
        <div class="anas-ai-quick-actions"><button>مراجعة المخزون</button><button>ديون العملاء</button></div>
        <button>فحص ذكي شامل</button>
      </section></section>
      <section id="view-invoices-list"><article class="invoice-card"><button>عرض قبل الطباعة</button></article></section>
      <section id="view-settings"><article class="settings-card"><button>حفظ الإعدادات</button></article></section>
      <nav id="anasQuickBottomNav"><button class="active" aria-current="page">الرئيسية</button></nav>
      <section id="hasibModal"><div class="anas-quick-payment-actions">
        <button data-payment-mode="full">كامل</button>
        <button data-payment-mode="partial">½ الآن</button>
        <button data-payment-mode="debt">دين كامل</button>
      </div></section>
    </body></html>`);
    await page.addStyleTag({ content: safeCss });
    await page.addStyleTag({ content: importCss });
    const results = await page.evaluate(() => {
      const read = selector => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('Missing test surface: ' + selector);
        const css = getComputedStyle(el);
        return { selector, foreground: css.color, background: css.backgroundColor, border: css.borderColor };
      };
      return [
        read('.anas-ai-import-pro .anas-ai-import-drop'),
        read('.anas-ai-import-pro .anas-ai-import-type'),
        read('#aiHubTabContent .anas-ai-quick-actions button'),
        read('#aiHubTabContent .anas-ai-section > button'),
        read('#view-invoices-list .invoice-card button'),
        read('#view-settings .settings-card button'),
        read('#anasQuickBottomNav'),
        read('#anasQuickBottomNav button.active'),
        read('#hasibModal button[data-payment-mode="full"]'),
        read('#hasibModal button[data-payment-mode="partial"]'),
        read('#hasibModal button[data-payment-mode="debt"]')
      ];
    });
    for (const item of results) {
      assert.ok(contrast(item.foreground, item.background) >= 4.5,
        item.selector + ' contrast below WCAG AA: ' + JSON.stringify(item));
    }
    assert.notEqual(results[8].background, results[9].background, 'full and partial payment colors must remain distinct');
    assert.notEqual(results[9].background, results[10].background, 'partial and debt payment colors must remain distinct');
    assert.match(results[8].background, /220, 252, 231/, 'full payment remains green');
    assert.match(results[9].background, /219, 234, 254/, 'partial payment remains blue');
    assert.match(results[10].background, /254, 226, 226/, 'debt payment remains red');
  } finally {
    await browser.close();
  }
});
