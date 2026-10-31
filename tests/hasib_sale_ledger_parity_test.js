const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const helperStart = html.indexOf('const ANAS_QTY_SCALE = 1000000;');
const helperEnd = html.indexOf('function updatePaymentMethodFromAmount()', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'integer currency/quantity helpers must be present and isolatable');
const helperSource = html.slice(helperStart, helperEnd);
const start = html.indexOf('function confirmHasibPayment()');
const end = html.indexOf('\n        function printLastConfirmedInvoice(type)', start + 20);
assert.ok(start >= 0 && end > start, 'confirmHasibPayment must be present and isolatable');
const source = helperSource + html.slice(start, end);

function runSale({paid = 500.5, warehouse = 'المخزن الرئيسي', saveResult = true, cart, cashMovements = [], stockMovements = [], omitLedgers = false, customerDebt = 0, caisseBalance = 100, productStock = 20, doubleConfirm = false} = {}) {
  const product = {id:'P-1', name:'Test product', stock:productStock, warehouseStock:{'فرع 1':12}};
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
    ANASReverseLedger: require('../reverse-ledger/reverse-ledger.js'),
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
  if (doubleConfirm) vm.runInContext('confirmHasibPayment();', context, {timeout:1000});
  return {AppData,product,customer,alerts,saves,renders,closes,posCart:context.posCart,lastInvoice:context.lastConfirmedInvoice,context};
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
  assert.equal(r.AppData.invoices[0].total,50.06);
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
  vm.runInContext(helperSource+'\n'+cashUiSource+'\nupdateCashUI();',uiContext,{timeout:1000});
  assert.equal(Number(cashDisplay.innerText.replace(' د.ج','').replace(/,/g,'')),100.2,
    'cash balance display must reflect opening balance plus normalized sale receipt');
  assert.equal(r.AppData.cashMovements.filter(m=>m.referenceType==='sales_invoice'&&m.type==='add').reduce((sum,m)=>sum+m.amount,0),0.1,
    'cash ledger reader contract must include the sales receipt as an add movement');
  assert.equal(r.AppData.stockMovements.filter(m=>m.type==='SALE_OUT'&&m.referenceType==='sales_invoice').reduce((sum,m)=>sum+m.qty,0),-3,
    'stock ledger contract must preserve the invoice-linked negative sale quantity');
  assert.equal(r.customer.debt,0.3,'cumulative customer debt must match opening debt plus invoice remainder');
  console.log('PASS: integrated invoice/cash UI/cash ledger/stock ledger/customer debt parity');
}


// Integer-centime stress matrix: all identity checks are exact integer equalities.
function assertAccountingIdentity(result, openingDebt = 0) {
  const invoice = result.AppData.invoices[0];
  const invoiceCents = Math.round(invoice.total * 100);
  const cashCents = result.AppData.cashMovements
    .filter(m => m.referenceType === 'sales_invoice' && m.referenceId === invoice.id && m.type === 'add')
    .reduce((sum, m) => sum + Math.round(m.amount * 100), 0);
  const debtDeltaCents = Math.round(result.customer.debt * 100) - Math.round(openingDebt * 100);
  assert.equal(invoiceCents, cashCents + debtDeltaCents,
    'invoice cents must equal linked cash inflow cents plus the exact customer-debt delta');
  assert.equal(Math.round(invoice.paid * 100), cashCents,
    'invoice paid cents must equal its linked cash movement cents');
  assert.equal(Math.round(invoice.remaining * 100), debtDeltaCents,
    'invoice remaining cents must equal the exact customer-debt delta');
}

{
  const r=runSale({cart:[{id:'P-1',name:'Test product',qty:7,price:0.1}],paid:0.7});
  assert.equal(r.AppData.invoices[0].total,0.7);
  assert.equal(r.AppData.invoices[0].paid,0.7);
  assert.equal(r.AppData.invoices[0].remaining,0);
  assert.equal(r.customer.debt,0);
  assertAccountingIdentity(r);
  console.log('PASS: 7 x 0.10 settles as exactly 0.70 with no phantom debt');
}

{
  const r=runSale({cart:[{id:'P-1',name:'Test product',qty:0.1,price:0.2}],paid:0.02});
  assert.equal(r.AppData.invoices[0].total,0.02);
  assert.equal(r.AppData.invoices[0].paid,0.02);
  assert.equal(r.AppData.invoices[0].remaining,0);
  assert.equal(r.customer.debt,0);
  assertAccountingIdentity(r);
  console.log('PASS: 0.1 x 0.2 settles as exactly 0.02');
}

{
  const r=runSale({cart:[{id:'P-1',name:'Test product',qty:0.1,price:0.2}],paid:0.01,customerDebt:0.03,caisseBalance:100.09});
  assert.equal(r.AppData.invoices[0].total,0.02);
  assert.equal(r.AppData.invoices[0].paid,0.01);
  assert.equal(r.AppData.invoices[0].remaining,0.01);
  assert.equal(r.customer.debt,0.04);
  assert.equal(r.AppData.cashMovements[0].amount,0.01);
  assert.equal(r.AppData.caisseBalance,100.10);
  assertAccountingIdentity(r,0.03);
  console.log('PASS: 0.1 x 0.2 partial settlement preserves exact 0.01 cash and 0.01 debt');
}

{
  const r=runSale({cart:[{id:'P-1',name:'Test product',qty:0.1,price:1}],paid:0.1,productStock:0.8});
  assert.equal(r.product.stock,0.7,'stock subtraction must be stored at six-decimal quantity precision');
  assert.equal(r.AppData.stockMovements[0].qty,-0.1);
  assert.equal(r.context.anasRoundQty(0.8-0.1),0.7);
  console.log('PASS: fractional stock arithmetic stores 0.700000 exactly, not a binary drift residue');
}

{
  const r=runSale({cart:[{id:'P-1',name:'Test product',qty:3,price:0.1}],paid:0.3,doubleConfirm:true});
  assert.equal(r.AppData.invoices.length,1,'a second confirmation after commit must be a no-op');
  assert.equal(r.AppData.cashMovements.length,1,'double confirmation must not duplicate SALE-CASH');
  assert.equal(r.AppData.stockMovements.length,1,'double confirmation must not duplicate SALE-STOCK');
  assert.equal(r.product.stock,17,'double confirmation must not deduct stock twice');
  assert.equal(r.saves,1,'second confirmation must not persist another sale');
  console.log('PASS: sequential double-confirmation cannot duplicate invoice, cash, or stock movements');
}

{
  const r=runSale({cart:[{id:'P-1',name:'Test product',qty:3,price:0.1}],paid:0.1,customerDebt:0.1,caisseBalance:100.1});
  const cashDisplay={innerText:''};
  const readerContext={
    AppData:r.AppData, cashDisplay,
    document:{getElementById:id=>id==='cashCurrentBalanceDisplay'?cashDisplay:null}
  };
  vm.createContext(readerContext);
  const cashStart=html.indexOf('function updateCashUI()');
  const cashEnd=html.indexOf('\n        function ',cashStart+20);
  const zStart=html.indexOf('function anasGetZReportTotal(');
  const zEnd=html.indexOf('\n        function ',zStart+20);
  assert.ok(cashStart>=0&&cashEnd>cashStart,'actual cash UI reader must be extractable');
  assert.ok(zStart>=0&&zEnd>zStart,'actual Z-report invoice aggregator must be extractable');
  vm.runInContext(helperSource+html.slice(cashStart,cashEnd)+html.slice(zStart,zEnd)+
    '\nupdateCashUI(); globalThis.zTotal=anasGetZReportTotal(AppData.invoices,"total"); globalThis.zPaid=anasGetZReportTotal(AppData.invoices,"paid"); globalThis.zDebt=anasGetZReportTotal(AppData.invoices,"remaining");',
    readerContext,{timeout:1000});
  assert.match(readerContext.cashDisplay.innerText,/100\.2/);
  assert.equal(readerContext.zTotal,0.3);
  assert.equal(readerContext.zPaid,0.1);
  assert.equal(readerContext.zDebt,0.2);
  assert.equal(r.AppData.cashMovements[0].type,'add');
  assert.equal(r.AppData.cashMovements[0].referenceType,'sales_invoice');
  assert.equal(r.AppData.stockMovements[0].type,'SALE_OUT');
  assert.equal(r.AppData.stockMovements[0].referenceType,'sales_invoice');
  console.log('PASS: actual cash balance and Z-report readers reflect the committed invoice values');
}

{
  const r=runSale({cart:[{id:'P-1',name:'Test product',qty:3,price:0.1}],paid:0.3,customerDebt:0.25});
  assert.equal(r.customer.debt,0.25,'fully paid invoice must not change an existing customer debt');
  assert.equal(r.AppData.invoices[0].remaining,0);
  assert.equal(r.AppData.invoices[0].paymentMethod,'cash');
  assert.equal(r.AppData.cashMovements.length,1);
  assert.equal(r.AppData.cashMovements[0].amount,0.3);
  assertAccountingIdentity(r,0.25);
  console.log('PASS: exact full payment creates no new debt and does not mark the invoice partial');
}

{
  const r=runSale({cart:[{id:'P-1',name:'Test product',qty:3,price:0.1}],paid:0.1,customerDebt:0.1});
  const stocktakeStart=html.indexOf('/* ANAS ERP — stocktake sessions, draft, variance approval and audit movements */');
  const stocktakeEnd=html.indexOf('\n})();',stocktakeStart);
  assert.ok(stocktakeStart>=0&&stocktakeEnd>stocktakeStart,'actual stocktake module must be present and isolatable');
  const stocktakeContext={
    AppData:r.AppData,Date,Math,Number,String,Object,Array,Map,Set,JSON,
    window:null,localStorage:{getItem:()=>null,setItem:()=>{}},
    document:{getElementById:()=>null,addEventListener:()=>{}},
    alert:()=>{},confirm:()=>true,console
  };
  stocktakeContext.window=stocktakeContext;
  vm.createContext(stocktakeContext);
  vm.runInContext(html.slice(stocktakeStart,stocktakeEnd+5),stocktakeContext,{timeout:1000});
  stocktakeContext.anasRenderStocktake=()=>{};
  stocktakeContext.anasSaveStocktakeDraft=()=>true;
  vm.runInContext('anasStartStocktake()',stocktakeContext,{timeout:1000});
  assert.equal(stocktakeContext.__anasCurrentStocktake.items[0].systemQty,17,
    'stocktake must snapshot the product master balance after the sale exactly once');
  console.log('PASS: actual stocktake session reader snapshots the post-sale product balance without replaying SALE_OUT');
}


{
  const r=runSale({cart:[{id:'P-1',name:'Test product',qty:3,price:0.1}],paid:0.1});
  const syncStart=html.indexOf('async function syncPushNow()');
  const syncEnd=html.indexOf('\n        async function syncPullNow()',syncStart);
  assert.ok(syncStart>=0&&syncEnd>syncStart,'actual cloud snapshot sender must be present and isolatable');
  const syncSource=html.slice(syncStart,syncEnd);
  assert.ok(syncSource.includes('data: AppData'),'cloud snapshot must serialize the complete AppData object');
  assert.ok(html.includes("'cashMovements'")&&html.includes("'stockMovements'"),'cloud validation must retain both financial and stock movement arrays');
  const cloudSnapshot=JSON.parse(JSON.stringify(r.AppData));
  assert.equal(cloudSnapshot.cashMovements[0].referenceType,'sales_invoice');
  assert.equal(cloudSnapshot.cashMovements[0].amount,0.1);
  assert.equal(cloudSnapshot.stockMovements[0].type,'SALE_OUT');
  assert.equal(cloudSnapshot.stockMovements[0].referenceType,'sales_invoice');
  console.log('PASS: complete Cloud Snapshot carries both linked sale ledgers without filtering');
}

{
  const executeStart=html.indexOf('function anasExecuteReversePosting(');
  const executeEnd=html.indexOf('\n        function cancelInvoicePrompt()',executeStart);
  assert.ok(executeStart>=0&&executeEnd>executeStart,'reverse posting entry point must be present and isolatable');
  for (const name of ['returnSalePrompt','returnPurchasePrompt','cancelInvoicePrompt']) {
    const fnStart=html.indexOf('function '+name+'()');
    const fnEnd=html.indexOf('\n        function ',fnStart+20);
    assert.ok(fnStart>=0&&fnEnd>fnStart,'missing reverse UI handler: '+name);
    assert.ok(html.slice(fnStart,fnEnd).includes('anasExecuteReversePosting('),
      name+' must delegate through the single guarded reverse-posting entry point');
  }
  const customer={id:'C-CANCEL',name:'Customer',debt:0.20};
  const invoice={id:'INV-CANCEL',customerId:'C-CANCEL',customerObj:customer,total:0.30,paid:0.10,remaining:0.20,
    items:[{id:'P-CANCEL',qty:3,price:0.10}],warehouse:'المخزن الرئيسي'};
  const AppData={customers:[customer],suppliers:[],invoices:[invoice],purchases:[],
    products:[{id:'P-CANCEL',name:'Tea',stock:0}],
    cashMovements:[{id:'SALE-CASH-CANCEL',type:'add',amount:0.10,referenceType:'sales_invoice',referenceId:'INV-CANCEL'}],
    stockMovements:[{id:'SALE-STOCK-CANCEL',productId:'P-CANCEL',qty:-3,type:'SALE_OUT',referenceType:'sales_invoice',referenceId:'INV-CANCEL'}],
    clientMovements:[],supplierMovements:[],settlementAllocations:[],returns:[],customerCreditMovements:[],
    caisseBalance:1,currentUser:{id:'U-CANCEL'}};
  const before=JSON.stringify(AppData);
  const alerts=[];
  let localEngineCalls=0;
  const cancelContext={AppData,ANASReverseLedger:{executeReturnTransaction(){localEngineCalls++;throw new Error('local engine must not run');}},
    alert:m=>alerts.push(String(m))};
  vm.createContext(cancelContext);
  vm.runInContext(html.slice(executeStart,executeEnd)+'\nglobalThis.__cancelResult = anasExecuteReversePosting({returnType:"INVOICE_CANCEL"});',
    cancelContext,{timeout:1500});
  assert.equal(cancelContext.__cancelResult,null,'missing server gateway must block the reversal');
  assert.equal(localEngineCalls,0,'browser-local financial engine must never execute a reverse posting');
  assert.equal(JSON.stringify(AppData),before,'blocked reverse posting must not mutate invoice, debt, stock, cash or ledgers');
  assert.ok(alerts.some(m=>m.includes('لا توجد بوابة ترحيل خادمية موثوقة')),
    'the operator must receive an explicit server-authorization block reason');
  console.log('PASS: reverse posting fails closed without a trusted server gateway and preserves all local state');
}
