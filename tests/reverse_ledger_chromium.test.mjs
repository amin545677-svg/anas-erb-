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
 const end = html.indexOf('\\n        function ', start + 30);
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
