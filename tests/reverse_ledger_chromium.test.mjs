'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
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
  console.log('CHROMIUM_REVERSE_LEDGER_FAIL_CLOSED_REPORT '+JSON.stringify(result));
 } finally {
  await browser.close();
 }
});


test('Chromium executes real return and cancellation prompts with atomic financial and stock parity', async () => {
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent('<!doctype html><html><body><main id="result">ready</main></body></html>');
  await page.addScriptTag({path:path.join(process.cwd(),'reverse-ledger/reverse-ledger.js')});
  const html=fs.readFileSync(path.join(process.cwd(),'index.html'),'utf8');
  const start=html.indexOf('function anasReverseInvoiceChoices(');
  const purchaseStart=html.indexOf('function returnPurchasePrompt()',start);
  const end=html.indexOf('\\n        function ',purchaseStart+30);
  assert.ok(start>=0&&purchaseStart>start&&end>purchaseStart,'real reverse-posting UI handlers must be extractable');
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
   window.alert=message=>window.__alerts.push(String(message));
   window.prompt=()=>window.__promptValue;
   window.saveDB=()=>true;
   window.anasValidatePurchaseLedgerParity=()=>true;
   for(const fn of ['renderInvoicesTable','renderPurchasesTable','renderCustomersDebts','renderSuppliersDebts','updateCashUI','updateDashboardStats','updateUIState']) window[fn]=()=>{};

   window.AppData=makeSale();
   window.__promptValue=JSON.stringify({invoiceId:'INV-UI-RET',items:[{productId:'P-UI-RET',quantity:'3'}],settlementMode:'credit',reason:'customer credit'});
   const saleDoc=window.returnSalePrompt();
   const saleResult={type:saleDoc.returnType,debt:saleDoc.debtReductionCentimes,customerCredit:saleDoc.customerCreditCentimes,
    customerDebt:AppData.customers[0].debt,creditBalance:AppData.customers[0].creditBalanceCentimes,
    stock:AppData.products[0].stock,originalPaid:AppData.invoices[0].paid,originalRemaining:AppData.invoices[0].remaining};

   window.AppData=makePurchase();
   window.__promptValue=JSON.stringify({invoiceId:'PUR-UI-RET',items:[{productId:'P-UI-RET',quantity:'3'}],settlementMode:'credit',reason:'supplier credit'});
   const purchaseDoc=window.returnPurchasePrompt();
   const purchaseResult={type:purchaseDoc.returnType,debt:purchaseDoc.debtReductionCentimes,supplierCredit:purchaseDoc.supplierCreditCentimes,
    supplierBalance:AppData.suppliers[0].balance,creditBalance:AppData.suppliers[0].creditBalanceCentimes,
    stock:AppData.products[0].stock,supplierMovement:AppData.supplierMovements[0].type};

   window.AppData=makeSale();
   window.__promptValue=JSON.stringify({invoiceType:'sales_invoice',invoiceId:'INV-UI-RET',reason:'duplicate invoice'});
   const cancelDoc=window.cancelInvoicePrompt();
   const cancelResult={type:cancelDoc.returnType,status:AppData.invoices[0].status,debt:AppData.customers[0].debt,
    cash:AppData.caisseBalance,stock:AppData.products[0].stock,originalPaid:AppData.invoices[0].paid};

   window.AppData=makeSale();
   const rollbackRefs={app:AppData,customer:AppData.customers[0],product:AppData.products[0],
    cash:AppData.cashMovements,stock:AppData.stockMovements,clients:AppData.clientMovements,returns:AppData.returns};
   const rollbackBefore=JSON.stringify(AppData);
   window.__promptValue=JSON.stringify({invoiceId:'INV-UI-RET',items:[{productId:'P-UI-RET',quantity:'1'}],settlementMode:'cash',reason:'force save failure'});
   window.saveDB=()=>false;
   const failed=window.returnSalePrompt();
   const rollbackResult={failed:failed===null,unchanged:JSON.stringify(AppData)===rollbackBefore,
    identities:AppData===rollbackRefs.app&&AppData.customers[0]===rollbackRefs.customer&&AppData.products[0]===rollbackRefs.product&&
     AppData.cashMovements===rollbackRefs.cash&&AppData.stockMovements===rollbackRefs.stock&&
     AppData.clientMovements===rollbackRefs.clients&&AppData.returns===rollbackRefs.returns};

   window.AppData=makeSale();
   AppData.cashMovements.push({id:'OLD-RECEIPT',type:'add',amount:0.10,referenceType:'customer_debt',referenceId:'C-UI-RET'});
   const legacyBefore=JSON.stringify(AppData);
   window.saveDB=()=>true;
   window.__promptValue=JSON.stringify({invoiceId:'INV-UI-RET',items:[{productId:'P-UI-RET',quantity:'1'}],settlementMode:'cash',reason:'legacy gate'});
   const legacyResult=window.returnSalePrompt();
   const legacyGate={rejected:legacyResult===null,unchanged:JSON.stringify(AppData)===legacyBefore};

   return {saleResult,purchaseResult,cancelResult,rollbackResult,legacyGate,alerts:window.__alerts};
  });
  assert.deepEqual(result.saleResult,{type:'SALE_RETURN',debt:20,customerCredit:10,customerDebt:0,creditBalance:10,stock:3,originalPaid:0.10,originalRemaining:0.20});
  assert.deepEqual(result.purchaseResult,{type:'PURCHASE_RETURN',debt:20,supplierCredit:10,supplierBalance:0,creditBalance:10,stock:0,supplierMovement:'return_credit'});
  assert.deepEqual(result.cancelResult,{type:'INVOICE_CANCEL',status:'CANCELLED',debt:0,cash:0.90,stock:3,originalPaid:0.10});
  assert.deepEqual(result.rollbackResult,{failed:true,unchanged:true,identities:true});
  assert.deepEqual(result.legacyGate,{rejected:true,unchanged:true});
  console.log('CHROMIUM_ATOMIC_REVERSE_POSTING_REPORT '+JSON.stringify({
   saleReturn:result.saleResult,purchaseReturn:result.purchaseResult,cancellation:result.cancelResult,
   failedSaveRollback:result.rollbackResult,legacyEligibilityGate:result.legacyGate
  }));
 } finally { await browser.close(); }
});
