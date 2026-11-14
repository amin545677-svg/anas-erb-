import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), 'utf8');
const html = read('index.html');
const cartJs = read('anas-pos-floating-cart.js');
const cartCss = read('anas-pos-floating-cart.css');
const safeCss = read('anas-erp-ui-safe-enhancements.css');

function contrastRatio(foreground, background) {
  const lum = hex => {
    const rgb = hex.match(/[0-9a-f]{2}/gi).map(v => parseInt(v,16)/255).map(v => v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
    return 0.2126*rgb[0]+0.7152*rgb[1]+0.0722*rgb[2];
  };
  const a=lum(foreground),b=lum(background);
  return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
}

test('strict report date parser rejects impossible calendar dates', () => {
  const start=html.indexOf('function reportParseDate(value)');
  const end=html.indexOf('\n        const ANAS_REPORT_RANGE_STORAGE_KEY',start);
  assert.ok(start>=0&&end>start);
  const context={};
  vm.runInNewContext(html.slice(start,end)+';globalThis.parseDate=reportParseDate;',context);
  assert.equal(context.parseDate('2026-02-31'),null);
  assert.equal(context.parseDate('2026-02-28').getDate(),28);
});

test('inventory cost aggregation is centime-exact and flags missing cost', () => {
  const start=html.indexOf('function anasInventoryCostAggregateCents(products)');
  const end=html.indexOf('\n        function anasPurchaseLineTotalForRecordCents',start);
  assert.ok(start>=0&&end>start);
  const context={
    anasPurchaseToQtyUnits:value=>Number.isFinite(Number(value))?Math.round(Number(value)*1000000):NaN,
    anasPurchaseToCents:value=>value==null||String(value).trim()===''?NaN:Math.round(Number(value)*100),
    anasPurchaseStockValueCents:(qty,cost)=>Number((BigInt(qty)*BigInt(cost)+500000n)/1000000n)
  };
  vm.runInNewContext(html.slice(start,end)+';globalThis.aggregate=anasInventoryCostAggregateCents;',context);
  const result=context.aggregate([{stock:'1.25',buyPrice:'10.01'},{stock:'0.5',buyPrice:'2.50'},{stock:'0',buyPrice:''},{stock:'2',buyPrice:''}]);
  assert.equal(result.totalCentimes,1376);
  assert.equal(result.validRecords,3);
  assert.equal(result.invalidRecords,1);
});

test('fractional POS weights use BigInt milliquantity and centime rounding', () => {
  const start=cartJs.indexOf('const QUICK_WEIGHT_MILLIS_MAP');
  const end=cartJs.indexOf('function currentCart()',start);
  assert.ok(start>=0&&end>start);
  const context={window:{}};
  vm.runInNewContext(cartJs.slice(start,end)+';globalThis.api={parseQtyToMillisBigInt,computeLineTotalCentimesBigInt,formatMillisToQtyString};',context);
  assert.equal(String(context.api.parseQtyToMillisBigInt('0.25')),'250');
  assert.equal(String(context.api.computeLineTotalCentimesBigInt(12500n,250n)),'3125');
  assert.equal(context.api.formatMillisToQtyString(250n),'0.25');
});

test('POS has one active checkout surface and hides legacy totals when cart is populated', () => {
  assert.match(cartJs,/view\.classList\.toggle\('anas-has-unified-cart',active&&cart\.length>0\)/);
  assert.match(cartCss,/#view-pos\.anas-has-unified-cart \.bottom-totals-bar\{display:none!important\}/);
  assert.match(cartJs,/computeLineTotalCentimesBigInt/);
});

test('customer statement invalid amounts are excluded from running balance, not converted to zero', () => {
  assert.ok(html.includes("const centsOf=m=>{if(Number.isSafeInteger(m.amountCentimes))return BigInt(m.amountCentimes);"));
  assert.ok(html.includes(String.raw`if(!/^\d+(?:\.\d{1,2})?$/.test(raw))return null;`));
  assert.ok(html.includes("const amount=centsOf(m),delta=signed(m);"));
});

test('profit report explicitly excludes incomplete-cost sales from confirmed profit', () => {
  assert.match(html,/incompleteCostRevenue/);
  assert.match(html,/ربح البنود مكتملة التكلفة فقط/);
  assert.match(html,/لم تُسجّل البنود الناقصة التكلفة كتكلفة صفر/);
  assert.doesNotMatch(html,/فسيُحسب الربح على أساس تكلفة صفر/);
});

test('expense grouping and product movement remain backed by AppData and BigInt', () => {
  assert.match(html,/const expenses=\(Array\.isArray\(AppData\.expenses\)\?AppData\.expenses:\[\]\)\.filter\(e=>reportItemInRange\(e\)\), groups=new Map\(\)/);
  assert.match(html,/const productRows=\[\],\{from:kardexFrom,to:kardexTo\}=getReportRange\(\)/);
  assert.match(html,/const svg=bars\.map/);
});

test('dark palette meets WCAG AA for navigation and scoped actions', () => {
  assert.ok(contrastRatio('#f8fafc','#0f172a')>=4.5);
  assert.ok(contrastRatio('#f8fafc','#1e293b')>=4.5);
  assert.ok(contrastRatio('#f8fafc','#334155')>=4.5);
  assert.match(html,/#anasQuickBottomNav\{background:#0f172a;border-color:#1e293b/);
  assert.match(safeCss,/#view-settings \.settings-card/);
  assert.match(safeCss,/#aiHubTabContent \.anas-ai-quick-actions/);
});

test('Hosting trigger includes app changes while Functions trigger excludes UI-only changes', () => {
  const hosting=read('.github/workflows/deploy-reverse-ledger-console-staging.yml');
  const functions=read('.github/workflows/deploy-reverse-ledger-functions-staging.yml');
  const hostPush=hosting.match(/\n  push:\n([\s\S]*?)\n\npermissions:/)?.[1]||'';
  const fnPush=functions.match(/\n  push:\n([\s\S]*?)\n\npermissions:/)?.[1]||'';
  for (const pattern of ["'index.html'","'erp/**'","'sw.js'","'anas-*.js'","'anas-*.css'","'firebase/**'","'.github/workflows/**'"]) assert.ok(hostPush.includes(pattern),pattern);
  assert.ok(fnPush.includes("'functions/**'"));
  for (const pattern of ["'index.html'","'erp/**'","'sw.js'","'anas-*.js'","'anas-*.css'","'firebase/**'"]) assert.ok(!fnPush.includes(pattern),pattern);
  assert.ok(fs.existsSync(new URL('.github/workflows/deploy-staging-firestore-rules.yml',root)));
});
