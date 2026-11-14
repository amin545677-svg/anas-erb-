'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildCashLedger } = require('../cashbox-readonly-ledger.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'cashbox-readonly-ledger.js'), 'utf8');

test('index.html loads the standalone read-only cashbox ledger module', () => {
  assert.match(html, /<script\b[^>]*src=["']\.\/?cashbox-readonly-ledger\.js["'][^>]*><\/script>/i);
  assert.equal(typeof buildCashLedger, 'function');
});

test('cash ledger returns centime totals and keeps malformed records visible', () => {
  const result = buildCashLedger([
    { id:'C1', type:'add', amount:10, description:'قبض' },
    { id:'C2', type:'subtract', amount:3, description:'صرف' },
    { id:'BAD', type:'unknown', amount:'x', description:'سجل غير صالح' }
  ]);
  assert.equal(result.total, 3);
  assert.equal(result.invalid, 1);
  assert.equal(result.incoming, 1000);
  assert.equal(result.outgoing, 300);
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows.find(row => !row.valid).description, 'سجل غير صالح');
});

test('cash ledger uses exact centimes and rejects over-precision instead of rounding', () => {
  const result = buildCashLedger([
    { id:'A', type:'add', amount:'0.10' },
    { id:'B', type:'add', amount:'0.20' },
    { id:'C', type:'subtract', amount:'0.10' },
    { id:'BAD-1', type:'add', amount:'1.005' },
    { id:'BAD-2', type:'add', amount:'1e2' },
    { id:'BAD-3', type:'add', amount:'0.001' }
  ]);
  assert.equal(result.incoming, 30);
  assert.equal(result.outgoing, 10);
  assert.equal(result.invalid, 3);
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows.filter(row => !row.valid).length, 3);
});

test('cash ledger filters by type and case-insensitive search without changing source data', () => {
  const movements = [
    { id:'C1', type:'add', amount:10, description:'قبض عميل' },
    { id:'C2', type:'subtract', amount:3, description:'مصاريف نقل' }
  ];
  const before = structuredClone(movements);
  const incoming = buildCashLedger(movements, 'عميل', 'add');
  assert.equal(incoming.rows.length, 1);
  assert.equal(incoming.rows[0].description, 'قبض عميل');
  assert.deepEqual(movements, before);
});

test('renderer is read-only and uses textContent for untrusted ledger fields', () => {
  assert.match(source, /root\.anasRenderCashLedger\s*=\s*renderCashLedgerUI/);
  assert.match(source, /td\.textContent\s*=\s*String\(v\)/);
  assert.doesNotMatch(source, /AppData\.cashMovements\s*=|AppData\.cashMovements\.push\(|AppData\.cashMovements\.splice\(/);
});

test('expected closing cash includes cash only and excludes non-cash collection channels', () => {
  const { expectedClosingCash } = require('../cashbox-readonly-ledger.js');
  const cashMovements = [
    { id:'CASH-1', type:'add', amount:'12.50', paymentChannel:'cash' },
    { id:'NONCASH-IN-CASH', type:'add', amount:'90.00', paymentChannel:'transfer', cashImpact:false },
    { id:'CASH-2', type:'subtract', amount:'2.00', paymentChannel:'cash' }
  ];
  const bankMovements = [
    { id:'BANK-1', type:'add', amount:'50.00', paymentChannel:'cheque', cashImpact:false },
    { id:'BANK-2', type:'add', amount:'20.00', paymentChannel:'card', cashImpact:false }
  ];
  assert.equal(expectedClosingCash('100.00', cashMovements, bankMovements), 11050);
});

test('cash ledger excludes legacy cheque and transfer entries even if they remain in cashMovements', () => {
  const result = buildCashLedger([
    { id:'CASH', type:'add', amount:12.5, paymentChannel:'cash', cashImpact:true },
    { id:'OLD-TRANSFER', type:'add', amount:90, paymentChannel:'transfer', cashImpact:false },
    { id:'OLD-CHEQUE', type:'add', amount:50, paymentChannel:'cheque', cashImpact:false }
  ]);
  assert.equal(result.total, 1);
  assert.equal(result.incoming, 1250);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].reference, '—');
});
