'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync('index.html','utf8');
const start=html.indexOf('function reportParseDate(value) {');
const end=html.indexOf("\n        const ANAS_REPORT_RANGE_STORAGE_KEY",start);
assert.ok(start>=0&&end>start,'report parser must exist');
const parseDate=vm.runInNewContext('(()=>{'+html.slice(start,end)+';return reportParseDate;})()');
test('five real-world invoice date shapes including Arabic clock suffixes are accepted',()=>{
 const invoices=[
  {id:'INV-1',date:'2026/11/14, 12:43:17'},
  {id:'INV-2',date:'2026/11/8, 2:31:22 م'},
  {id:'INV-3',date:'2026/11/7, 7:40:03 ص'},
  {id:'INV-4',invoiceDate:'2026-11-06T09:15:00'},
  {id:'INV-5',createdAt:'14/11/2026'}
 ];
 const parsed=invoices.map(x=>parseDate(x.date||x.invoiceDate||x.createdAt));
 assert.equal(parsed.filter(Boolean).length,5);
 assert.deepEqual(parsed.map(d=>d&&[d.getFullYear(),d.getMonth()+1,d.getDate()]),[[2026,11,14],[2026,11,8],[2026,11,7],[2026,11,6],[2026,11,14]]);
 assert.equal(parseDate('2026-02-31'),null);
 assert.equal(parseDate('2026-04-31'),null);
 assert.ok(parseDate('2024-02-29'));
});
test('Arabic-Indic and Persian digits and epoch milliseconds parse safely',()=>{
 assert.deepEqual([parseDate('٢٠٢٦/١١/٨'),parseDate('۲۰۲۶-۱۱-۰۷')].map(d=>d&&[d.getFullYear(),d.getMonth()+1,d.getDate()]),[[2026,11,8],[2026,11,7]]);
 assert.ok(parseDate(Date.UTC(2026,10,14)));
});
test('report range prioritizes supported alternate date fields',()=>{
 const start=html.indexOf('function reportItemInRange('),end=html.indexOf('\n        function getReportInvoices',start);
 assert.ok(start>=0&&end>start);
 const source=html.slice(start,end);
 for(const key of ["'date'","'invoiceDate'","'createdAt'","'timestamp'","'time'","'day'"])assert.ok(source.includes(key),key+' must be supported');
});

test('store movement buttons render the full modal with SVG, print and CSV actions',()=>{
 const runtime=fs.readFileSync('anas-live-status.js','utf8');
 for(const token of ['renderStoreMovementReport','customReportModal','anas-store-movement-kpis','data-store-print','data-store-csv','<svg viewBox'])assert.ok(runtime.includes(token),token+' must be wired');
 assert.match(runtime,/title==='حركة المتجر'\|\|title==='حركة المتجر - رسم بياني'/);
});
test('customer ledger uses the shared ordered date resolver and inquiry tabs exist',()=>{
 const runtime=fs.readFileSync('anas-live-status.js','utf8');
 assert.ok(runtime.includes('const dateOf=row=>reportRecordDate(row)'));
 for(const token of ['invoiceDate','createdAt','timestamp','time','day','anas-inquiry-filter-tabs'])assert.ok(runtime.includes(token),token+' must be supported');
});

test('sales report includes all five Arabic date/time invoice shapes and falls through invalid preferred fields',()=>{
 const rangeStart=html.indexOf('function reportItemInRange(');
 const rangeEnd=html.indexOf('function getReportPurchases()',rangeStart);
 assert.ok(rangeStart>=0&&rangeEnd>rangeStart,'sales report range functions must be isolatable');
 const rangeSource=html.slice(rangeStart,rangeEnd);
 const invoices=[
  {id:'INV-AR-1',date:'2026/11/14, 12:43:17'},
  {id:'INV-AR-2',date:'2026/11/8, 2:31:22 م'},
  {id:'INV-AR-3',date:'2026/11/7, 7:40:03 ص'},
  {id:'INV-AR-4',invoiceDate:'2026-11-06T09:15:00'},
  {id:'INV-AR-5',createdAt:'14/11/2026'},
  {id:'INV-AR-6',date:'invalid-date',invoiceDate:'2026-11-12T14:00:00 م'}
 ];
 const context={AppData:{invoices},getReportRange:()=>({from:'2026-11-01',to:'2026-11-30'}),
  reportParseDate:parseDate,reportLocalDateValue:d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
 vm.createContext(context);vm.runInContext(rangeSource,context);
 const matched=vm.runInContext('getReportInvoices()',context);
 assert.equal(matched.length,6,'all five Arabic/alternate date shapes plus invalid-first-field fallback must be included');
 assert.deepEqual(matched.map(x=>x.id),invoices.map(x=>x.id));
});
