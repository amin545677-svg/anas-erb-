import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const MicroPOSCore = require('../micro-pos-core.js');
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateQuickCheckoutCents, filterPosProducts, prepareBulkImport, resolveProductPrice } from '../pos/micro-pos-engine.mjs';
import './advanced_financial_engine.test.mjs';
import './advanced_import_safety.test.mjs';

test('POS stock chips filter in-memory records with exclusive stock states', () => {
  const rows = [
    { id: 'a', stock: 12, minAlert: 5, favorite: true, cat: 'عام' },
    { id: 'b', stock: 3, minAlert: 5, cat: 'عام' },
    { id: 'c', stock: 0, minAlert: 5, cat: 'عام' },
    { id: 'd', stock: 4, minAlert: 2, cat: 'آخر' }
  ];
  assert.deepEqual(filterPosProducts(rows, { stockFilter: 'available' }).map(x => x.id), ['a', 'd']);
  assert.deepEqual(filterPosProducts(rows, { stockFilter: 'low' }).map(x => x.id), ['b']);
  assert.deepEqual(filterPosProducts(rows, { stockFilter: 'out' }).map(x => x.id), ['c']);
  assert.deepEqual(filterPosProducts(rows, { stockFilter: 'favorite' }).map(x => x.id), ['a']);
  assert.deepEqual(filterPosProducts(rows, { category: 'آخر', stockFilter: 'available' }).map(x => x.id), ['d']);
});

test('new POS filter engine stays behaviorally aligned with the shared legacy core', () => {
  const rows = [
    { id: 'one', name: 'A', stock: 12, minAlert: 5, cat: 'عام', favorite: true },
    { id: 'two', name: 'B', stock: 3, minAlert: 5, cat: 'عام' },
    { id: 'three', name: 'C', stock: 0, minAlert: 5, cat: 'عام' },
    { id: 'four', name: 'D', stock: 4, minAlert: 0, cat: 'آخر', is_featured: true }
  ];
  for (const status of ['all', 'available', 'low', 'out', 'favorite']) {
    const modern = filterPosProducts(rows, { stockFilter: status }).map(row => row.id).sort();
    const shared = MicroPOSCore.filterInventoryItems(rows, {
      category: 'ALL', status: status === 'favorite' ? 'featured' : status
    }).map(row => row.id).sort();
    assert.deepEqual(modern, shared, 'filter parity for ' + status);
  }
});

test('dual price resolution preserves legitimate zero and legacy tier fallbacks', () => {
  assert.equal(resolveProductPrice({ price1: 10, price2: 8, price3: 7 }, 1), 10);
  assert.equal(resolveProductPrice({ price1: 10, price2: 8, price3: 7 }, 2), 8);
  assert.equal(resolveProductPrice({ price1: 10, price2: 8, price3: 7 }, 3), 7);
  assert.equal(resolveProductPrice({ price1: 10, price2: 0 }, 2), 0);
  assert.equal(resolveProductPrice({ price1: 10 }, 3), 10);
  assert.throws(() => resolveProductPrice({ price1: -1 }), /INVALID_PRODUCT_PRICE/);
});

test('quick checkout computes exact centimes and blocks configured credit-limit overflow', () => {
  const customer = { debt: 4000, credit_limit: 10000 };
  assert.deepEqual(
    { paid: calculateQuickCheckoutCents(10000, 'full', customer).paidCents, debt: calculateQuickCheckoutCents(10000, 'full', customer).projectedDebtCents },
    { paid: 10000, debt: 4000 }
  );
  const half = calculateQuickCheckoutCents(10001, 'half', customer);
  assert.equal(half.paidCents, 5000);
  assert.equal(half.remainingDebtCents, 5001);
  assert.equal(half.creditExceeded, false);
  const fullDebt = calculateQuickCheckoutCents(10000, 'full_debt', customer);
  assert.equal(fullDebt.projectedDebtCents, 14000);
  assert.equal(fullDebt.creditExceeded, true);
  assert.equal(calculateQuickCheckoutCents(10000, 'full_debt', { debt: 0 }).creditExceeded, false);
  assert.equal(calculateQuickCheckoutCents(100, 'full_debt', { debt: 0, credit_limit: 0 }).creditExceeded, true);
  assert.throws(() => calculateQuickCheckoutCents(Number.MAX_SAFE_INTEGER, 'full_debt', { debt: 1 }), /OVERFLOW/);
});

test('bulk import planner supports merge, replace, stable IDs and exact counters without mutation', () => {
  const existing = [{ id: '1', barcode: 'A', name: 'Old', quantity: 2 }];
  const incoming = [
    { barcode: 'A', name: 'New', quantity: 3 },
    { barcode: 'B', name: 'Second' },
    { name: '' },
    { barcode: 'A', name: 'New', quantity: 3 }
  ];
  const merged = prepareBulkImport(existing, incoming, 'merge');
  assert.deepEqual(merged.stats, { total: 4, added: 1, updated: 1, skipped: 2 });
  assert.equal(merged.rows[0].id, '1');
  assert.equal(existing[0].name, 'Old');
  const replaced = prepareBulkImport(existing, incoming.slice(1, 3), 'replace');
  assert.deepEqual(replaced.stats, { total: 2, added: 1, updated: 0, skipped: 1 });
  assert.deepEqual(replaced.rows.map(row => row.barcode), ['B']);
});


test('credit ceiling form persists a validated centime-safe limit and restores it while editing', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /id="newCustCreditLimitInput"[^>]*min="0"[^>]*step="0\.01"/,
    'customer form must expose a non-negative DA credit-limit input');
  assert.match(html, /const rawCreditLimit=creditLimitInput\?String\(creditLimitInput\.value\?\?''\)\.trim\(\):'';/,
    'blank credit limit must remain an explicit no-limit value');
  assert.match(html, /!Number\.isSafeInteger\(creditLimitCents\)\|\|creditLimitCents<0/,
    'invalid, negative, or unsafe credit limits must fail closed');
  assert.match(html, /credit_limit: creditLimit/,
    'customer save must persist the credit limit under the canonical field');
  assert.match(html, /newCustCreditLimitInput:c\.credit_limit\?\?''/,
    'editing a customer must restore the saved credit ceiling');
  assert.match(html, /credit_limit:\['حد الائتمان','الحد الائتماني','سقف الدين','creditlimit','credit_limit'\]/,
    'customer spreadsheet import must recognize credit-limit headers');
  assert.match(html, /\['debt','balance','creditUsed',\.\.\.\(indexes\.credit_limit<0\?\['credit_limit'\]:\[\]\)\]/,
    'spreadsheet imports without a credit-limit column must preserve the existing ceiling');
});

test('inventory and POS share live status/category filtering with 20-item progressive rendering', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /id="inventoryUnifiedCategory"/, 'inventory must expose a category selector');
  assert.match(html, /data-inventory-status="featured"/, 'inventory must expose featured status chips');
  assert.match(html, /function filterInventoryStatus\(/, 'inventory chips must update the same filter state as the select');
  assert.match(html, /new deep\.ProgressiveListRenderer\(\s*cont, document\.getElementById\('inventoryProgressiveBadge'\), 20\s*\)/,
    'inventory cards must render in bounded 20-item chunks');
  assert.match(html, /function renderQuickProducts\(\)[\s\S]*?core\.filterInventoryItems\(products, \{ query: search, status, category: category \}\)[\s\S]*?new deep\.ProgressiveListRenderer\(\s*cont, progress, 20\s*\)/,
    'POS catalogue must retain shared category/status/search filtering with bounded progressive rendering');
  assert.match(html, /id="anas-pos-search-first-v1"/,
    'search-first POS styling contract must be integrated into the ERP shell');
  assert.match(html, /core\.filterInventoryItems\(products, \{ query: search, status, category: selectedCategory \}\)/,
    'inventory and POS must use the canonical in-memory inventory filter');
});

test('r39 dashboard exposes eight primary destinations and preserves six persistent navigation tabs', () => {
  const html = readFileSync('index.html', 'utf8');
  const dashboardStart = html.indexOf('<section id="view-dashboard"');
  const dashboardEnd = html.indexOf('<section id="view-more"', dashboardStart);
  const dashboard = html.slice(dashboardStart, dashboardEnd);
  assert.match(dashboard, /id="anasDailyGroupTitle"/, 'the primary dashboard group must remain present');
  assert.equal((dashboard.match(/class="grid-card-item"/g) || []).length, 8,
    'dashboard must expose all eight primary operational modules');
  for (const module of ["sales-pos","mstore","cashbox","purchases","suppliers","customers","inquiries","reports"]) {
    assert.match(dashboard, new RegExp('data-erp-module="' + module + '"'),
      'dashboard must expose the ' + module + ' destination');
  }
  assert.doesNotMatch(dashboard, /anasStockGroupTitle|anasMoneyGroupTitle|anasSmartGroupTitle/,
    'inventory, finance and AI shortcuts must not recreate secondary dashboard groups');
  assert.match(html, /id="anasQuickBottomNav"[\s\S]*?data-nav-view="dashboard"[\s\S]*?data-nav-view="pos"[\s\S]*?data-nav-view="inventory"[\s\S]*?data-nav-view="invoices-list"[\s\S]*?data-nav-view="customers"[\s\S]*?المزيد/,
    'six primary navigation destinations must remain present and ordered');
  assert.match(html, /dashboardAlertBadge[\s\S]*?dashboardBadge\.hidden = alerts\.length === 0/,
    'combined stock and overdue-debt alert count must be refreshed from the shared alert calculation');
});

test('customer directory renders initials and phone-gated Algerian call and WhatsApp statement actions', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /const customerInitials = fullName =>/);
  assert.match(html, /Array\.from\(parts\[0\]\)\[0\]/);
  assert.match(html, /const customerWhatsAppUrl = customer =>/);
  assert.match(html, /const customerTelUrl = customer =>/);
  assert.match(html, /c\.phone && customerWhatsAppUrl\(c\)/,
    'WhatsApp statement action must not render without a phone number');
  assert.match(html, /href="tel:\$\{safe\(customerTelUrl\(c\)\)\}"/,
    'call action must use normalized Algerian phone data');
});
