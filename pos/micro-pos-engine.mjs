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
    ? options.favoriteFor : product => product?.favorite === true || product?.isFavorite === true;
  return products.filter(product => {
    if (!product || typeof product !== 'object') return false;
    if (category !== 'الكل' && String(product.cat ?? product.category ?? 'عام') !== String(category)) return false;
    const rawStock = stockFor(product);
    const stock = Number(rawStock);
    if (!Number.isFinite(stock)) return false;
    const minimum = Number(product.minAlert ?? product.min_limit ?? 5);
    const threshold = Number.isFinite(minimum) && minimum >= 0 ? minimum : 5;
    if (stockFilter === 'favorite' && !favoriteFor(product)) return false;
    if (stockFilter === 'available' && stock <= 0) return false;
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
export function prepareBulkImport(existingRows, incomingRows, mode = 'merge', keyFields = ['barcode', 'id', 'name']) {
  if (!Array.isArray(existingRows) || !Array.isArray(incomingRows)) throw new TypeError('IMPORT_ROWS_MUST_BE_ARRAYS');
  if (!['merge', 'replace'].includes(mode)) throw new TypeError('INVALID_IMPORT_MODE');
  const keyOf = row => {
    for (const field of keyFields) {
      const value = row && row[field];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim().toLocaleLowerCase();
    }
    return '';
  };
  const output = mode === 'replace' ? [] : existingRows.map(row => ({ ...row }));
  const index = new Map();
  output.forEach((row, position) => {
    const key = keyOf(row);
    if (key && !index.has(key)) index.set(key, position);
  });
  const stats = { total: incomingRows.length, added: 0, updated: 0, skipped: 0 };
  for (const row of incomingRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !keyOf(row)) {
      stats.skipped++;
      continue;
    }
    const key = keyOf(row);
    if (mode === 'merge' && index.has(key)) {
      const position = index.get(key);
      const previous = output[position];
      const merged = { ...previous, ...row, id: previous.id ?? row.id };
      if (JSON.stringify(previous) === JSON.stringify(merged)) stats.skipped++;
      else { output[position] = merged; stats.updated++; }
    } else {
      const position = output.length;
      output.push({ ...row });
      index.set(key, position);
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
