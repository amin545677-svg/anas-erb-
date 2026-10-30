const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');

function extractFunctionBlock(startMarker, endMarker, label) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, label + ' must exist and be isolatable in index.html');
  return html.slice(start, end);
}

const truckExpenseValidator = extractFunctionBlock(
  'function anasValidateTruckExpenseLinks(incoming)',
  'function anasValidateIncomingSyncData(incoming)',
  'truck expense restore validator'
);
const backupValidator = extractFunctionBlock(
  'function anasValidateBackupData(incoming)',
  'function importDataBackup(e)',
  'backup restore validator'
);

function validate(incoming, current = {}) {
  const context = { AppData: current, candidate: incoming, result: null };
  vm.createContext(context);
  vm.runInContext(
    truckExpenseValidator + '\n' + backupValidator + '\\nresult = anasValidateBackupData(candidate);',
    context,
    { timeout: 1000 }
  );
  return context.result;
}

function validSnapshot() {
  return {
    appName: 'ANAS ERP',
    appSchemaVersion: 'legacy-v42',
    customModuleState: { retained: true, nested: ['alpha', 7] },
    caisseBalance: 500.5,
    products: [{ id: 'P-1', stock: 500.5, warehouseStock: { Main: 250.25 } }],
    customers: [{ id: 'C-1', debt: 125.75 }],
    suppliers: [{ id: 'S-1', balance: 75.5 }],
    invoices: [{
      id: 'I-1', total: 500.5, paid: 0.5, remaining: 500,
      items: [{ id: 'P-1', qty: 1, price: 500.5 }]
    }],
    purchases: [],
    expenses: [],
    users: [],
    trucks: [],
    returns: [],
    warehouseTransfers: [{ id: 'WT-1', quantity: 0.5, buyPrice: 10.25, salePrice: 12.5 }],
    stockMovements: [{ id: 'SM-1', qty: -0.5, previousStock: 501, newStock: 500.5 }],
    purchaseInvoices: [],
    alerts: [],
    truckTrips: [],
    cashMovements: [{ id: 'CM-1', amount: 500.5 }],
    stocktakeRecords: [],
    warehouses: ['Main'],
    posScreensCarts: { 1: [], 2: [], 3: [], 4: [] }
  };
}

{
  const incoming = validSnapshot();
  const before = JSON.stringify(incoming);
  const result = validate(incoming);
  assert.equal(result, incoming, 'validator must return the original snapshot object');
  assert.equal(JSON.stringify(result), before, 'validation must not coerce, normalize, or strip snapshot fields');
  assert.equal(result.products[0].stock, 500.5);
  assert.equal(result.customers[0].debt, 125.75);
  assert.equal(result.invoices[0].items[0].price, 500.5);
  assert.deepEqual(result.customModuleState, { retained: true, nested: ['alpha', 7] });
  console.log('PASS: decimal values and unknown/nested AppData fields survive validation unchanged');
}

{
  const incoming = validSnapshot();
  incoming.products[0].stock = true;
  assert.throws(() => validate(incoming), /رصيد مخزون سالب أو غير رقمي|المجال الرقمي الآمن/);
  console.log('PASS: boolean stock values are rejected before restore');
}

{
  const incoming = validSnapshot();
  incoming.customers[0].debt = true;
  assert.throws(() => validate(incoming), /قيمة مالية غير صالحة/);
  console.log('PASS: boolean customer debt is rejected before restore');
}

{
  const incoming = validSnapshot();
  incoming.invoices[0].remaining = 499;
  assert.throws(() => validate(incoming), /غير متطابقة حسابيًا/);
  console.log('PASS: inconsistent invoice total/paid/remaining is rejected');
}

{
  const incoming = validSnapshot();
  delete incoming.cashMovements;
  const current = { cashMovements: [{ id: 'LOCAL-CM-1', amount: 10 }] };
  assert.throws(() => validate(incoming, current), /تفتقد قائمة cashMovements/);
  console.log('PASS: restore cannot erase a non-empty local ledger omitted by the backup');
}

{
  const incoming = validSnapshot();
  incoming.warehouseTransfers[0].quantity = 0;
  assert.throws(() => validate(incoming), /قيمة مالية غير صالحة/);
  console.log('PASS: zero-quantity warehouse transfers are rejected');
}

console.log('ANAS ERP Firebase restore contract tests passed');
