const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function editSalesInvoice(invoiceId) {');
const end = html.indexOf('\n        function ', start + 20);
assert.ok(start >= 0 && end > start, 'editSalesInvoice must be present and isolatable');
const source = html.slice(start, end);
const resolution = source.indexOf('const matchingInvoices = invoices.filter(');
const selected = source.indexOf('const inv = matchingInvoices[0]');
const prompt = source.indexOf('prompt(');
const mutation = source.indexOf('stockChanges');
assert.ok(resolution >= 0, 'invoice editing must resolve all matching invoice IDs');
assert.ok(source.includes('matchingInvoices.length !== 1'), 'invoice editing must fail closed when an ID is missing or ambiguous');
assert.ok(source.includes('معرّف الفاتورة مكرر'), 'ambiguous invoice IDs must show an explicit warning');
assert.ok(selected > resolution && prompt > selected, 'the invoice must be uniquely resolved before prompting for edits');
assert.ok(mutation > selected, 'invoice selection guard must run before stock reconciliation');
console.log('Ambiguous invoice edit identity checks passed');
