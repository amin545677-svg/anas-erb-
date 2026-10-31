'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('cash view exposes a read-only movement ledger with explicit scope', () => {
  assert.match(html, /id="anasCashLedgerRows"/);
  assert.match(html, /id="anasCashLedgerSummary"/);
  assert.match(html, /id="anasCashLedgerSearch"/);
  assert.match(html, /id="anasCashLedgerType"/);
  assert.match(html, /يعرض هذا الجدول السجلات الموجودة فعلياً في cashMovements فقط/);
  assert.match(html, /لا يتم تعديل أي حركة من هذه الشاشة/);
});

test('cash ledger renderer preserves invalid records as visible audit exceptions', () => {
  const start = html.indexOf('function anasRenderCashLedger()');
  assert.notEqual(start, -1, 'renderer must exist');
  const end = html.indexOf('\n        function selectCashOp', start);
  assert.ok(end > start, 'renderer boundary must be present');
  const renderer = html.slice(start, end);
  assert.match(renderer, /Array\.isArray\(AppData\.cashMovements\)/);
  assert.match(renderer, /Number\.isSafeInteger\(cents\)/);
  assert.match(renderer, /invalidCount/);
  assert.match(renderer, /سجل غير صالح/);
  assert.match(renderer, /لا يتم/);
  assert.doesNotMatch(renderer, /AppData\.cashMovements\s*=|\.push\(|\.splice\(|\.pop\(/,
    'read-only renderer must not mutate the financial ledger');
});

test('cash ledger safely escapes untrusted ledger text before HTML rendering', () => {
  assert.match(html, /function anasCashLedgerEscape\(value\)/);
  assert.match(html, /'&': '&amp;'/);
  assert.match(html, /'<': '&lt;'/);
  assert.match(html, /'\\\"': '&quot;'/);
  assert.match(html, /anasCashLedgerEscape\(row\.description\)/);
  assert.match(html, /anasCashLedgerEscape\(row\.user\)/);
  assert.match(html, /anasCashLedgerEscape\(row\.reference\)/);
});

test('cash balance refresh also refreshes the read-only ledger', () => {
  const start = html.indexOf('function updateCashUI()');
  const end = html.indexOf('\n        function anasCashLedgerEscape', start);
  assert.ok(start >= 0 && end > start);
  assert.match(html.slice(start, end), /anasRenderCashLedger\(\)/);
});
