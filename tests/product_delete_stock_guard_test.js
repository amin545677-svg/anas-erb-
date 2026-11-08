const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function deleteProduct(pId) {');
const end = html.indexOf('function populateProductCategorySuggestions()', start);
assert.ok(start >= 0 && end > start, 'deleteProduct function must be present and isolatable');
const deleteSource = html.slice(start, end);

function runDelete(product, { saveResult = true, typedName } = {}) {
  const alerts = [];
  let saves = 0;
  const context = {
    AppData: {
      products: [product],
      invoices: [], purchases: [], salesReturns: [], purchaseReturns: [], returns: [],
      stockMovements: [], warehouseTransfers: [], truckTrips: [], inventoryAdjustments: [],
      stocktakeRecords: []
    },
    alert: message => alerts.push(String(message)),
    prompt: () => typedName === undefined ? String(product.name || '') : typedName,
    saveDB: () => { saves++; return saveResult; },
    renderInventoryList() {},
    renderQuickProducts() {},
    Number, String, Object, Array, Set, Math
  };
  vm.createContext(context);
  vm.runInContext(deleteSource + '\ndeleteProduct(' + JSON.stringify(product.id) + ');', context);
  return { context, alerts, saves };
}

for (const [label, product] of [
  ['invalid main stock', { id: 'bad-main', name: 'Bad main', stock: 'broken' }],
  ['invalid warehouse map', { id: 'bad-map', name: 'Bad map', stock: 0, warehouseStock: 'broken' }],
  ['invalid warehouse balance', { id: 'bad-balance', name: 'Bad balance', stock: 0, warehouseStock: { w1: 'not-a-number' } }],
  ['non-finite warehouse total', { id: 'overflow', name: 'Overflow', stock: 0, warehouseStock: { w1: Number.MAX_VALUE, w2: Number.MAX_VALUE } }]
]) {
  const { context, alerts, saves } = runDelete(product);
  assert.equal(context.AppData.products.length, 1, label + ': must retain product');
  assert.equal(saves, 0, label + ': must not persist deletion');
  assert.ok(alerts.length > 0, label + ': must explain refusal');
}

{
  const product = { id: 'valid-zero', name: 'Valid zero', stock: 0, warehouseStock: { w1: 0 } };
  const { context, alerts, saves } = runDelete(product);
  assert.equal(context.AppData.products.length, 0, 'valid zero-stock product without history may be deleted');
  assert.equal(saves, 1, 'valid deletion should persist once');
  assert.ok(alerts.some(x => x.includes('تم حذف المنتج')), 'successful deletion should be reported');
}

{
  const product = { id: 'save-fails', name: 'Save fails', stock: 0 };
  const { context, saves } = runDelete(product, { saveResult: false });
  assert.equal(context.AppData.products.length, 1, 'failed persistence must restore product list');
  assert.equal(saves, 1, 'failed persistence should be attempted once');
}

console.log('Product deletion runtime regression tests passed: malformed balances fail closed; valid zero-stock deletion and save rollback behave correctly.');

// Run the adjacent financial-ledger runtime regression in the same CI entry point.
require('./customer_debt_collection_guard_test.js');
