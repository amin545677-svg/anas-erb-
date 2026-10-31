'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';

test('Chromium loads reverse-ledger primitives and enforces exact return ceilings', async () => {
 const browser = await chromium.launch({headless:true});
 try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><main id="result">ready</main></body></html>');
  await page.addScriptTag({path:path.join(process.cwd(),'reverse-ledger/reverse-ledger.js')});
  const result = await page.evaluate(() => {
   const R = window.ANASReverseLedger;
   const state = R.ensureCollections({invoices:[{id:'S-1',customerId:'C-1',paid:7.25}],cashMovements:[{id:'M-1',amountCentimes:1000,referenceType:'customer_debt',referenceId:'C-1'}]});
   const allocation = R.sealSettlementAllocation(state, {allocationId:'A-1',partyType:'customer',partyId:'C-1',invoiceType:'sales_invoice',invoiceId:'S-1',sourceMovementId:'M-1',sourceMovementType:'customer_debt',amountCentimes:725,createdAt:'2026-10-30T12:00:00Z'});
   state.settlementAllocations.push(allocation);
   const valid = R.validateReverseLedgerParity(state);
   const remaining = R.computeReturnableMicroUnits(5000000n,1250000n).toString();
   let overReturnRejected = false;
   try { R.computeReturnableMicroUnits(5,6); } catch (_) { overReturnRejected = true; }
   const legacy = R.validateReverseLedgerParity({customers:[{id:'C-legacy',debt:12.5}],suppliers:[],invoices:[],purchases:[],returns:[]});
   const jsonSafe = JSON.stringify(state).length > 0;
   return {valid,legacy,remaining,overReturnRejected,jsonSafe,collections:['clientMovements','settlementAllocations','returns'].every(k=>Array.isArray(state[k]))};
  });
  assert.deepEqual(result,{valid:true,legacy:true,remaining:'3750000',overReturnRejected:true,jsonSafe:true,collections:true});
  console.log('CHROMIUM_REVERSE_LEDGER_REPORT '+JSON.stringify(result));
 } finally { await browser.close(); }
});


test('Chromium blocks browser-local reverse posting when trusted server gateway is absent', async () => {
 const html = fs.readFileSync(path.join(process.cwd(),'index.html'),'utf8');
 const start = html.indexOf('function anasExecuteReversePosting(');
 const end = html.indexOf('\n        function ', start + 30);
 assert.ok(start >= 0 && end > start, 'guarded reverse posting entry point must be present');
 const browser = await chromium.launch({headless:true});
 try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><main>ANAS ERP reverse gate</main></body></html>');
  await page.addScriptTag({content:html.slice(start,end)});
  const result = await page.evaluate(() => {
   const state = {
    invoices:[{id:'INV-SECURE',status:'POSTED',paid:10,remaining:20}],
    customers:[{id:'C-1',debt:20}],
    products:[{id:'P-1',stock:0}],
    cashMovements:[],stockMovements:[],returns:[],clientMovements:[],
    supplierMovements:[],settlementAllocations:[],customerCreditMovements:[],caisseBalance:100
   };
   const before = JSON.stringify(state);
   const alerts = [];
   let localEngineCalls = 0;
   window.AppData = state;
   window.ANASReverseLedger = {executeReturnTransaction(){ localEngineCalls++; throw new Error('local engine must not run'); }};
   window.alert = message => alerts.push(String(message));
   const response = window.anasExecuteReversePosting({returnType:'INVOICE_CANCEL',invoiceId:'INV-SECURE'});
   return {
    responseIsNull: response === null,
    unchanged: JSON.stringify(state) === before,
    localEngineCalls,
    alerts
   };
  });
  assert.equal(result.responseIsNull,true);
  assert.equal(result.unchanged,true);
  assert.equal(result.localEngineCalls,0);
  assert.ok(result.alerts.some(message=>message.includes('لا توجد بوابة ترحيل خادمية موثوقة')));
  assert.ok(result.alerts.every(message=>!message.includes('لم تتغير أي بيانات.. لم تتغير أي بيانات')),
   'fail-closed alert must not duplicate the unchanged-state suffix');
  assert.ok(result.alerts.every(message=>!message.includes('..')),
   'fail-closed alert must not contain duplicated terminal punctuation');
  console.log('CHROMIUM_REVERSE_LEDGER_FAIL_CLOSED_REPORT '+JSON.stringify(result));
 } finally {
  await browser.close();
 }
});


test('Chromium reverse UI handlers fail closed without a trusted server gateway', async () => {
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent('<!doctype html><html><body><main id="result">ready</main></body></html>');
  const html=fs.readFileSync(path.join(process.cwd(),'index.html'),'utf8');
  const start=html.indexOf('function anasReverseInvoiceChoices(');
  const purchaseStart=html.indexOf('function returnPurchasePrompt()',start);
  const end=html.indexOf('\n        function ',purchaseStart+30);
  assert.ok(start>=0&&purchaseStart>start&&end>purchaseStart,'reverse UI handlers must be extractable');
  await page.addScriptTag({content:html.slice(start,end)});
  const result=await page.evaluate(() => {
   const makeSale=()=> {
    const customer={id:'C-UI-RET',name:'Customer',debt:0.20};
    return {customers:[customer],suppliers:[],
     invoices:[{id:'INV-UI-RET',customerId:'C-UI-RET',customerObj:customer,total:0.30,paid:0.10,remaining:0.20,
       items:[{id:'P-UI-RET',qty:3,price:0.10}],warehouse:'المخزن الرئيسي'}],
     purchases:[],products:[{id:'P-UI-RET',name:'Tea',stock:0}],
     cashMovements:[{id:'SALE-CASH-UI',type:'add',amount:0.10,referenceType:'sales_invoice',referenceId:'INV-UI-RET'}],
     stockMovements:[{id:'SALE-STOCK-UI',productId:'P-UI-RET',qty:-3,type:'SALE_OUT',referenceType:'sales_invoice',referenceId:'INV-UI-RET'}],
     clientMovements:[],supplierMovements:[],settlementAllocations:[],returns:[],customerCreditMovements:[],
     caisseBalance:1,currentUser:{id:'U-UI'}};
   };
   const makePurchase=()=> {
    const supplier={id:'SUP-UI-RET',name:'Supplier',balance:0.20};
    return {customers:[],suppliers:[supplier],invoices:[],
     purchases:[{id:'PUR-UI-RET',supplierId:'SUP-UI-RET',total:0.30,paid:0.10,remaining:0.20,
       productId:'P-UI-RET',qty:3,cost:0.10,warehouse:'المخزن الرئيسي'}],
     products:[{id:'P-UI-RET',name:'Tea',stock:3}],
     cashMovements:[{id:'PUR-CASH-UI',type:'subtract',amount:0.10,referenceType:'purchase_invoice',referenceId:'PUR-UI-RET'}],
     stockMovements:[{id:'PUR-STOCK-UI',productId:'P-UI-RET',qty:3,type:'PURCHASE_IN',referenceType:'purchase_invoice',referenceId:'PUR-UI-RET'}],
     clientMovements:[],supplierMovements:[{id:'SUP-PUR-UI',supplierId:'SUP-UI-RET',type:'purchase',amount:0.30,referenceType:'purchase_invoice',referenceId:'PUR-UI-RET'}],
     settlementAllocations:[],returns:[],customerCreditMovements:[],caisseBalance:1,currentUser:{id:'U-UI'}};
   };
   window.__alerts=[];
   window.__localEngineCalls=0;
   window.alert=message=>window.__alerts.push(String(message));
   window.anasReadReversePrompt=()=>JSON.parse(window.__promptValue);
   window.ANASReverseLedger={executeReturnTransaction(){window.__localEngineCalls++;throw new Error('local engine must not run');}};
   const before=[];
   window.AppData=makeSale();
   before.push(JSON.stringify(AppData));
   window.__promptValue=JSON.stringify({invoiceId:'INV-UI-RET',items:[{productId:'P-UI-RET',quantity:'3'}],settlementMode:'credit',reason:'customer credit'});
   const saleResult=window.returnSalePrompt();
   const saleUnchanged=JSON.stringify(AppData)===before[0];

   window.AppData=makePurchase();
   before.push(JSON.stringify(AppData));
   window.__promptValue=JSON.stringify({invoiceId:'PUR-UI-RET',items:[{productId:'P-UI-RET',quantity:'3'}],settlementMode:'credit',reason:'supplier credit'});
   const purchaseResult=window.returnPurchasePrompt();
   const purchaseUnchanged=JSON.stringify(AppData)===before[1];

   window.AppData=makeSale();
   before.push(JSON.stringify(AppData));
   window.__promptValue=JSON.stringify({invoiceType:'sales_invoice',invoiceId:'INV-UI-RET',reason:'duplicate invoice'});
   const cancelResult=window.cancelInvoicePrompt();
   const cancelUnchanged=JSON.stringify(AppData)===before[2];

   return {saleBlocked:saleResult===null,saleUnchanged,purchaseBlocked:purchaseResult===null,purchaseUnchanged,
    cancelBlocked:cancelResult===null,cancelUnchanged,localEngineCalls:window.__localEngineCalls,alerts:window.__alerts};
  });
  assert.deepEqual({
   saleBlocked:result.saleBlocked,saleUnchanged:result.saleUnchanged,
   purchaseBlocked:result.purchaseBlocked,purchaseUnchanged:result.purchaseUnchanged,
   cancelBlocked:result.cancelBlocked,cancelUnchanged:result.cancelUnchanged,
   localEngineCalls:result.localEngineCalls
  },{saleBlocked:true,saleUnchanged:true,purchaseBlocked:true,purchaseUnchanged:true,
   cancelBlocked:true,cancelUnchanged:true,localEngineCalls:0});
  assert.equal(result.alerts.length,3);
  assert.ok(result.alerts.every(message=>message.includes('لا توجد بوابة ترحيل خادمية موثوقة')));
  console.log('CHROMIUM_REVERSE_UI_FAIL_CLOSED_REPORT '+JSON.stringify(result));
 } finally { await browser.close(); }
});
