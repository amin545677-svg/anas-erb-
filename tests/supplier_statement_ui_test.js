'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function showSupplierStatement(supplierId)');
const end = html.indexOf('function paySupplierDebt(supplierId)', start);
assert.ok(start >= 0 && end > start, 'supplier statement function must be present and isolatable');
const source = html.slice(start, end);

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
  vm.runInContext(source + '\nthis.openStatement = showSupplierStatement;', ctx, { timeout: 1500 });
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
  assert.match(text, /عدد الحركات المسجلة: 4/);
  assert.match(text, /الرصيد الحالي/);
  assert.match(text, /الرصيد الافتتاحي/);
  assert.match(text, /إجمالي فواتير الشراء/);
  assert.match(text, /إجمالي التسديدات/);
  assert.ok(text.indexOf('PUR-1') < text.indexOf('PUR-2') && text.indexOf('PUR-2') < text.indexOf('PAY-1'), 'movements should be chronological');
  assert.ok(text.includes('<img src=x onerror=alert(1)>'), 'untrusted note must be rendered as literal text');
  assert.equal(dialog.children[0].children[1].textContent, 'إغلاق');
  console.log('PASS: full supplier statement shows every movement, exact summary buckets, and chronological order');
}

{
  const h = harness({ suppliers: [{ id: 'S-1', name: 'Supplier', balance: 0 }, { id: 'S-1', name: 'Duplicate', balance: 0 }], supplierMovements: [] });
  h.ctx.openStatement('S-1');
  assert.equal(h.body.children.length, 0);
  assert.ok(h.alerts.some(message => message.includes('مكرر')));
  console.log('PASS: duplicate supplier identities fail closed without rendering a statement');
}

{
  const h = harness({ suppliers: [{ id: 'S-1', name: 'Supplier', balance: 0 }], supplierMovements: null });
  h.ctx.openStatement('S-1');
  assert.equal(h.body.children.length, 0);
  assert.ok(h.alerts.some(message => message.includes('غير متاح')));
  console.log('PASS: malformed supplier ledger fails closed without rendering an incomplete statement');
}

console.log('Supplier statement UI tests passed');
