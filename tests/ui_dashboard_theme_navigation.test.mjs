import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('anas-erp-ui-safe-enhancements.css', 'utf8');
const dashboard = html.slice(html.indexOf('<section id="view-dashboard"'), html.indexOf('<section id="view-more"'));
const inventory = html.slice(html.indexOf('<section id="view-inventory"'), html.indexOf('<section id="view-warehouse-transfer"'));
const purchases = html.slice(html.indexOf('<section id="view-purchases"'), html.indexOf('<section id="view-customers"'));

test('dashboard exposes parent modules without exposing product creation or OCR child actions', () => {
  assert.doesNotMatch(dashboard, /openAddProductModal\(\)/);
  assert.doesNotMatch(dashboard, /openInvoiceOcr\(/);
  assert.match(dashboard, /data-erp-module="purchases"[^>]*openView\('purchases'\)/);
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
  assert.match(html, /<section id="view-invoices-list"[\s\S]*?openView\('reports'\)/);
  assert.match(html, /فتح التقارير والإحصائيات/);
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

test('r39 dashboard exposes the eight canonical operational modules exactly once', () => {
  assert.equal((dashboard.match(/class="grid-card-item"/g) || []).length, 8);
  const modules = ["sales-pos","mstore","cashbox","purchases","suppliers","customers","inquiries","reports"];
  for (const module of modules) assert.equal((dashboard.match(new RegExp('data-erp-module="' + module + '"',"g")) || []).length, 1,
    "dashboard must expose exactly one " + module + " module");
  for (const action of ["openView('pos')","openView('inventory')","openView('cash')","openView('purchases')","openView('suppliers')","openView('customers')","openView('reports')"]) {
    assert.ok(dashboard.includes(action), "dashboard is missing " + action);
  }
  assert.doesNotMatch(dashboard, /openView\('trucks'\)|openAddProductModal\(\)|openInvoiceOcr\(/);
  assert.match(dashboard, /تنبيهات المخزون والديون/);
});

test('dashboard alert badge counts both low stock and overdue customer debts', () => {
  assert.match(html, /id="dashboardAlertBadge"/);
  assert.match(html, /dashboardBadge\.textContent = String\(alerts\.length\)/);
  assert.match(html, /dashboardBadge\.hidden = alerts\.length === 0/);
});

test('dashboard alert badge ignores invalid stock and debt values', () => {
  const checkStart = html.indexOf('function checkSystemAlerts()');
  const renderStart = html.indexOf('function renderAlertsList()', checkStart);
  const checker = html.slice(checkStart, renderStart);
  assert.match(checker, /Array\.isArray\(AppData\.products\)/);
  assert.match(checker, /Array\.isArray\(AppData\.customers\)/);
  assert.match(checker, /Number\.isFinite\(stockValue\)/);
  assert.match(checker, /Number\.isFinite\(debt\)/);
  assert.match(checker, /dashboardBadge\.textContent = String\(alerts\.length\)/);
  assert.match(checker, /dashboardBadge\.hidden = alerts\.length === 0/);
});

test('primary modules are on the dashboard while logistics stays in secondary tools', () => {
  const drawer = html.slice(html.indexOf('<div class="drawer-sidebar" id="drawerMenu">'), html.indexOf('<!-- نافذة معاينة الفاتورة'));
  const more = html.slice(html.indexOf('<section id="view-more"'), html.indexOf('<!-- 3. شاشة المبيعات'));
  assert.ok(dashboard.includes("openView('purchases')"));
  assert.ok(dashboard.includes("openView('suppliers')"));
  assert.ok(dashboard.includes("openView('cash')"));
  assert.doesNotMatch(dashboard, /openView\('trucks'\)/);
  assert.match(more, /data-secondary-module="trucks"[^>]*openView\('trucks'\)/);
  assert.match(drawer, /اللوجستيات والنقل[\s\S]*?openView\('trucks'\)/);
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


test('More workspace contains eight secondary tools without duplicating primary modules', () => {
  const more = html.slice(html.indexOf('<section id="view-more"'), html.indexOf('<!-- 3. شاشة المبيعات'));
  assert.equal((more.match(/class="anas-more-card"/g) || []).length, 8);
  for (const action of ["expenses","trucks","warehouse-transfer","warehouse-stock","users","settings","sync","ai-excel-hub"]) {
    assert.ok(more.includes('data-secondary-module="' + action + '"'), "More workspace is missing " + action);
    assert.ok(more.includes("openView('" + action + "')"), "More workspace route is missing " + action);
  }
  for (const primary of ["pos","inventory","cash","purchases","suppliers","customers","invoices-list","reports"]) {
    assert.doesNotMatch(more, new RegExp("openView\\('" + primary + "'\\)"), "Primary module duplicated in More: " + primary);
  }
  assert.ok(html.includes('data-nav-view="more"'));
  assert.ok(html.includes("onclick=\"openView('more')\""));
  for (const view of ["expenses","trucks","warehouse-transfer","warehouse-stock","users","settings","sync","ai-excel-hub"]) {
    assert.ok(html.includes('id="view-' + view + '"'), "Missing destination view " + view);
  }
});

test('More workspace cards have explicit readable light and dark theme rules', () => {
  assert.ok(css.includes('#view-more .anas-more-card'));
  assert.ok(css.includes(':root[data-anas-theme="dark"] #view-more .anas-more-card'));
  assert.ok(css.includes(':root:not([data-anas-theme="dark"]) #view-more .anas-more-card'));
  assert.ok(css.includes('#view-more .anas-more-label'));
});


test('inquiries dashboard card opens the video-matched reports screen while invoice history stays separate', () => {
  const reports = html.slice(html.indexOf('<section id="view-reports"'), html.indexOf('<!-- 11. شاشة الإعدادات'));
  assert.match(dashboard, /data-erp-module="inquiries" onclick="openView\('reports'\)"/);
  assert.match(reports, /<div class="sub-header-title">الاستعلامات<\/div>/);
  assert.match(reports, /class="anas-query-datebar"/);
  assert.match(reports, /id="reportDateFrom"/);
  assert.match(reports, /id="reportDateTo"/);
  for (const heading of ['العملاء','المبيعات وحساب الأرباح','المشتريات','الموردون','المصروفات','المخازن وجرد المخزون','الصندوق والمصروفات']) {
    assert.ok(reports.includes('>' + heading + '</h3>'), 'missing inquiries group: ' + heading);
  }
  assert.match(reports, /class="anas-query-row"[^>]*onclick="openView\('invoices-list'\)"/);
  assert.ok(reports.indexOf('class="anas-query-list"') < reports.indexOf('class="anas-query-stats"'));
  assert.equal((html.match(/id="reportDateFrom"/g) || []).length, 1);
  assert.equal((html.match(/id="reportDateTo"/g) || []).length, 1);
  assert.match(html, /<section id="view-invoices-list"/);
});

test('inquiries report rows are real keyboard-operable buttons and retain existing report handlers', () => {
  const reports = html.slice(html.indexOf('<section id="view-reports"'), html.indexOf('<!-- 11. شاشة الإعدادات'));
  assert.ok((reports.match(/<button type="button" class="anas-query-row"/g) || []).length >= 20);
  for (const action of ["showReportDetails('تقرير المبيعات')","showProfitsReportModal()","showReportDetails('تقرير المشتريات')","showReportDetails('جرد مخزني')","showReportDetails('تقرير المصروفات حسب الحساب')","printZReport()","openLuminaAnalyticsModal()"]) {
    assert.ok(reports.includes(action), 'missing report action: ' + action);
  }
});

test('inquiries screen has explicit light/dark row and date-field contrast rules', () => {
  assert.match(css, /#view-reports \.anas-query-row/);
  assert.match(css, /html:root\[data-anas-theme="dark"\] body #view-reports \.anas-query-row/);
  assert.match(css, /#view-reports \.anas-query-datebar/);
  assert.match(css, /anas-query-row:focus-visible/);
});
