/**
 * ANAS ERP advanced Micro POS domain engine.
 * Pure import/zakat/RBAC planners plus a transaction-bound proforma conversion.
 * No implicit localStorage writes: callers must provide an atomic repository.
 */
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const text = value => String(value ?? '').normalize('NFKC').trim();
const norm = value => text(value).toLocaleLowerCase().replace(/[\u064B-\u065F\u0670]/g, '').replace(/[\s_-]+/g, ' ');
const first = (row, keys) => {
  for (const key of keys) if (own(row, key) && text(row[key])) return row[key];
  return '';
};
const toCents = value => {
  const raw = text(value || '0').replace(/\s/g, '').replace(',', '.');
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(raw)) throw new TypeError('INVALID_MONEY');
  const negative = raw[0] === '-';
  const unsigned = raw.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  const signed = negative ? -cents : cents;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('MONEY_OVERFLOW');
  return Number(signed);
};
const fromCents = cents => Number((cents / 100).toFixed(2));

function classifyImportRow(row, sheetName = '') {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const fields = Object.keys(row).map(norm);
  const sheet = norm(sheetName);
  const has = (...terms) => fields.some(field => terms.some(term => field.includes(norm(term))));
  const invoiceScore = Number(has('رقم الفاتورة', 'invoice', 'date', 'تاريخ')) +
    Number(has('الإجمالي', 'total', 'المبلغ')) + Number(has('الزبون', 'العميل', 'customer'));
  const supplierScore = Number(/مورد|supplier|fournisseur/.test(sheet)) +
    Number(has('المورد', 'supplier', 'fournisseur', 'شركة')) +
    Number(has('رقم المورد', 'supplier id'));
  const customerScore = Number(/عميل|زبائن|customer|client/.test(sheet)) +
    Number(has('العميل', 'زبون', 'customer', 'client')) +
    Number(has('حد الائتمان', 'credit limit', 'دين'));
  const productScore = Number(/منتج|مخزون|product|stock/.test(sheet)) +
    Number(has('الباركود', 'barcode', 'sku')) +
    Number(has('سعر البيع', 'price', 'سعر التكلفة', 'cost', 'كمية', 'quantity'));
  if (invoiceScore >= 2 && invoiceScore > Math.max(supplierScore, customerScore, productScore)) return 'invoices';
  const scores = [['suppliers', supplierScore], ['customers', customerScore], ['products', productScore]];
  scores.sort((a, b) => b[1] - a[1]);
  if (scores[0][1] === 0 || scores[0][1] === scores[1][1]) return null;
  return scores[0][0];
}

function identityFor(type, row) {
  const keySets = {
    products: ['barcode', 'الباركود', 'sku', 'code', 'رمز المنتج', 'name', 'الاسم', 'اسم المنتج'],
    customers: ['phone', 'الهاتف', 'mobile', 'telephone', 'customer_id', 'رقم العميل', 'name', 'الاسم', 'العميل'],
    suppliers: ['phone', 'الهاتف', 'mobile', 'telephone', 'supplier_id', 'رقم المورد', 'name', 'الاسم', 'المورد'],
    invoices: ['invoice_no', 'رقم الفاتورة', 'invoice', 'id', 'رقم', 'date']
  };
  const value = first(row, keySets[type] || ['id', 'name']);
  return norm(value);
}

export function classifyAndStageWorkbookSheets(sheetsDataMap, existingDB = {}) {
  const staged = { suppliers: [], products: [], customers: [], invoices: [], totalValidRows: 0, sheetCount: 0, unclassified: 0 };
  const existing = {};
  for (const type of ['suppliers', 'products', 'customers', 'invoices']) {
    existing[type] = new Set((Array.isArray(existingDB[type]) ? existingDB[type] : [])
      .map(row => identityFor(type, row)).filter(Boolean));
  }
  const seen = Object.fromEntries(Object.keys(existing).map(type => [type, new Set()]));
  for (const [sheetName, rows] of Object.entries(sheetsDataMap || {})) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    staged.sheetCount++;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          !Object.values(row).some(value => text(value))) continue;
      const type = classifyImportRow(row, sheetName);
      if (!type) { staged.unclassified++; continue; }
      const name = text(first(row, ['name', 'الاسم', 'اسم المنتج', 'العميل', 'الزبون', 'المورد']));
      const normalized = { ...row, name: name || text(first(row, ['رقم الفاتورة', 'invoice_no', 'barcode', 'الباركود'])) };
      if (!normalized.name) { staged.unclassified++; continue; }
      const key = identityFor(type, normalized);
      if (!key) { staged.unclassified++; continue; }
      const isDuplicate = existing[type].has(key) || seen[type].has(key);
      seen[type].add(key);
      staged[type].push({ ...normalized, sourceSheet: sheetName, identityKey: key, isDuplicate,
        duplicateScope: existing[type].has(key) ? 'database' : isDuplicate ? 'workbook' : null,
        action: isDuplicate ? 'match' : 'create' });
      staged.totalValidRows++;
    }
  }
  return staged;
}

export function createProformaDraft({ id, customerId = null, lines, currency = 'DZD', createdAt = new Date().toISOString(), expiresAt = null, notes = '' }) {
  if (!text(id)) throw new TypeError('PROFORMA_ID_REQUIRED');
  if (!Array.isArray(lines) || lines.length === 0) throw new TypeError('PROFORMA_LINES_REQUIRED');
  const normalizedLines = lines.map(line => {
    const productId = text(line?.productId ?? line?.product_id);
    const quantity = text(line?.quantity);
    const unitPriceCents = toCents(line?.unitPrice ?? line?.price);
    if (!productId || !/^\d+(?:\.\d{1,6})?$/.test(quantity) || Number(quantity) <= 0 || unitPriceCents < 0) {
      throw new TypeError('INVALID_PROFORMA_LINE');
    }
    return Object.freeze({ productId, quantity, unitPriceCents });
  });
  const totalCents = normalizedLines.reduce((sum, line) => {
    const scaledQty = BigInt(line.quantity.replace('.', '').padEnd(7, '0'));
    const digits = (line.quantity.split('.')[1] || '').length;
    const qtyUnits = BigInt(line.quantity.split('.')[0]) * 1000000n +
      BigInt(((line.quantity.split('.')[1] || '') + '000000').slice(0, 6));
    const lineCents = (qtyUnits * BigInt(line.unitPriceCents) + 500000n) / 1000000n;
    return sum + Number(lineCents);
  }, 0);
  if (!Number.isSafeInteger(totalCents)) throw new RangeError('PROFORMA_TOTAL_OVERFLOW');
  return Object.freeze({ id: text(id), customerId, lines: Object.freeze(normalizedLines), totalCents,
    currency, status: 'proforma', createdAt, expiresAt, notes: text(notes) });
}

/**
 * Conversion contract: every read/write is performed inside repository.runTransaction.
 * Repository methods must be transaction-scoped and reject if any write fails.
 */
export async function convertProformaToActualInvoice({ proformaId, repository, paymentMethod = 'cash', paidCents = null }) {
  if (!repository || typeof repository.runTransaction !== 'function') throw new TypeError('ATOMIC_REPOSITORY_REQUIRED');
  return repository.runTransaction(async tx => {
    const proforma = await tx.getProforma(proformaId);
    if (!proforma) throw new Error('PROFORMA_NOT_FOUND');
    if (proforma.status !== 'proforma') throw new Error('PROFORMA_ALREADY_CONVERTED');
    const lines = [];
    for (const line of proforma.lines || []) {
      const product = await tx.getProduct(line.productId);
      if (!product) throw new Error('PRODUCT_NOT_FOUND:' + line.productId);
      const available = Number(product.quantity ?? product.stock);
      const required = Number(line.quantity);
      if (!Number.isFinite(available) || available < required) throw new Error('INSUFFICIENT_STOCK:' + line.productId);
      lines.push({ ...line, product, nextQuantity: available - required });
    }
    const total = Number(proforma.totalCents);
    const paid = paidCents == null ? total : Number(paidCents);
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(paid) || paid < 0 || paid > total) {
      throw new RangeError('INVALID_PAYMENT_SPLIT');
    }
    const invoice = await tx.createSalesInvoice({ ...proforma, id: undefined, sourceProformaId: proforma.id,
      status: paid === total ? 'paid' : paid === 0 ? 'unpaid' : 'partial', paidCents: paid,
      debtCents: total - paid, paymentMethod, convertedAt: new Date().toISOString() });
    for (const line of lines) await tx.setProductQuantity(line.product.id, line.nextQuantity);
    await tx.postSaleFinancials({ invoice, customerId: proforma.customerId, paidCents: paid, debtCents: total - paid });
    await tx.markProformaConverted(proforma.id, invoice.id);
    return invoice;
  });
}

export function calculateZakatSummary({ cashBalance = 0, products = [], customers = [], suppliers = [],
  goldPricePerGram24k, valuationMode = 'cost', receivableFilter = row => row.collectible !== false } = {}) {
  const cash = toCents(cashBalance);
  const inventory = (Array.isArray(products) ? products : []).reduce((sum, product) => {
    const quantity = Number(product?.quantity ?? product?.stock ?? 0);
    if (!Number.isFinite(quantity) || quantity < 0) throw new RangeError('INVALID_STOCK_QUANTITY');
    const price = toCents(valuationMode === 'retail'
      ? (product?.price_retail ?? product?.price ?? 0) : (product?.cost_price ?? product?.cost ?? 0));
    if (price < 0) throw new RangeError('NEGATIVE_INVENTORY_VALUE');
    const quantityMicros = BigInt(Math.round(quantity * 1000000));
    return sum + Number((quantityMicros * BigInt(price) + 500000n) / 1000000n);
  }, 0);
  const receivables = (Array.isArray(customers) ? customers : []).reduce((sum, customer) => {
    if (!receivableFilter(customer)) return sum;
    const debt = toCents(customer?.collectibleDebt ?? customer?.debt ?? 0);
    return sum + Math.max(0, debt);
  }, 0);
  const payables = (Array.isArray(suppliers) ? suppliers : []).reduce((sum, supplier) =>
    sum + Math.max(0, toCents(supplier?.balance ?? supplier?.payable ?? 0)), 0);
  const goldPrice = toCents(goldPricePerGram24k);
  if (goldPrice <= 0) throw new RangeError('GOLD_PRICE_REQUIRED');
  const net = Math.max(0, cash + inventory + receivables - payables);
  const nisab = goldPrice * 85;
  const due = net >= nisab ? Math.round(net * 0.025) : 0;
  return Object.freeze({ cashBalance: fromCents(cash), inventoryValue: fromCents(inventory),
    goodReceivables: fromCents(receivables), supplierPayables: fromCents(payables),
    netZakatableWealth: fromCents(net), nisabThreshold: fromCents(nisab),
    isNisabReached: net >= nisab, zakatDue: fromCents(due), valuationMode });
}

export function canPerformRoleAction(role, action) {
  const grants = {
    general_manager: new Set(['pos', 'proforma', 'customers', 'inventory_view', 'cash_shift', 'expenses', 'capital', 'cashbox', 'zakat', 'reports', 'users', 'import', 'delete']),
    seller: new Set(['pos', 'proforma', 'customers', 'inventory_view']),
    cashier: new Set(['pos', 'cash_shift'])
  };
  return !!grants[role] && grants[role].has(action);
}
