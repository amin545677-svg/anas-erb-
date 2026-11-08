import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CartEngine, MicroPOSHelpers, ProgressiveListRenderer,
  createDailyImportQuota, getOrCreateDeviceId, setCloudSyncState
} from '../pos/micro-pos-deep-core.mjs';

function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); }
  };
}

test('progressive renderer emits 20-item windows and progressive badges', () => {
  const container = {
    innerHTML: '', html: '', scrollTop: 0, clientHeight: 100, scrollHeight: 1000,
    insertAdjacentHTML(_where, value) { this.html += value; },
    addEventListener() {}, removeEventListener() {}
  };
  const badge = { textContent: '' };
  const renderer = new ProgressiveListRenderer(container, badge, 20);
  renderer.setItems(Array.from({ length: 45 }, (_, i) => i + 1), value => '<i>' + value + '</i>');
  assert.equal((container.html.match(/<i>/g) || []).length, 20);
  assert.equal(badge.textContent, '+20');
  assert.equal(renderer.renderNextChunk(), 20);
  assert.equal(badge.textContent, '+40');
  assert.equal(renderer.renderNextChunk(), 5);
  assert.equal(badge.textContent, '45');
  assert.equal(renderer.renderNextChunk(), 0);
  renderer.destroy();
});

test('free cart items and fixed/percentage discounts use bounded centime arithmetic', () => {
  const cart = CartEngine.addCustomFreeItem([], { title: 'خدمة توصيل', price: '125.50', quantity: '2' });
  assert.equal(cart.length, 1);
  assert.match(cart[0].id, /^custom_item_/);
  assert.equal(cart[0].isFreeItem, true);
  assert.equal(cart[0].affectsInventory, false);
  const fixed = CartEngine.calculateCartSummary(cart, '50.25', 'fixed');
  assert.equal(fixed.subtotalCents, 25100);
  assert.equal(fixed.discountCents, 5025);
  assert.equal(fixed.finalTotalCents, 20075);
  const percent = CartEngine.calculateCartSummary(cart, '10', 'percent');
  assert.equal(percent.discountCents, 2510);
  assert.equal(percent.finalTotalCents, 22590);
  assert.equal(CartEngine.calculateCartSummary(cart, '150', 'percent').finalTotalCents, 0);
  assert.throws(() => CartEngine.calculateCartSummary(cart, '-1', 'fixed'), /NEGATIVE_DISCOUNT/);
  assert.throws(() => CartEngine.addCustomFreeItem([], { price: 10, quantity: 0 }), /INVALID_QUANTITY/);
});

test('Arabic customer initials and phone-independent rendering helper are deterministic', () => {
  assert.equal(MicroPOSHelpers.getArabicInitials('أسامة بلقايد'), 'أب');
  assert.equal(MicroPOSHelpers.getArabicInitials('أشرف تندوف'), 'أت');
  assert.equal(MicroPOSHelpers.getArabicInitials('إدريس عفيفي'), 'إع');
  assert.equal(MicroPOSHelpers.getArabicInitials('محمد'), 'مح');
  assert.equal(MicroPOSHelpers.getArabicInitials(''), 'ز');
});

test('customer contact actions hide without a phone and invoices carry a stable device identity', () => {
  assert.deepEqual(MicroPOSHelpers.getCustomerContactState(''), {
    hasPhone: false, phone: '', showCall: false, showWhatsApp: false, label: 'بدون هاتف'
  });
  assert.equal(MicroPOSHelpers.getCustomerContactState('0550123456').showCall, true);
  const invoice = MicroPOSHelpers.stampInvoiceWithDeviceId({ id: 'INV-1', total: 100 }, 'device_123456789012');
  assert.equal(invoice.device_id, 'device_123456789012');
  assert.equal(invoice.total, 100);
  assert.throws(() => MicroPOSHelpers.stampInvoiceWithDeviceId({}, ''), /DEVICE_ID_REQUIRED/);
});

test('file guard enforces 2MB sheets, 10MB media and rejects unsupported formats', () => {
  const mb = 1024 * 1024;
  assert.equal(MicroPOSHelpers.validateImportFile({ name: 'data.xlsx', size: 2 * mb }).valid, true);
  assert.equal(MicroPOSHelpers.validateImportFile({ name: 'data.csv', size: 2 * mb + 1 }).valid, false);
  assert.equal(MicroPOSHelpers.validateImportFile({ name: 'scan.pdf', size: 10 * mb }).valid, true);
  assert.equal(MicroPOSHelpers.validateImportFile({ name: 'scan.jpg', size: 10 * mb + 1 }).valid, false);
  assert.equal(MicroPOSHelpers.validateImportFile({ name: 'payload.exe', size: 10 }).valid, false);
  assert.equal(MicroPOSHelpers.validateImportFile(null).valid, false);
});

test('daily AI import quota resets by local day and never exceeds the configured limit', () => {
  const storage = memoryStorage();
  let date = new Date(2026, 10, 7, 8);
  const quota = createDailyImportQuota(storage, { limit: 2, now: () => date });
  assert.equal(quota.status().remaining, 2);
  assert.equal(quota.consume().remaining, 1);
  assert.equal(quota.consume().remaining, 0);
  assert.equal(quota.consume().allowed, false);
  date = new Date(2026, 10, 8, 1);
  assert.equal(quota.status().remaining, 2);
  assert.equal(quota.consume().allowed, true);
});

test('device identity is stable and cloud badge reflects offline, pending and synced states', () => {
  const storage = memoryStorage();
  const first = getOrCreateDeviceId(storage);
  assert.equal(getOrCreateDeviceId(storage), first);
  assert.ok(first.length >= 16);
  const attrs = {};
  const badge = { dataset: {}, textContent: '', setAttribute(name, value) { attrs[name] = value; } };
  assert.equal(setCloudSyncState(badge, { online: false, pending: 0 }), 'offline');
  assert.equal(setCloudSyncState(badge, { online: true, pending: 2 }), 'pending');
  assert.equal(setCloudSyncState(badge, { online: true, pending: 0 }), 'synced');
  assert.equal(badge.dataset.syncState, 'synced');
  assert.match(attrs['aria-label'], /متزامنة/);
});
