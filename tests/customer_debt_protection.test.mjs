import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const debt = require('../customer-debt-protection.js');

test('editing a customer preserves the authoritative debt while creation accepts opening debt', () => {
  assert.equal(debt.anasCustomerDebtForSave(true, { debt: 8400 }, 0), 8400);
  assert.equal(debt.anasCustomerDebtForSave(true, { debt: 8400 }, 999999), 8400);
  assert.equal(debt.anasCustomerDebtForSave(true, {}, 999999), 0);
  assert.equal(debt.anasCustomerDebtForSave(false, null, 1250), 1250);
});

test('debt filters classify positive, clear and malformed balances safely', () => {
  assert.equal(debt.anasCustomerDebtFilterMatches({ debt: 125.5 }, 'debt'), true);
  assert.equal(debt.anasCustomerDebtFilterMatches({ debt: 0 }, 'clear'), true);
  assert.equal(debt.anasCustomerDebtFilterMatches({ debt: 'bad' }, 'debt'), false);
  assert.equal(debt.anasCustomerDebtFilterMatches({ debt: 'bad' }, 'all'), true);
});

test('collection history is customer-scoped, receipt-only, newest-first and capped at ten', () => {
  const movements = [
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: 100, date: '2026-01-01T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'B', type: 'add', amount: 200, date: '2026-01-02T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'remove', amount: 50, date: '2026-01-03T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: -5, date: '2026-01-04T10:00:00Z' },
    { referenceType: 'cash_sale', referenceId: 'A', type: 'add', amount: 500, date: '2026-01-05T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: 75, date: '2026-01-06T10:00:00Z' }
  ];
  assert.deepEqual(debt.anasGetCustomerDebtCollections('A', movements).map(x => x.amount), [75, 100]);
  const many = Array.from({ length: 12 }, (_, i) => ({
    referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: i + 1,
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString()
  }));
  const selected = debt.anasGetCustomerDebtCollections('A', many);
  assert.equal(selected.length, 10);
  assert.equal(selected[0].amount, 12);
  assert.equal(selected[9].amount, 3);
  assert.deepEqual(debt.anasGetCustomerDebtCollections('A', null), []);
});

test('collection history renderer escapes untrusted user labels', () => {
  const html = debt.anasRenderCustomerDebtCollections(
    { id: 'A' },
    [{ referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: 20,
      date: '2026-01-01T10:00:00Z', userName: '<img src=x onerror=alert(1)>' }]
  );
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img/);
});


test('missing and blank legacy balances are treated as clear without changing customer records', () => {
  const missing = { id: 'C-missing' };
  const blank = { id: 'C-blank', debt: '   ' };
  assert.equal(debt.anasCustomerDebtFilterMatches(missing, 'clear'), true);
  assert.equal(debt.anasCustomerDebtFilterMatches(blank, 'clear'), true);
  assert.equal(debt.anasCustomerDebtFilterMatches({ id: 'C-bad', debt: -1 }, 'clear'), false);
  assert.deepEqual(missing, { id: 'C-missing' });
  assert.deepEqual(blank, { id: 'C-blank', debt: '   ' });
});

test('customer collection history returns a sorted copy and never mutates the source ledger', () => {
  const movements = [
    { referenceType: 'customer_debt', referenceId: 'C-1', type: 'add', amount: 10, date: '2026-02-01T00:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'C-1', type: 'add', amount: 20, date: '2026-03-01T00:00:00Z' }
  ];
  const before = structuredClone(movements);
  const selected = debt.anasGetCustomerDebtCollections('C-1', movements);
  assert.deepEqual(selected.map(item => item.amount), [20, 10]);
  assert.deepEqual(movements, before);
  assert.notEqual(selected, movements);
});
