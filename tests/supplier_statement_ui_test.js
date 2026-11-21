'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildSupplierStatement } = require('../supplier-account-statement.js');
assert.equal(typeof buildSupplierStatement, 'function', 'standalone supplier statement module must load');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'supplier-account-statement.js'), 'utf8');
assert.match(source, /root\.showSupplierStatement\s*=\s*showSupplierStatement/);

class FakeElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.style = {}; this.listeners = {}; this._text = ''; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { this.children.push(node); return node; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  remove() { this.removed = true; }
  focus() { this.focused = true; }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent || '').join(''); }
}

function harness({ suppliers, supplierMovements }) {
  const body = new FakeElement('body');
  const alerts = [];
  const ctx = {
    AppData: { suppliers, supplierMovements },
    document: { body, createElement: tag => new FakeElement(tag) },
    alert: message => alerts.push(String(message)),
    anasPurchaseToCents(value) {
      if (typeof value !== 'number' && typeof value !== 'string') return NaN;
      if (String(value).trim() === '') return NaN;
      const n = Number(value);
      return Number.isFinite(n) && Number.isSafeInteger(Math.round(n * 100)) ? Math.round(n * 100) : NaN;
    },
    anasPurchaseCentsToCurrency(cents) { return cents / 100; },
    Date, Math, String, Number, Object, Array
  };
  vm.createContext(ctx);
  vm.runInContext(source + '\nthis.openStatement = this.showSupplierStatement;', ctx, { timeout: 1500 });
  return { ctx, body, alerts };
}

{
  const rows = [
    { id: 'M-4', supplierId: 'S-1', type: 'payment', amount: '2.00', referenceId: 'PAY-1', date: '2026-10-04T10:00:00Z', note: 'دفعة' },
    { id: 'M-2', supplierId: 'S-1', type: 'purchase', amount: '12.50', referenceId: 'PUR-1', date: '2026-10-02T10:00:00Z', note: 'فاتورة أولى' },
    { id: 'M-1', supplierId: 'S-1', type: 'opening_balance', amount: '5.00', referenceId: 'S-1', date: '2026-10-01T10:00:00Z', note: 'افتتاحي' },
    { id: 'M-3', supplierId: 'S-1', type: 'purchase', amount: '3.25', referenceId: 'PUR-2', date: '2026-10-03T10:00:00Z', note: '<img src=x onerror=alert(1)>' },
    { id: 'OTHER', supplierId: 'S-2', type: 'purchase', amount: '999', referenceId: 'OTHER' }
  ];
  const h = harness({ suppliers: [{ id: 'S-1', name: 'مورد الاختبار', balance: '18.75' }], supplierMovements: rows });
  h.ctx.openStatement('S-1');
  assert.equal(h.body.children.length, 1, 'statement dialog should be mounted');
  const dialog = h.body.children[0];
  const text = dialog.textContent;
  assert.match(text, /مورد الاختبار/);
  assert.match(text, /الرصيد الحالي/);
  assert.match(text, /الرصيد الافتتاحي/);
  assert.match(text, /المشتريات/);
  assert.match(text, /التسديدات/);
  assert.ok(text.indexOf('PUR-1') < text.indexOf('PUR-2') && text.indexOf('PUR-2') < text.indexOf('PAY-1'), 'movements should be chronological');
  assert.ok(text.includes('<img src=x onerror=alert(1)>'), 'untrusted note must be rendered as literal text');
  assert.equal(dialog.children[0].children[1].textContent, 'إغلاق');
  console.log('PASS: full supplier statement shows every movement, exact summary buckets, and chronological order');
}

{
  const h = harness({ suppliers: [{ id: 'S-1', name: 'Supplier', balance: 0 }, { id: 'S-1', name: 'Duplicate', balance: 0 }], supplierMovements: [] });
  assert.throws(() => h.ctx.openStatement('S-1'), /مكرر/);
  assert.equal(h.body.children.length, 0);
  console.log('PASS: duplicate supplier identities fail closed without rendering a statement');
}

{
  const h = harness({ suppliers: [{ id: 'S-1', name: 'Supplier', balance: 0 }], supplierMovements: null });
  assert.throws(() => h.ctx.openStatement('S-1'), /غير صالح/);
  assert.equal(h.body.children.length, 0);
  console.log('PASS: malformed supplier ledger fails closed without rendering an incomplete statement');
}

// Regression: filtered/reordered supplier cards must bind actions by stable ID, never array index.
assert.match(fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8'), /card\.setAttribute\('data-supplier-id', String\(s\.id \?\? ''\)\)/);
assert.match(source, /forEach\(card=>\{const supplierId=card&&typeof card\.getAttribute==='function'\?card\.getAttribute\('data-supplier-id'\)/);
assert.doesNotMatch(source, /forEach\(\(card,index\)=>\{const supplier=AppData\.suppliers\[index\]/);
console.log('Supplier statement UI tests passed');

{
  const result = buildSupplierStatement('S1', [{ id: 'S1', name: 'مورد', balance: 8 }], [
    { id: 'P1', supplierId: 'S1', type: 'purchase', amount: 12.5, date: '2026-01-01' },
    { id: 'M1', supplierId: 'S1', type: 'payment', amount: 4.5, date: '2026-01-02' }
  ]);
  assert.equal(result.totals.purchase, 1250);
  assert.equal(result.totals.payment, 450);
  console.log('PASS: standalone supplier-account-statement.js exports exact centime totals');
}

{
  const result = buildSupplierStatement('S1', [{ id: 'S1', name: 'مورد', balance: '0.30' }], [
    { id: 'P1', supplierId: 'S1', type: 'purchase', amount: '0.10', date: '2026-01-01' },
    { id: 'M1', supplierId: 'S1', type: 'payment', amount: 0.2, date: '2026-01-02' }
  ]);
  assert.equal(result.totals.purchase, 10, '0.10 must be parsed as exactly ten centimes');
  assert.equal(result.totals.payment, 20, 'numeric 0.2 must be parsed as exactly twenty centimes');
  assert.equal(result.balanceCentimes, 30, 'supplier balance must use the same exact centime parser');
  assert.equal(result.valid.balance, true);
  console.log('PASS: supplier statement uses exact centime parsing for strings, numbers and current balance');
}

{
  const result = buildSupplierStatement('S1', [{ id: 'S1', name: 'مورد', balance: '0.001' }], [
    { id: 'P1', supplierId: 'S1', type: 'purchase', amount: '1.005', date: '2026-01-01' },
    { id: 'M1', supplierId: 'S1', type: 'payment', amount: '1e2', date: '2026-01-02' }
  ]);
  assert.equal(result.totals.purchase, 0, 'amounts with more than two decimal places must not be silently rounded');
  assert.equal(result.totals.payment, 0, 'scientific notation must not be accepted as a currency entry');
  assert.equal(result.valid.purchase, false);
  assert.equal(result.valid.payment, false);
  assert.equal(result.balanceCentimes, null, 'invalid supplier balance must not be rounded into a plausible amount');
  assert.equal(result.valid.balance, false);
  console.log('PASS: supplier statement rejects ambiguous, over-precision and scientific-notation currency values');
}
