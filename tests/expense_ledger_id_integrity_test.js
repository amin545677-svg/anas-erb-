const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function submitExpenseOperation() {');
const end = html.indexOf('\n        function ', start + 20);
assert.ok(start >= 0 && end > start, 'submitExpenseOperation must be present and isolatable');
const source = html.slice(start, end);
const fixedNow = 1234567890123;
class FixedDate extends Date {
  static now() { return fixedNow; }
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
}
function runExpense({ expenses = [], math = Math, saveResult = true } = {}) {
  const alerts = [];
  let saves = 0;
  const fields = {
    expAmountInput: { value: '10', focus() {} },
    expDescInput: { value: 'Test expense' },
    expAccountInput: { value: 'General' }
  };
  const appData = { caisseBalance: 100, expenses: expenses.map(x => ({ ...x })) };
  const context = {
    AppData: appData,
    document: { getElementById: id => fields[id] || null },
    alert: message => alerts.push(String(message)),
    saveDB: () => { saves++; return saveResult; },
    updateCashUI() {},
    Date: FixedDate,
    Math: math,
    Number, String, Object, Array, Set, console
  };
  vm.createContext(context);
  vm.runInContext(source + '\nsubmitExpenseOperation();', context);
  return { appData, alerts, saves };
}

{
  const result = runExpense({ expenses: [{ id: 'EXP-DUP' }, { id: 'EXP-DUP' }] });
  assert.equal(result.saves, 0, 'duplicate expense IDs must be rejected before persistence');
  assert.equal(result.appData.caisseBalance, 100, 'cash must remain unchanged for an invalid ledger');
  assert.equal(result.appData.expenses.length, 2, 'invalid ledger must not be overwritten or appended');
  assert.ok(result.alerts.some(message => message.includes('معرّفات مكررة')), 'operator must be told why expense recording stopped');
}
console.log('PASS: duplicate expense ledger IDs fail closed');

{
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => 0.5;
  const baseId = 'EXP-' + fixedNow.toString(36).toUpperCase() + '-' + (0.5).toString(36).slice(2, 7).toUpperCase();
  const result = runExpense({ expenses: [{ id: baseId, amt: 1 }], math: deterministicMath });
  assert.equal(result.saves, 1, 'a unique existing ledger with generated-ID collision should still save');
  assert.equal(result.appData.expenses.length, 2);
  assert.equal(result.appData.expenses[1].id, baseId + '-1', 'generated ID collision must be resolved with a suffix');
  assert.equal(new Set(result.appData.expenses.map(x => x.id)).size, 2, 'resulting expense IDs must be unique');
  assert.equal(result.appData.caisseBalance, 90);
}
console.log('PASS: generated expense ID collisions are resolved without losing ledger entries');
