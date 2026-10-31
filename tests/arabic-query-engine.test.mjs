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
