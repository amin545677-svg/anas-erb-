'use strict';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {chromium} from 'playwright';
const script=fs.readFileSync('anas-live-status.js','utf8'),css=fs.readFileSync('anas-erp-ui-safe-enhancements.css','utf8');
const fixture={
 customers:[{id:'C1',name:'عميل المصادقة',phone:'0550000001'},{id:'C2',name:'عميل فاتورة قديمة',phone:'0550000002'}],
 invoices:[{id:'INV1',customerId:'C1',total:30,paid:10,remaining:20,date:'2026-02-01'},{id:'INV2',customerId:'C2',total:10,paid:5,remaining:5,date:'2026-02-05'},{id:'INV-CANCEL',customerId:'C1',total:99,paid:0,remaining:99,status:'CANCELLED',date:'2026-02-07'}],
 clientMovements:[
 {movementId:'M-OPEN',clientId:'C1',type:'opening_balance',amountCentimes:1000000,direction:'debit',createdAt:'2026-01-01'},
 {movementId:'M-INV',clientId:'C1',type:'invoice_debit',amountCentimes:2000,direction:'debit',referenceId:'INV1',createdAt:'2026-02-01'},
 {movementId:'M-RECEIPT',clientId:'C1',type:'receipt',amountCentimes:500,direction:'credit',createdAt:'2026-02-02'},
 {movementId:'M-RETURN',clientId:'C1',type:'return_credit',amountCentimes:250,direction:'credit',referenceId:'RET1',createdAt:'2026-02-03'},
 {movementId:'M-CANCEL',clientId:'C1',type:'invoice_debit',amountCentimes:9900,direction:'debit',referenceId:'INV-CANCEL',createdAt:'2026-02-07'}],
 returns:[{returnId:'RET1',originalInvoiceId:'INV1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'POSTED',financialMovementIds:['M-RETURN']},{returnId:'RET-DRAFT',originalInvoiceId:'INV1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'DRAFT',financialMovementIds:[]}]};
const parseDate=v=>v?new Date(String(v).slice(0,10)+'T00:00:00'):null,range={from:'2026-02-01',to:'2026-02-28'};
test('Node: BigInt reconciliation, POSTED return gate, invoice fallback and cancelled invoice exclusion',()=>{
 const win={document:{getElementById:()=>null,addEventListener:()=>{}},navigator:{onLine:true},addEventListener:()=>{},showReportDetails:()=>'original'};
 vm.runInNewContext(script,{window:win,BigInt,Map,Set,Date,String,Number,Object,Array});
 const rows=win.anasBuildCustomerReconciliationRows(fixture,range,parseDate),a=rows.find(r=>r.customerId==='C1'),b=rows.find(r=>r.customerId==='C2');
 assert.equal(a.openingBalanceCents,1000000n);assert.equal(a.periodDebitCents,2000n);assert.equal(a.periodCreditCents,750n);assert.equal(a.closingBalanceCents,1001250n);
 assert.equal(b.openingBalanceCents,0n);assert.equal(b.periodDebitCents,500n);assert.equal(b.periodCreditCents,0n);assert.equal(b.closingBalanceCents,500n);
 assert.equal(win.showReportDetails('كشف حساب عميل'),'original');
});
test('Node: report search, CSV, print controls and shared AI inventory formatter are retained',()=>{
 const source=fs.readFileSync('index.html','utf8');
 assert.match(source,/<script src=["']\\.\\/anas-live-status\\.js["'] defer>/);
 assert.match(source,/function anasFilterCurrentReport\\(/);assert.match(source,/function anasExportCurrentReportCSV\\(/);assert.match(source,/function anasPrintCurrentReport\\(/);
 assert.match(script,/title==='تقرير مصادقة حساب العميل'\\|\\|title==='مصادقة حساب العميل'/);
 assert.match(css,/#cfgStoreNIF[\\s\\S]*?font-feature-settings:"tnum" 1/);assert.match(css,/\\.badge-active-tag[\\s\\S]*?word-break:keep-all/);
 assert.match(css,/\\.drawer-nav-row \\.row-icon[\\s\\S]*?min-width:28px/);assert.match(css,/body\\.dark-mode #aiHubTabContent[\\s\\S]*?#1e293b/);
 const metrics=source.slice(source.indexOf('function anasGetAiHubKpiMetrics(tabKey)'),source.indexOf('function anasRenderAiHubKpis()'));
 assert.equal((metrics.match(/value:inventoryValue/g)||[]).length,2);
});
test('Chromium: report DOM, LTR tax fields, nowrap badges and KPI light/dark contrast',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.setContent('<!doctype html><html><head></head><body><input id="cfgStoreNIF"><input id="cfgStoreRC"><input id="newCustNISInput"><input id="newSuppArtInput"><span class="badge-active-tag">مفعل</span><div class="drawer-nav-row"><span class="row-icon">TAX</span></div><div id="aiHubTabContent"><article class="anas-ai-hub-kpi-card"><span class="anas-ai-hub-kpi-label">المخزون</span><strong class="anas-ai-hub-kpi-value">123,456.78</strong></article></div><h2 id="customReportTitle"></h2><div id="customReportContent"></div><div id="customReportModal"><input id="anasReportSearch"></div></body></html>');
  await page.addStyleTag({content:css});
  await page.evaluate(data=>{window.AppData=data;window.applyReportDateRange=()=>true;window.getReportRange=()=>({from:'2026-02-01',to:'2026-02-28'});window.reportParseDate=v=>new Date(String(v).slice(0,10)+'T00:00:00');window.anasFilterCurrentReport=()=>{};window.showReportDetails=()=>'original';},fixture);
  await page.addScriptTag({content:script});await page.evaluate(()=>window.showReportDetails('تقرير مصادقة حساب العميل'));
  const report=await page.locator('#customReportContent').innerText();assert.match(report,/الرصيد الختامي المستحق للمصادقة/);assert.match(report,/بانتظار المطابقة/);assert.match(report,/1[\\s, ]001[\\s, ]250,00/);
  const light=await page.evaluate(()=>({dir:getComputedStyle(cfgStoreNIF).direction,num:getComputedStyle(cfgStoreNIF).fontVariantNumeric,badge:getComputedStyle(document.querySelector('.badge-active-tag')).whiteSpace,icon:getComputedStyle(document.querySelector('.row-icon')).whiteSpace,min:getComputedStyle(document.querySelector('.row-icon')).minWidth,bg:getComputedStyle(document.querySelector('.anas-ai-hub-kpi-card')).backgroundColor,val:getComputedStyle(document.querySelector('.anas-ai-hub-kpi-value')).color,label:getComputedStyle(document.querySelector('.anas-ai-hub-kpi-label')).color}));
  assert.equal(light.dir,'ltr');assert.match(light.num,/tabular-nums/);assert.equal(light.badge,'nowrap');assert.equal(light.icon,'nowrap');assert.equal(light.min,'28px');assert.equal(light.bg,'rgb(248, 250, 252)');assert.equal(light.val,'rgb(15, 23, 42)');assert.equal(light.label,'rgb(51, 65, 85)');
  await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
  const dark=await page.evaluate(()=>({bg:getComputedStyle(document.querySelector('.anas-ai-hub-kpi-card')).backgroundColor,val:getComputedStyle(document.querySelector('.anas-ai-hub-kpi-value')).color}));
  assert.equal(dark.bg,'rgb(30, 41, 59)');assert.equal(dark.val,'rgb(248, 250, 252)');
 }finally{await browser.close();}
});
