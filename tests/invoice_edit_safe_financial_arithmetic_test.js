const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function editSalesInvoice(invoiceId) {');
const end = html.indexOf('// ================= إدارة المخزون وحساب الأرباح =================', start);
assert.ok(start >= 0 && end > start, 'editSalesInvoice must be present and isolatable');
const source = html.slice(start, end);

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
console.log('Invoice edit safe financial arithmetic tests passed');
