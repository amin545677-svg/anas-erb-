import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const match = html.match(/        \/\/ محرك استعلام موحد[\s\S]*?(?=        \/\/ بحث البيع:)/);
assert.ok(match, 'shared query engine must exist in index.html');
const context = {};
vm.runInNewContext(match[0] + '\nthis.api = { anasNormalizeQueryText, anasQueryMatches, anasQueryScore };', context);
const { anasNormalizeQueryText, anasQueryMatches, anasQueryScore } = context.api;

test('normalizes Arabic alef variants, diacritics and tatweel', () => {
  assert.equal(anasNormalizeQueryText('إِبْرَاهِيمـ'), 'ابراهيم');
});

test('normalizes Arabic-Indic and Persian digits to ASCII', () => {
  assert.equal(anasNormalizeQueryText('باركود ١٢٣ ۴۵'), 'باركود 123 45');
});

test('matches every query token across multiple fields', () => {
  assert.equal(anasQueryMatches(['زيت الزيتون', 'منتج غذائي'], 'الزيت منتج'), true);
  assert.equal(anasQueryMatches(['زيت الزيتون', 'منتج غذائي'], 'الزيت دواء'), false);
});

test('empty query matches all records', () => {
  assert.equal(anasQueryMatches(['أي منتج'], '   '), true);
});

test('ranks exact and prefix matches above partial matches', () => {
  assert.ok(anasQueryScore(['زيت الزيتون'], 'زيت الزيتون') > anasQueryScore(['زيت الزيتون'], 'الزيت'));
  assert.ok(anasQueryScore(['زيت الزيتون'], 'زيت') > anasQueryScore(['زيت الزيتون'], 'الزيت'));
});

test('invoice history search is connected to the shared multi-field query engine', () => {
  assert.match(html, /id="invoiceListSearch"[^>]+oninput="renderInvoicesList\(\)"/);
  assert.match(html, /filteredInvoices = invoices\.filter\(inv => inv && anasQueryMatches\(/);
  assert.match(html, /inv\.id, inv\.customer, inv\.date, inv\.createdAt, inv\.invoiceDate, inv\.total/);
});

test('report table and report-entry filtering use Arabic-aware all-token matching', () => {
  assert.match(html, /function anasFilterCurrentReport\(query\)[\s\S]*?const q = anasNormalizeQueryText\(query \|\| ''\)/);
  assert.match(html, /anasQueryMatches\(\[row\.textContent \|\| ''\], q\)/);
  assert.match(html, /anasQueryMatches\(\[node\.textContent \|\| ''\], q\)/);
});

test('quick-sale exact barcode auto-add normalizes Arabic and Persian digits', () => {
  assert.match(html, /anasNormalizeQueryText\(list\[0\]\.barcode\|\|'\'\)===q/);
});

test('customer debt screen uses shared Arabic-aware query matching', () => {
  assert.match(html, /id="customerDebtSearch"[^>]+oninput="renderCustomersDebts\(\)"/);
  assert.match(html, /filteredCustomers = customers\.filter\(c => c && anasQueryMatches\(/);
  assert.match(html, /c\.name, c\.phone, c\.phone2, c\.address, c\.rc, c\.nif, c\.nis, c\.art, c\.debt/);
});

test('supplier debt screen uses shared Arabic-aware query matching', () => {
  assert.match(html, /id="supplierDebtSearch"[^>]+oninput="renderSuppliersDebts\(\)"/);
  assert.match(html, /filteredSuppliers = suppliers\.filter\(s => s && anasQueryMatches\(/);
  assert.match(html, /s\.name, s\.phone, s\.phone2, s\.address, s\.rc, s\.nif, s\.nis, s\.art, s\.balance/);
});


const customerDebtMatch = html.match(/        function anasCustomerDebtForSave\([\s\S]*?(?=        function saveNewCustomerMpos)/);
assert.ok(customerDebtMatch, 'customer debt preservation helper must exist');
const customerDebtContext = {};
vm.runInNewContext(customerDebtMatch[0] + '\nthis.resolve = anasCustomerDebtForSave;', customerDebtContext);
const anasCustomerDebtForSave = customerDebtContext.resolve;
test('customer profile edits preserve stored debt and new customers accept opening debt', () => {
  assert.equal(anasCustomerDebtForSave(true, { debt: 8400 }, 0), 8400);
  assert.equal(anasCustomerDebtForSave(true, { debt: 8400 }, 999999), 8400);
  assert.equal(anasCustomerDebtForSave(true, {}, 999999), 0);
  assert.equal(anasCustomerDebtForSave(false, null, 1250), 1250);
});

const debtFilterMatch = html.match(/        function anasCustomerDebtFilterMatches\([\s\S]*?(?=        function setCustomerDirectoryDebtFilter)/);
assert.ok(debtFilterMatch, 'customer debt filter helper must exist');
const debtFilterContext = {};
vm.runInNewContext(debtFilterMatch[0] + '\nthis.match = anasCustomerDebtFilterMatches;', debtFilterContext);
const anasCustomerDebtFilterMatches = debtFilterContext.match;
test('customer debt filters distinguish positive, clear and malformed balances', () => {
  assert.equal(anasCustomerDebtFilterMatches({ debt: 125.5 }, 'debt'), true);
  assert.equal(anasCustomerDebtFilterMatches({ debt: 0 }, 'clear'), true);
  assert.equal(anasCustomerDebtFilterMatches({ debt: 'bad' }, 'debt'), false);
  assert.equal(anasCustomerDebtFilterMatches({ debt: 'bad' }, 'all'), true);
});

const collectionsMatch = html.match(/        function anasGetCustomerDebtCollections\([\s\S]*?(?=        function anasRenderCustomerDebtCollections)/);
assert.ok(collectionsMatch, 'customer collection history selector must exist');
const collectionsContext = {};
vm.runInNewContext(collectionsMatch[0] + '\nthis.select = anasGetCustomerDebtCollections;', collectionsContext);
const anasGetCustomerDebtCollections = collectionsContext.select;
test('customer collection history is isolated and includes valid receipts only', () => {
  const movements = [
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: 100, date: '2026-01-01T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'B', type: 'add', amount: 200, date: '2026-01-02T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'remove', amount: 50, date: '2026-01-03T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: -5, date: '2026-01-04T10:00:00Z' },
    { referenceType: 'cash_sale', referenceId: 'A', type: 'add', amount: 500, date: '2026-01-05T10:00:00Z' },
    { referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: 75, date: '2026-01-06T10:00:00Z' }
  ];
  const selected = anasGetCustomerDebtCollections('A', movements);
  assert.equal(selected.length, 2);
  assert.deepEqual(Array.from(selected, x => x.amount), [75, 100]);
});
test('customer collection history caps display to ten newest records', () => {
  assert.equal(anasGetCustomerDebtCollections('A', null).length, 0);
  const movements = Array.from({ length: 12 }, (_, i) => ({
    referenceType: 'customer_debt', referenceId: 'A', type: 'add', amount: i + 1,
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString()
  }));
  const selected = anasGetCustomerDebtCollections('A', movements);
  assert.equal(selected.length, 10);
  assert.equal(selected[0].amount, 12);
  assert.equal(selected[9].amount, 3);
});
