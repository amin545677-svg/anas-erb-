/**
 * ANAS ERP deep-core primitives inspired by the Micro POS field workflow.
 * UI adapters are deliberately isolated from financial persistence and stock mutation.
 */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function decimalToScaledBigInt(value, digits) {
  const raw = String(value == null || value === '' ? '0' : value).trim().replace(',', '.');
  if (!/^[+]?(?:\d+)(?:\.\d*)?$/.test(raw)) throw new TypeError('INVALID_DECIMAL');
  const [whole, fraction = ''] = raw.replace(/^\+/, '').split('.');
  const kept = (fraction + '0'.repeat(digits)).slice(0, digits);
  const discarded = fraction.slice(digits);
  let scaled = BigInt(whole || '0') * (10n ** BigInt(digits)) + BigInt(kept || '0');
  if (discarded && discarded[0] >= '5') scaled += 1n;
  return scaled;
}
function safeNumber(value) {
  if (value < 0n || value > MAX_SAFE) throw new RangeError('VALUE_OUT_OF_RANGE');
  return Number(value);
}
function toCents(value) { return safeNumber(decimalToScaledBigInt(value, 2)); }

export class ProgressiveListRenderer {
  constructor(containerEl, badgeEl, chunkSize = 20) {
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new RangeError('INVALID_CHUNK_SIZE');
    this.containerEl = containerEl || null;
    this.badgeEl = badgeEl || null;
    this.chunkSize = chunkSize;
    this.items = [];
    this.renderedCount = 0;
    this.renderCardFn = item => String(item ?? '');
    this._onScroll = () => {
      const el = this.containerEl;
      if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 80) this.renderNextChunk();
    };
    if (this.containerEl?.addEventListener) this.containerEl.addEventListener('scroll', this._onScroll, { passive: true });
  }
  setItems(newItems, renderCardFn = this.renderCardFn) {
    this.items = Array.isArray(newItems) ? newItems : [];
    this.renderCardFn = typeof renderCardFn === 'function' ? renderCardFn : this.renderCardFn;
    this.renderedCount = 0;
    if (this.containerEl) this.containerEl.innerHTML = '';
    if (!this.items.length && this.badgeEl) this.badgeEl.textContent = '0';
    return this.renderNextChunk();
  }
  renderNextChunk() {
    if (this.renderedCount >= this.items.length) {
      if (this.badgeEl) this.badgeEl.textContent = String(this.items.length);
      return 0;
    }
    const end = Math.min(this.renderedCount + this.chunkSize, this.items.length);
    const slice = this.items.slice(this.renderedCount, end);
    if (this.containerEl) {
      const doc = this.containerEl.ownerDocument || globalThis.document;
      if (doc?.createDocumentFragment && doc?.createElement) {
        const fragment = doc.createDocumentFragment();
        for (const item of slice) {
          const rendered = this.renderCardFn(item);
          if (rendered && typeof rendered.nodeType === 'number') fragment.appendChild(rendered);
          else {
            const template = doc.createElement('template');
            template.innerHTML = String(rendered ?? '');
            fragment.appendChild(template.content);
          }
        }
        this.containerEl.appendChild(fragment);
      } else if (typeof this.containerEl.insertAdjacentHTML === 'function') {
        this.containerEl.insertAdjacentHTML('beforeend', slice.map(this.renderCardFn).join(''));
      }
    }
    this.renderedCount = end;
    if (this.badgeEl) this.badgeEl.textContent = end < this.items.length ? '+' + end : String(this.items.length);
    return slice.length;
  }
  destroy() {
    if (this.containerEl?.removeEventListener) this.containerEl.removeEventListener('scroll', this._onScroll);
  }
}

export const CartEngine = Object.freeze({
  addCustomFreeItem(cart, { title = 'منتج حر', price = 0, quantity = 1 } = {}) {
    if (!Array.isArray(cart)) throw new TypeError('CART_MUST_BE_ARRAY');
    const cleanPrice = toCents(price);
    const cleanQty = decimalToScaledBigInt(quantity, 3);
    if (cleanQty <= 0n) throw new RangeError('INVALID_QUANTITY');
    const id = 'custom_item_' + (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)));
    const item = {
      id, name: String(title || '').trim() || 'منتج حر',
      price: cleanPrice / 100, unitPriceCents: cleanPrice,
      quantity: Number(cleanQty) / 1000, quantityMilli: safeNumber(cleanQty),
      priceTier: 'free_item', isFreeItem: true, affectsInventory: false
    };
    return [...cart, item];
  },
  calculateCartSummary(cart, discountValue = 0, discountType = 'fixed') {
    if (!Array.isArray(cart)) throw new TypeError('CART_MUST_BE_ARRAY');
    const subtotalCents = cart.reduce((sum, item) => {
      const price = Number.isSafeInteger(item?.unitPriceCents) ? item.unitPriceCents : toCents(item?.price ?? 0);
      const qty = decimalToScaledBigInt(item?.quantity ?? 0, 3);
      if (price < 0 || qty < 0n) throw new RangeError('NEGATIVE_CART_VALUE');
      return sum + safeNumber((BigInt(price) * qty + 500n) / 1000n);
    }, 0);
    if (!Number.isSafeInteger(subtotalCents)) throw new RangeError('CART_TOTAL_OVERFLOW');
    const raw = decimalToScaledBigInt(discountValue, 2);
    if (raw < 0n) throw new RangeError('NEGATIVE_DISCOUNT');
    let discountCents;
    if (discountType === 'percent') {
      const boundedBasisPoints = raw > 10000n ? 10000n : raw;
      discountCents = safeNumber((BigInt(subtotalCents) * boundedBasisPoints + 5000n) / 10000n);
    } else if (discountType === 'fixed') {
      discountCents = Math.min(subtotalCents, safeNumber(raw));
    } else throw new TypeError('INVALID_DISCOUNT_TYPE');
    const quantityMilli = cart.reduce((sum, item) => sum + safeNumber(decimalToScaledBigInt(item?.quantity ?? 0, 3)), 0);
    return Object.freeze({
      itemCount: cart.length, quantity: quantityMilli / 1000,
      subtotal: subtotalCents / 100, subtotalCents,
      discountAmount: discountCents / 100, discountCents,
      finalTotal: (subtotalCents - discountCents) / 100,
      finalTotalCents: subtotalCents - discountCents
    });
  }
});

export const MicroPOSHelpers = Object.freeze({
  getArabicInitials(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/u).filter(Boolean);
    if (!parts.length) return 'ز';
    const first = Array.from(parts[0])[0] || '';
    const last = parts.length > 1 ? Array.from(parts[1])[0] || '' : Array.from(parts[0]).slice(1, 2).join('');
    return first + last;
  },
  validateImportFile(file) {
    if (!file || typeof file !== 'object') return { valid: false, error: 'لم يتم اختيار ملف' };
    const name = String(file.name || '');
    const ext = (name.split('.').pop() || '').toLowerCase();
    const size = Number(file.size);
    if (!Number.isFinite(size) || size < 0) return { valid: false, error: 'حجم الملف غير صالح' };
    const isSheet = ['xlsx', 'xls', 'csv'].includes(ext);
    const isMedia = ['pdf', 'jpg', 'jpeg', 'png', 'webp'].includes(ext);
    if (!isSheet && !isMedia) return { valid: false, error: 'صيغة الملف غير مدعومة' };
    const limit = (isSheet ? 2 : 10) * 1024 * 1024;
    if (size > limit) return { valid: false, error: isSheet
      ? 'يتجاوز ملف الجدول الحد الأقصى المسموح (2MB)'
      : 'يتجاوز ملف الصورة/PDF الحد الأقصى المسموح (10MB)' };
    return { valid: true, isSheet, isMedia, sizeMB: Math.round(size / 1048576 * 100) / 100 };
  },
  async preparseSpreadsheet(file, XLSX, sampleRows = 8) {
    const validation = this.validateImportFile(file);
    if (!validation.valid || !validation.isSheet) throw new Error(validation.error || 'SPREADSHEET_REQUIRED');
    if (!XLSX?.read || !XLSX?.utils?.sheet_to_json) throw new Error('SHEETJS_UNAVAILABLE');
    const bytes = await file.arrayBuffer();
    const workbook = XLSX.read(bytes, { type: 'array', cellDates: false, dense: true });
    const firstName = workbook.SheetNames?.[0];
    if (!firstName) return { sheetNames: [], headers: [], sample: [], rowCount: 0 };
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstName], { header: 1, defval: '', blankrows: false });
    const clean = rows.filter(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''));
    return {
      sheetNames: workbook.SheetNames.slice(),
      headers: (clean[0] || []).map(value => String(value ?? '').trim()),
      sample: clean.slice(1, 1 + Math.max(0, Math.min(20, sampleRows))),
      rowCount: Math.max(0, clean.length - 1)
    };
  }
});

export function createDailyImportQuota(storage, { limit = 50, now = () => new Date() } = {}) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new TypeError('STORAGE_REQUIRED');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('INVALID_QUOTA_LIMIT');
  const dayKey = () => {
    const d = now();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };
  const key = 'ANAS_AI_IMPORT_QUOTA_V1';
  function read() {
    try {
      const state = JSON.parse(storage.getItem(key) || 'null');
      if (!state || state.day !== dayKey() || !Number.isSafeInteger(state.used) || state.used < 0) return { day: dayKey(), used: 0 };
      return state;
    } catch (_) { return { day: dayKey(), used: 0 }; }
  }
  return Object.freeze({
    status() { const s = read(); return { limit, used: s.used, remaining: Math.max(0, limit - s.used), day: s.day }; },
    consume() {
      const s = read();
      if (s.used >= limit) return { allowed: false, ...this.status() };
      const next = { day: s.day, used: s.used + 1 };
      storage.setItem(key, JSON.stringify(next));
      return { allowed: true, limit, used: next.used, remaining: limit - next.used, day: next.day };
    }
  });
}

export function getOrCreateDeviceId(storage, cryptoObject = globalThis.crypto) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new TypeError('STORAGE_REQUIRED');
  const key = 'ANAS_ERP_DEVICE_ID_V1';
  const existing = storage.getItem(key);
  if (typeof existing === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(existing)) return existing;
  const random = cryptoObject?.randomUUID?.() || ('dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  storage.setItem(key, random);
  return random;
}

export function setCloudSyncState(element, { online, pending = 0, syncing = false } = {}) {
  if (!element) return 'offline';
  const state = !online ? 'offline' : syncing || pending > 0 ? 'pending' : 'synced';
  element.dataset.syncState = state;
  element.textContent = state === 'synced' ? '☁️✓' : state === 'pending' ? '☁️…' : '☁️';
  element.setAttribute?.('aria-label', state === 'synced' ? 'سحابة متصلة ومتزامنة' : state === 'pending' ? 'توجد بيانات بانتظار المزامنة' : 'غير متصل — محفوظ محلياً');
  return state;
}

if (typeof window !== 'undefined') {
  window.ANASMicroPOSDeepCore = Object.freeze({
    ProgressiveListRenderer, CartEngine, MicroPOSHelpers,
    createDailyImportQuota, getOrCreateDeviceId, setCloudSyncState
  });
}
