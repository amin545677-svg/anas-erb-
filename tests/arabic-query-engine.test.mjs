import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scriptTag = /<script\b[^>]*src=["']\.\/?arabic-query-engine\.js["'][^>]*><\/script>/i;
assert.match(html, scriptTag, 'index.html must load the standalone Arabic query engine');
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
test('invoice history search is connected to the shared multi-field query engine', () => {
  assert.match(html, /id="invoiceListSearch"[^>]+oninput="renderInvoicesList\(\)"/);
  assert.match(html, /filteredInvoices = invoices\.filter\(inv => inv && anasQueryMatches\(/);
});
test('report, customer and supplier screens use shared Arabic-aware matching', () => {
  assert.match(html, /function anasFilterCurrentReport\(query\)/);
  assert.match(html, /id="customerDebtSearch"/);
  assert.match(html, /id="supplierDebtSearch"/);
  assert.match(html, /anasQueryMatches\(/);
});
