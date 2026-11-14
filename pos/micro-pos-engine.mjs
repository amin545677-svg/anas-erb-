import * as DeepCore from './micro-pos-deep-core.mjs';

/**
 * ANAS ERP Micro POS primitives.
 * Pure functions only: no storage, DOM, network, or transaction side effects.
 */
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function resolveProductPrice(product, tier = 1) {
  if (!product || typeof product !== 'object') throw new TypeError('PRODUCT_REQUIRED');
  const fields = tier === 3 ? ['price3', 'price1']
    : tier === 2 ? ['price2', 'price1'] : ['price1'];
  for (const field of fields) {
    const value = product[field];
    if (value !== undefined && value !== null && value !== '') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) throw new RangeError('INVALID_PRODUCT_PRICE:' + field);
      return number;
    }
  }
  throw new RangeError('PRODUCT_PRICE_MISSING');
}

export function filterPosProducts(products, options = {}) {
  if (!Array.isArray(products)) return [];
  const category = options.category ?? 'الكل';
  const stockFilter = options.stockFilter ?? 'all';
  const stockFor = typeof options.stockFor === 'function'
    ? options.stockFor : product => product?.stock ?? product?.quantity ?? 0;
  const favoriteFor = typeof options.favoriteFor === 'function'
    ? options.favoriteFor : product => product?.favorite === true || product?.isFavorite === true || product?.featured === true || product?.is_featured === true;
  return products.filter(product => {
    if (!product || typeof product !== 'object') return false;
    if (category !== 'الكل' && String(product.cat ?? product.category ?? 'عام') !== String(category)) return false;
    const rawStock = stockFor(product);
    const stock = Number(rawStock);
    if (!Number.isFinite(stock)) return false;
    const minimum = Number(product.minAlert ?? product.min_limit ?? 5);
    const threshold = Number.isFinite(minimum) && minimum > 0 ? minimum : 5;
    // Keep stock chips mutually exclusive: available is above threshold, low is positive up to threshold.
    if (stockFilter === 'favorite' && !favoriteFor(product)) return false;
    if (stockFilter === 'available' && stock <= threshold) return false;
    if (stockFilter === 'low' && !(stock > 0 && stock <= threshold)) return false;
    if (stockFilter === 'out' && stock > 0) return false;
    return true;
  });
}

/**
 * Money crosses this boundary as integer centimes. A missing credit_limit keeps
 * legacy customers compatible; an explicitly configured zero means no credit.
 */
export function calculateQuickCheckoutCents(totalCents, splitMode, customer = null) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new RangeError('INVALID_TOTAL_CENTIMES');
  if (!['full', 'half', 'full_debt'].includes(splitMode)) throw new TypeError('INVALID_SPLIT_MODE');
  const paidCents = splitMode === 'full' ? totalCents
    : splitMode === 'half' ? Math.floor(totalCents / 2) : 0;
  const remainingDebtCents = totalCents - paidCents;
  const hasDebt = !!customer && (own(customer, 'debt') || own(customer, 'initial_debt'));
  const debtValue = hasDebt ? (own(customer, 'debt') ? customer.debt : customer.initial_debt) : 0;
  const currentDebtCents = Number(debtValue);
  if (!Number.isSafeInteger(currentDebtCents) || currentDebtCents < 0) throw new RangeError('INVALID_CUSTOMER_DEBT');
  const projectedDebtCents = currentDebtCents + remainingDebtCents;
  if (!Number.isSafeInteger(projectedDebtCents)) throw new RangeError('PROJECTED_DEBT_OVERFLOW');
  const hasCreditLimit = !!customer && own(customer, 'credit_limit') && customer.credit_limit !== null && customer.credit_limit !== '';
  const creditLimitCents = hasCreditLimit ? Number(customer.credit_limit) : null;
  if (hasCreditLimit && (!Number.isSafeInteger(creditLimitCents) || creditLimitCents < 0)) {
    throw new RangeError('INVALID_CREDIT_LIMIT');
  }
  const creditExceeded = hasCreditLimit && projectedDebtCents > creditLimitCents && remainingDebtCents > 0;
  return Object.freeze({
    totalCents, paidCents, remainingDebtCents, currentDebtCents, projectedDebtCents,
    creditLimitCents, creditExceeded,
    status: remainingDebtCents === 0 ? 'paid' : paidCents === 0 ? 'unpaid' : 'partial'
  });
}

/**
 * Pure staging planner. It never mutates inputs or writes storage. Callers must
 * validate domain-specific fields and persist the complete result atomically.
 */
export function prepareBulkImport(existingRows, incomingRows, mode = 'merge', keyFields = ['id', 'barcode'], options = {}) {
  if (!Array.isArray(existingRows) || !Array.isArray(incomingRows)) throw new TypeError('IMPORT_ROWS_MUST_BE_ARRAYS');
  if (!['merge', 'replace'].includes(mode)) throw new TypeError('INVALID_IMPORT_MODE');
  if (!Array.isArray(keyFields) || keyFields.length === 0 || keyFields.some(field => typeof field !== 'string' || !field.trim())) {
    throw new TypeError('INVALID_IMPORT_IDENTITY_FIELDS');
  }
  const strictIdentity = options.strictIdentity === true;
  const fields = [...new Set(keyFields.map(field => field.trim()))];
  const valueOf = (row, field) => {
    const value = row && row[field];
    return value === undefined || value === null || String(value).trim() === ''
      ? '' : String(value).normalize('NFKC').trim().toLocaleLowerCase();
  };
  const keysOf = row => fields.map(field => {
    const value = valueOf(row, field);
    return value ? field + '\\u0000' + value : '';
  }).filter(Boolean);
  const output = mode === 'replace' ? [] : existingRows.map(row => ({ ...row }));
  const index = new Map();
  const addToIndex = (row, position, existing = false) => {
    for (const key of keysOf(row)) {
      const previous = index.get(key);
      if (previous !== undefined && previous !== position) {
        throw new Error(existing ? 'IMPORT_EXISTING_IDENTITY_COLLISION' : 'IMPORT_IDENTITY_CONFLICT');
      }
      index.set(key, position);
    }
  };
  output.forEach((row, position) => addToIndex(row, position, true));
  const stats = { total: incomingRows.length, added: 0, updated: 0, skipped: 0 };
  for (const row of incomingRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      stats.skipped++;
      continue;
    }
    const keys = keysOf(row);
    if (!keys.length) {
      stats.skipped++;
      continue;
    }
    const matches = [...new Set(keys.map(key => index.get(key)).filter(position => position !== undefined))];
    if (matches.length > 1) throw new Error('IMPORT_IDENTITY_CONFLICT');
    if (matches.length === 1) {
      const position = matches[0];
      const previous = output[position];
      if (strictIdentity && fields.some(field => {
        const before = valueOf(previous, field);
        const incoming = valueOf(row, field);
        return before && incoming && before !== incoming;
      })) throw new Error('IMPORT_IDENTITY_CONFLICT');
      const merged = { ...previous, ...row, id: previous.id ?? row.id };
      const mergedKeys = keysOf(merged);
      for (const key of mergedKeys) {
        const owner = index.get(key);
        if (owner !== undefined && owner !== position) throw new Error('IMPORT_IDENTITY_CONFLICT');
      }
      if (JSON.stringify(previous) === JSON.stringify(merged)) stats.skipped++;
      else {
        output[position] = merged;
        addToIndex(merged, position);
        stats.updated++;
      }
    } else {
      const position = output.length;
      output.push({ ...row });
      addToIndex(row, position);
      stats.added++;
    }
  }
  return Object.freeze({ rows: output, stats: Object.freeze(stats) });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'ANASMicroPOSEngine', {
    configurable: true,
    enumerable: false,
    value: Object.freeze({ resolveProductPrice, filterPosProducts, calculateQuickCheckoutCents, prepareBulkImport, deepCore: DeepCore })
  });
}
