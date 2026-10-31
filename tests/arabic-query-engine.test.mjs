import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const match = html.match(/        \/\/ محرك استعلام موحد[\s\S]*?(?=        \/\/ بحث البيع:)/);
assert.ok(match, 'shared query engine must exist in index.html');
const context = {};
vm.runInNewContext(match[0] + '\nthis.api = { anasNormalizeQueryText, anasQueryMatches, anasQueryScore };', context);
const { anasNormalizeQueryText, anasQueryMatches, anasQueryScore } = context.api;

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


const customerFilterMatch = html.match(/        function anasCustomerDebtFilterMatches\([\s\S]*?(?=        function setCustomerDirectoryDebtFilter)/);
assert.ok(customerFilterMatch, 'customer debt filter helper must exist');
const customerFilterContext = {};
vm.runInNewContext(customerFilterMatch[0] + '\nthis.match = anasCustomerDebtFilterMatches;', customerFilterContext);
const anasCustomerDebtFilterMatches = customerFilterContext.match;

test('customer debt filter separates positive debt from zero balance', () => {
  assert.equal(anasCustomerDebtFilterMatches({ debt: 125.5 }, 'debt'), true);
  assert.equal(anasCustomerDebtFilterMatches({ debt: 0 }, 'clear'), true);
  assert.equal(anasCustomerDebtFilterMatches({ debt: 0 }, 'debt'), false);
  assert.equal(anasCustomerDebtFilterMatches({ debt: 125.5 }, 'clear'), false);
});

test('customer debt filter handles legacy empty balances and fails closed on malformed balances', () => {
  assert.equal(anasCustomerDebtFilterMatches({}, 'clear'), true);
  assert.equal(anasCustomerDebtFilterMatches({ debt: '' }, 'clear'), true);
  assert.equal(anasCustomerDebtFilterMatches({ debt: 'not-a-number' }, 'all'), true);
  assert.equal(anasCustomerDebtFilterMatches({ debt: 'not-a-number' }, 'debt'), false);
  assert.equal(anasCustomerDebtFilterMatches({ debt: -1 }, 'clear'), false);
});


const debtSaveMatch = html.match(/        function anasCustomerDebtForSave\([\s\S]*?(?=        function saveNewCustomerMpos)/);
assert.ok(debtSaveMatch, 'customer debt preservation helper must exist');
const debtSaveContext = {};
vm.runInNewContext(debtSaveMatch[0] + '\nthis.resolve = anasCustomerDebtForSave;', debtSaveContext);
const anasCustomerDebtForSave = debtSaveContext.resolve;

test('editing a customer profile preserves the stored debt instead of accepting edited form input', () => {
  assert.equal(anasCustomerDebtForSave(true, { debt: 8400 }, 0), 8400);
  assert.equal(anasCustomerDebtForSave(true, { debt: 8400 }, 999999), 8400);
  assert.equal(anasCustomerDebtForSave(true, {}, 999999), 0);
});

test('creating a customer keeps the explicitly supplied opening debt', () => {
  assert.equal(anasCustomerDebtForSave(false, null, 1250), 1250);
  assert.equal(anasCustomerDebtForSave(false, null, 0), 0);
});


const collectionsMatch = html.match(/        function anasGetCustomerDebtCollections\([\s\S]*?(?=        function anasRenderCustomerDebtCollections)/);
assert.ok(collectionsMatch, 'read-only customer collection history selector must exist');
const collectionsContext = {};
vm.runInNewContext(collectionsMatch[0] + '\nthis.select = anasGetCustomerDebtCollections;', collectionsContext);
const anasGetCustomerDebtCollections = collectionsContext.select;

test('customer collection history is isolated by customer and includes valid debt receipts only', () => {
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

test('customer collection history rejects invalid input and caps display to ten newest records', () => {
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
