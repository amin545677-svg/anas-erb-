import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /<script\b[^>]*src=["']\.\/?arabic-query-engine\.js["'][^>]*><\/script>/i,
  'index.html must load the standalone Arabic query engine');
assert.match(html, /<script\b[^>]*src=["']\.\/?customer-debt-protection\.js["'][^>]*><\/script>/i,
  'index.html must load the standalone customer debt protection module');

const { anasNormalizeQueryText, anasQueryMatches, anasQueryScore } = require('../arabic-query-engine.js');
const debt = require('../customer-debt-protection.js');

test('normalizes Arabic alef variants, diacritics and tatweel', () => {
  assert.equal(anasNormalizeQueryText('إِبْرَاهِيمـ'), 'ابراهيم');
});
test('normalizes Arabic-Indic and Persian digits to ASCII', () => {
  assert.equal(anasNormalizeQueryText('باركود ١٢٣ ۴۵'), 'باركود 123 45');
});
test('matches every query token across multiple fields', () => {
  assert.equal(anasQueryMatches(['زيت الزيتون', 'منتج غذائي'], 'الزيت منتج'), true);
  assert.equal(anasQueryMatches(['زيت الزيتون', 'منتج غذائي'], 'الزيت دواء'), false);
});
test('empty query matches all records', () => {
  assert.equal(anasQueryMatches(['أي منتج'], '   '), true);
});
test('ranks exact and prefix matches above partial matches', () => {
  assert.ok(anasQueryScore(['زيت الزيتون'], 'زيت الزيتون') > anasQueryScore(['زيت الزيتون'], 'الزيت'));
  assert.ok(anasQueryScore(['زيت الزيتون'], 'زيت') > anasQueryScore(['زيت الزيتون'], 'الزيت'));
});
test('customer directory uses standalone Arabic matching and customer debt controls', () => {
  assert.match(html, /customerDirectorySearch/);
  assert.match(html, /window\.anasNormalizeQueryText\(/);
  assert.match(html, /window\.anasQueryMatches\(/);
  assert.match(html, /data-customer-debt-filter="debt"/);
  assert.match(html, /window\.anasCustomerDebtForSave\(/);
  assert.match(html, /window\.anasCustomerDebtFilterMatches\(/);
  assert.match(html, /window\.anasRenderCustomerDebtCollections\(/);
});
test('standalone modules are loaded by the application HTML', () => {
  assert.ok(html.indexOf('id="app"') < html.indexOf('arabic-query-engine.js'));
  assert.ok(html.indexOf('customer-debt-protection.js') > -1);
});

test('customer profile edits preserve stored debt and new customers accept opening debt', () => {
  assert.equal(debt.anasCustomerDebtForSave(true, { debt: 8400 }, 0), 8400);
  assert.equal(debt.anasCustomerDebtForSave(true, { debt: 8400 }, 999999), 8400);
  assert.equal(debt.anasCustomerDebtForSave(true, {}, 999999), 0);
  assert.equal(debt.anasCustomerDebtForSave(false, null, 1250), 1250);
});
test('customer debt filters distinguish positive, clear and malformed balances', () => {
  assert.equal(debt.anasCustomerDebtFilterMatches({ debt: 125.5 }, 'debt'), true);
  assert.equal(debt.anasCustomerDebtFilterMatches({ debt: 0 }, 'clear'), true);
  assert.equal(debt.anasCustomerDebtFilterMatches({ debt: 'bad' }, 'debt'), false);
  assert.equal(debt.anasCustomerDebtFilterMatches({ debt: 'bad' }, 'all'), true);
});
test('customer collection history is customer-isolated and includes valid receipts only', () => {
  const movements = [
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: 100, date: '2026-01-01T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'B', type: 'add', amount: 200, date: '2026-01-02T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'remove', amount: 50, date: '2026-01-03T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: -5, date: '2026-01-04T10:00:00Z' },
    { referenceType: 'cash_sale', referenceId: 'A', type: 'add', amount: 500, date: '2026-01-05T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: 75, date: '2026-01-06T10:00:00Z' }
  ];
  const selected = debt.anasGetCustomerDebtCollections('A', movements);
  assert.equal(selected.length, 2);
  assert.deepEqual(Array.from(selected, x => x.amount), [75, 100]);
});
test('customer collection history caps display to ten newest receipts', () => {
  assert.equal(debt.anasGetCustomerDebtCollections('A', null).length, 0);
  const movements = Array.from({ length: 12 }, (_, i) => ({
    referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: i + 1,
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString()
  }));
  const selected = debt.anasGetCustomerDebtCollections('A', movements);
  assert.equal(selected.length, 10);
  assert.equal(selected[0].amount, 12);
  assert.equal(selected[9].amount, 3);
});
test('customer collection renderer escapes untrusted labels', () => {
  const html = debt.anasRenderCustomerDebtCollections({ id: 'A' }, [
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: 50, date: '2026-01-01', userName: '<img src=x onerror=alert(1)>' }
  ]);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
});
