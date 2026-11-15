'use strict';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {chromium} from 'playwright';
const script=fs.readFileSync('anas-live-status.js','utf8'),css=fs.readFileSync('anas-erp-ui-safe-enhancements.css','utf8');
const indexSource = fs.readFileSync('index.html','utf8');
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
 assert.match(source,/<script src=["']\.\/anas-live-status\.js["'] defer>/);
 assert.match(source,/function anasFilterCurrentReport\(/);assert.match(source,/function anasExportCurrentReportCSV\(/);assert.match(source,/function anasPrintCurrentReport\(/);
 assert.match(script,/title==='تقرير مصادقة حساب العميل'\|\|title==='مصادقة حساب العميل'/);
 assert.match(css,/#cfgStoreNIF[\s\S]*?font-feature-settings:"tnum" 1/);assert.match(css,/\.badge-active-tag[\s\S]*?word-break:keep-all/);
 assert.match(css,/\.drawer-nav-row \.row-icon[\s\S]*?min-width:28px/);assert.match(css,/body\.dark-mode #aiHubTabContent[\s\S]*?#1e293b/);
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
  const report=await page.locator('#customReportContent').innerText();assert.match(report,/الرصيد الختامي المستحق للمصادقة/);assert.match(report,/بانتظار المطابقة/);assert.match(report,/10[\s, ]012,50/);
  const light=await page.evaluate(()=>({dir:getComputedStyle(document.getElementById('cfgStoreNIF')).direction,num:getComputedStyle(document.getElementById('cfgStoreNIF')).fontVariantNumeric,badge:getComputedStyle(document.querySelector('.badge-active-tag')).whiteSpace,icon:getComputedStyle(document.querySelector('.row-icon')).whiteSpace,min:getComputedStyle(document.querySelector('.row-icon')).minWidth,bg:getComputedStyle(document.querySelector('.anas-ai-hub-kpi-card')).backgroundColor,val:getComputedStyle(document.querySelector('.anas-ai-hub-kpi-value')).color,label:getComputedStyle(document.querySelector('.anas-ai-hub-kpi-label')).color}));
  assert.equal(light.dir,'ltr');assert.match(light.num,/tabular-nums/);assert.equal(light.badge,'nowrap');assert.equal(light.icon,'nowrap');assert.equal(light.min,'28px');assert.equal(light.bg,'rgb(248, 250, 252)');assert.equal(light.val,'rgb(15, 23, 42)');assert.equal(light.label,'rgb(51, 65, 85)');
  await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
  const dark=await page.evaluate(()=>({bg:getComputedStyle(document.querySelector('.anas-ai-hub-kpi-card')).backgroundColor,val:getComputedStyle(document.querySelector('.anas-ai-hub-kpi-value')).color,label:getComputedStyle(document.querySelector('.anas-ai-hub-kpi-label')).color}));
  assert.equal(dark.bg,'rgb(30, 41, 59)');assert.equal(dark.val,'rgb(248, 250, 252)');assert.equal(dark.label,'rgb(248, 250, 252)');
 }finally{await browser.close();}
});


function reconciliationRows(data,range={from:'2026-02-01',to:'2026-02-28'}){
 const win={document:{getElementById:()=>null,addEventListener:()=>{}},navigator:{onLine:true},addEventListener:()=>{},showReportDetails:()=>'original'};
 vm.runInNewContext(script,{window:win,BigInt,Map,Set,Date,String,Number,Object,Array});
 return win.anasBuildCustomerReconciliationRows(data,range,v=>v?new Date(String(v).slice(0,10)+'T00:00:00'):null);
}
function productionFunction(name){
 const start=indexSource.indexOf('function '+name+'(');
 assert.notEqual(start,-1,'production function not found: '+name);
 const end=indexSource.indexOf('\n        function ',start+1);
 assert.notEqual(end,-1,'production function boundary not found: '+name);
 return indexSource.slice(start,end);
}

test('1. Legacy invoice: initial payment, later receipt and POSTED return are each counted once',()=>{
 const data={customers:[{id:'L1',name:'عميل قديم'}],
  invoices:[{id:'OLD-1',customerId:'L1',total:100,paid:50,remaining:20,date:'2026-02-02'}],
  clientMovements:[
   {movementId:'OLD-RECEIPT',clientId:'L1',type:'receipt',amount:30,direction:'credit',invoiceId:'OLD-1',createdAt:'2026-02-05'},
   {movementId:'OLD-RETURN',clientId:'L1',type:'return_credit',amount:5,direction:'credit',referenceId:'OLD-RET',createdAt:'2026-02-06'}],
  returns:[{returnId:'OLD-RET',originalInvoiceId:'OLD-1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'POSTED',financialMovementIds:['OLD-RETURN']}]};
 const row=reconciliationRows(data).find(r=>r.customerId==='L1');
 assert.equal(row.periodDebitCents,8500n);assert.equal(row.periodCreditCents,3500n);assert.equal(row.closingBalanceCents,5000n);
 assert.equal(row.closingBalanceCents-(10000n-1500n-3000n-500n),0n,'centime reconciliation variance');
 assert.notEqual(row.closingBalanceCents,2000n,'stale remaining must be ignored');
});

test('2. Period continuity: closing balance equals the next period opening balance',()=>{
 const data={customers:[{id:'P1',name:'عميل الاستمرارية'}],
  invoices:[{id:'PERIOD-INV',customerId:'P1',total:100,paid:30,remaining:70,date:'2026-02-02'}],
  clientMovements:[
   {movementId:'PERIOD-R1',clientId:'P1',type:'receipt',amount:10,direction:'credit',invoiceId:'PERIOD-INV',createdAt:'2026-02-05'},
   {movementId:'PERIOD-R2',clientId:'P1',type:'receipt',amount:20,direction:'credit',invoiceId:'PERIOD-INV',createdAt:'2026-02-15'}],returns:[]};
 const first=reconciliationRows(data,{from:'2026-02-01',to:'2026-02-10'}).find(r=>r.customerId==='P1');
 const second=reconciliationRows(data,{from:'2026-02-11',to:'2026-02-20'}).find(r=>r.customerId==='P1');
 assert.equal(first.closingBalanceCents,9000n);assert.equal(second.openingBalanceCents,first.closingBalanceCents);assert.equal(second.closingBalanceCents,7000n);
});

test('3. Cancelled/voided invoices and DRAFT/REJECTED returns are excluded',()=>{
 const data={customers:[{id:'S1',name:'عميل حالات'}],
  invoices:[
   {id:'CANCELLED-1',customerId:'S1',total:100,paid:0,status:'cancelled',date:'2026-02-02'},
   {id:'VOIDED-1',customerId:'S1',total:200,paid:0,status:'voided',date:'2026-02-03'},
   {id:'VALID-1',customerId:'S1',total:50,paid:0,date:'2026-02-04'}],
  clientMovements:[
   {movementId:'VOID-DEBIT',clientId:'S1',type:'invoice_debit',amount:200,direction:'debit',referenceId:'VOIDED-1',createdAt:'2026-02-03'},
   {movementId:'DRAFT-RETURN',clientId:'S1',type:'return_credit',amount:10,direction:'credit',referenceId:'RET-DRAFT',createdAt:'2026-02-05'},
   {movementId:'REJECTED-RETURN',clientId:'S1',type:'return_credit',amount:20,direction:'credit',referenceId:'RET-REJECTED',createdAt:'2026-02-06'}],
  returns:[
   {returnId:'RET-DRAFT',originalInvoiceId:'VALID-1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'DRAFT',financialMovementIds:['DRAFT-RETURN']},
   {returnId:'RET-REJECTED',originalInvoiceId:'VALID-1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'REJECTED',financialMovementIds:['REJECTED-RETURN']}]};
 const row=reconciliationRows(data).find(r=>r.customerId==='S1');
 assert.equal(row.periodDebitCents,5000n);assert.equal(row.periodCreditCents,0n);assert.equal(row.closingBalanceCents,5000n);
});

test('4. Actual production search, CSV export and print run on the generated reconciliation table',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:900,height:700}});
  await page.setContent('<!doctype html><html><head></head><body><h2 id="customReportTitle"></h2><div id="customReportContent"></div><div id="customReportModal"><input id="anasReportSearch"></div><div id="anasReportFilterStatus"></div></body></html>');
  await page.evaluate(data=>{
   window.AppData=data;window.applyReportDateRange=()=>true;window.getReportRange=()=>({from:'2026-02-01',to:'2026-02-28'});
   window.reportParseDate=v=>new Date(String(v).slice(0,10)+'T00:00:00');window.showReportDetails=()=> 'original';
   window.anasNormalizeQueryText=q=>String(q||'').toLocaleLowerCase();window.anasQueryMatches=(values,q)=>!q||values.join(' ').toLocaleLowerCase().includes(q);
  },{customers:[{id:'UI1',name:'عميل المصادقة',phone:'0550000001'},{id:'UI2',name:'عميل قديم',phone:'0550000002'}],
   invoices:[{id:'UI-INV1',customerId:'UI1',total:30,paid:10,date:'2026-02-01'},{id:'UI-INV2',customerId:'UI2',total:10,paid:5,date:'2026-02-05'}],clientMovements:[],returns:[]});
  const funcs=['anasFilterCurrentReport','anasCsvCell','anasExportCurrentReportCSV','anasPrintCurrentReport'].map(productionFunction).join('\n');
  await page.addScriptTag({content:funcs});await page.addScriptTag({content:script});
  await page.evaluate(()=>window.showReportDetails('تقرير مصادقة حساب العميل'));
  assert.equal(await page.locator('#customReportContent tbody tr').count(),2);
  await page.evaluate(()=>window.anasFilterCurrentReport('عميل قديم'));
  assert.equal(await page.locator('#customReportContent tbody tr:not([hidden])').count(),1);
  assert.match(await page.locator('#anasReportFilterStatus').innerText(),/1 من 2/);
  await page.evaluate(()=>{
   window.anasFilterCurrentReport('');URL.createObjectURL=blob=>{window.__csvBlob=blob;return 'blob:anas-test';};
   HTMLAnchorElement.prototype.click=function(){window.__csvFilename=this.download;};window.anasExportCurrentReportCSV();
  });
  const csv=await page.evaluate(async()=>await window.__csvBlob.text());
  const visibleRows=await page.locator('#customReportContent tbody tr:not([hidden])').allInnerTexts();
  assert.equal(visibleRows.length,2);assert.match(csv,/عميل المصادقة/);assert.match(csv,/عميل قديم/);assert.match(csv,/الرصيد الختامي المستحق للمصادقة/);
  for(const row of visibleRows)for(const cell of row.split('\t'))assert.ok(csv.includes(cell),'CSV missing table cell: '+cell);
  await page.evaluate(()=>{
   window.__printedHtml='';window.open=()=>({document:{open(){},write(html){window.__printedHtml=html;},close(){}},focus(){},print(){window.__didPrint=true;}});
   window.anasPrintCurrentReport();
  });
  await page.waitForTimeout(350);
  const printed=await page.evaluate(()=>({html:window.__printedHtml,didPrint:!!window.__didPrint}));
  assert.equal(printed.didPrint,true);assert.match(printed.html,/عميل المصادقة/);assert.match(printed.html,/عميل قديم/);assert.match(printed.html,/<table>/);assert.match(printed.html,/تقرير مصادقة حساب العميل/);
 }finally{await browser.close();}
});

test('5. Existing invoice_debit remains canonical and prevents a second invoice debit',()=>{
 const data={customers:[{id:'D1',name:'عميل دفتر'}],
  invoices:[{id:'CANON-1',customerId:'D1',total:100,paid:50,remaining:50,date:'2026-02-02'}],
  clientMovements:[
   {movementId:'CANON-DEBIT',clientId:'D1',type:'invoice_debit',amount:100,direction:'debit',referenceId:'CANON-1',createdAt:'2026-02-02'},
   {movementId:'CANON-RECEIPT',clientId:'D1',type:'receipt',amount:50,direction:'credit',invoiceId:'CANON-1',createdAt:'2026-02-03'}],returns:[]};
 const row=reconciliationRows(data).find(r=>r.customerId==='D1');
 assert.equal(row.periodDebitCents,10000n);assert.equal(row.periodCreditCents,5000n);assert.equal(row.closingBalanceCents,5000n);
});

test('6. Allocation links apportion a shared receipt across invoices of the same client exactly once',()=>{
 const data={customers:[{id:'A1',name:'عميل ألف'}],
  invoices:[{id:'ALLOC-A',customerId:'A1',total:100,paid:40,date:'2026-02-02'},{id:'ALLOC-B',customerId:'A1',total:80,paid:20,date:'2026-02-02'}],
  clientMovements:[{movementId:'ALLOC-RECEIPT',clientId:'A1',type:'receipt',amount:40,direction:'credit',createdAt:'2026-02-03',
   allocations:[{invoiceId:'ALLOC-A',amount:25},{invoiceId:'ALLOC-B',amount:15}]}],returns:[]};
 const row=reconciliationRows(data).find(r=>r.customerId==='A1');
 assert.equal(row.periodDebitCents,16000n);assert.equal(row.periodCreditCents,4000n);assert.equal(row.closingBalanceCents,12000n);
});

test('7. ANAS POS settlementAllocations: gross sale, initial payment, later receipt and return are counted once',()=>{
 const data={customers:[{id:'POS-C',name:'عميل نقطة البيع'}],
  invoices:[{id:'POS-INV',customerId:'POS-C',total:100,paid:30,remaining:70,date:'2026-02-02'}],
  cashMovements:[{id:'CASH-SALE-POS-INV',type:'add',amount:30,referenceType:'sales_invoice',referenceId:'POS-INV',date:'2026-02-02'}],
  clientMovements:[
   {movementId:'CL-REC-CASH-REC-4',clientId:'POS-C',type:'receipt',amountCentimes:4000,direction:'credit',referenceType:'customer_debt',referenceId:'POS-C',createdAt:'2026-02-05'},
   {movementId:'POS-RETURN',clientId:'POS-C',type:'return_credit',amountCentimes:1000,direction:'credit',referenceId:'POS-RET',createdAt:'2026-02-06'}],
  returns:[{returnId:'POS-RET',originalInvoiceId:'POS-INV',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'POSTED',financialMovementIds:['POS-RETURN']}],
  settlementAllocations:[
   {allocationId:'ALLOC-SALE-POS-INV',partyType:'customer',partyId:'POS-C',invoiceType:'sales_invoice',invoiceId:'POS-INV',sourceMovementId:'CASH-SALE-POS-INV',sourceMovementType:'sales_invoice',amountCentimes:3000,createdAt:'2026-02-02'},
   {allocationId:'ALLOC-RECEIPT-POS-INV',partyType:'customer',partyId:'POS-C',invoiceType:'sales_invoice',invoiceId:'POS-INV',sourceMovementId:'CASH-REC-4',sourceMovementType:'customer_debt',amountCentimes:4000}
  ]};
 const row=reconciliationRows(data).find(r=>r.customerId==='POS-C');
 assert.equal(row.periodDebitCents,10000n,'gross invoice amount is reported as customer withdrawals');
 assert.equal(row.periodCreditCents,8000n,'initial sale payment, later receipt and POSTED return are each credited once');
 assert.equal(row.closingBalanceCents,2000n);
});

test('8. Exact financial triangle: 900.00 invoice, 400.00 initial cash and 200.00 later receipt reconcile to 300.00',()=>{
 const data={customers:[{id:'UAT-C',name:'عميل اختبار المثلث'}],
  invoices:[{id:'UAT-INV-900',customerId:'UAT-C',total:900,paid:400,remaining:500,date:'2026-11-15T10:00:00'}],
  cashMovements:[
   {id:'SALE-CASH-UAT-INV-900',type:'add',amount:400,referenceType:'sales_invoice',referenceId:'UAT-INV-900',date:'2026-11-15T10:00:00'},
   {id:'DEBT-RECEIPT-200',type:'add',amount:200,referenceType:'customer_debt',referenceId:'UAT-C',date:'2026-11-15T11:00:00'}],
  clientMovements:[
   {movementId:'CL-INV-UAT-INV-900',clientId:'UAT-C',type:'invoice_debit',amountCentimes:50000,direction:'debit',referenceType:'sales_invoice',referenceId:'UAT-INV-900',createdAt:'2026-11-15T10:00:00'},
   {movementId:'CL-REC-DEBT-RECEIPT-200',clientId:'UAT-C',type:'receipt',amountCentimes:20000,direction:'credit',referenceType:'customer_debt',referenceId:'UAT-C',createdAt:'2026-11-15T11:00:00'}],
  settlementAllocations:[
   {allocationId:'ALLOC-SALE-UAT-INV-900',partyType:'customer',partyId:'UAT-C',invoiceType:'sales_invoice',invoiceId:'UAT-INV-900',sourceMovementId:'SALE-CASH-UAT-INV-900',sourceMovementType:'sales_invoice',amountCentimes:40000,createdAt:'2026-11-15T10:00:00'},
   {allocationId:'ALLOC-RECEIPT-UAT-INV-900',partyType:'customer',partyId:'UAT-C',invoiceType:'sales_invoice',invoiceId:'UAT-INV-900',sourceMovementId:'DEBT-RECEIPT-200',sourceMovementType:'customer_debt',amountCentimes:20000,createdAt:'2026-11-15T11:00:00'}
  ],returns:[]};
 const row=reconciliationRows(data).find(r=>r.customerId==='UAT-C');
 assert.equal(row.periodDebitCents,90000n);
 assert.equal(row.periodCreditCents,60000n);
 assert.equal(row.closingBalanceCents,30000n);
 assert.equal(row.invalidRows,0);
 assert.equal(row.missingDateRows,0);
});
