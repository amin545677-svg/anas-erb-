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

test('purchase invoices have a dedicated drawer destination and the scanner stays inside purchases', () => {
  const drawer = html.slice(html.indexOf('<div class="drawer-sidebar" id="drawerMenu">'), html.indexOf('<!-- نافذة معاينة الفاتورة'));
  assert.doesNotMatch(inventory, /openView\('purchases'\)/);
  assert.doesNotMatch(inventory, /فواتير الشراء ودخول البضاعة/);
  assert.match(drawer, /المشتريات والموردون[\s\S]*?openView\('purchases'\)/);
  assert.match(purchases, /openInvoiceOcr\('purchases'\)/);
  assert.match(purchases, /ماسح فاتورة الشراء AI/);
});

test('invoice workspace provides a direct reports destination', () => {
  const invoiceStart = html.indexOf('<section id="view-invoices-list"');
  const invoices = html.slice(invoiceStart, html.indexOf('</section>', invoiceStart));
  assert.match(invoices, /openView\('reports'\)/);
  assert.match(invoices, /فتح التقارير والإحصائيات/);
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

test('r38 dashboard exposes the five requested primary destinations only', () => {
  assert.equal((dashboard.match(/class="grid-card-item"/g) || []).length, 5);
  for (const action of ["openView('pos')", "openView('customers')", "openView('invoices-list')", "openNotificationModal()", "openView('trucks')"]) {
    assert.ok(dashboard.includes(action), "dashboard is missing " + action);
  }
  assert.doesNotMatch(dashboard, /openView\('inventory'\)|openView\('purchases'\)|openView\('suppliers'\)|openView\('settings'\)|openView\('sync'\)|openView\('ai-excel-hub'\)|openQuickSale\(\)/);
  assert.match(dashboard, /تنبيهات المخزون والديون/);
});

test('purchases and supplier management stay in the drawer while trucks remain on dashboard', () => {
  const drawer = html.slice(html.indexOf('<div class="drawer-sidebar" id="drawerMenu">'), html.indexOf('<!-- نافذة معاينة الفاتورة'));
  assert.match(drawer, /اللوجستيات والنقل[\s\S]*?openView\('trucks'\)/);
  assert.match(drawer, /المشتريات والموردون[\s\S]*?openView\('purchases'\)[\s\S]*?openView\('suppliers'\)/);
  assert.ok(dashboard.includes("openView('trucks')"));
  assert.doesNotMatch(dashboard, /openView\('suppliers'\)/);
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
