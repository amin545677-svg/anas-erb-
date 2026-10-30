'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const ANASReverseLedger=require('../reverse-ledger/reverse-ledger.js');

const purchaseStart=html.indexOf('function anasCreateUniqueProductId(products)');
const purchaseEnd=html.indexOf('function anasEscapeHtml(value)',purchaseStart);
assert.ok(purchaseStart>=0&&purchaseEnd>purchaseStart,'purchase helpers/save function must be isolatable');
const purchaseSource=html.slice(purchaseStart,purchaseEnd);
const moneyHelperStart=html.indexOf('// Purchase-specific decimal parser');
const moneyHelperEnd=html.indexOf('function savePurchaseItem()',moneyHelperStart);
assert.ok(moneyHelperStart>=0&&moneyHelperEnd>moneyHelperStart,'purchase centime helpers must be isolatable');
const moneyHelperSource=html.slice(moneyHelperStart,moneyHelperEnd);
const paymentStart=html.indexOf('function paySupplierDebt(supplierId)');
const paymentEnd=html.indexOf('function openAddSupplierModal()',paymentStart);
assert.ok(paymentStart>=0&&paymentEnd>paymentStart,'supplier payment function must be isolatable');
const paymentSource=html.slice(paymentStart,paymentEnd);
const supplierStart=html.indexOf('function saveNewSupplierMpos()');
const supplierEnd=html.indexOf('function printLatestLegalCustomerInvoice()',supplierStart);
assert.ok(supplierStart>=0&&supplierEnd>supplierStart,'supplier creation function must be isolatable');
const supplierSource=html.slice(supplierStart,supplierEnd);

function elements({name='Test product',cost='10.10',qty='3',paid='10.00',supplier='S-1',debt='0'}={}) {
 return {
  purProductName:{value:name,focus(){}},purBuyCost:{value:cost,focus(){}},purBuyQty:{value:qty,focus(){}},
  purPaidAmount:{value:paid,focus(){}},purSupplierSelect:{value:supplier},purInvoiceDate:{value:'2026-10-30'},
  newSuppNameInput:{value:'New supplier'},newSuppPhoneInput:{value:'0550000000'},newSuppRCInput:{value:''},
  newSuppNIFInput:{value:''},newSuppArtInput:{value:''},newSuppAddressInput:{value:''},newSuppDebtInput:{value:debt,focus(){}}
 };
}
function runPurchase({fields=elements(),products=[{id:'P-1',name:'Test product',stock:10,buyPrice:5}],suppliers=[{id:'S-1',name:'Supplier',balance:2}],caisseBalance=100,saveResult=true}={}) {
 const AppData={products:products.map(x=>({...x})),suppliers:suppliers.map(x=>({...x})),purchases:[],cashMovements:[],stockMovements:[],supplierMovements:[],caisseBalance,currentUser:{id:'U-1',name:'Tester'}};
 const alerts=[];let saves=0;
 const ctx={AppData,posCart:[],document:{getElementById:id=>fields[id]||null},saveDB:()=>{saves++;return saveResult;},
  alert:m=>alerts.push(String(m)),console:{error(){}},renderPurchasesTable(){},renderSuppliersDebts(){},updateCashUI(){},updateDashboardStats(){},updateUIState(){},
  anasNormalizeBarcode:v=>String(v||'').replace(/\D/g,'')};
 vm.createContext(ctx);vm.runInContext(purchaseSource+'\nsavePurchaseItem();',ctx,{timeout:1500});
 return {AppData:ctx.AppData,alerts,saves};
}
function runPayment({balance=20,cash=100,amount='7.25',saveResult=true}={}) {
 const AppData={
  suppliers:[{id:'S-1',name:'Supplier',balance}],
  purchases:[{id:'PUR-1',supplierId:'S-1',total:20,paid:0,remaining:20,productId:'P-1',cost:10,qty:2}],
  cashMovements:[],
  supplierMovements:[{id:'SM-PUR-1',supplierId:'S-1',type:'purchase',amount:20,referenceType:'purchase_invoice',referenceId:'PUR-1'}],
  settlementAllocations:[],caisseBalance:cash,currentUser:{id:'U-1',name:'Tester'}
 };
 const alerts=[];let saves=0;
 const supplierRef=AppData.suppliers[0],supplierMovementsRef=AppData.supplierMovements,cashMovementsRef=AppData.cashMovements,allocationsRef=AppData.settlementAllocations;
 const ctx={AppData,ANASReverseLedger,prompt:()=>JSON.stringify([{invoiceId:'PUR-1',amount}]),
  saveDB:()=>{saves++;return saveResult;},alert:m=>alerts.push(String(m)),console:{error(){}},renderSuppliersDebts(){},updateCashUI(){}};
 vm.createContext(ctx);vm.runInContext(moneyHelperSource+'\n'+paymentSource+'\npaySupplierDebt("S-1");',ctx,{timeout:1500});
 return {AppData:ctx.AppData,alerts,saves,identity:{supplier:ctx.AppData.suppliers[0]===supplierRef,supplierMovements:ctx.AppData.supplierMovements===supplierMovementsRef,cashMovements:ctx.AppData.cashMovements===cashMovementsRef,allocations:ctx.AppData.settlementAllocations===allocationsRef}};
}
function runSupplierCreate({debt='12.345',saveResult=true}={}) {
 const fields=elements({debt});const AppData={suppliers:[],supplierMovements:[]};const alerts=[];let saves=0;
 const ctx={AppData,document:{getElementById:id=>fields[id]||null},saveDB:()=>{saves++;return saveResult;},
  alert:m=>alerts.push(String(m)),closeModal(){},renderSuppliersDebts(){},Date,Math,console:{error(){}}};
 vm.createContext(ctx);vm.runInContext(purchaseSource+'\n'+supplierSource+'\nsaveNewSupplierMpos();',ctx,{timeout:1500});
 return {AppData:ctx.AppData,alerts,saves};
}

{
 const r=runPurchase(),p=r.AppData.purchases[0];
 assert.equal(r.saves,1);assert.equal(p.total,30.30);assert.equal(p.paid,10);assert.equal(p.remaining,20.30);
 assert.equal(r.AppData.suppliers[0].balance,22.30);assert.equal(r.AppData.caisseBalance,90);
 assert.equal(r.AppData.products[0].stock,13);assert.equal(r.AppData.products[0].buyPrice,6.18);
 assert.equal(r.AppData.products[0].lastPurchaseCost,10.10);
 assert.equal(r.AppData.stockMovements[0].type,'PURCHASE_IN');assert.equal(r.AppData.stockMovements[0].qty,3);
 assert.equal(r.AppData.stockMovements[0].referenceId,p.id);
 assert.equal(r.AppData.cashMovements[0].type,'subtract');assert.equal(r.AppData.cashMovements[0].amount,10);
 assert.equal(r.AppData.cashMovements[0].referenceId,p.id);
 assert.deepEqual(r.AppData.supplierMovements.map(x=>x.type),['payment','purchase']);
 assert.equal(r.AppData.supplierMovements[0].amount,10);assert.equal(r.AppData.supplierMovements[1].amount,30.30);
 assert.ok(r.AppData.supplierMovements.every(x=>x.referenceId===p.id));
 console.log('PASS: partial purchase posts exact stock, weighted cost, supplier payable and cash ledgers');
}
{
 const r=runPurchase({fields:elements({cost:'0.10',qty:'3',paid:'0.30'})});
 assert.equal(r.AppData.purchases[0].total,0.30);assert.equal(r.AppData.purchases[0].paid,0.30);
 assert.equal(r.AppData.purchases[0].remaining,0);assert.equal(r.AppData.suppliers[0].balance,2);
 assert.equal(r.AppData.caisseBalance,99.70);assert.deepEqual(r.AppData.supplierMovements.map(x=>x.amount),[0.30,0.30]);
 console.log('PASS: 3 x 0.10 purchase settles exactly with no residual supplier debt');
}
{
 const r=runPurchase({fields:elements({paid:'0',supplier:''})});
 assert.equal(r.saves,0);assert.equal(r.AppData.purchases.length,0);assert.equal(r.AppData.products[0].stock,10);
 assert.equal(r.AppData.suppliers[0].balance,2);assert.equal(r.AppData.caisseBalance,100);
 console.log('PASS: unpaid purchase without registered supplier is rejected before mutation');
}
{
 const r=runPurchase({caisseBalance:5,fields:elements({paid:'10'})});
 assert.equal(r.saves,0);assert.equal(r.AppData.purchases.length,0);assert.equal(r.AppData.products[0].stock,10);
 assert.equal(r.AppData.suppliers[0].balance,2);assert.equal(r.AppData.caisseBalance,5);
 console.log('PASS: purchase payment cannot overdraw cashbox');
}
{
 const r=runPurchase({saveResult:false});
 assert.equal(r.saves,1);assert.equal(r.AppData.purchases.length,0);assert.equal(r.AppData.products[0].stock,10);
 assert.equal(r.AppData.products[0].buyPrice,5);assert.equal(r.AppData.suppliers[0].balance,2);assert.equal(r.AppData.caisseBalance,100);
 assert.equal(r.AppData.cashMovements.length,0);assert.equal(r.AppData.stockMovements.length,0);assert.equal(r.AppData.supplierMovements.length,0);
 console.log('PASS: failed purchase persistence restores stock, supplier, cash and movement ledgers');
}
{
 const r=runPurchase({products:[{id:'P-1',name:'Test product',stock:10}]});
 assert.equal(r.saves,0);assert.equal(r.AppData.products[0].stock,10);assert.equal(r.AppData.purchases.length,0);
 console.log('PASS: existing stock with missing historical cost basis is rejected');
}
{
 const r=runPayment();assert.equal(r.saves,1);assert.equal(r.AppData.suppliers[0].balance,12.75);
 assert.equal(r.AppData.caisseBalance,92.75);assert.equal(r.AppData.supplierMovements[0].type,'payment');
 assert.equal(r.AppData.supplierMovements[0].amount,7.25);assert.equal(r.AppData.cashMovements[0].type,'subtract');
 assert.equal(r.AppData.settlementAllocations[0].amountCentimes,725);
 assert.equal(r.AppData.settlementAllocations[0].invoiceId,'PUR-1');
 assert.equal(r.AppData.cashMovements[0].amount,7.25);
 assert.equal(r.AppData.cashMovements[0].referenceId,r.AppData.supplierMovements[0].referenceId);
 console.log('PASS: supplier debt payment posts matching supplier and cash ledger entries');
}
{
 const r=runPurchase({suppliers:[{id:'S-1',name:'Supplier',balance:2},{id:'S-1',name:'Duplicate',balance:0}]});
 assert.equal(r.saves,0);assert.equal(r.AppData.purchases.length,0);assert.equal(r.AppData.products[0].stock,10);
 console.log('PASS: duplicate supplier identities are rejected before purchase mutation');
}
{
 const r=runPayment({balance:20,cash:100,amount:'7.25'});
 r.AppData.cashMovements.push({...r.AppData.cashMovements[0]});
 const duplicateContext={AppData:r.AppData,ANASReverseLedger,prompt:()=>JSON.stringify([{invoiceId:'PUR-1',amount:'1'}]),saveDB:()=>{throw new Error('must not save');},alert:m=>r.alerts.push(String(m)),console:{error(){}},renderSuppliersDebts(){},updateCashUI(){}};
 vm.createContext(duplicateContext);
 vm.runInContext(moneyHelperSource+'\n'+paymentSource+'\npaySupplierDebt("S-1");',duplicateContext,{timeout:1500});
 assert.equal(duplicateContext.AppData.suppliers[0].balance,12.75);
 assert.ok(r.alerts.some(x=>x.includes('معرّفات مكررة')));
 console.log('PASS: supplier payment refuses duplicate pre-existing ledger IDs');
}
{
 const r=runPayment({balance:19,cash:99,amount:'1.00'});
 r.AppData.supplierMovements.push({id:'OLD-SP',supplierId:'S-1',type:'payment',amount:1,referenceType:'supplier_payment',referenceId:'OLD-SP'});
 r.AppData.cashMovements.push({id:'OLD-CM',type:'subtract',amount:1,referenceType:'supplier_payment',referenceId:'OLD-SP'});
 const ctx={AppData:r.AppData,ANASReverseLedger,prompt:()=>{throw new Error('must reject before prompting');},
  saveDB:()=>{throw new Error('must not save');},alert:m=>r.alerts.push(String(m)),console:{error(){}},renderSuppliersDebts(){},updateCashUI(){}};
 vm.createContext(ctx);vm.runInContext(moneyHelperSource+'\n'+paymentSource+'\npaySupplierDebt("S-1");',ctx,{timeout:1500});
 assert.equal(ctx.AppData.suppliers[0].balance,18);
 assert.equal(ctx.AppData.supplierMovements.length,3);
 assert.ok(r.alerts.some(x=>x.includes('غير مخصص بالكامل')));
 console.log('PASS: prior unallocated supplier settlements block new invoice payments');
}
{
 const r=runPayment({balance:20,cash:5,amount:'7.25'});assert.equal(r.saves,0);
 assert.equal(r.AppData.suppliers[0].balance,20);assert.equal(r.AppData.caisseBalance,5);
 assert.equal(r.AppData.supplierMovements.length,1);assert.equal(r.AppData.cashMovements.length,0);
 assert.equal(r.AppData.settlementAllocations.length,0);
 console.log('PASS: supplier payment rejects insufficient cash without mutation');
}
{
 const r=runPayment({saveResult:false});assert.equal(r.AppData.suppliers[0].balance,20);
 assert.equal(r.AppData.caisseBalance,100);assert.equal(r.AppData.supplierMovements.length,1);
 assert.equal(r.AppData.cashMovements.length,0);
 assert.deepEqual(r.identity,{supplier:true,supplierMovements:true,cashMovements:true,allocations:true},'rollback must preserve supplier and ledger array identities');
 assert.equal(r.AppData.settlementAllocations.length,0);
 console.log('PASS: failed supplier payment persistence restores both ledgers and preserves object identity');
}
{
 const r=runSupplierCreate();assert.equal(r.saves,1);assert.equal(r.AppData.suppliers[0].balance,12.35);
 assert.equal(r.AppData.supplierMovements.length,1);assert.equal(r.AppData.supplierMovements[0].type,'opening_balance');
 assert.equal(r.AppData.supplierMovements[0].amount,12.35);
 console.log('PASS: supplier opening balance is recorded to centime precision');
}
{
 const r=runSupplierCreate({debt:'12.34',saveResult:false});assert.equal(r.AppData.suppliers.length,0);
 assert.equal(r.AppData.supplierMovements.length,0);
 console.log('PASS: failed supplier creation restores supplier and opening ledger');
}
{
 const ctx={};vm.createContext(ctx);
 vm.runInContext(moneyHelperSource+"\nthis.aggregate=anasPurchaseAggregateCents([{total:'0.10'},{total:'0.20'}]);this.stockValue=anasPurchaseStockValueCents(anasPurchaseToQtyUnits('3'),anasPurchaseToCents('0.10'));this.invalidAggregate=anasPurchaseAggregateCents([{total:'9007199254740992'}]);this.invalidStockValue=anasPurchaseStockValueCents(1000000,NaN);",ctx);
 assert.equal(ctx.aggregate,30,'purchase report aggregates must sum exact integer centimes');
 assert.equal(ctx.stockValue,30,'inventory valuation must multiply micro-units and unit cents without floating drift');
 assert.ok(Number.isNaN(ctx.invalidAggregate),'purchase report must fail closed on totals outside safe integer range');
 assert.ok(Number.isNaN(ctx.invalidStockValue),'inventory valuation must fail closed when a stocked product has no valid cost basis');
 console.log('PASS: purchase reports and inventory valuation aggregate in exact centimes');
}
{
 const backupStart=html.indexOf('function anasValidateBackupData(incoming)');
 const backupEnd=html.indexOf('function importDataBackup(e)',backupStart);
 const cloudStart=html.indexOf('function anasValidateIncomingSyncData(incoming)');
 const cloudEnd=html.indexOf('async function syncPushNow()',cloudStart);
 assert.ok(backupStart>=0&&backupEnd>backupStart&&cloudStart>=0&&cloudEnd>cloudStart,'backup and cloud validators must be isolatable');
 const base={
  products:[],customers:[],suppliers:[{id:'S-1',name:'Supplier',balance:0.20}],invoices:[],
  purchases:[{id:'PUR-1',ledgerVersion:1,productId:'P-1',cost:'0.10',qty:'3',total:'0.30',paid:'0.10',remaining:'0.20',supplierId:'S-1'}],
  cashMovements:[{id:'CM-1',type:'subtract',amount:'0.10',referenceType:'purchase_invoice',referenceId:'PUR-1'}],
  stockMovements:[{id:'ST-1',type:'PURCHASE_IN',productId:'P-1',qty:'3',referenceType:'purchase_invoice',referenceId:'PUR-1'}],
  supplierMovements:[
   {id:'SM-1',supplierId:'S-1',type:'purchase',amount:'0.30',referenceType:'purchase_invoice',referenceId:'PUR-1'},
   {id:'SM-2',supplierId:'S-1',type:'payment',amount:'0.10',referenceType:'purchase_invoice',referenceId:'PUR-1'}
  ]
 };
 function validate(kind,incoming,current={}) {
  const start=kind==='backup'?backupStart:cloudStart;
  const end=kind==='backup'?backupEnd:cloudEnd;
  const fn=kind==='backup'?'anasValidateBackupData':'anasValidateIncomingSyncData';
  const ctx={AppData:{products:[],customers:[],suppliers:[],invoices:[],purchases:[],expenses:[],users:[],trucks:[],returns:[],warehouseTransfers:[],stockMovements:[],purchaseInvoices:[],supplierMovements:[],alerts:[],truckTrips:[],cashMovements:[],stocktakeRecords:[],warehouses:[],caisseBalance:0,...current},
   anasValidateTruckExpenseLinks(){},console};
  vm.createContext(ctx);
  vm.runInContext(moneyHelperSource+'\n'+html.slice(start,end)+'\nthis.__validate='+fn+';',ctx,{timeout:1500});
  return ctx.__validate(JSON.parse(JSON.stringify(incoming)));
 }
 for(const kind of ['backup','cloud']) {
  const accepted=validate(kind,base);
  assert.equal(accepted.purchases[0].total,'0.30');
  assert.equal(accepted.supplierMovements.length,2);
  const mismatch=JSON.parse(JSON.stringify(base));mismatch.purchases[0].remaining='0.19';
  assert.throws(()=>validate(kind,mismatch),/غير متطابقة بالسنتيم/,'restore must reject purchase total/paid/remaining mismatch');
  const orphan=JSON.parse(JSON.stringify(base));orphan.supplierMovements[0].supplierId='MISSING';
  assert.throws(()=>validate(kind,orphan),/مورد مفقود أو مكرر/,'restore must reject supplier ledger entries without a unique supplier');
  const missingPurchaseEntry=JSON.parse(JSON.stringify(base));missingPurchaseEntry.supplierMovements=missingPurchaseEntry.supplierMovements.filter(x=>x.type!=='purchase');
  assert.throws(()=>validate(kind,missingPurchaseEntry),/قيد فاتورة الشراء غير مطابق/,'restore must reject a purchase with no supplier purchase ledger entry');
  const wrongCash=JSON.parse(JSON.stringify(base));wrongCash.cashMovements[0].amount='0.09';
  assert.throws(()=>validate(kind,wrongCash),/حركة الصندوق لا تطابق/,'restore must reject purchase cash movements that differ from paid centimes');
  const missingStock=JSON.parse(JSON.stringify(base));missingStock.stockMovements=[];
  assert.throws(()=>validate(kind,missingStock),/حركة المخزون لا تطابق/,'restore must reject purchase invoices without their stock-in movement');
  const wrongLine=JSON.parse(JSON.stringify(base));wrongLine.purchases[0].total='0.31';wrongLine.purchases[0].remaining='0.21';wrongLine.supplierMovements.find(x=>x.type==='purchase').amount='0.31';
  assert.throws(()=>validate(kind,wrongLine),/تكلفة الوحدة والكمية/,'restore must reject purchase totals that do not equal exact unit-cost times quantity');
  const missingLedger=JSON.parse(JSON.stringify(base));delete missingLedger.supplierMovements;
  assert.throws(()=>validate(kind,missingLedger,{supplierMovements:[{id:'OLD',supplierId:'S-1',type:'purchase',amount:1}]}),/تفتقد قائمة/,'restore must not erase an existing supplier ledger when the snapshot omits it');
  const legacy=JSON.parse(JSON.stringify(base));delete legacy.purchases[0].ledgerVersion;legacy.supplierMovements=[];legacy.cashMovements=[];legacy.stockMovements=[];
  assert.doesNotThrow(()=>validate(kind,legacy),'legacy purchases without ledgerVersion must remain restorable without fabricated historical movements');
  const supplierPayment=JSON.parse(JSON.stringify(base));
  supplierPayment.supplierMovements.push({id:'SP-1',supplierId:'S-1',type:'payment',amount:'0.05',referenceType:'supplier_payment',referenceId:'SP-1'});
  supplierPayment.cashMovements.push({id:'SC-1',type:'subtract',amount:'0.05',referenceType:'supplier_payment',referenceId:'SP-1'});
  assert.doesNotThrow(()=>validate(kind,supplierPayment),'supplier debt payment must restore only with its matching cash movement');
  const brokenSupplierPayment=JSON.parse(JSON.stringify(supplierPayment));brokenSupplierPayment.cashMovements[1].amount='0.04';
  assert.throws(()=>validate(kind,brokenSupplierPayment),/تسديد المورد غير مرتبط بحركة صندوق مطابقة/,'restore must reject supplier payments without exact cash parity');
  const duplicateOpening=JSON.parse(JSON.stringify(base));
  duplicateOpening.supplierMovements.push({id:'SM-OPEN-2',supplierId:'S-1',type:'opening_balance',amount:'1.00',referenceType:'supplier_opening_balance',referenceId:'S-1'});
  duplicateOpening.supplierMovements.push({id:'SM-OPEN-3',supplierId:'S-1',type:'opening_balance',amount:'1.00',referenceType:'supplier_opening_balance',referenceId:'S-1'});
  assert.throws(()=>validate(kind,duplicateOpening),/غير متطابق أو مكرر/,'restore must reject duplicate supplier opening-balance entries');
 }
 console.log('PASS: cloud and backup restore validate purchase settlement and preserve supplier ledger history');
}
console.log('Purchase and supplier centime ledger tests passed');
