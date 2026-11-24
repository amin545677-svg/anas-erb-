'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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


test('daily cash closing reconciles the exact centime balance chain and cash-only movements',()=>{
 const {buildDailyCashClosing}=require('../cashbox-readonly-ledger.js'),day='2026-11-24';
 const rows=[
  {id:'DAY-IN',type:'add',amount:'12.50',date:day+'T09:00:00.000Z',balanceBeforeCentimes:10000,balanceAfterCentimes:11250},
  {id:'DAY-OUT',type:'subtract',amount:'2.00',date:day+'T10:00:00.000Z',balanceBeforeCentimes:11250,balanceAfterCentimes:11050},
  {id:'BANK-IN',type:'add',amount:'90.00',date:day+'T11:00:00.000Z',paymentChannel:'transfer',cashImpact:false}
 ];
 const result=buildDailyCashClosing(rows,day,'110.50');
 assert.equal(result.openingBalanceCentimes,10000);assert.equal(result.incomingCentimes,1250);assert.equal(result.outgoingCentimes,200);
 assert.equal(result.expectedClosingCentimes,11050);assert.equal(result.actualClosingCentimes,11050);assert.equal(result.varianceCentimes,0);
 assert.equal(result.matches,true);assert.equal(result.movementCount,2);
 const mismatch=buildDailyCashClosing(rows,day,'110.49');assert.equal(mismatch.matches,false);assert.equal(mismatch.varianceCentimes,-1);
 assert.throws(()=>buildDailyCashClosing([...rows,{...rows[0]}],day,'110.50'),/مكرر/);
 const broken=rows.map(x=>({...x}));broken[1].balanceBeforeCentimes=11249;
 assert.throws(()=>buildDailyCashClosing(broken,day,'110.50'),/تسلسل/);
});
test('cash operation retry reuses one idempotency key and daily Z close reconciles',async()=>{
 const fields={
  cashAmountInput:{value:'12.50',listeners:{},addEventListener(n,fn){this.listeners[n]=fn;},focus(){}},
  cashDescInput:{value:'تحصيل اختبار',listeners:{},addEventListener(n,fn){this.listeners[n]=fn;}},
  optAddCash:{classList:{contains:()=>true},addEventListener(){}},
  optSubtractCash:{classList:{contains:()=>false},addEventListener(){}}
 };
 const store=new Map(),localStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
 const ctx={AppData:{caisseBalance:100,cashMovements:[],auditTrail:[],currentUser:{id:'U1',name:'Tester'}},
  document:{getElementById:id=>fields[id]||null,querySelector:()=>null},localStorage,alert(){},updateCashUI(){},
  anasToCents:v=>Math.round(Number(v)*100),anasCentsToCurrency:v=>v/100,saveDB:()=>true,saveDBDurably:async()=>true,
  anasAppendAuditTrailEvent:event=>ctx.AppData.auditTrail.push(event),console:{error(){}}};
 ctx.window=ctx;
 const start=html.indexOf('async function submitCashOperation()'),end=html.indexOf('async function submitExpenseOperation()',start);
 assert.ok(start>=0&&end>start);
 vm.runInNewContext(html.slice(start,end)+'\nthis.submitCashOperation=submitCashOperation;',ctx);
 vm.runInNewContext(source,ctx);
 await ctx.submitCashOperation();
 const firstKey=ctx.AppData.cashMovements[0].idempotencyKey;
 await ctx.submitCashOperation();
 assert.equal(ctx.AppData.cashMovements.length,1);
 assert.equal(ctx.AppData.cashMovements[0].idempotencyKey,firstKey);
 fields.cashAmountInput.listeners.input();fields.cashAmountInput.value='13.00';
 await ctx.submitCashOperation();
 assert.equal(ctx.AppData.cashMovements.length,2);
 assert.notEqual(ctx.AppData.cashMovements[1].idempotencyKey,firstKey);
 const day=new Date().toISOString().slice(0,10);
 assert.equal(ctx.anasBuildCashDailyClosing(ctx.AppData.cashMovements,day,ctx.AppData.caisseBalance).matches,true);
});
test('Z-report consumes daily cash reconciliation and persists the idempotency key',()=>{
 assert.match(html,/anasBuildCashDailyClosing\(AppData\.cashMovements/);assert.match(html,/مطابقة حركات الصندوق ليوم/);
 assert.match(html,/idempotencyKey: cashIdempotencyKey/);assert.match(html,/balanceBeforeCentimes: previousBalanceCents/);
 assert.match(html,/balanceAfterCentimes: nextBalanceCents/);
 assert.match(html,/existingCashOperation = \(Array\.isArray\(AppData\.cashMovements\) \? AppData\.cashMovements : \[\]\)\.find/);
 assert.match(source,/ANAS_CASH_OPERATION_REQUEST_V1/);assert.match(source,/__ANAS_CASH_OPERATION_IDEMPOTENCY_KEY__/);
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
