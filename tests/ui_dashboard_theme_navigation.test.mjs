import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('anas-erp-ui-safe-enhancements.css', 'utf8');
const dashboard = html.slice(html.indexOf('<section id="view-dashboard"'), html.indexOf('<section id="view-pos"'));
const inventory = html.slice(html.indexOf('<section id="view-inventory"'), html.indexOf('<section id="view-warehouse-transfer"'));
const purchases = html.slice(html.indexOf('<section id="view-purchases"'), html.indexOf('<section id="view-customers"'));

test('dashboard does not expose inventory creation or purchase processing shortcuts', () => {
  assert.doesNotMatch(dashboard, /openAddProductModal\(\)/);
  assert.doesNotMatch(dashboard, /openView\('purchases'\)/);
  assert.doesNotMatch(dashboard, /openInvoiceOcr\(/);
});

test('product creation remains inside the inventory workspace', () => {
  assert.match(inventory, /openAddProductModal\(\)/);
  assert.match(inventory, /اضافة منتج جديد/);
});

test('purchase invoices are reachable from inventory and the scanner is inside purchases', () => {
  assert.match(inventory, /openView\('purchases'\)/);
  assert.match(inventory, /فواتير الشراء ودخول البضاعة/);
  assert.match(purchases, /openInvoiceOcr\('purchases'\)/);
  assert.match(purchases, /ماسح فاتورة الشراء AI/);
});

test('OCR opened from purchases defaults to purchase classification without auto-posting', () => {
  assert.match(html, /function openInvoiceOcr\(defaultCategory\)/);
  assert.match(html, /categorySelect\.value=defaultCategory/);
  assert.match(html, /لا تُنشئ فاتورة ولا تغيّر المخزون أو الديون تلقائياً/);
});

test('theme contrast tokens define both light and dark states', () => {
  assert.match(css, /--anas-ui-btn-bg:#f1f3f6/);
  assert.match(css, /:root\[data-anas-theme="dark"\]/);
  assert.match(css, /--anas-ui-btn-bg:#26364d/);
  assert.match(css, /-webkit-text-fill-color:var\(--anas-ui-btn-text\)!important/);
});
