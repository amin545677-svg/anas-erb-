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
  assert.match(html, /لا تُنشئ فاتورة ولا تغيّر المخزون أو الديون تلقائي/);
});

test('theme contrast tokens define both light and dark states', () => {
  assert.match(css, /--anas-ui-btn-bg:#f1f3f6/);
  assert.match(css, /:root\[data-anas-theme="dark"\]/);
  assert.match(css, /--anas-ui-btn-bg:#26364d/);
  assert.match(css, /-webkit-text-fill-color:var\(--anas-ui-btn-text\)!important/);
});

test('dashboard keeps only daily operations, stock and one AI entry', () => {
  assert.doesNotMatch(dashboard, /openView\('trucks'\)|openView\('suppliers'\)|openView\('settings'\)|openView\('sync'\)/);
  assert.equal((dashboard.match(/openView\('ai-excel-hub'\)/g) || []).length, 1);
  assert.doesNotMatch(dashboard, /ملفات العملاء|استيراد Excel|الاستيراد الذكي AI/);
});

test('logistics and supplier management live in the drawer, not the dashboard', () => {
  const drawer = html.slice(html.indexOf('<div class="drawer-sidebar" id="drawerMenu">'), html.indexOf('<!-- نافذة معاينة الفاتورة'));
  assert.match(drawer, /اللوجستيات والنقل[\s\S]*?openView\('trucks'\)/);
  assert.match(drawer, /المشتريات والموردون[\s\S]*?openView\('purchases'\)[\s\S]*?openView\('suppliers'\)/);
  assert.doesNotMatch(dashboard, /openView\('trucks'\)|openView\('suppliers'\)/);
});

test('settings, sync and customer directory have one canonical navigation entry', () => {
  const drawer = html.slice(html.indexOf('<div class="drawer-sidebar" id="drawerMenu">'), html.indexOf('<!-- نافذة معاينة الفاتورة'));
  assert.match(drawer, /openView\('settings'\)/);
  assert.match(drawer, /openView\('sync'\)/);
  assert.equal((dashboard.match(/openView\('customers'\)/g) || []).length, 1);
});

test('invoice action buttons and AI import category controls have theme-safe contrast hooks', () => {
  assert.match(css, /\.btn-pos-hasib,[\s\S]*?#smartImportPreviewModal \[data-smart-import-target\]/);
  assert.match(css, /#anasQuickBottomNav button\.active/);
  assert.match(css, /:root\[data-anas-theme="dark"\] \.anas-ai-file-actions > label\[data-anas-ai-action\]/);
  assert.match(css, /#smartImportPreviewModal > div/);
});
