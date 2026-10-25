const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('index.html', 'utf8');
const helperStart = source.indexOf('function anasEscapeHTML(value) {');
const helperEnd = source.indexOf('const initialDB =', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'HTML escape helper must exist');
const escapeHelper = source.slice(helperStart, helperEnd);

function extractFunction(name, nextName) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('function ' + nextName + '(', start + 1);
  assert.ok(start >= 0 && end > start, 'could not isolate ' + name);
  return source.slice(start, end);
}
const thermalSource = extractFunction('printThermalReceipt', 'printLegalA4Invoice');
const a4Source = extractFunction('printLegalA4Invoice', 'openInvoicePreview');

const malicious = '<img src=x onerror=alert(1)>';
const escaped = '&lt;img src=x onerror=alert(1)&gt;';
function makeContext() {
  const elements = {
    receiptPrintArea: { innerHTML: '', classList: { add() {}, remove() {} } },
    legalInvoiceA4Area: { innerHTML: '', classList: { add() {}, remove() {} } }
  };
  const context = {
    AppData: {
      storeConfig: {
        name: malicious, address: malicious, phone: malicious, phone2: malicious,
        rc: malicious, nif: malicious, nis: malicious, art: malicious, footer: malicious
      }
    },
    document: { getElementById: id => elements[id] || null },
    window: { print() {} },
    Number, String, Object, Array
  };
  vm.createContext(context);
  vm.runInContext(escapeHelper, context);
  return { context, elements };
}

const invoice = {
  id: malicious, date: malicious, customer: malicious,
  total: 10, paid: 0, remaining: 10, newDebt: 2,
  customerObj: { name: malicious, address: malicious, phone: malicious, rc: malicious, nif: malicious, art: malicious },
  items: [{ name: malicious, unit: malicious, qty: 2, price: 5 }]
};

{
  const { context, elements } = makeContext();
  vm.runInContext(thermalSource + '\nprintThermalReceipt(invoice);', Object.assign(context, { invoice }));
  const output = elements.receiptPrintArea.innerHTML;
  assert.ok(output.includes(escaped), 'thermal receipt should render escaped user-controlled text');
  assert.equal(output.includes(malicious), false, 'thermal receipt must not contain raw injected markup');
  assert.ok(output.includes('&lt;img src=x onerror=alert(1)&gt;'), 'thermal receipt should preserve the text visibly as text');
}

{
  const { context, elements } = makeContext();
  vm.runInContext(a4Source + '\nprintLegalA4Invoice(invoice, false);', Object.assign(context, { invoice }));
  const output = elements.legalInvoiceA4Area.innerHTML;
  assert.ok(output.includes(escaped), 'A4 invoice should render escaped user-controlled text');
  assert.equal(output.includes(malicious), false, 'A4 invoice must not contain raw injected markup');
}

console.log('Invoice print HTML escaping tests passed: thermal and A4 templates safely render imported/store/customer/item fields');
