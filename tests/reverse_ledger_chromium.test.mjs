'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

test('Chromium loads reverse-ledger primitives and enforces exact return ceilings', async () => {
 const browser = await chromium.launch({headless:true});
 try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><main id="result">ready</main></body></html>');
  await page.addScriptTag({path:path.join(__dirname,'../reverse-ledger/reverse-ledger.js')});
  const result = await page.evaluate(() => {
   const R = window.ANASReverseLedger;
   const state = R.ensureCollections({invoices:[{id:'S-1',customerId:'C-1'}],cashMovements:[{id:'M-1',amountCentimes:1000}]});
   const allocation = R.makeSettlementAllocation({allocationId:'A-1',partyType:'customer',partyId:'C-1',invoiceType:'sales_invoice',invoiceId:'S-1',sourceMovementId:'M-1',sourceMovementType:'customer_debt',amountCentimes:725,createdAt:'2026-10-30T12:00:00Z'});
   state.settlementAllocations.push(allocation);
   const valid = R.validateSettlementAllocations(state);
   const remaining = R.computeReturnableMicroUnits(5000000n,1250000n).toString();
   let overReturnRejected = false;
   try { R.computeReturnableMicroUnits(5,6); } catch (_) { overReturnRejected = true; }
   const jsonSafe = JSON.stringify(state).length > 0;
   return {valid,remaining,overReturnRejected,jsonSafe,collections:['clientMovements','settlementAllocations','returns'].every(k=>Array.isArray(state[k]))};
  });
  assert.deepEqual(result,{valid:true,remaining:'3750000',overReturnRejected:true,jsonSafe:true,collections:true});
  console.log('CHROMIUM_REVERSE_LEDGER_REPORT '+JSON.stringify(result));
 } finally { await browser.close(); }
});
