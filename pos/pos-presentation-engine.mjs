import { filterPosProducts } from './micro-pos-engine.mjs';

const VALID_MODES = new Set(['list', 'grid']);
const VALID_STOCK_FILTERS = new Set(['all', 'available', 'low', 'out', 'favorite']);

export function normalizePosSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim();
}

function productFields(product) {
  const name = product?.name ?? product?.product_name ?? product?.title ?? '';
  const barcode = product?.barcode ?? product?.barCode ?? product?.ean ?? '';
  const code = product?.code ?? product?.sku ?? product?.reference ?? '';
  return {
    name: normalizePosSearchText(name),
    barcode: normalizePosSearchText(barcode),
    code: normalizePosSearchText(code)
  };
}

/**
 * Deterministic POS search: exact barcode/code, barcode prefix, exact name,
 * name prefix, then token-contained matches. Original order breaks ties.
 */
export function searchPosProducts(products, query) {
  if (!Array.isArray(products)) return [];
  const normalized = normalizePosSearchText(query);
  if (!normalized) return products.filter(row => row && typeof row === 'object');
  const tokens = normalized.split(' ').filter(Boolean);
  const ranked = [];
  products.forEach((product, index) => {
    if (!product || typeof product !== 'object') return;
    const fields = productFields(product);
    let rank = Infinity;
    if (fields.barcode === normalized || fields.code === normalized) rank = 0;
    else if (fields.barcode.startsWith(normalized) || fields.code.startsWith(normalized)) rank = 1;
    else if (fields.name === normalized) rank = 2;
    else if (fields.name.startsWith(normalized)) rank = 3;
    else {
      const searchable = [fields.name, fields.barcode, fields.code].filter(Boolean).join(' ');
      if (tokens.every(token => searchable.includes(token))) rank = 4;
    }
    if (rank !== Infinity) ranked.push({ product, index, rank });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map(item => item.product);
}

export function createPosPresentationController(options = {}) {
  let products = Array.isArray(options.products) ? options.products : [];
  let cart = Array.isArray(options.cart) ? options.cart : [];
  let invoiceDraft = options.invoiceDraft ?? null;
  let mode = VALID_MODES.has(options.mode) ? options.mode : 'list';
  let query = '';
  let category = options.category ?? 'الكل';
  let stockFilter = VALID_STOCK_FILTERS.has(options.stockFilter) ? options.stockFilter : 'all';

  const visibleProducts = () => {
    const filtered = filterPosProducts(products, { category, stockFilter });
    return searchPosProducts(filtered, query);
  };
  const snapshot = () => Object.freeze({
    mode, query, category, stockFilter,
    products, cart, invoiceDraft,
    visibleProducts: visibleProducts(),
    visibleCount: visibleProducts().length,
    cartLineCount: cart.length
  });

  return Object.freeze({
    snapshot,
    setMode(nextMode) {
      if (!VALID_MODES.has(nextMode)) throw new TypeError('INVALID_POS_VIEW_MODE');
      mode = nextMode;
      return snapshot();
    },
    toggleMode() {
      mode = mode === 'list' ? 'grid' : 'list';
      return snapshot();
    },
    setQuery(nextQuery) {
      query = String(nextQuery ?? '');
      return snapshot();
    },
    setCategory(nextCategory) {
      category = String(nextCategory ?? 'الكل');
      return snapshot();
    },
    setStockFilter(nextFilter) {
      if (!VALID_STOCK_FILTERS.has(nextFilter)) throw new TypeError('INVALID_POS_STOCK_FILTER');
      stockFilter = nextFilter;
      return snapshot();
    },
    setProducts(nextProducts) {
      if (!Array.isArray(nextProducts)) throw new TypeError('POS_PRODUCTS_MUST_BE_ARRAY');
      products = nextProducts;
      return snapshot();
    },
    setCart(nextCart) {
      if (!Array.isArray(nextCart)) throw new TypeError('POS_CART_MUST_BE_ARRAY');
      cart = nextCart;
      return snapshot();
    },
    setInvoiceDraft(nextDraft) {
      invoiceDraft = nextDraft ?? null;
      return snapshot();
    }
  });
}
