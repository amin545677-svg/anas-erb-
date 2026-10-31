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

test('invoice history search is connected to the shared multi-field query engine', () => {
  assert.match(html, /id="invoiceListSearch"[^>]+oninput="renderInvoicesList\(\)"/);
  assert.match(html, /filteredInvoices = invoices\.filter\(inv => inv && anasQueryMatches\(/);
  assert.match(html, /inv\.id, inv\.customer, inv\.date, inv\.createdAt, inv\.invoiceDate, inv\.total/);
});

test('report table and report-entry filtering use Arabic-aware all-token matching', () => {
  assert.match(html, /function anasFilterCurrentReport\(query\)[\s\S]*?const q = anasNormalizeQueryText\(query \|\| ''\)/);
  assert.match(html, /anasQueryMatches\(\[row\.textContent \|\| ''\], q\)/);
  assert.match(html, /anasQueryMatches\(\[node\.textContent \|\| ''\], q\)/);
});

test('quick-sale exact barcode auto-add normalizes Arabic and Persian digits', () => {
  assert.match(html, /anasNormalizeQueryText\(list\[0\]\.barcode\|\|'\'\)===q/);
});
