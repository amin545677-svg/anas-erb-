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


test('profit report uses invoice-line historical cost only and never current product cost fallback', () => {
  const start=html.indexOf('function anasHistoricalSaleUnitCost(item) {');
  const end=html.indexOf('function showProfitsReportModal()',start);
  assert.ok(start>=0&&end>start);
  const context={};
  vm.runInNewContext(html.slice(start,end)+';globalThis.resolveCost=anasHistoricalSaleUnitCost;',context);
  assert.equal(context.resolveCost({buyPrice:'12.50'}),12.5);
  assert.equal(context.resolveCost({costPrice:8}),8);
  assert.equal(context.resolveCost({purchasePrice:7}),7);
  assert.equal(context.resolveCost({}),null);
  assert.equal(context.resolveCost({buyPrice:null,costPrice:'4.25'}),4.25);
  assert.equal(context.resolveCost({buyPrice:'-1'}),null);
  const profitStart=html.indexOf('function showProfitsReportModal()');
  const profitEnd=html.indexOf('const ANAS_QUERY_OPTIONS',profitStart);
  const profitSource=html.slice(profitStart,profitEnd);
  assert.equal((profitSource.match(/anasHistoricalSaleUnitCost\(it\)/g)||[]).length,2);
  assert.doesNotMatch(profitSource,/prod\s*\?\s*prod\.buyPrice/);
  assert.match(profitSource,/لا يُستخدم سعر الشراء الحالي للمنتج بديلاً عن التكلفة التاريخية/);
});

test('all previously unlinked report routes have explicit AppData-backed handlers', () => {
  const titles = [
    'تقرير بالفواتير المرتجع-مبيعات','تقرير بفواتير المبيعات التي تم إلغاؤها','تقرير بعروض الأسعار','إجمالي الضرائب حسب الصنف','إجمالي الضرائب حسب العميل',
    'تقرير بحركة الرصيد الافتتاحي والقيد للعميل','تقرير بالفواتير للعميل','تقرير بالفواتير للعميل - إجمالي','تقرير بالفواتير المرتجع لعميل',
    'تقرير بسندات القبض لعميل','تقرير بسندات الصرف لعميل','تقرير بحركة التسديد لعميل','تقرير إجمالي حسب الصنف لعميل',
    'تقرير بحركة سداد العملاء','تقرير بحركة سداد العملاء حسب طريقة الدفع','تقرير بحركة الرصيد الافتتاحي والقيد للمورد',
    'تقرير بفواتير المورد','تقرير بفواتير المورد - إجمالي','تقرير بسندات الصرف لمورد','تقرير بسندات القبض لمورد',
    'تقرير بحركة التسديد لمورد','تقرير إجمالي حسب الصنف لمورد','تقرير بحركة سداد الموردين','تقرير بحركة سداد الموردين حسب طريقة الدفع',
    'تقرير رأس المال','حساب الزكاة','تقرير بالإقرار الضريبي','تقرير بالإقرار الضريبي مع المرتجع','تقرير بالمصروفات','تقرير بالمصروفات لحساب',
    'جرد مخزني حسب التصنيف','جرد مخزني لصنف','تقرير بالمنتجات حسب تاريخ الانتهاء','تقرير بالمنتجات التالفة'
  ];
  for (const title of titles) assert.ok(html.includes("case '"+title+"'"),title);
  assert.match(html,/const renderGenericReport = title =>/);
  assert.ok(html.includes('const reportSources=auditSourceMap[title]||[];'));
  assert.match(html,/background:var\(--mp-table-head/);
  assert.match(html,/background:var\(--mp-card-bg/);
  assert.match(html,/AppData\.returns/);
  assert.match(html,/AppData\.clientMovements/);
  assert.match(html,/AppData\.supplierMovements/);
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

test('saved report date range uses a real calendar-date matcher', () => {
  const start=html.indexOf('function reportParseDate(value)');
  const end=html.indexOf('// بدء التشغيل',start);
  assert.ok(start>=0&&end>start);
  const rangeInit=html.slice(start,end);
  assert.match(rangeInit,/\/\^\\d\{4\}-\\d\{2\}-\\d\{2}\$\//);
  assert.doesNotMatch(rangeInit,/\/\^\\\\d\{4\}/);
});

test('product kardex safely excludes invalid dates before computing opening balance', () => {
  assert.ok(html.includes("const before=all.filter(m=>{const d=reportParseDate(m.date);return !!(kardexFrom&&d&&reportLocalDateValue(d)<kardexFrom);});"));
  assert.ok(html.includes("sort((a,b)=>{const da=reportParseDate(a.date),db=reportParseDate(b.date);"));
});

test('dark AI quick actions and invoice/settings actions have explicit dark surfaces and readable text', () => {
  assert.match(safeCss,/#aiHubTabContent \.anas-ai-quick-actions button/);
  assert.match(safeCss,/background-color:#1e293b!important;[\s\S]*?color:#f8fafc!important/);
  assert.match(safeCss,/#view-invoices-list/);
  assert.match(safeCss,/#settingsModal/);
  assert.ok(contrastRatio('#f8fafc','#1e293b')>=4.5);
  assert.ok(contrastRatio('#f8fafc','#0f172a')>=4.5);
});

test('sale return inventory restoration reduces reported net cost as well as net profit', () => {
  assert.ok(html.includes("totalCost=Math.max(0,totalCost-Number(restoredCostCents)/100);"));
  assert.ok(html.includes("lineProfit-=Number(returnCents-restoredCostCents)/100;"));
});

test('AI executive dashboard shares the same centime-exact BigInt inventory valuation engine', () => {
  const start=html.indexOf('function anasRenderAiExecutiveDashboard()');
  const end=html.indexOf('\n        function ',start+1);
  assert.ok(start>=0&&end>start);
  const dashboard=html.slice(start,end);
  assert.match(dashboard,/const stockCostAggregate=anasInventoryCostAggregateCents\(products\)/);
  assert.match(dashboard,/const inventoryValue=stockCostAggregate\.totalCentimes\/100/);
  assert.match(dashboard,/stockCostAggregate\.invalidRecords/);
  assert.doesNotMatch(dashboard,/inventoryValue\s*\+=\s*row\.stock\s*\*\s*row\.cost/);
  assert.match(dashboard,/قيمة المخزون بسعر الشراء/);
});


test('AI hub renders four AppData-backed KPIs per tab and shares centime-exact inventory valuation', () => {
  const start=html.indexOf('function anasGetAiHubKpiMetrics(tabKey)');
  const end=html.indexOf('function anasRenderAiHubKpis()',start);
  assert.ok(start>=0&&end>start);
  const context={
    AppData:{
      products:[{stock:'2',buyPrice:'100'}],
      customers:[{debt:'20'}],
      suppliers:[{balance:'30'}],
      invoices:[{id:'I-1'}],
      clientMovements:[],
      purchases:[]
    },
    anasInventoryCostAggregateCents:()=>({totalCentimes:51154260,validRecords:1,invalidRecords:0}),
    anasPurchaseToCents:value=>value==null||String(value).trim()===''?NaN:Math.round(Number(value)*100),
    anasPurchaseToQtyUnits:value=>Number.isFinite(Number(value))?Math.round(Number(value)*1000000):NaN,
    anasGetInvoiceCollectionBalance:()=>({status:'valid',totalCents:10000,paidCents:4000,remainingCents:6000})
  };
  vm.runInNewContext(html.slice(start,end)+';globalThis.getMetrics=anasGetAiHubKpiMetrics;',context);
  for(const tab of ['all','products','customers','suppliers','invoices'])assert.equal(context.getMetrics(tab).length,4,tab);
  const allInventory=context.getMetrics('all').find(metric=>metric.label==='قيمة المخزون بسعر الشراء');
  const productInventory=context.getMetrics('products').find(metric=>metric.label==='قيمة المخزون بسعر الشراء');
  assert.equal(allInventory.value,'511,542.60 دج');
  assert.equal(productInventory.value,allInventory.value);
  assert.ok(html.includes('anasRenderAiHubKpis();'));
  assert.ok(html.includes('id="anasAiHubKpis"'));
});

test('AI KPI light theme, NIS fiscal fields and narrow labels have explicit mobile-safe styling', () => {
  assert.ok(safeCss.includes(':root:not([data-anas-theme="dark"]) #aiHubTabContent :is(.ai-stat-card,.kpi-card,.data-hub-card){background:#fff!important;color:#0f172a!important;'));
  assert.ok(safeCss.includes('.anas-ai-hub-kpi-value{display:block;color:#0f172a!important;'));
  assert.ok(safeCss.includes('[id*="NIS" i]'));
  assert.ok(safeCss.includes('direction:ltr!important;text-align:left!important;font-variant-numeric:tabular-nums!important'));
  assert.ok(safeCss.includes('.badge-active-tag'));
  assert.ok(safeCss.includes('.anas-ai-priority'));
  assert.ok(safeCss.includes('.drawer-nav-row .row-icon'));
  assert.ok(html.includes('class="anas-ai-priority"'));
});

test('all 50 visible report entries have explicit AppData-backed routes', () => {
  const start=html.indexOf('<section id="view-reports"');
  const end=html.indexOf('<!-- 11.',start);
  assert.ok(start>=0&&end>start);
  const markup=html.slice(start,end);
  const groups=[...markup.matchAll(/<section class="anas-query-group"[^>]*>([\s\S]*?)<\/section>/g)];
  const expected=[2,11,13,1,9,5,3,6];
  assert.equal(groups.length,8);
  const counts=groups.map(match=>(match[1].match(/data-report-entry/g)||[]).length);
  assert.deepEqual(counts,expected);
  assert.equal(counts.reduce((sum,value)=>sum+value,0),50);
  const reportHandlerStart=html.indexOf('function showReportDetails(title)');
  const reportHandlerEnd=html.indexOf('// أدوات احترافية مشتركة لكل تقارير',reportHandlerStart);
  assert.ok(reportHandlerStart>=0&&reportHandlerEnd>reportHandlerStart);
  const handler=html.slice(reportHandlerStart,reportHandlerEnd);
  const handled=new Set([
    ...[...handler.matchAll(/case '([^']+)'/g)].map(match=>match[1]),
    ...[...handler.matchAll(/title === '([^']+)'/g)].map(match=>match[1])
  ]);
  const reportRoutes=[...markup.matchAll(/onclick="showReportDetails\('([^']+)'\)"/g)].map(match=>match[1]);
  for(const title of reportRoutes)assert.ok(handled.has(title),'missing explicit handler: '+title);
  assert.ok(handler.includes('AppData.clientMovements'));
  assert.ok(handler.includes('AppData.expenses'));
  assert.ok(handler.includes('هذا التقرير غير مربوط حالياً بمصدر بيانات موثوق'));
  const profitStart=html.indexOf('function showProfitsReportModal()');
  const profitEnd=html.indexOf('function showReportDetails(title)',profitStart);
  assert.ok(profitStart>=0&&profitEnd>profitStart);
  assert.ok(html.slice(profitStart,profitEnd).includes('getReportInvoices'));
  assert.ok(html.includes('const allInvoices = Array.isArray(AppData.invoices) ? AppData.invoices : [];'));
  assert.ok(html.includes('const customers = Array.isArray(AppData?.customers) ? AppData.customers : [];'));
});

test('invoice share text contains complete receipt details and item lines', () => {
  const start=html.indexOf('function buildInvoiceShareText(inv)');
  const end=html.indexOf('function closeInvoicePostSaveActions()',start);
  assert.ok(start>=0&&end>start);
  const context={AppData:{storeConfig:{name:'متجر الاختبار',footer:'شكراً'}}};
  vm.runInNewContext(html.slice(start,end)+';globalThis.share=buildInvoiceShareText;',context);
  const message=context.share({id:'INV-77',date:'2026-11-14',customer:'عميل تجريبي',items:[{name:'شاي',qty:2,total:500}],total:500,paid:300,remaining:200});
  for(const value of ['متجر الاختبار','INV-77','2026-11-14','عميل تجريبي','شاي × 2 = 500 د.ج','الإجمالي: 500 د.ج','المدفوع: 300 د.ج','المتبقي: 200 د.ج'])assert.ok(message.includes(value),value);
});

test('store movement chart route renders a real accessible SVG chart', () => {
  const start=html.indexOf("if(title === 'حركة المتجر' || title === 'حركة المتجر - رسم بياني')");
  assert.ok(start>=0);
  const end=html.indexOf("} else if(title === 'تقرير فواتير الآجل')",start);
  const chart=html.slice(start,end);
  assert.ok(chart.includes('<svg viewBox="0 0 320 190" role="img" aria-label="رسم بياني لحركة المتجر"'));
  assert.ok(chart.includes('<rect x="8"'));
  assert.ok(chart.includes('bars.map'));
});
