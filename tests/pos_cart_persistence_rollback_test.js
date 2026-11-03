const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function addItemToPosCart(pId) {');
const end = html.indexOf('\n        function ', start + 20);
assert.ok(start >= 0 && end > start, 'addItemToPosCart must be present and isolatable');
const source = html.slice(start, end);

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
    String, Number, Array, Object, Math, Set, console
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
  const paymentStart = appSource.indexOf('function confirmHasibPaymentDurable()');
  const paymentEnd = appSource.indexOf('function printLastConfirmedInvoice', paymentStart);
  assert.ok(paymentStart >= 0 && paymentEnd > paymentStart,
    'POS payment UI must route through the durable transaction handler');
  const paymentSource = appSource.slice(paymentStart, paymentEnd);
  const awaitedSave = paymentSource.indexOf('saveDBDurably()');
  const modalClose = paymentSource.indexOf("closeModal('hasibModal')");
  assert.ok(awaitedSave >= 0 && modalClose > awaitedSave && paymentSource.includes('durableSave.then'),
    'payment modal must close only after the durable save acknowledgement');
  assert.match(paymentSource, /hasibPaymentInFlight/,
    'payment flow must guard against duplicate submissions while persistence is pending');
  assert.match(appSource, /onclick="confirmHasibPaymentDurable\(\)"/,
    'the live payment button must call the durable handler, not the legacy compatibility handler');
  const helperStart = appSource.indexOf('async function saveDBDurably()');
  const helperEnd = appSource.indexOf('function openAddSupplierModal()', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart &&
    appSource.slice(helperStart, helperEnd).includes('await storage.setSync(ANAS_DB_KEY, serialized)'),
    'durable save must await the storage engine write acknowledgement');
  const supplierStart = appSource.indexOf('function saveNewSupplierMpos()');
  const supplierEnd = appSource.indexOf('function printLatestLegalCustomerInvoice', supplierStart);
  assert.ok(supplierStart >= 0 && supplierEnd > supplierStart,
    'supplier creation must expose a promise-aware durable-save flow');
  assert.match(appSource.slice(supplierStart, supplierEnd), /durableSave\.then\(/,
    'supplier creation must await durable persistence before closing its modal');
}
console.log('PASS: supplier and POS payment flows await durable storage before success UI');
})().catch(error => { console.error(error); process.exitCode = 1; });
