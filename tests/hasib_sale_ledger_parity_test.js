const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function confirmHasibPayment()');
const end = html.indexOf('\n        function ', start + 20);
assert.ok(start >= 0 && end > start, 'confirmHasibPayment must be present and isolatable');
const source = html.slice(start, end);

function runSale({paid = 500.5, warehouse = 'المخزن الرئيسي', saveResult = true, cart} = {}) {
  const product = {id:'P-1', name:'Test product', stock:20, warehouseStock:{'فرع 1':12}};
  const customer = {id:'C-1', name:'Test customer', debt:0};
  const AppData = {
    products:[product], customers:[customer], invoices:[],
    caisseBalance:100, cashMovements:[], stockMovements:[],
    currentUser:{id:'U-1',name:'Tester'}
  };
  const posCart = cart || [{id:'P-1',name:'Test product',qty:2,price:250.25}];
  const alerts = [];
  let saves = 0, renders = 0, closes = 0;
  const elements = {
    hasibCustomerSelect:{value:'C-1'},
    hasibPaidAmount:{value:String(paid)}
  };
  const context = {
    AppData, posCart, lastConfirmedInvoice:null,
    document:{getElementById:id=>elements[id] || null},
    wtTryEnsureData:()=>true,
    wtCurrentSaleWarehouse:()=>warehouse,
    wtAvailableStock:(p,w)=>w==='المخزن الرئيسي'?p.stock:(p.warehouseStock?.[w]??0),
    saveDB:()=>{saves++;return saveResult;},
    renderPosTable:()=>{renders++;},
    closeModal:()=>{closes++;},
    alert:m=>alerts.push(String(m)),
    console,
    Date, Math, Number, String, Object, Array, Map, Set
  };
  vm.createContext(context);
  vm.runInContext(source + '\\nconfirmHasibPayment();', context, {timeout:1000});
  return {AppData,product,customer,alerts,saves,renders,closes,posCart:context.posCart,lastInvoice:context.lastConfirmedInvoice};
}

{
  const r=runSale({paid:500.5});
  assert.equal(r.saves,1);
  assert.equal(r.product.stock,18);
  assert.equal(r.AppData.caisseBalance,600.5);
  assert.equal(r.AppData.invoices.length,1);
  const inv=r.AppData.invoices[0];
  assert.equal(inv.total,500.5);
  assert.equal(inv.paid,500.5);
  assert.equal(r.AppData.cashMovements.length,1,'cash sale must create exactly one independent cash ledger movement');
  assert.equal(r.AppData.cashMovements[0].amount,500.5);
  assert.equal(r.AppData.cashMovements[0].referenceType,'sales_invoice');
  assert.equal(r.AppData.cashMovements[0].referenceId,inv.id);
  assert.equal(r.AppData.stockMovements.length,1,'cash sale must create one stock ledger movement per aggregated product');
  assert.equal(r.AppData.stockMovements[0].qty,-2);
  assert.equal(r.AppData.stockMovements[0].referenceType,'sales_invoice');
  assert.equal(r.AppData.stockMovements[0].referenceId,inv.id);
  console.log('PASS: full cash sale keeps invoice, cash ledger, stock ledger, and balances in parity');
}

{
  const r=runSale({paid:200.5});
  assert.equal(r.AppData.caisseBalance,300.5);
  assert.equal(r.customer.debt,300);
  assert.equal(r.AppData.cashMovements.length,1);
  assert.equal(r.AppData.cashMovements[0].amount,200.5);
  assert.equal(r.AppData.invoices[0].remaining,300);
  assert.equal(r.AppData.stockMovements.length,1);
  console.log('PASS: partial sale records only collected cash while preserving remaining customer debt');
}

{
  const r=runSale({paid:0});
  assert.equal(r.AppData.caisseBalance,100);
  assert.equal(r.customer.debt,500.5);
  assert.equal(r.AppData.cashMovements.length,0,'credit sale must not create a cash receipt');
  assert.equal(r.AppData.stockMovements.length,1);
  console.log('PASS: credit sale records stock movement without inventing a cash movement');
}

{
  const r=runSale({paid:500.5,warehouse:'فرع 1'});
  assert.equal(r.product.warehouseStock['فرع 1'],10);
  assert.equal(r.product.stock,20);
  assert.equal(r.AppData.stockMovements[0].warehouse,'فرع 1');
  assert.equal(r.AppData.stockMovements[0].qty,-2);
  console.log('PASS: sale stock ledger records the exact originating warehouse');
}

{
  const r=runSale({paid:500.5,saveResult:false});
  assert.equal(r.saves,1);
  assert.equal(r.product.stock,20);
  assert.equal(r.AppData.caisseBalance,100);
  assert.equal(r.customer.debt,0);
  assert.equal(r.AppData.invoices.length,0);
  assert.equal(r.AppData.cashMovements.length,0);
  assert.equal(r.AppData.stockMovements.length,0);
  assert.equal(r.posCart.length,1);
  assert.equal(r.alerts.some(x=>x.includes('فشل')),true);
  console.log('PASS: failed save rolls back invoice, both ledgers, balances, stock, and cart');
}

console.log('ANAS ERP Hasib sale ledger differential parity tests passed');
