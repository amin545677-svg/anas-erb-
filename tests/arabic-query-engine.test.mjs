import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

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
