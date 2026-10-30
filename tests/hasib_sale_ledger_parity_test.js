const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function confirmHasibPayment()');
const end = html.indexOf('\n        function ', start + 20);
assert.ok(start >= 0 && end > start, 'confirmHasibPayment must be present and isolatable');
const source = html.slice(start, end);

function runSale({paid = 500.5, warehouse = 'المخزن الرئيسي', saveResult = true, cart, cashMovements = [], stockMovements = [], omitLedgers = false, customerDebt = 0, caisseBalance = 100} = {}) {
  const product = {id:'P-1', name:'Test product', stock:20, warehouseStock:{'فرع 1':12}};
  const customer = {id:'C-1', name:'Test customer', debt:customerDebt};
  const AppData = {
    products:[product], customers:[customer], invoices:[],
    caisseBalance, cashMovements:cashMovements.map(x=>({...x})), stockMovements:stockMovements.map(x=>({...x})), 
    currentUser:{id:'U-1',name:'Tester'}
  };
  if (omitLedgers) { delete AppData.cashMovements; delete AppData.stockMovements; }
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
  vm.runInContext(source + '\nconfirmHasibPayment();', context, {timeout:1000});
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
  assert.equal(r.AppData.cashMovements[0].type,'add','cash report contract must use the canonical add movement type');
  assert.equal(r.AppData.cashMovements[0].referenceType,'sales_invoice');
  assert.equal(r.AppData.cashMovements[0].referenceId,inv.id);
  assert.equal(r.AppData.stockMovements.length,1,'cash sale must create one stock ledger movement per aggregated product');
  assert.equal(r.AppData.stockMovements[0].qty,-2);
  assert.equal(r.AppData.stockMovements[0].type,'SALE_OUT');
  assert.equal(r.AppData.stockMovements[0].referenceType,'sales_invoice');
  assert.equal(r.AppData.stockMovements[0].type,'SALE_OUT','sale stock movements must use the canonical stock-out event type');
  assert.equal(r.AppData.stockMovements[0].referenceId,inv.id);
  console.log('PASS: full cash sale keeps invoice, cash ledger, stock ledger, and balances in parity');
}

{
  const r=runSale({
    cart:[{id:'P-1',name:'Test product',qty:3,price:0.1}],
    paid:0.3
  });
  assert.equal(r.AppData.invoices.length,1);
  assert.equal(r.AppData.invoices[0].total,0.3,'floating-point multiplication must normalize to the displayed currency total');
  assert.equal(r.AppData.invoices[0].paid,0.3);
  assert.equal(r.AppData.invoices[0].remaining,0,'a fully paid 0.30 invoice must not create a microscopic residual debt');
  assert.equal(r.customer.debt,0);
  assert.equal(r.AppData.cashMovements[0].amount,0.3);
  assert.equal(r.AppData.invoices[0].paymentMethod,'cash');
  console.log('PASS: 3 x 0.10 paid as 0.30 is normalized as fully paid with zero residual debt');
}

{
  const r=runSale({
    cart:[{id:'P-1',name:'Test product',qty:0.1,price:0.1}],
    paid:0.01
  });
  assert.equal(r.AppData.invoices[0].total,0.01);
  assert.equal(r.AppData.invoices[0].remaining,0);
  assert.equal(r.customer.debt,0);
  console.log('PASS: sub-unit fractional quantity is rounded to currency precision before settlement');
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

{
  const r=runSale({cart:[
    {id:'P-1',name:'Test product',qty:0.25,price:100.1},
    {id:'P-1',name:'Test product',qty:0.25,price:100.1}
  ],paid:50.05});
  assert.equal(r.AppData.invoices[0].total,50.05);
  assert.equal(r.AppData.stockMovements.length,1,'repeated cart lines must aggregate to one stock movement per product');
  assert.equal(r.AppData.stockMovements[0].qty,-0.5);
  assert.equal(r.AppData.cashMovements[0].amount,50.05);
  console.log('PASS: repeated fractional cart lines aggregate without losing decimal precision');
}

{
  const r=runSale({cashMovements:[{id:'DUP',amount:1},{id:'DUP',amount:2}]});
  assert.equal(r.saves,0,'duplicate cash movement IDs must block the sale before mutation');
  assert.equal(r.product.stock,20);
  assert.equal(r.AppData.caisseBalance,100);
  assert.equal(r.AppData.invoices.length,0);
  assert.equal(r.alerts.some(x=>x.includes('معرّفات مكررة')),true);
  console.log('PASS: ambiguous pre-existing cash ledger IDs block the sale before mutation');
}

{
  const r=runSale({stockMovements:[{id:'DUP',qty:-1},{id:'DUP',qty:-2}]});
  assert.equal(r.saves,0,'duplicate stock movement IDs must block the sale before mutation');
  assert.equal(r.product.stock,20);
  assert.equal(r.AppData.caisseBalance,100);
  assert.equal(r.AppData.invoices.length,0);
  assert.equal(r.alerts.some(x=>x.includes('معرّفات مكررة')),true);
  console.log('PASS: ambiguous pre-existing stock ledger IDs block the sale before mutation');
}

{
  const r=runSale({omitLedgers:true,saveResult:false});
  assert.equal(Object.prototype.hasOwnProperty.call(r.AppData,'cashMovements'),false,'failed sale must remove a newly created cash ledger property');
  assert.equal(Object.prototype.hasOwnProperty.call(r.AppData,'stockMovements'),false,'failed sale must remove a newly created stock ledger property');
  assert.equal(r.AppData.caisseBalance,100);
  assert.equal(r.product.stock,20);
  assert.equal(r.AppData.invoices.length,0);
  console.log('PASS: rollback removes ledgers that did not exist before the attempted sale');
}

{
  const r=runSale({
    cart:[{id:'P-1',name:'Test product',qty:3,price:0.1}],
    paid:0.1,
    customerDebt:0.1,
    caisseBalance:100.1
  });
  const inv=r.AppData.invoices[0];
  assert.equal(inv.total,0.3);
  assert.equal(inv.paid,0.1);
  assert.equal(inv.remaining,0.2);
  assert.equal(r.customer.debt,0.3,'customer debt accumulation must be normalized to currency precision');
  assert.equal(r.AppData.cashMovements[0].amount,0.1);
  assert.equal(r.AppData.caisseBalance,100.2,'cash balance accumulation must be normalized to currency precision');
  assert.equal(r.AppData.stockMovements[0].type,'SALE_OUT');
  assert.equal(r.AppData.stockMovements[0].referenceType,'sales_invoice');
  console.log('PASS: invoice, paid cash, stock-out reference, and cumulative customer debt remain in two-decimal parity');
}

console.log('ANAS ERP Hasib sale ledger differential parity tests passed');


{
  const r=runSale({
    cart:[{id:'P-1',name:'Test product',qty:3,price:0.1}],
    paid:0.1,
    customerDebt:0.1,
    caisseBalance:100.1
  });
  const cashUiStart=html.indexOf('function updateCashUI()');
  const cashUiEnd=html.indexOf('\n        function ',cashUiStart+20);
  assert.ok(cashUiStart>=0&&cashUiEnd>cashUiStart,'cash balance UI reader must be present and isolatable');
  const cashUiSource=html.slice(cashUiStart,cashUiEnd);
  const cashDisplay={innerText:''};
  const uiContext={AppData:r.AppData,document:{getElementById:id=>id==='cashCurrentBalanceDisplay'?cashDisplay:null}};
  vm.createContext(uiContext);
  vm.runInContext(cashUiSource+'\nupdateCashUI();',uiContext,{timeout:1000});
  assert.equal(Number(cashDisplay.innerText.replace(' د.ج','').replace(/,/g,'')),100.2,
    'cash balance display must reflect opening balance plus normalized sale receipt');
  assert.equal(r.AppData.cashMovements.filter(m=>m.referenceType==='sales_invoice'&&m.type==='add').reduce((sum,m)=>sum+m.amount,0),0.1,
    'cash ledger reader contract must include the sales receipt as an add movement');
  assert.equal(r.AppData.stockMovements.filter(m=>m.type==='SALE_OUT'&&m.referenceType==='sales_invoice').reduce((sum,m)=>sum+m.qty,0),-3,
    'stock ledger contract must preserve the invoice-linked negative sale quantity');
  assert.equal(r.customer.debt,0.3,'cumulative customer debt must match opening debt plus invoice remainder');
  console.log('PASS: integrated invoice/cash UI/cash ledger/stock ledger/customer debt parity');
}
