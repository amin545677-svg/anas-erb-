const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function collectCustDebt(cId) {');
const end = html.indexOf('function openGoogleMaps(loc)', start);
assert.ok(start >= 0 && end > start, 'collectCustDebt function must be present and isolatable');
const source = html.slice(start, end);

function runCollection({ movements = [], debt = 100, cash = 0, amount = '25', saveResult = true, math = Math } = {}) {
  const alerts = [];
  let saves = 0;
  const customer = { id: 'C-1', name: 'Test customer', debt };
  const appData = {
    customers: [customer],
    caisseBalance: cash,
    cashMovements: movements.map(m => ({ ...m }))
  };
  const context = {
    AppData: appData,
    alert: message => alerts.push(String(message)),
    prompt: () => amount,
    saveDB: () => { saves++; return saveResult; },
    updateCashUI() {},
    renderCustomersDebts() {},
    console,
    Date,
    Math: math,
    Number, String, Object, Array, Set
  };
  vm.createContext(context);
  vm.runInContext(source + '\ncollectCustDebt("C-1");', context);
  return { appData, customer, alerts, saves };
}

{
  const before = [{ id: 'CASH-1', amount: 10 }, { id: 'CASH-1', amount: 20 }];
  const result = runCollection({ movements: before, amount: '25' });
  assert.equal(result.saves, 0, 'duplicate ledger IDs must be rejected before persistence');
  assert.equal(result.customer.debt, 100, 'customer debt must remain unchanged');
  assert.equal(result.appData.caisseBalance, 0, 'cash balance must remain unchanged');
  assert.equal(result.appData.cashMovements.length, 2, 'ledger must not be overwritten or appended');
  assert.ok(result.alerts.some(message => message.includes('معرّفات مكررة')), 'user must be told why collection was stopped');
}

{
  const result = runCollection({ movements: [{ id: 'LEGACY-1', amount: 10 }], amount: '25' });
  assert.equal(result.saves, 1);
  assert.equal(result.customer.debt, 75);
  assert.equal(result.appData.caisseBalance, 25);
  assert.equal(result.appData.cashMovements.length, 2);
  assert.equal(new Set(result.appData.cashMovements.map(m => m.id)).size, 2, 'new movement ID must be unique');
}

{
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => 0.5;
  const baseId = 'DEBT-IN-' + Date.now().toString(36).toUpperCase() + '-' + (0.5).toString(36).slice(2, 7).toUpperCase();
  const result = runCollection({ movements: [{ id: baseId, amount: 1 }], amount: '25', math: deterministicMath });
  assert.equal(result.saves, 1);
  assert.equal(result.appData.cashMovements.length, 2);
  assert.equal(result.appData.cashMovements[1].id, baseId + '-1', 'new movement ID collision must be resolved with a suffix');
  assert.equal(new Set(result.appData.cashMovements.map(m => m.id)).size, 2);
}

{
  const original = [{ id: 'CASH-1', amount: 10 }];
  const result = runCollection({ movements: original, amount: '25', saveResult: false });
  assert.equal(result.saves, 1);
  assert.equal(result.customer.debt, 100, 'failed persistence must restore customer debt');
  assert.equal(result.appData.caisseBalance, 0, 'failed persistence must restore cash balance');
  assert.deepEqual(result.appData.cashMovements.map(m => m.id), ['CASH-1'], 'failed persistence must restore the original ledger');
}

console.log('PASS: duplicate cash movement IDs fail closed');
console.log('PASS: normal customer debt collection updates debt, cash and ledger');
console.log('PASS: generated cash movement ID collisions are resolved');
console.log('PASS: failed persistence rolls back customer debt, cash and ledger');
