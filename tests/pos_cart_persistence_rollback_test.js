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
