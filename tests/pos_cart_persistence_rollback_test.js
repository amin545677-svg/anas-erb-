const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function addItemToPosCart(pId, selectedTier) {');
const end = html.indexOf('\n        function ', start + 20);
assert.ok(start >= 0 && end > start, 'addItemToPosCart must be present and isolatable');
const arithmeticStart = html.indexOf('const ANAS_QTY_SCALE = 1000000;');
const arithmeticEnd = html.indexOf('function updatePaymentMethodFromAmount()', arithmeticStart);
const saveStart = html.indexOf('function savePosCartChange(rollback) {');
const saveEnd = html.indexOf('function validatePosCartStock(', saveStart);
assert.ok(arithmeticStart >= 0 && arithmeticEnd > arithmeticStart &&
  saveStart >= 0 && saveEnd > saveStart,
  'POS cart test must isolate the production integer arithmetic and persistence helpers');
const snapshotStart = html.indexOf('function snapshotPosCart() {');
const snapshotEnd = html.indexOf('function addItemToPosCart(pId, selectedTier) {', snapshotStart);
assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart,
  'POS rollback test must isolate the production cart snapshot/restore helpers');
const source = html.slice(arithmeticStart, arithmeticEnd) + '\n' +
  html.slice(snapshotStart, snapshotEnd) + '\n' +
  html.slice(start, end) + '\n' + html.slice(saveStart, saveEnd);

function run({ initialMap, includeMap = true, saveResult = false }) {
  const alerts = [];
  const product = { id: 'p1', name: 'Test product', stock: 5, price1: 10, unit: 'piece' };
  const appData = { products: [product], activePosScreenTab: 'tab1' };
  if (includeMap) appData.posScreensCarts = initialMap;
  let cart = includeMap && initialMap && Array.isArray(initialMap.tab1) ? initialMap.tab1 : [];
  const context = {
    AppData: appData,
    posCart: cart,
    alert: message => alerts.push(String(message)),
    saveDB: () => saveResult,
    renderPosTable() {},
    wtCurrentSaleWarehouse: () => 'Main',
    wtAvailableStock: p => Number(p.stock),
    String, Number, Array, Object, Math, Set, BigInt, console
  };
  vm.createContext(context);
  vm.runInContext(source + '\naddItemToPosCart("p1");', context);
  return { appData, alerts, cart: context.posCart };
}

{
  const result = run({ includeMap: false });
  assert.equal(result.cart.length, 0, 'failed save must roll back the added cart item');
  assert.equal(Object.prototype.hasOwnProperty.call(result.appData, 'posScreensCarts'), false,
    'failed first cart save must not leave a newly created unsaved cart map');
}
console.log('PASS: failed first POS cart save restores absent cart-map state');

{
  const originalTab = [{ id: 'old', qty: 1 }];
  const originalMap = { tab1: originalTab, tab2: [{ id: 'other', qty: 2 }] };
  const result = run({ initialMap: originalMap });
  assert.equal(result.cart.length, 1, 'failed save must remove only the newly added item and preserve the prior cart');
  assert.equal(result.cart[0].id, 'old', 'failed save must preserve the pre-existing cart item');
  assert.equal(result.appData.posScreensCarts, originalMap, 'failed save must restore the original map object');
  assert.equal(result.appData.posScreensCarts.tab1, originalTab, 'failed save must preserve original tab-cart reference');
  assert.deepEqual(result.appData.posScreensCarts.tab1, originalTab, 'failed save must not corrupt the prior tab cart');
  assert.equal(result.appData.posScreensCarts.tab2[0].id, 'other', 'other POS tabs must remain unchanged');
}
console.log('PASS: failed POS cart save preserves existing multi-tab cart state');

(async () => {
{
  // Exercise the durable-save boundary independently of the full Chromium UI.
  // The live cart map must not be published until the storage promise ACKs.
  const appSource = fs.readFileSync('index.html', 'utf8');
  const helperStart = appSource.indexOf('async function saveDBDurably()');
  const helperEnd = appSource.indexOf('function openAddSupplierModal()', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart,
    'saveDBDurably must exist before the legacy UI helpers');
  const durableHelper = appSource.slice(helperStart, helperEnd);
  let acknowledge;
  const storageAck = new Promise(resolve => { acknowledge = resolve; });
  const oldCart = [{ id: 'old', qty: 1 }];
  const nextCart = [{ id: 'new', qty: 2 }];
  const oldMap = { tab1: oldCart, tab2: [{ id: 'other', qty: 1 }] };
  const context = {
    AppData: { posScreensCarts: oldMap, activePosScreenTab: 'tab1' },
    posCart: nextCart,
    ANAS_DB_KEY: 'ANAS_TEST_LEDGER',
    anasStorageHydrationComplete: true,
    anasStartupFatalLoadError: false,
    anasStartupIntegrityIssues: [],
    window: { ANASResilientStorage: {
      encode: value => JSON.stringify(value),
      setSync: () => storageAck
    }},
    ANASReverseLedger: { validateReverseLedgerParity() {} },
    updateUIState() {}, checkSystemAlerts() {}, updateDashboardStats() {},
    console, Promise, JSON, Object, Array, Error, String
  };
  vm.createContext(context);
  vm.runInContext(durableHelper + '\nthis.__pendingDurableSave = saveDBDurably();', context);
  assert.equal(context.AppData.posScreensCarts, oldMap,
    'cart map identity must remain unchanged while IndexedDB has not acknowledged');
  assert.equal(context.AppData.posScreensCarts.tab1, oldCart,
    'the previous persisted cart must remain visible while the write is pending');
  acknowledge({ revision: 9, mode: 'INDEXEDDB' });
  assert.equal(await context.__pendingDurableSave, true);
  assert.notEqual(context.AppData.posScreensCarts, oldMap,
    'the new cart map must publish after the durable acknowledgement');
  assert.deepEqual(context.AppData.posScreensCarts.tab1, nextCart);
  assert.deepEqual(context.AppData.posScreensCarts.tab2, oldMap.tab2);
}
console.log('PASS: durable POS save publishes the cart map only after storage ACK');

{
  const appSource = fs.readFileSync('index.html', 'utf8');
  const paymentStart = appSource.indexOf('async function confirmHasibPaymentDurable()');
  const paymentEnd = appSource.indexOf('function printLastConfirmedInvoice', paymentStart);
  assert.ok(paymentStart >= 0 && paymentEnd > paymentStart,
    'POS payment UI must route through the durable transaction handler');
  const paymentSource = appSource.slice(paymentStart, paymentEnd);
  const captureSave = paymentSource.indexOf('saveDB()');
  const awaitedSave = paymentSource.indexOf('await saveDBDurably()');
  const finalizeStart = paymentSource.indexOf('const finalizeSale = () => {');
  const finalizeCall = paymentSource.indexOf('finalizeSale();', awaitedSave);
  const modalClose = paymentSource.indexOf("closeModal('hasibModal')", finalizeStart);
  assert.ok(captureSave >= 0 && awaitedSave > captureSave && finalizeStart >= 0 &&
    modalClose > finalizeStart && finalizeCall > awaitedSave,
    'payment modal close must remain behind V42 capture and the awaited durable acknowledgement');
  assert.match(paymentSource, /hasibPaymentInFlight/,
    'payment flow must guard against duplicate submissions while persistence is pending');
  assert.match(appSource, /onclick="confirmHasibPaymentDurable\(\)"/,
    'the live payment button must call the durable handler, not the legacy compatibility handler');
  const helperStart = appSource.indexOf('async function saveDBDurably()');
  const helperEnd = appSource.indexOf('function openAddSupplierModal()', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart &&
    appSource.slice(helperStart, helperEnd).includes('await storage.setSync(ANAS_DB_KEY, serialized)'),
    'durable save must await the storage engine write acknowledgement');
  const supplierMatch = /async function saveNewSupplierMpos\(\) \{/.exec(appSource);
  const supplierStart = supplierMatch ? supplierMatch.index : -1;
  const supplierEnd = appSource.indexOf('function printLatestLegalCustomerInvoice', supplierStart);
  assert.ok(supplierMatch && supplierEnd > supplierStart,
    'supplier creation must expose an async durable-save flow');
  const supplierSource = appSource.slice(supplierStart, supplierEnd);
  const durableAck = supplierSource.indexOf('await saveDBDurably() !== true');
  const supplierModalClose = supplierSource.indexOf("closeModal('addSupplierModal')");
  assert.ok(durableAck >= 0 && supplierModalClose > durableAck,
    'supplier creation must await a true durable acknowledgement before closing its modal');
}
console.log('PASS: supplier and POS payment flows await durable storage before success UI');

async function verifyDurablePaymentGate(failCommit) {
  const html = fs.readFileSync('index.html', 'utf8');
  const helperStart = html.indexOf('const ANAS_QTY_SCALE = 1000000;');
  const helperEnd = html.indexOf('function updatePaymentMethodFromAmount()', helperStart);
  const paymentStart = html.indexOf('async function confirmHasibPaymentDurable()');
  const paymentEnd = html.indexOf('function buildInvoiceShareText', paymentStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && paymentStart >= 0 && paymentEnd > paymentStart,
    'durable POS payment and integer arithmetic helpers must be isolatable');
  const source = html.slice(helperStart, helperEnd) + html.slice(paymentStart, paymentEnd);

  let resolveCommit, rejectCommit;
  const commit = new Promise((resolve, reject) => { resolveCommit = resolve; rejectCommit = reject; });
  const product = { id: 'P-DURABLE', name: 'Tea', stock: 5, buyPrice: 10 };
  const AppData = {
    products: [product], customers: [], invoices: [], caisseBalance: 100,
    cashMovements: [], stockMovements: [], currentUser: { id: 'U-1', name: 'Tester' }
  };
  const originalCart = [{ id: 'P-DURABLE', name: 'Tea', qty: 1, price: 25, unit: 'قطعة' }];
  const alerts = [];
  let saves = 0, closes = 0;
  const elements = {
    hasibCustomerSelect: { value: '' },
    hasibPaidAmount: { value: '25' }
  };
  const context = {
    AppData, posCart: originalCart, lastConfirmedInvoice: null, hasibPaymentInFlight: false,
    document: { getElementById: id => elements[id] || null },
    wtTryEnsureData: () => true,
    wtCurrentSaleWarehouse: () => 'المخزن الرئيسي',
    wtAvailableStock: p => p.stock,
    saveDB: () => true,
    saveDBDurably: () => { saves++; return commit; },
    renderPosTable() {}, renderCustomersDebts() {}, updateCashUI() {},
    closeModal() { closes++; }, showInvoicePostSaveActions() {}, alert: message => alerts.push(String(message)), console,
    Date, Math, Number, String, Object, Array, Map, Set, BigInt
  };
  vm.createContext(context);
    try {
      vm.runInContext(source + String.fromCharCode(10) + 'this.__paymentPromise = confirmHasibPaymentDurable();', context, { timeout: 10000 });
    } catch (error) {
      console.error('POS_NONCASH_VM_SOURCE_TAIL:', JSON.stringify(source.slice(-320)));
      console.error('POS_NONCASH_VM_SOURCE_HEAD:', JSON.stringify(source.slice(0,180)));
      throw error;
    }

  assert.equal(saves, 1, 'POS must issue exactly one durable write');
  assert.equal(AppData.invoices.length, 1, 'the candidate invoice is prepared before awaiting the durable commit');
  assert.equal(product.stock, 4, 'stock mutation is staged while the payment modal remains open');
  assert.equal(closes, 0, 'payment modal must remain open while storage has not acknowledged');
  assert.equal(context.hasibPaymentInFlight, true, 'duplicate payment submissions remain blocked while pending');

  if (failCommit) {
    rejectCommit(new Error('simulated IndexedDB commit failure'));
    assert.equal(await context.__paymentPromise, false);
    assert.equal(product.stock, 5, 'failed durable commit must restore stock');
    assert.equal(AppData.invoices.length, 0, 'failed durable commit must leave no invoice');
    assert.equal(AppData.cashMovements.length, 0, 'failed durable commit must leave no cash movement');
    assert.equal(AppData.caisseBalance, 100, 'failed durable commit must restore cash balance');
    assert.equal(context.posCart.length, 1, 'failed durable commit must restore the cart');
    assert.equal(closes, 0, 'failed durable commit must not close the payment modal');
    assert.equal(context.hasibPaymentInFlight, false, 'failed transaction must release the in-flight guard');
  } else {
    resolveCommit(true);
    assert.equal(await context.__paymentPromise, true);
    assert.equal(AppData.invoices.length, 1);
    assert.equal(product.stock, 4);
    assert.equal(AppData.caisseBalance, 125);
    assert.equal(AppData.cashMovements.length, 1);
    assert.equal(context.posCart.length, 0);
    assert.equal(closes, 1, 'payment modal closes only after durable acknowledgement');
    assert.equal(context.hasibPaymentInFlight, false);
  }
}
await verifyDurablePaymentGate(false);
console.log('PASS: POS payment modal closes only after durable commit ACK');
await verifyDurablePaymentGate(true);
console.log('PASS: failed POS durable commit rolls back invoice, cash, stock and cart without closing modal');

async function verifyFreeProductAndDiscountSale() {
  const html = fs.readFileSync('index.html', 'utf8');
  const helperStart = html.indexOf('const ANAS_QTY_SCALE = 1000000;');
  const helperEnd = html.indexOf('function updatePaymentMethodFromAmount()', helperStart);
  const paymentStart = html.indexOf('async function confirmHasibPaymentDurable()');
  const paymentEnd = html.indexOf('function buildInvoiceShareText', paymentStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && paymentStart >= 0 && paymentEnd > paymentStart);
  const source = html.slice(helperStart, helperEnd) + html.slice(paymentStart, paymentEnd);
  const AppData = {
    products: [], customers: [], invoices: [], caisseBalance: 0,
    cashMovements: [], stockMovements: [], currentUser: { id: 'U-FREE', name: 'Tester' },
    activePosScreenTab: 'tab1', posCartDiscounts: { tab1: 200 }
  };
  const freeCart = [{
    id: 'FREE-TEST-1', name: 'خدمة تركيب', qty: 2, price: 5,
    unit: 'خدمة', isFreeItem: true
  }];
  const elements = {
    hasibCustomerSelect: { value: '' },
    hasibPaidAmount: { value: '8.00' }
  };
  const context = {
    AppData, posCart: freeCart, lastConfirmedInvoice: null, hasibPaymentInFlight: false,
    document: { getElementById: id => elements[id] || null },
    wtTryEnsureData: () => true,
    wtCurrentSaleWarehouse: () => 'المخزن الرئيسي',
    wtAvailableStock: () => 0,
    saveDB: () => true,
    saveDBDurably: () => Promise.resolve(true),
    renderPosTable() {}, renderCustomersDebts() {}, updateCashUI() {},
    closeModal() {}, showInvoicePostSaveActions() {}, alert() {}, console,
    Date, Math, Number, String, Object, Array, Map, Set, BigInt
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.__preTotal = anasCartTotalCents(posCart); this.__paymentPromise = confirmHasibPaymentDurable();', context, { timeout: 10000 });
  assert.equal(context.__preTotal, 800, 'cart total must apply the persisted centime discount');
  assert.equal(await context.__paymentPromise, true);
  assert.equal(AppData.products.length, 0, 'free product must never be inserted into the inventory table');
  assert.equal(AppData.stockMovements.length, 0, 'free product must never create stock movements');
  assert.equal(AppData.invoices.length, 1);
  assert.equal(AppData.invoices[0].subtotal, 10);
  assert.equal(AppData.invoices[0].discount, 2);
  assert.equal(AppData.invoices[0].total, 8);
  assert.equal(AppData.invoices[0].items[0].isFreeItem, true);
  assert.equal(AppData.invoices[0].invoiceLedgerVersion, 1,
    'free-item invoice must use the compatibility ledger path without a stock posting');
  assert.equal(AppData.caisseBalance, 8);
  assert.equal(AppData.posCartDiscounts.tab1, undefined, 'successful sale clears only the active tab discount');
}
await verifyFreeProductAndDiscountSale();
console.log('PASS: free product and centime discount post to invoice without inventory deduction');

async function verifyNonCashSaleDoesNotChangePhysicalCash() {
  const html = fs.readFileSync('index.html', 'utf8');
  const helperStart = html.indexOf('const ANAS_QTY_SCALE = 1000000;');
  const helperEnd = html.indexOf('function updatePaymentMethodFromAmount()', helperStart);
  const paymentStart = html.indexOf('async function confirmHasibPaymentDurable()');
  const paymentEnd = html.indexOf('function buildInvoiceShareText', paymentStart);
  const source = html.slice(helperStart, helperEnd) + html.slice(paymentStart, paymentEnd);
  for (const paymentChannel of ['cheque','transfer','card','other']) {
    const product = { id:'P-NONCASH-' + paymentChannel, name:'Rice', stock:3, buyPrice:5 };
    const AppData = { products:[product], customers:[], invoices:[], caisseBalance:100,
      cashMovements:[], bankMovements:[], stockMovements:[], currentUser:{id:'U-1',name:'Tester'} };
    const elements = { hasibCustomerSelect:{value:''}, hasibPaidAmount:{value:'25'}, hasibPaymentChannel:{value:paymentChannel} };
    const context = { AppData, posCart:[{id:product.id,name:'Rice',qty:1,price:25,unit:'كيس'}],
      lastConfirmedInvoice:null,hasibPaymentInFlight:false,document:{getElementById:id=>elements[id]||null},
      wtTryEnsureData:()=>true,wtCurrentSaleWarehouse:()=>'المخزن الرئيسي',wtAvailableStock:p=>p.stock,
      saveDB:()=>true,saveDBDurably:()=>Promise.resolve(true),renderPosTable(){},renderCustomersDebts(){},
      updateCashUI(){},closeModal(){},showInvoicePostSaveActions(){},alert(){},console,Date,Math,Number,String,Object,Array,Map,Set,BigInt };
    vm.createContext(context);
    try {
      vm.runInContext(source + String.fromCharCode(10) + 'this.__paymentPromise = confirmHasibPaymentDurable();', context, { timeout: 10000 });
    } catch (error) {
      console.error('POS_NONCASH_VM_SOURCE_TAIL:', JSON.stringify(source.slice(-320)));
      throw error;
    }
    assert.equal(await context.__paymentPromise,true,paymentChannel + ' sale must commit');
    assert.equal(AppData.caisseBalance,100,paymentChannel + ' must not increase physical cash');
    assert.equal(AppData.cashMovements.length,0,paymentChannel + ' must not enter cash movement ledger');
    assert.equal(AppData.bankMovements.length,1);
    assert.equal(AppData.bankMovements[0].paymentChannel,paymentChannel);
    assert.equal(AppData.bankMovements[0].cashImpact,false);
    assert.equal(AppData.invoices[0].paymentChannel,paymentChannel);
    assert.equal(product.stock,2);
  }
}
await verifyNonCashSaleDoesNotChangePhysicalCash();
console.log('PASS: non-cash receipt remains outside physical cash balance');


})().catch(error => { console.error(error); process.exitCode = 1; });
