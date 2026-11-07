const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync('index.html', 'utf8');
const helperStart = html.indexOf('const ANAS_QTY_SCALE = 1000000;');
const helperEnd = html.indexOf('function updatePaymentMethodFromAmount()', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'integer-centime helpers must be present and isolatable');
const helperSource = html.slice(helperStart, helperEnd);
const start = html.indexOf('async function submitExpenseOperation() {');
const end = html.indexOf('\n        function ', start + 20);
assert.ok(start >= 0 && end > start, 'async submitExpenseOperation must be present and isolatable');
const source = helperSource + html.slice(start, end);
const fixedNow = 1234567890123;
class FixedDate extends Date {
  static now() { return fixedNow; }
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
}
async function runExpense({ expenses = [], math = Math, saveResult = true, amount = '10', cash = 100, confirmResult = true, openingInput = '0', paymentMethod = 'cash' } = {}) {
  const alerts = [];
  let saves = 0;
  const fields = {
    expAmountInput: { value: amount, focus() {} },
    expDescInput: { value: 'Test expense' },
    expAccountInput: { value: 'General' },
    expPaymentMethod: { value: paymentMethod }
  };
  const appData = { caisseBalance: cash, expenses: expenses.map(x => ({ ...x })) };
  const context = {
    AppData: appData,
    document: { getElementById: id => fields[id] || null },
    alert: message => alerts.push(String(message)),
    confirm: message => { alerts.push('CONFIRM: ' + String(message)); return confirmResult; },
    prompt: () => openingInput,
    saveDBDurably: async () => {
      saves++;
      if (!saveResult) throw new Error('simulated IndexedDB write failure');
      return true;
    },
    updateCashUI() {},
    Date: FixedDate,
    Math: math,
    Number, String, Object, Array, Set, console
  };
  vm.createContext(context);
  await vm.runInContext(source + '\nsubmitExpenseOperation();', context);
  return { appData, alerts, saves };
}

test('duplicate expense ledger IDs fail closed before IndexedDB writes', async () => {
  const result = await runExpense({ expenses: [{ id: 'EXP-DUP' }, { id: 'EXP-DUP' }] });
  assert.equal(result.saves, 0);
  assert.equal(result.appData.caisseBalance, 100);
  assert.equal(result.appData.expenses.length, 2);
  assert.ok(result.alerts.some(message => message.includes('معرّفات مكررة')));
});

test('generated expense ID collisions are resolved without losing ledger entries', async () => {
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => 0.5;
  const baseId = 'EXP-' + fixedNow.toString(36).toUpperCase() + '-' + (0.5).toString(36).slice(2, 7).toUpperCase();
  const result = await runExpense({ expenses: [{ id: baseId, amt: 1 }], math: deterministicMath });
  assert.equal(result.saves, 1);
  assert.equal(result.appData.expenses.length, 2);
  assert.equal(result.appData.expenses[1].id, baseId + '-1');
  assert.equal(new Set(result.appData.expenses.map(x => x.id)).size, 2);
  assert.equal(result.appData.caisseBalance, 90);
});

test('fractional cash expense settles exactly in integer centimes after durable save', async () => {
  const result = await runExpense({ amount: '0.1', cash: 100.1 });
  assert.equal(result.saves, 1);
  assert.equal(result.appData.caisseBalance, 100);
  assert.equal(result.appData.expenses[0].amt, 0.1);
});

test('empty-cashbox expense can be recorded as pending driver advance without cash deduction', async () => {
  const result = await runExpense({ amount: '2000', cash: 0, confirmResult: true });
  assert.equal(result.saves, 1);
  assert.equal(result.appData.caisseBalance, 0);
  assert.equal(result.appData.expenses.length, 1);
  assert.equal(result.appData.expenses[0].paymentMethod, 'driver_advance');
  assert.equal(result.appData.expenses[0].settlementStatus, 'pending');
  assert.equal(result.appData.cashMovements, undefined);
});

test('explicit driver-advance selection saves with zero cash and creates no cash movement', async () => {
  const result = await runExpense({ amount: '2000', cash: 0, paymentMethod: 'driver_advance' });
  assert.equal(result.saves, 1);
  assert.equal(result.appData.caisseBalance, 0);
  assert.equal(result.appData.expenses[0].paymentMethod, 'driver_advance');
  assert.equal(result.appData.expenses[0].settlementStatus, 'pending');
  assert.equal(result.appData.cashMovements, undefined);
  assert.equal(result.alerts.some(message => message.startsWith('CONFIRM:')), false);
});

test('cash expense can be funded by an auditable opening-balance movement', async () => {
  const result = await runExpense({ amount: '2000', cash: 0, confirmResult: false, openingInput: '2000' });
  assert.equal(result.saves, 1);
  assert.equal(result.appData.caisseBalance, 0);
  assert.equal(result.appData.expenses.length, 1);
  assert.equal(result.appData.expenses[0].paymentMethod, 'cash');
  assert.equal(result.appData.expenses[0].settlementStatus, 'settled');
  assert.equal(result.appData.cashMovements.length, 1);
  assert.equal(result.appData.cashMovements[0].referenceType, 'opening_balance');
  assert.equal(result.appData.cashMovements[0].amount, 2000);
});

test('failed durable expense save restores the cashbox and both ledgers', async () => {
  const result = await runExpense({ amount: '25', cash: 100, saveResult: false });
  assert.equal(result.appData.caisseBalance, 100);
  assert.equal(result.appData.expenses.length, 0);
  assert.equal(result.saves, 2, 'one failed write plus one rollback attempt must be awaited');
  assert.ok(result.alerts.some(message => message.includes('التخزين الدائم')));
});
