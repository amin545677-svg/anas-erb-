import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateQuickCheckoutCents, filterPosProducts, prepareBulkImport, resolveProductPrice } from '../pos/micro-pos-engine.mjs';

test('POS stock chips filter in-memory records with exclusive stock states', () => {
  const rows = [
    { id: 'a', stock: 12, minAlert: 5, favorite: true, cat: 'عام' },
    { id: 'b', stock: 3, minAlert: 5, cat: 'عام' },
    { id: 'c', stock: 0, minAlert: 5, cat: 'عام' },
    { id: 'd', stock: 4, minAlert: 2, cat: 'آخر' }
  ];
  assert.deepEqual(filterPosProducts(rows, { stockFilter: 'available' }).map(x => x.id), ['a', 'b', 'd']);
  assert.deepEqual(filterPosProducts(rows, { stockFilter: 'low' }).map(x => x.id), ['b']);
  assert.deepEqual(filterPosProducts(rows, { stockFilter: 'out' }).map(x => x.id), ['c']);
  assert.deepEqual(filterPosProducts(rows, { stockFilter: 'favorite' }).map(x => x.id), ['a']);
  assert.deepEqual(filterPosProducts(rows, { category: 'آخر', stockFilter: 'available' }).map(x => x.id), ['d']);
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
});
