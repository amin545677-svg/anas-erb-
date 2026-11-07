import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('durable POS posting enforces credit_limit before any financial or stock mutation', async () => {
  const html = await readFile('index.html', 'utf8');
  const start = html.indexOf('function confirmHasibPaymentDurable()');
  assert.ok(start >= 0, 'durable checkout function must exist');
  const end = html.indexOf('\n        function ', start + 20);
  const durable = html.slice(start, end < 0 ? undefined : end);
  const guard = durable.indexOf('const creditLimitCents = anasToCents(cust.credit_limit)');
  const firstMutation = durable.search(/(?:\.stock\s*=|cust\.debt\s*=|AppData\.caisseBalance\s*=|AppData\.invoices\.push)/);
  assert.ok(guard >= 0, 'credit ceiling must be checked inside the durable posting function');
  assert.ok(firstMutation < 0 || guard < firstMutation,
    'credit ceiling check must precede all stock, debt, cash and invoice mutations');
  assert.match(durable, /remainingCents > 0 && newDebtCents > creditLimitCents/);
  assert.match(durable, /حد ائتمان العميل غير صالح/);
  assert.match(durable, /يتجاوز حد الائتمان/);
});
