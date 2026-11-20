import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../anas-pos-floating-cart.js', import.meta.url), 'utf8');
const start = source.indexOf('function decimalScaled(');
const end = source.indexOf('function render()', start);
assert.ok(start >= 0 && end > start, 'pricing primitives must remain isolatable');
const isolated = source.slice(start, end);
const validateCartPricing = new Function('window', isolated + '; return validateCartPricing;')({});

test('POS rejects zero, negative, malformed and over-precision unit prices before confirmation', () => {
  for (const price of ['0', '0.00', '-1', '12.345', 'NaN', '']) {
    const result = validateCartPricing([{ name: 'Tea', price, qty: 1 }]);
    assert.equal(result.ok, false, 'must reject price ' + JSON.stringify(price));
  }
  assert.deepEqual(validateCartPricing([{ name: 'Tea', price: '1550', qty: 1 }]), { ok: true, code: 'OK', index: -1 });
  assert.deepEqual(validateCartPricing([{ name: 'Tea', price: '15,50', qty: 1 }]), { ok: true, code: 'OK', index: -1 });
});

test('zero-price sample requires an explicit flag and a documented reason', () => {
  assert.equal(validateCartPricing([{ name: 'Sample', price: '0', freeSample: true }]).code, 'ZERO_PRICE');
  assert.equal(validateCartPricing([{ name: 'Sample', price: '0', freeSample: true, freeSampleReason: 'عرض ترويجي' }]).ok, true);
});

test('the actual checkout click is guarded in capture phase and zero-default free-entry price clears on focus', () => {
  assert.match(source, /document\.addEventListener\('click',guardSaleConfirmation,true\)/);
  assert.match(source, /preventDefault\(\);\s*event\.stopImmediatePropagation\(\)/);
  assert.match(source, /price\.addEventListener\('focus',[\s\S]*?price\.value=''/);
  assert.match(source, /data-anas-pricing-guard/);
});
