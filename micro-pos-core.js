(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ANASMicroPOSCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const QTY_SCALE = 1000000n;
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

  function decimalToScaledBigInt(value, scaleDigits) {
    if (!Number.isInteger(scaleDigits) || scaleDigits < 0 || scaleDigits > 9) throw new RangeError('Invalid decimal scale');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Decimal must be finite');
    let raw = String(value == null || value === '' ? '0' : value).trim().replace(',', '.');
    if (!/^[+-]?(?:\d+)(?:\.\d*)?$/.test(raw)) throw new TypeError('Invalid decimal: ' + raw);
    const negative = raw[0] === '-';
    if (raw[0] === '+' || raw[0] === '-') raw = raw.slice(1);
    const parts = raw.split('.');
    const whole = parts[0] || '0';
    const fraction = parts[1] || '';
    const kept = (fraction + '0'.repeat(scaleDigits)).slice(0, scaleDigits);
    let units = BigInt(whole) * (10n ** BigInt(scaleDigits)) + BigInt(kept || '0');
    const discarded = fraction.slice(scaleDigits);
    if (discarded && discarded[0] >= '5') units += 1n;
    return negative ? -units : units;
  }
  function safeNumber(bigint) {
    if (bigint > MAX_SAFE || bigint < -MAX_SAFE) throw new RangeError('Value exceeds safe integer range');
    return Number(bigint);
  }
  function toCents(value) { return safeNumber(decimalToScaledBigInt(value, 2)); }
  function toMicroUnits(value) { return safeNumber(decimalToScaledBigInt(value, 6)); }
  function centsToCurrency(cents) {
    if (!Number.isSafeInteger(cents)) throw new TypeError('Invalid centime integer');
    return cents / 100;
  }
  function lineTotalCents(quantity, unitPrice, discount = 0) {
    const qty = decimalToScaledBigInt(quantity, 6);
    const price = decimalToScaledBigInt(unitPrice, 2);
    const disc = decimalToScaledBigInt(discount, 2);
    if (qty < 0n || price < 0n || disc < 0n) throw new RangeError('Quantity, price and discount must be non-negative');
    const product = qty * price;
    const gross = (product + QTY_SCALE / 2n) / QTY_SCALE;
    return safeNumber(gross > disc ? gross - disc : 0n);
  }
  function stockStatus(quantity, minimum = 5) {
    const qty = Number(quantity);
    const min = Number(minimum);
    if (!Number.isFinite(qty)) return { code: 'invalid', label: 'غير صالح' };
    if (qty <= 0) return { code: 'out', label: 'نافد' };
    if (qty <= (Number.isFinite(min) && min > 0 ? min : 5)) return { code: 'low', label: 'منخفض' };
    return { code: 'available', label: 'متوفر' };
  }
  function filterInventoryItems(items, options = {}) {
    const query = String(options.query || '').trim().toLocaleLowerCase();
    const category = options.category || 'ALL';
    const requestedStatus = options.status || 'ALL';
    const status = requestedStatus === 'all' || requestedStatus === 'الكل' ? 'ALL' : requestedStatus;
    return (Array.isArray(items) ? items : []).filter(item => {
      if (!item) return false;
      if ((options.onlyFeatured || status === 'featured') && !(item.is_featured || item.featured || item.favorite || item.isFavorite)) return false;
      const itemCategory = item.category ?? item.cat ?? 'عام';
      if (category !== 'ALL' && category !== 'الكل' && String(itemCategory) !== String(category)) return false;
      const rawStock = item.stock ?? item.quantity;
      if (rawStock === undefined || rawStock === null || rawStock === '' || !Number.isFinite(Number(rawStock))) return false;
      const stock = stockStatus(rawStock, item.minAlert ?? item.min_limit).code;
      if (status !== 'ALL' && status !== 'featured' && stock !== status) return false;
      if (!query) return true;
      return [item.name, item.title, item.barcode, item.sku].some(v => String(v || '').toLocaleLowerCase().includes(query));
    });
  }
  function normalizeAlgeriaPhone(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('00213')) digits = digits.slice(2);
    if (digits.startsWith('0') && digits.length === 10) digits = '213' + digits.slice(1);
    else if (digits.length === 9 && /^[567]/.test(digits)) digits = '213' + digits;
    if (!/^213[567]\d{8}$/.test(digits)) return '';
    return digits;
  }
  function invoiceAmounts(invoice) {
    try {
      const totalCents = toCents(invoice && invoice.total || 0);
      const paidCents = toCents(invoice && invoice.paid || 0);
      if (totalCents < 0 || paidCents < 0) return { valid: false, totalCents: 0, paidCents: 0, remainingCents: 0 };
      return { valid: true, totalCents, paidCents, remainingCents: Math.max(0, totalCents - paidCents) };
    } catch (_) {
      return { valid: false, totalCents: 0, paidCents: 0, remainingCents: 0 };
    }
  }
  function invoiceStatus(invoice) {
    const amounts = invoiceAmounts(invoice);
    if (!amounts.valid) return 'invalid';
    if (amounts.totalCents <= 0 || amounts.paidCents >= amounts.totalCents) return 'paid';
    return amounts.paidCents <= 0 ? 'unpaid' : 'partial';
  }
  function filterSalesInvoices(invoices, { period = 'all', sort = 'newest', now = new Date() } = {}) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (period === '7d') start.setDate(start.getDate() - 6);
    if (period === '30d') start.setDate(start.getDate() - 29);
    const rows = (Array.isArray(invoices) ? invoices : []).filter(inv => {
      if (!inv) return false;
      if (period === 'all') return true;
      const date = new Date(inv.createdAt || inv.timestamp || inv.date || inv.invoiceDate || '');
      return !Number.isNaN(date.getTime()) && date >= start && date <= now;
    });
    return rows.sort((a, b) => {
      const ta = Date.parse(a.createdAt || a.timestamp || a.date || a.invoiceDate || '') || 0;
      const tb = Date.parse(b.createdAt || b.timestamp || b.date || b.invoiceDate || '') || 0;
      if (sort === 'oldest') return ta - tb;
      if (sort === 'amount') return invoiceAmounts(b).totalCents - invoiceAmounts(a).totalCents;
      return tb - ta;
    });
  }
  function createInventoryEventBridge(target) {
    if (!target || target.__anasInventoryBridgeInstalled) return false;
    target.__anasInventoryBridgeInstalled = true;
    let refreshing = false;
    const refresh = event => {
      if (refreshing) return;
      refreshing = true;
      try {
        const detail = event && event.detail || {};
        if (typeof target.renderInventoryList === 'function') target.renderInventoryList();
        if (typeof target.renderQuickProducts === 'function') target.renderQuickProducts();
        target.dispatchEvent(new target.CustomEvent('anas:inventory-refreshed', { detail }));
      } finally { refreshing = false; }
    };
    target.addEventListener('anas:inventory-changed', refresh);
    const inventoryFingerprint = () => {
      if (!target.AppData || !Array.isArray(target.AppData.products)) return null;
      try { return JSON.stringify(target.AppData.products); }
      catch (_) { return undefined; }
    };
    const inventoryChanged = (before, after) =>
      before === null || after === null || before === undefined || after === undefined || before !== after;
    const original = typeof target.saveDB === 'function' ? target.saveDB : null;
    if (original) {
      target.saveDB = function () {
        const before = inventoryFingerprint();
        const result = original.apply(this, arguments);
        const after = inventoryFingerprint();
        if (result === true && inventoryChanged(before, after)) {
          target.dispatchEvent(new target.CustomEvent('anas:inventory-changed', { detail: { source: 'saveDB' } }));
        }
        return result;
      };
    }
    const originalDurable = typeof target.saveDBDurably === 'function' ? target.saveDBDurably : null;
    if (originalDurable) {
      target.saveDBDurably = async function () {
        const before = inventoryFingerprint();
        const result = await originalDurable.apply(this, arguments);
        const after = inventoryFingerprint();
        if (result === true && inventoryChanged(before, after)) {
          target.dispatchEvent(new target.CustomEvent('anas:inventory-changed', { detail: { source: 'saveDBDurably' } }));
        }
        return result;
      };
    }
    return true;
  }
  return Object.freeze({ decimalToScaledBigInt, toCents, toMicroUnits, centsToCurrency, lineTotalCents, stockStatus, filterInventoryItems, normalizeAlgeriaPhone, invoiceAmounts, invoiceStatus, filterSalesInvoices, createInventoryEventBridge });
});
