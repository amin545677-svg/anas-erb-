import test from 'node:test';
import assert from 'node:assert/strict';
import Core from '../micro-pos-core.js';

test('fractional quantity and DZD line totals use exact micro-units and centimes', () => {
  assert.equal(Core.toMicroUnits('7.4'), 7400000);
  assert.equal(Core.lineTotalCents('7.4', '4800'), 3552000);
  assert.equal(Core.centsToCurrency(Core.lineTotalCents('0.2', '4800')), 960);
  assert.equal(Core.lineTotalCents('0.1', '0.10'), 1);
  assert.equal(Core.lineTotalCents('0.15', '0.10'), 2);
});

test('decimal parser rejects malformed and unsafe values rather than coercing silently', () => {
  assert.throws(() => Core.toMicroUnits('7kg'), /Invalid decimal/);
  assert.throws(() => Core.toCents('9007199254740992'), /safe integer/);
});

test('one inventory filter contract supports legacy and canonical product fields', () => {
  const rows = [
    { id: 1, name: 'Tea', barcode: '111', stock: 18.2, minAlert: 5, cat: 'Food', is_featured: true },
    { id: 2, name: 'Sugar', barcode: '222', stock: 2.4, minAlert: 5, cat: 'Food' },
    { id: 3, name: 'Rice', barcode: '333', stock: 0, minAlert: 5, category: 'Grain' }
  ];
  assert.deepEqual(Core.filterInventoryItems(rows, { status: 'available' }).map(x => x.id), [1]);
  assert.deepEqual(Core.filterInventoryItems(rows, { status: 'low' }).map(x => x.id), [2]);
  assert.deepEqual(Core.filterInventoryItems(rows, { status: 'out' }).map(x => x.id), [3]);
  assert.deepEqual(Core.filterInventoryItems(rows, { query: '222' }).map(x => x.id), [2]);
  assert.deepEqual(Core.filterInventoryItems(rows, { onlyFeatured: true }).map(x => x.id), [1]);
});

test('Algerian WhatsApp phone normalization accepts domestic and international mobile formats only', () => {
  assert.equal(Core.normalizeAlgeriaPhone('0551 23 45 67'), '213551234567');
  assert.equal(Core.normalizeAlgeriaPhone('+213 661 23 45 67'), '213661234567');
  assert.equal(Core.normalizeAlgeriaPhone('00213 771 23 45 67'), '213771234567');
  assert.equal(Core.normalizeAlgeriaPhone('1234567890'), '');
  assert.equal(Core.normalizeAlgeriaPhone('0000000000'), '');
});

test('sales period and status logic are deterministic and centime accurate', () => {
  const now = new Date('2026-11-07T12:00:00');
  const invoices = [
    { id: 'today', date: '2026-11-07T09:00:00', total: '100.00', paid: '100.00' },
    { id: 'week', date: '2026-11-02T09:00:00', total: '100.00', paid: '25.00' },
    { id: 'old', date: '2026-10-01T09:00:00', total: '100.00', paid: '0.00' }
  ];
  assert.deepEqual(Core.filterSalesInvoices(invoices, { period: '7d', now }).map(x => x.id), ['today', 'week']);
  assert.deepEqual(Core.filterSalesInvoices(invoices, { period: '30d', now }).map(x => x.id), ['today', 'week']);
  assert.equal(Core.invoiceStatus(invoices[0]), 'paid');
  assert.equal(Core.invoiceStatus(invoices[1]), 'partial');
  assert.equal(Core.invoiceStatus(invoices[2]), 'unpaid');
});
