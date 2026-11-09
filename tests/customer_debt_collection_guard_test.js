const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const customerDebtProtection = require('../customer-debt-protection.js');

const html = fs.readFileSync('index.html', 'utf8');
const currentHtml = html;
const helperStart = html.indexOf('const ANAS_QTY_SCALE = 1000000;');
const helperEnd = html.indexOf('function updatePaymentMethodFromAmount()', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'integer-centime helpers must be present and isolatable');
const helperSource = html.slice(helperStart, helperEnd);
const start = html.indexOf('async function collectCustDebt(cId) {');
const end = html.indexOf('function openGoogleMaps(loc)', start);
assert.ok(start >= 0 && end > start, 'collectCustDebt function must be present and isolatable');
const source = helperSource + html.slice(start, end);
const fixedNow = 1234567890123;
class FixedDate extends Date {
  static now() { return fixedNow; }
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
}

async function runCollection({ movements = [], debt = 100, cash = 0, amount = '25', saveResult = true, math = Math, customerId = 'C-1', invoices = null } = {}) {
  const alerts = [];
  let saves = 0;
  let legacySaves = 0;
  const customer = { id: customerId, name: 'Test customer', debt };
  const invoice = { id: 'INV-1', customerId: customerId, total: debt, paid: 0, remaining: debt };
  const appData = {
    customers: [customer], invoices: invoices || [invoice],
    caisseBalance: cash,
    cashMovements: movements.map(m => ({ ...m }))
  };
  let promptCount = 0;
  const context = {
    AppData: appData,
    ANASReverseLedger: require('../reverse-ledger/reverse-ledger.js'),
    alert: message => alerts.push(String(message)),
    prompt: () => (++promptCount === 1 ? amount : JSON.stringify([{ invoiceId: 'INV-1', amount }])) ,
    saveDB: () => { legacySaves++; return true; },
    saveDBDurably: () => { saves++; return saveResult ? Promise.resolve(true) : Promise.reject(new Error('simulated durable persistence failure')); },
    updateCashUI() {},
    renderCustomersDebts() {},
    console,
    Date: FixedDate,
    Math: math,
    Number, String, Object, Array, Set
  };
  vm.createContext(context);
  await vm.runInContext(source + '\ncollectCustDebt(' + JSON.stringify(String(customerId)) + ');', context);
  return { appData, customer, alerts, saves, legacySaves };
}

(async () => {
{
  const before = [{ id: 'CASH-1', amount: 10 }, { id: 'CASH-1', amount: 20 }];
  const result = await runCollection({ movements: before, amount: '25' });
  assert.equal(result.saves, 0, 'duplicate ledger IDs must be rejected before persistence');
  assert.equal(result.customer.debt, 100, 'customer debt must remain unchanged');
  assert.equal(result.appData.caisseBalance, 0, 'cash balance must remain unchanged');
  assert.equal(result.appData.cashMovements.length, 2, 'ledger must not be overwritten or appended');
  assert.ok(result.alerts.some(message => message.includes('معرّفات مكررة')), 'user must be told why collection was stopped');
}

{
  const result = await runCollection({ movements: [{ id: 'LEGACY-1', amount: 10 }], amount: '25' });
  assert.equal(result.saves, 1);
  assert.equal(result.legacySaves, 1, 'V42 saveDB hook must capture the mutation before the durable acknowledgement');
  assert.equal(result.customer.debt, 75);
  assert.equal(result.appData.caisseBalance, 25);
  assert.equal(result.appData.cashMovements.length, 2);
  assert.equal(new Set(result.appData.cashMovements.map(m => m.id)).size, 2, 'new movement ID must be unique');
}

{
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => 0.5;
  const baseId = 'DEBT-IN-' + fixedNow.toString(36).toUpperCase() + '-' + (0.5).toString(36).slice(2, 7).toUpperCase();
  const result = await runCollection({ movements: [{ id: baseId, amount: 1 }], amount: '25', math: deterministicMath });
  assert.equal(result.saves, 1);
  assert.equal(result.appData.cashMovements.length, 2);
  assert.equal(result.appData.cashMovements[0].id, baseId + '-1', 'new movement ID collision must be resolved with a suffix');
  assert.equal(new Set(result.appData.cashMovements.map(m => m.id)).size, 2);
}

{
  const original = [{ id: 'CASH-1', amount: 10 }];
  const result = await runCollection({ movements: original, amount: '25', saveResult: false });
  assert.equal(result.saves, 1);
  assert.equal(result.legacySaves, 1, 'V42 capture hook runs once before a failed durable acknowledgement');
  assert.ok(result.alerts.some(message => message.includes('لم يتم اعتماد القبض')) || result.alerts.some(message => message.includes('لم يتم تسجيل')),
    'failed durable acknowledgement must not report collection success');
  assert.equal(result.customer.debt, 100, 'failed persistence must restore customer debt');
  assert.equal(result.appData.caisseBalance, 0, 'failed persistence must restore cash balance');
  assert.deepEqual(result.appData.cashMovements.map(m => m.id), ['CASH-1'], 'failed persistence must restore the original ledger');
}

console.log('PASS: duplicate cash movement IDs fail closed');
console.log('PASS: normal customer debt collection updates debt, cash and ledger');
console.log('PASS: generated cash movement ID collisions are resolved');
console.log('PASS: failed persistence rolls back customer debt, cash and ledger');

{
  for (const customerId of ['', '   ']) {
    const result = await runCollection({ customerId, amount: '25' });
    assert.equal(result.saves, 0, 'customer without a stable ID must not be used for debt collection');
    assert.equal(result.customer.debt, 100, 'invalid-identity customer debt must remain unchanged');
    assert.equal(result.appData.caisseBalance, 0, 'invalid-identity collection must not alter cash');
    assert.equal(result.appData.cashMovements.length, 0, 'invalid-identity collection must not append a cash movement');
    assert.ok(result.alerts.some(message => message.includes('معرّف صالح')), 'operator must be told a valid customer identity is required');
  }
}
console.log('PASS: customer debt collection rejects blank or whitespace-only customer IDs before mutation');

{
  const app = fs.readFileSync('index.html', 'utf8');
  const customerStart = app.indexOf('function saveNewCustomerMpos()');
  const customerEnd = app.indexOf('function openCustomerDirectory()', customerStart);
  const supplierStart = app.indexOf('function saveNewSupplierMpos()');
  const supplierEnd = app.indexOf('function printLatestLegalCustomerInvoice()', supplierStart);
  assert.ok(customerStart >= 0 && customerEnd > customerStart, 'customer save handler must be isolatable');
  assert.ok(supplierStart >= 0 && supplierEnd > supplierStart, 'supplier save handler must be isolatable');
  const customerSave = app.slice(customerStart, customerEnd);
  const supplierSave = app.slice(supplierStart, supplierEnd);
  assert.ok(customerSave.includes('debt > Number.MAX_SAFE_INTEGER'), 'customer debt must reject values beyond safe financial range');
  assert.ok(supplierSave.includes('debt > Number.MAX_SAFE_INTEGER'), 'supplier balance must reject values beyond safe financial range');
}
console.log('PASS: customer and supplier opening balances reject values beyond the safe financial range');

function runOpeningBalanceGuard(handlerName, fieldId, collectionName, invalidValue) {
  const start = html.indexOf('function ' + handlerName + '()');
  const end = html.indexOf('\n        function ', start + 10);
  assert.ok(start >= 0 && end > start, handlerName + ' must be isolatable');
  const handler = html.slice(start, end);
  const fields = {};
  const ids = handlerName === 'saveNewCustomerMpos'
    ? ['newCustNameInput','newCustPhoneInput','newCustPhone2Input','newCustRCInput','newCustNIFInput','newCustNISInput','newCustArtInput','newCustAddressInput','newCustLocationInput','newCustDebtInput']
    : ['newSuppNameInput','newSuppPhoneInput','newSuppRCInput','newSuppNIFInput','newSuppArtInput','newSuppAddressInput','newSuppDebtInput'];
  for (const id of ids) fields[id] = { value: id === (fieldId) ? invalidValue : (id.endsWith('NameInput') ? 'Test name' : '0'), focus() {} };
  const existing = [{ id: 'EXISTING', name: 'Existing record', debt: 10, balance: 10 }];
  const appData = { [collectionName]: existing };
  const alerts = [];
  let saves = 0;
  const context = {
    window: customerDebtProtection,
    AppData: appData, editingCustomerId: null,
    document: { getElementById: id => fields[id] || null },
    alert: message => alerts.push(String(message)),
    saveDB: () => { saves++; return true; },
    Number, String, Object, Array, Date, Math, JSON,
    console, closeModal() {}, renderCustomersDebts() {}, renderCustomerDirectory() {},
    renderSuppliersDebts() {}
  };
  vm.createContext(context);
  vm.runInContext(handler + '\n' + handlerName + '();', context);
  assert.equal(saves, 0, handlerName + ' must not persist invalid opening balance ' + invalidValue);
  assert.equal(appData[collectionName].length, 1, handlerName + ' must not mutate records for invalid balance ' + invalidValue);
  assert.ok(alerts.some(message => message.includes('المجال المالي الآمن')), handlerName + ' must explain the safe financial range');
}
for (const invalidValue of ['9007199254740992', '1e309', '-1']) {
  runOpeningBalanceGuard('saveNewCustomerMpos', 'newCustDebtInput', 'customers', invalidValue);
  runOpeningBalanceGuard('saveNewSupplierMpos', 'newSuppDebtInput', 'suppliers', invalidValue);
}
console.log('PASS: runtime customer and supplier handlers reject unsafe, infinite, and negative opening balances before persistence');

{
  const customerStart = html.indexOf('function saveNewCustomerMpos()');
  const customerEnd = html.indexOf('function openCustomerDirectory()', customerStart);
  const supplierStart = html.indexOf('function saveNewSupplierMpos()');
  const supplierEnd = html.indexOf('function printLatestLegalCustomerInvoice()', supplierStart);
  assert.ok(customerStart >= 0 && customerEnd > customerStart, 'customer save handler must be isolatable');
  assert.ok(supplierStart >= 0 && supplierEnd > supplierStart, 'supplier save handler must be isolatable');
  const customerSave = html.slice(customerStart, customerEnd);
  const supplierSave = html.slice(supplierStart, supplierEnd);
  assert.ok(customerSave.includes('const customerIds = new Set()'), 'customer save must validate existing record IDs');
  assert.ok(customerSave.includes('معرّفات مكررة'), 'customer save must reject duplicate IDs');
  assert.ok(customerSave.includes('عنصر تالف'), 'customer save must reject malformed records');
  assert.ok(supplierSave.includes('const supplierIds = new Set()'), 'supplier save must validate existing record IDs');
  assert.ok(supplierSave.includes('معرّفات مكررة'), 'supplier save must reject duplicate IDs');
  assert.ok(supplierSave.includes('عنصر تالف'), 'supplier save must reject malformed records');
}
console.log('PASS: customer and supplier saves fail closed on malformed records and duplicate IDs');


{
  const result = await runCollection({debt:0.3,cash:100.1,amount:'0.1'});
  assert.equal(result.saves,1);
  assert.equal(result.customer.debt,0.2,'debt reduction must be exact to the centime');
  assert.equal(result.appData.caisseBalance,100.2,'cash increase must be exact to the centime');
  assert.equal(result.appData.cashMovements[0].amount,0.1,'cash movement amount must match the collected centimes');
}
{
  const result = await runCollection({debt:0.3,cash:100.1,amount:'0.105'});
  assert.equal(result.customer.debt,0.19,'half-cent amount must normalize once to 0.11 DZD');
  assert.equal(result.appData.caisseBalance,100.21);
  assert.equal(result.appData.cashMovements[0].amount,0.11);
}
console.log('PASS: debt collection and cash receipt use the same integer-centime arithmetic');

{
  const invoices = [
    { id: 'INV-OLD', customerId: 'C-1', date: '2026-01-01T10:00:00Z', total: 30, paid: 0, remaining: 30 },
    { id: 'INV-MID', customerId: 'C-1', date: '2026-02-01T10:00:00Z', total: 50, paid: 10, remaining: 40 },
    { id: 'INV-NEW', customerId: 'C-1', date: '2026-03-01T10:00:00Z', total: 60, paid: 0, remaining: 60 }
  ];
  const result = await runCollection({ debt: 100, cash: 10, amount: '45', invoices });
  assert.equal(result.saves, 1, 'FIFO receipt must commit exactly once');
  assert.equal(result.customer.debt, 55, 'customer debt must decrease by the exact receipt');
  assert.equal(result.appData.caisseBalance, 55, 'cashbox must receive the exact receipt');
  assert.deepEqual(Array.from(result.appData.settlementAllocations, x => [x.invoiceId, x.amountCentimes]),
    [['INV-OLD', 3000], ['INV-MID', 1500]], 'allocation must exhaust the oldest invoice before moving to the next');
  assert.equal(invoices[0].remaining, 30, 'original invoice balances remain immutable ledger facts');
  assert.equal(invoices[1].remaining, 40, 'settlement allocations must not rewrite original invoice totals');
  assert.equal(invoices[2].remaining, 60, 'newer invoices remain untouched when the receipt is exhausted');
  const viewStart = currentHtml.indexOf('function anasGetInvoiceCollectionBalance(invoice)');
  const viewEnd = currentHtml.indexOf('function renderInvoicesList()', viewStart);
  assert.ok(viewStart >= 0 && viewEnd > viewStart, 'invoice list must expose a derived collection-balance helper');
  const viewContext = {
    AppData: { settlementAllocations: result.appData.settlementAllocations },
    anasToCents: value => Math.round(Number(value) * 100),
    Number, String, Object, Array, Set, BigInt
  };
  vm.createContext(viewContext);
  vm.runInContext(currentHtml.slice(viewStart, viewEnd), viewContext);
  const oldState = viewContext.anasGetInvoiceCollectionBalance(invoices[0]);
  const middleState = viewContext.anasGetInvoiceCollectionBalance(invoices[1]);
  assert.equal(oldState.status, 'paid');
  assert.equal(oldState.remainingCents, 0);
  assert.equal(middleState.status, 'partial');
  assert.equal(middleState.remainingCents, 2500);
  assert.match(currentHtml, /const collectionBalance = anasGetInvoiceCollectionBalance\(inv\)/,
    'invoice cards must render the derived FIFO balance rather than stale original fields');
  assert.equal(result.appData.cashMovements[0].referenceType, 'customer_debt');
  assert.equal(result.appData.cashMovements[0].amount, 45);
}
console.log('PASS: customer debt receipt allocates oldest-first and updates invoice collection balances/statuses');



{
  const currentHtml = fs.readFileSync('index.html', 'utf8');
  assert.match(currentHtml, /isPiece && qtyUnits % 1000000 !== 0/,
    'POS must reject fractional quantities for piece-counted products');
  assert.match(currentHtml, /isWeight && qtyUnits % 10000 !== 0/,
    'POS must enforce at most two decimal places for kilogram quantities');
  assert.match(currentHtml, /async function triggerAiGeneration\(section\)[\s\S]*?anasLoadSheetJs\(\)[\s\S]*?bookType:'xlsx'/,
    'Excel templates must be generated as XLSX by the local offline SheetJS loader');
  assert.match(currentHtml, /قالب_المنتجات\.xlsx[\s\S]*?قالب_العملاء\.xlsx[\s\S]*?قالب_الموردين\.xlsx/,
    'all three Arabic Excel templates must be available locally');
  assert.match(currentHtml, /function anasCalculateExecutiveAnalytics\([\s\S]*?grossCents[\s\S]*?netCents/,
    'executive analytics must separate gross profit and net profit');
  assert.match(currentHtml, /const product = saleProducts\.get\(String\(it\.id\)\)[\s\S]*?costPrice/,
    'new invoices must snapshot acquisition cost per sale line');
  assert.doesNotMatch(currentHtml, /it\.price\s*\*\s*0\.8/,
    'analytics must never invent COGS as 80 percent of the selling price');
  assert.match(currentHtml, /id="luminaNetProfit"/,
    'analytics UI must display net profit after operating expenses');
}
console.log('PASS: unit guards, offline XLSX templates and cost-snapshot net-profit analytics are present');

{
  const invoices = [
    { id: 'INV-FIFO-OLD', customerId: 'C-1', total: 5000, paid: 0, remaining: 5000, date: '2026-11-01' },
    { id: 'INV-FIFO-NEW', customerId: 'C-1', total: 8387.5, paid: 0, remaining: 8387.5, date: '2026-11-05' }
  ];
  const result = await runCollection({ invoices, debt: 13387.5, cash: 0, amount: '13387.50' });
  assert.equal(result.saves, 1);
  assert.equal(result.customer.debt, 0);
  assert.equal(result.appData.caisseBalance, 13387.5);
  assert.equal(result.appData.cashMovements.at(-1).amount, 13387.5);
  assert.equal(JSON.stringify(result.appData.settlementAllocations.map(row => [row.invoiceId, row.amountCentimes])), JSON.stringify([
    ['INV-FIFO-OLD', 500000], ['INV-FIFO-NEW', 838750]
  ]), 'full customer receipt must allocate oldest invoice first and settle both balances exactly');
  console.log('PASS: requested 13,387.50 DA customer receipt clears the partial debt using FIFO invoice allocation');
}


{
  let releaseDurable;
  let durableSaves = 0;
  let promptCount = 0;
  const alerts = [];
  const durableGate = new Promise(resolve => { releaseDurable = resolve; });
  const customer = { id: 'C-LOCK', name: 'Locked customer', debt: 100 };
  const context = {
    AppData: {
      customers: [customer],
      invoices: [{ id: 'INV-LOCK', customerId: 'C-LOCK', total: 100, paid: 0, remaining: 100 }],
      caisseBalance: 0,
      cashMovements: []
    },
    ANASReverseLedger: require('../reverse-ledger/reverse-ledger.js'),
    alert: message => alerts.push(String(message)),
    prompt: () => { promptCount++; return '25'; },
    saveDB: () => true,
    saveDBDurably: () => { durableSaves++; return durableGate; },
    updateCashUI() {},
    renderCustomersDebts() {},
    console,
    Date: FixedDate,
    Math,
    Number, String, Object, Array, Set
  };
  vm.createContext(context);
  const firstCommit = vm.runInContext(source + '\ncollectCustDebt("C-LOCK");', context);
  assert.equal(durableSaves, 1, 'first collection must wait for one durable acknowledgement');
  const duplicateCommit = vm.runInContext('collectCustDebt("C-LOCK");', context);
  await duplicateCommit;
  assert.equal(durableSaves, 1, 'duplicate click must not start a second durable write');
  assert.equal(promptCount, 1, 'duplicate click must not open a second collection prompt');
  assert.ok(alerts.some(message => message.includes('قيد الحفظ')), 'operator must be told the first collection is still committing');
  releaseDurable(true);
  await firstCommit;
  assert.equal(customer.debt, 75, 'the acknowledged collection must commit once');
}
console.log('PASS: duplicate customer debt collection is blocked while durable persistence is in flight');


const cashOperationStart = html.indexOf('async function submitCashOperation() {');
const cashOperationEnd = html.indexOf('async function submitExpenseOperation()', cashOperationStart);
assert.ok(cashOperationStart >= 0 && cashOperationEnd > cashOperationStart, 'cash operation must be isolatable');
const cashOperationSource = helperSource + html.slice(cashOperationStart, cashOperationEnd);
async function runCashOperation({captureResults=[true],durableResults=[true]}={}) {
  const AppData={caisseBalance:100,cashMovements:[],currentUser:{id:'U-CASH',name:'Tester'}};
  const fields={
    cashAmountInput:{value:'25',focus(){}},
    cashDescInput:{value:'test cash operation'},
    optAddCash:{classList:{contains:()=>true}}
  };
  const alerts=[];let captureSaves=0,durableSaves=0;
  const context={
    AppData,
    document:{getElementById:id=>fields[id]||null},
    saveDB:()=>{captureSaves++;return captureResults.length?captureResults.shift():true;},
    saveDBDurably:()=>{durableSaves++;const result=durableResults.length?durableResults.shift():true;return result?Promise.resolve(true):Promise.reject(new Error('simulated cash durable failure'));},
    updateCashUI(){},alert:message=>alerts.push(String(message)),console,
    Date:FixedDate,Math,Number,String,Object,Array,Set
  };
  vm.createContext(context);
  await vm.runInContext(cashOperationSource+'\nsubmitCashOperation();',context);
  return {AppData,alerts,captureSaves,durableSaves};
}
{
  const result = await runCashOperation();
  assert.equal(result.AppData.caisseBalance,125);
  assert.equal(result.AppData.cashMovements.length,1);
  assert.equal(result.captureSaves,1);
  assert.equal(result.durableSaves,1);
  assert.ok(result.alerts.some(message=>message.includes('بنجاح')));
  console.log('PASS: cashbox operation waits for durable acknowledgement after V42 capture');
}
{
  const result = await runCashOperation({durableResults:[false,true]});
  assert.equal(result.AppData.caisseBalance,100,'failed cash commit must restore the previous balance');
  assert.equal(result.AppData.cashMovements.length,0,'failed cash commit must remove the movement');
  assert.equal(result.captureSaves,2,'rollback snapshot must pass through the capture hook');
  assert.equal(result.durableSaves,2,'rollback snapshot must receive its own durable acknowledgement');
  assert.ok(result.alerts.some(message=>message.includes('حُفظت الحالة السابقة')));
  console.log('PASS: failed cashbox commit durably persists the rollback snapshot');
}
{
  let releaseDurable;
  let durableSaves=0;
  const durableGate=new Promise(resolve=>{releaseDurable=resolve;});
  const AppData={caisseBalance:100,cashMovements:[],currentUser:{id:'U-CASH',name:'Tester'}};
  const fields={cashAmountInput:{value:'25',focus(){}},cashDescInput:{value:'test'},optAddCash:{classList:{contains:()=>true}}};
  const context={AppData,document:{getElementById:id=>fields[id]||null},saveDB:()=>true,
    saveDBDurably:()=>{durableSaves++;return durableGate;},updateCashUI(){},alert:()=>{},console,
    Date:FixedDate,Math,Number,String,Object,Array,Set};
  vm.createContext(context);
  const first=vm.runInContext(cashOperationSource+'\nsubmitCashOperation();',context);
  assert.equal(durableSaves,1);
  await vm.runInContext('submitCashOperation();',context);
  assert.equal(durableSaves,1,'duplicate click must not start another durable cash write');
  assert.equal(AppData.cashMovements.length,1,'duplicate click must not create a second cash movement');
  releaseDurable(true);
  await first;
  console.log('PASS: duplicate cashbox submissions are serialized until durable acknowledgement');
}

const cashOperationStart = html.indexOf('async function submitCashOperation() {');
const cashOperationEnd = html.indexOf('async function submitExpenseOperation()', cashOperationStart);
assert.ok(cashOperationStart >= 0 && cashOperationEnd > cashOperationStart, 'cash operation must be isolatable');
const cashOperationSource = helperSource + html.slice(cashOperationStart, cashOperationEnd);
async function runCashOperation({captureResults=[true],durableResults=[true]}={}) {
  const AppData={caisseBalance:100,cashMovements:[],currentUser:{id:'U-CASH',name:'Tester'}};
  const fields={
    cashAmountInput:{value:'25',focus(){}},
    cashDescInput:{value:'test cash operation'},
    optAddCash:{classList:{contains:()=>true}}
  };
  const alerts=[];let captureSaves=0,durableSaves=0;
  const context={
    AppData,
    document:{getElementById:id=>fields[id]||null},
    saveDB:()=>{captureSaves++;return captureResults.length?captureResults.shift():true;},
    saveDBDurably:()=>{durableSaves++;const result=durableResults.length?durableResults.shift():true;return result?Promise.resolve(true):Promise.reject(new Error('simulated cash durable failure'));},
    updateCashUI(){},alert:message=>alerts.push(String(message)),console,
    Date:FixedDate,Math,Number,String,Object,Array,Set
  };
  vm.createContext(context);
  await vm.runInContext(cashOperationSource+'\\nsubmitCashOperation();',context);
  return {AppData,alerts,captureSaves,durableSaves};
}
{
  const result = await runCashOperation();
  assert.equal(result.AppData.caisseBalance,125);
  assert.equal(result.AppData.cashMovements.length,1);
  assert.equal(result.captureSaves,1);
  assert.equal(result.durableSaves,1);
  assert.ok(result.alerts.some(message=>message.includes('بنجاح')));
  console.log('PASS: cashbox operation waits for durable acknowledgement after V42 capture');
}
{
  const result = await runCashOperation({durableResults:[false,true]});
  assert.equal(result.AppData.caisseBalance,100,'failed cash commit must restore the previous balance');
  assert.equal(result.AppData.cashMovements.length,0,'failed cash commit must remove the movement');
  assert.equal(result.captureSaves,2,'rollback snapshot must pass through the capture hook');
  assert.equal(result.durableSaves,2,'rollback snapshot must receive its own durable acknowledgement');
  assert.ok(result.alerts.some(message=>message.includes('حُفظت الحالة السابقة')));
  console.log('PASS: failed cashbox commit durably persists the rollback snapshot');
}
{
  let releaseDurable;
  let durableSaves=0;
  const durableGate=new Promise(resolve=>{releaseDurable=resolve;});
  const AppData={caisseBalance:100,cashMovements:[],currentUser:{id:'U-CASH',name:'Tester'}};
  const fields={cashAmountInput:{value:'25',focus(){}},cashDescInput:{value:'test'},optAddCash:{classList:{contains:()=>true}}};
  const context={AppData,document:{getElementById:id=>fields[id]||null},saveDB:()=>true,
    saveDBDurably:()=>{durableSaves++;return durableGate;},updateCashUI(){},alert:()=>{},console,
    Date:FixedDate,Math,Number,String,Object,Array,Set};
  vm.createContext(context);
  const first=vm.runInContext(cashOperationSource+'\\nsubmitCashOperation();',context);
  assert.equal(durableSaves,1);
  await vm.runInContext('submitCashOperation();',context);
  assert.equal(durableSaves,1,'duplicate click must not start another durable cash write');
  assert.equal(AppData.cashMovements.length,1,'duplicate click must not create a second cash movement');
  releaseDurable(true);
  await first;
  console.log('PASS: duplicate cashbox submissions are serialized until durable acknowledgement');
}
const durableSaleStart = html.indexOf("async function confirmHasibPaymentDurable()");
const durableSaleEnd = html.indexOf("function buildInvoiceShareText", durableSaleStart);
assert.ok(durableSaleStart >= 0 && durableSaleEnd > durableSaleStart,
  'the live POS confirmation entrypoint must remain inspectable');
const durableSaleSource = html.slice(durableSaleStart, durableSaleEnd);
assert.ok(durableSaleSource.indexOf("saveDB()") >= 0 &&
  durableSaleSource.indexOf("saveDB()") < durableSaleSource.indexOf("saveDBDurably()"),
  'durable POS checkout must pass through V42 mutation capture before storage acknowledgement');
assert.match(durableSaleSource, /await saveDBDurably\(\)/,
  'POS checkout must await the durable persistence acknowledgement');
console.log('PASS: durable POS checkout captures V42 mutation before durable commit');

assert.match(html, /typeof window\.saveDBDurably === 'function'/,
  'global application bridge readiness must require durable persistence');
console.log('PASS: global application bridge readiness requires durable persistence');
})().catch(error => { console.error(error); process.exitCode = 1; });
