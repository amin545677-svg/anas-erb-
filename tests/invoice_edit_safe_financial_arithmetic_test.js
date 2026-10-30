const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const helperStart = html.indexOf('const ANAS_QTY_SCALE = 1000000;');
const helperEnd = html.indexOf('function updatePaymentMethodFromAmount()', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'integer stock quantity helpers must be present and isolatable');
const helperSource = html.slice(helperStart, helperEnd);
const start = html.indexOf('function editSalesInvoice(invoiceId) {');
const end = html.indexOf('// ================= إدارة المخزون وحساب الأرباح =================', start);
assert.ok(start >= 0 && end > start, 'editSalesInvoice must be present and isolatable');
const source = helperSource + html.slice(start, end);

function run({qty = '2', price = '10', total = 10, paid = 0, remaining = 10, customerDebt = 0} = {}) {
  const invoice = {id:'INV-SAFE-1', items:[{id:'P1', name:'Test', qty:1, price:10}], total, paid, remaining, customer:'Customer'};
  const product = {id:'P1', name:'Test', stock:10, warehouseStock:{}};
  const customer = {id:'C1', name:'Customer', debt:customerDebt};
  const data = {invoices:[invoice], products:[product], customers:[customer], stockMovements:[]};
  const answers = [qty, price];
  const alerts = [];
  let saves = 0, confirmations = 0;
  const ctx = {
    AppData:data, prompt:()=>answers.shift(), confirm:()=>{confirmations++;return true;},
    alert:m=>alerts.push(String(m)), saveDB:()=>{saves++;return true;},
    renderInvoicesList(){}, renderInventoryList(){},
    wtAvailableStock:(p, warehouse)=>warehouse==='المخزن الرئيسي'?p.stock:(p.warehouseStock?.[warehouse]??0),
    console, Number, String, Object, Array, Map, Set, Math, Date
  };
  vm.createContext(ctx);
  vm.runInContext(source + '\neditSalesInvoice("INV-SAFE-1");', ctx);
  return {data,invoice,product,customer,alerts,saves,confirmations};
}

{
  const r = run({qty:'1', price:String(Number.MAX_SAFE_INTEGER + 2), total:10, remaining:10});
  assert.equal(r.saves,0,'unsafe computed invoice total must not be persisted');
  assert.equal(r.product.stock,10,'unsafe invoice total must not mutate stock');
  assert.equal(r.invoice.total,10,'unsafe invoice total must not mutate invoice');
  assert.ok(r.alerts.some(x=>x.includes('المجال المالي الآمن')));
}
{
  const r = run({qty:'2', price:'10', total:10, remaining:10, customerDebt:Number.MAX_SAFE_INTEGER - 5});
  assert.equal(r.saves,0,'customer debt overflow must not be persisted');
  assert.equal(r.confirmations,0,'customer debt overflow must be rejected before confirmation');
  assert.equal(r.product.stock,10,'customer debt overflow must not mutate stock');
  assert.equal(r.invoice.total,10,'customer debt overflow must not mutate invoice');
  assert.equal(r.customer.debt,Number.MAX_SAFE_INTEGER - 5,'customer debt must remain unchanged');
  assert.ok(r.alerts.some(x=>x.includes('تسوية دين العميل')));
}
{
  const r = run({qty:'2', price:'10', total:Number.MAX_SAFE_INTEGER + 2, remaining:Number.MAX_SAFE_INTEGER + 2});
  assert.equal(r.saves,0,'unsafe historical invoice balances must be rejected');
  assert.equal(r.product.stock,10,'unsafe historical balances must not mutate stock');
  assert.equal(r.invoice.total,Number.MAX_SAFE_INTEGER + 2,'historical invoice must remain unchanged');
  assert.ok(r.alerts.some(x=>x.includes('غير متطابقة') || x.includes('المجال المالي الآمن')));
}
{
  const r = run({qty:'7', price:'0.1', total:0.7, paid:0.3, remaining:0.4, customerDebt:0.4});
  assert.equal(r.saves,1);
  assert.equal(r.invoice.total,0.7,'invoice edit must store the exact 0.70 total for 7 x 0.10');
  assert.equal(r.invoice.paid,0.3);
  assert.equal(r.invoice.remaining,0.4,'invoice remaining must remain exact to the centime');
  assert.equal(r.customer.debt,0.4,'customer debt must remain aligned with invoice remaining');
  assert.equal(r.invoice.items[0].total,0.7,'edited invoice line must persist its authoritative centime total');
}
{
  const r = run({qty:'1', price:'10', total:0.3, paid:0.1, remaining:0.194, customerDebt:0.194});
  assert.equal(r.saves,0,'a historical invoice with even a sub-dinar centime mismatch must be rejected');
  assert.equal(r.confirmations,0,'exact invoice identity must be checked before confirmation');
  assert.equal(r.invoice.total,0.3,'invalid historical invoice must remain unchanged');
  assert.ok(r.alerts.some(x=>x.includes('غير متطابقة')));
}
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(helperSource + `
    globalThis.__centimeCases = [
      anasToCents('1.005'),
      anasToCents('0.10'),
      anasToQtyUnits('0.000001'),
      anasLineTotalCents(3, 10),
      anasCartTotalCents([{qty:'7',price:'0.10'}])
    ];
  `, ctx);
  assert.deepEqual(Array.from(ctx.__centimeCases), [101,10,1,30,70],
    'decimal strings and line/cart totals must resolve through exact integer base units');
}
console.log('Invoice edit safe financial arithmetic tests passed');
