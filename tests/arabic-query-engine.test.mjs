import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /<script\b[^>]*src=["']\.\/?arabic-query-engine\.js["'][^>]*><\/script>/i,
  'index.html must load the standalone Arabic query engine');
const { anasNormalizeQueryText, anasQueryMatches, anasQueryScore } = require('../arabic-query-engine.js');

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
test('customer directory calls the standalone Arabic normalization and matching exports', () => {
  assert.match(html, /customerDirectorySearch/);
  assert.match(html, /window\.anasNormalizeQueryText\(/);
  assert.match(html, /window\.anasQueryMatches\(/);
});
test('standalone module is loaded after the main application scripts', () => {
  assert.ok(html.indexOf('id="app"') < html.indexOf('arabic-query-engine.js'));
});

const customerDebtMatch = html.match(/        function anasCustomerDebtForSave\([\s\S]*?(?=        function saveNewCustomerMpos)/);
assert.ok(customerDebtMatch, 'customer debt preservation helper must exist');
const customerDebtContext = {};
vm.runInNewContext(customerDebtMatch[0] + '\\nthis.resolve = anasCustomerDebtForSave;', customerDebtContext);
const anasCustomerDebtForSave = customerDebtContext.resolve;
test('customer profile edits preserve stored debt and new customers accept opening debt', () => {
  assert.equal(anasCustomerDebtForSave(true, { debt: 8400 }, 0), 8400);
  assert.equal(anasCustomerDebtForSave(true, { debt: 8400 }, 999999), 8400);
  assert.equal(anasCustomerDebtForSave(true, {}, 999999), 0);
  assert.equal(anasCustomerDebtForSave(false, null, 1250), 1250);
});

const debtFilterMatch = html.match(/        function anasCustomerDebtFilterMatches\([\s\S]*?(?=        function setCustomerDirectoryDebtFilter)/);
assert.ok(debtFilterMatch, 'customer debt filter helper must exist');
const debtFilterContext = {};
vm.runInNewContext(debtFilterMatch[0] + '\\nthis.match = anasCustomerDebtFilterMatches;', debtFilterContext);
const anasCustomerDebtFilterMatches = debtFilterContext.match;
test('customer debt filters distinguish positive, clear and malformed balances', () => {
  assert.equal(anasCustomerDebtFilterMatches({ debt: 125.5 }, 'debt'), true);
  assert.equal(anasCustomerDebtFilterMatches({ debt: 0 }, 'clear'), true);
  assert.equal(anasCustomerDebtFilterMatches({ debt: 'bad' }, 'debt'), false);
  assert.equal(anasCustomerDebtFilterMatches({ debt: 'bad' }, 'all'), true);
});

const collectionsMatch = html.match(/        function anasGetCustomerDebtCollections\([\s\S]*?(?=        function anasRenderCustomerDebtCollections)/);
assert.ok(collectionsMatch, 'customer collection history selector must exist');
const collectionsContext = {};
vm.runInNewContext(collectionsMatch[0] + '\\nthis.select = anasGetCustomerDebtCollections;', collectionsContext);
const anasGetCustomerDebtCollections = collectionsContext.select;
test('customer collection history is isolated and includes valid receipts only', () => {
  const movements = [
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: 100, date: '2026-01-01T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'B', type: 'add', amount: 200, date: '2026-01-02T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'remove', amount: 50, date: '2026-01-03T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: -5, date: '2026-01-04T10:00:00Z' },
    { referenceType: 'cash_sale', referenceId: 'A', type: 'add', amount: 500, date: '2026-01-05T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: 75, date: '2026-01-06T10:00:00Z' }
  ];
  const selected = anasGetCustomerDebtCollections('A', movements);
  assert.equal(selected.length, 2);
  assert.deepEqual(Array.from(selected, x => x.amount), [75, 100]);
});
test('customer collection history caps display to ten newest records', () => {
  assert.equal(anasGetCustomerDebtCollections('A', null).length, 0);
  const movements = Array.from({ length: 12 }, (_, i) => ({
    referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: i + 1,
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString()
  }));
  const selected = anasGetCustomerDebtCollections('A', movements);
  assert.equal(selected.length, 10);
  assert.equal(selected[0].amount, 12);
  assert.equal(selected[9].amount, 3);
});
