'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('index.html', 'utf8');

test('reportParseDate rejects impossible calendar dates and accepts valid leap dates', () => {
  const start = html.indexOf('function reportParseDate(value) {');
  const end = html.indexOf("\n        const ANAS_REPORT_RANGE_STORAGE_KEY", start);
  assert.ok(start >= 0 && end > start, 'strict report date parser must exist');
  const source = html.slice(start, end);
  const parseDate = vm.runInNewContext('(() => {' + source + '; return reportParseDate; })()');
  assert.equal(parseDate('2026-02-31'), null);
  assert.equal(parseDate('2026-04-31'), null);
  assert.ok(parseDate('2024-02-29') && Number.isFinite(parseDate('2024-02-29').getTime()));
  assert.ok(parseDate('2026-11-14') && Number.isFinite(parseDate('2026-11-14').getTime()));
});

test('product kardex gathers complete history before splitting opening and period movements', () => {
  const start = html.indexOf("} else if(title === 'تقرير بحركة منتج' || title === 'حركة منتج') {");
  const end = html.indexOf("} else if(title === 'جرد مخزني')", start);
  assert.ok(start >= 0 && end > start, 'product movement report must exist');
  const block = html.slice(start, end);
  for (const source of [
    'AppData.stockMovements', 'AppData.inventoryMovements', 'AppData.purchases',
    'AppData.invoices', 'AppData.returns', 'AppData.warehouseTransfers',
    'AppData.stockAdjustments'
  ]) assert.ok(block.includes(source), source + ' must feed the kardex');
  assert.ok(!/AppData\.(?:purchases|invoices|returns|warehouseTransfers|transfers|stockAdjustments|damagedStock)[^;]*?\.filter\([^)]*reportItemInRange/.test(block),
    'historical source rows must not be range-filtered before opening-balance calculation');
  assert.match(block, /const before=all\.filter/);
  assert.match(block, /let balance=before\.reduce/);
  assert.match(block, /const current=all\.filter/);
});
