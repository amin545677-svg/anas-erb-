import { prepareBulkImport } from './micro-pos-engine.mjs';
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
  const aliases = new Set(keys.map(norm));
  for (const [key, value] of Object.entries(row || {})) {
    if (aliases.has(norm(key)) && text(value)) return value;
  }
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

function identityKeysFor(type, row) {
  const groups = {
    products: [
      ['id', 'product_id', 'productId', 'معرف المنتج', 'رقم المنتج'],
      ['barcode', 'الباركود', 'sku', 'code', 'رمز المنتج']
    ],
    customers: [
      ['phone', 'الهاتف', 'mobile', 'telephone'],
      ['id', 'customer_id', 'customerId', 'رقم العميل']
    ],
    suppliers: [
      ['phone', 'الهاتف', 'mobile', 'telephone'],
      ['id', 'supplier_id', 'supplierId', 'رقم المورد']
    ],
    invoices: [
      ['id', 'invoice_id', 'invoiceId', 'invoice_no', 'invoiceNumber', 'رقم الفاتورة', 'number']
    ]
  };
  return (groups[type] || [['id']]).flatMap((aliases, index) => {
    const raw = text(first(row, aliases));
    if (!raw) return [];
    const field = type === 'products' ? (index === 0 ? 'id' : 'barcode') :
      type === 'customers' || type === 'suppliers' ? (index === 0 ? 'phone' : 'id') : 'invoice';
    const value = field === 'phone'
      ? (normalizeAlgeriaPhone(raw) || raw.toLocaleLowerCase().replace(/\s+/g, ''))
      : raw.toLocaleLowerCase().replace(/[\u064B-\u065F\u0670]/g, '').replace(/\s+/g, ' ');
    return [field + ':' + value];
  });
}

function identityFor(type, row) {
  return identityKeysFor(type, row)[0] || '';
}

export function classifyAndStageWorkbookSheets(sheetsDataMap, existingDB = {}, targetBySheet = {}) {
  const staged = { suppliers: [], products: [], customers: [], invoices: [], totalValidRows: 0, sheetCount: 0, unclassified: 0 };
  const existing = {};
  const recordByIdentity = {};
  for (const type of ['suppliers', 'products', 'customers', 'invoices']) {
    const index = new Map();
    const records = Array.isArray(existingDB[type]) ? existingDB[type] : [];
    records.forEach((row, rowIndex) => {
      const recordKey = 'database:' + rowIndex;
      recordByIdentity[type] = recordByIdentity[type] || new Map();
      recordByIdentity[type].set(recordKey, row);
      for (const identity of identityKeysFor(type, row)) {
        if (!index.has(identity)) index.set(identity, new Set());
        index.get(identity).add(recordKey);
      }
    });
    existing[type] = index;
    recordByIdentity[type] = recordByIdentity[type] || new Map();
  }
  const seen = Object.fromEntries(Object.keys(existing).map(type => [type, new Map()]));
  for (const [sheetName, rows] of Object.entries(sheetsDataMap || {})) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    staged.sheetCount++;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          !Object.values(row).some(value => text(value))) continue;
      const forcedType = targetBySheet && targetBySheet[sheetName];
      const type = ['suppliers','products','customers','invoices'].includes(forcedType)
        ? forcedType : classifyImportRow(row, sheetName);
      if (!type) { staged.unclassified++; continue; }
      const name = text(first(row, ['name', 'الاسم', 'اسم المنتج', 'العميل', 'الزبون', 'المورد']));
      const normalized = { ...row, name: name || text(first(row, ['رقم الفاتورة', 'invoice_no', 'barcode', 'الباركود'])) };
      if (!normalized.name) { staged.unclassified++; continue; }
      const identityKeys = identityKeysFor(type, normalized);
      if (!identityKeys.length) { staged.unclassified++; continue; }
      const key = identityKeys[0];
      const matches = new Set();
      for (const identity of identityKeys) {
        for (const match of existing[type].get(identity) || []) matches.add(match);
        for (const match of seen[type].get(identity) || []) matches.add(match);
      }
      const isDatabaseDuplicate = identityKeys.some(identity => existing[type].has(identity));
      const isWorkbookDuplicate = identityKeys.some(identity => seen[type].has(identity));
      const isDuplicate = isDatabaseDuplicate || isWorkbookDuplicate;
      const resolvedIdentity = matches.size === 1 ? [...matches][0] : 'workbook:' + staged[type].length;
      let identityConflict = matches.size > 1;
      if (type === 'products' && matches.size === 1) {
        const matchedRow = recordByIdentity[type].get(resolvedIdentity);
        const matchedKeys = new Map(identityKeysFor(type, matchedRow).map(identity => {
          const separator = identity.indexOf(':');
          return [identity.slice(0, separator), identity];
        }));
        identityConflict = identityKeys.some(identity => {
          const separator = identity.indexOf(':');
          const field = identity.slice(0, separator);
          const previousIdentity = matchedKeys.get(field);
          return previousIdentity && previousIdentity !== identity;
        });
      }
      identityKeys.forEach(identity => {
        if (!seen[type].has(identity)) seen[type].set(identity, new Set());
        seen[type].get(identity).add(resolvedIdentity);
      });
      if (!recordByIdentity[type].has(resolvedIdentity)) recordByIdentity[type].set(resolvedIdentity, normalized);
      staged[type].push({ ...normalized, sourceSheet: sheetName, identityKey: key, identityKeys, isDuplicate,
        identityConflict,
        duplicateScope: isDatabaseDuplicate ? 'database' : isWorkbookDuplicate ? 'workbook' : null,
        action: identityConflict ? 'review_conflict' : isDuplicate ? 'match' : 'create' });
      staged.totalValidRows++;
    }
  }
  return staged;
}

function decimalToUnits(value, digits = 6) {
  const raw = text(value === '' || value == null ? '0' : value).replace(/\s/g, '').replace(',', '.');
  if (!/^[+]?(?:\d+)(?:\.\d*)?$/.test(raw)) throw new TypeError('INVALID_QUANTITY');
  const [whole, fraction = ''] = raw.replace(/^\+/, '').split('.');
  if (fraction.length > digits) throw new TypeError('INVALID_QUANTITY_PRECISION');
  const kept = (fraction + '0'.repeat(digits)).slice(0, digits);
  const units = BigInt(whole || '0') * (10n ** BigInt(digits)) + BigInt(kept || '0');
  return units;
}
function safeInteger(value, code) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(code || 'INTEGER_OVERFLOW');
  return Number(value);
}
function unitsToNumber(units, digits = 6) {
  return Number(units) / Number(10n ** BigInt(digits));
}

export function createProformaDraft({ id, customerId = null, lines, currency = 'DZD', createdAt = new Date().toISOString(), expiresAt = null, notes = '' }) {
  if (!text(id)) throw new TypeError('PROFORMA_ID_REQUIRED');
  if (!Array.isArray(lines) || lines.length === 0) throw new TypeError('PROFORMA_LINES_REQUIRED');
  const normalizedLines = lines.map(line => {
    const productId = text(line?.productId ?? line?.product_id);
    const quantity = text(line?.quantity).replace(',', '.');
    const quantityUnits = decimalToUnits(quantity, 6);
    const unitPriceCents = toCents(line?.unitPrice ?? line?.price);
    if (!productId || quantityUnits <= 0n || unitPriceCents < 0) throw new TypeError('INVALID_PROFORMA_LINE');
    return Object.freeze({ productId, quantity, quantityUnits: safeInteger(quantityUnits, 'PROFORMA_QUANTITY_OVERFLOW'), unitPriceCents });
  });
  const totalCentsBig = normalizedLines.reduce((sum, line) =>
    sum + (BigInt(line.quantityUnits) * BigInt(line.unitPriceCents) + 500000n) / 1000000n, 0n);
  const totalCents = safeInteger(totalCentsBig, 'PROFORMA_TOTAL_OVERFLOW');
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
    const requiredByProduct = new Map();
    for (const line of proforma.lines || []) {
      const productId = text(line?.productId ?? line?.product_id);
      if (!productId) throw new Error('PROFORMA_PRODUCT_ID_REQUIRED');
      const units = line.quantityUnits == null ? decimalToUnits(line.quantity, 6) : BigInt(line.quantityUnits);
      if (units <= 0n) throw new RangeError('INVALID_PROFORMA_QUANTITY');
      requiredByProduct.set(productId, (requiredByProduct.get(productId) || 0n) + units);
    }
    const stockWrites = [];
    for (const [productId, requiredUnits] of requiredByProduct) {
      const product = await tx.getProduct(productId);
      if (!product) throw new Error('PRODUCT_NOT_FOUND:' + productId);
      const stockUnits = decimalToUnits(product.quantity ?? product.stock ?? 0, 6);
      if (stockUnits < requiredUnits) throw new Error('INSUFFICIENT_STOCK:' + productId);
      stockWrites.push({ productId: product.id || productId, nextQuantity: unitsToNumber(stockUnits - requiredUnits, 6) });
    }
    const total = Number(proforma.totalCents);
    const paid = paidCents == null ? total : Number(paidCents);
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(paid) || paid < 0 || paid > total) {
      throw new RangeError('INVALID_PAYMENT_SPLIT');
    }
    const invoice = await tx.createSalesInvoice({ ...proforma, id: undefined, sourceProformaId: proforma.id,
      status: paid === total ? 'paid' : paid === 0 ? 'unpaid' : 'partial', paidCents: paid,
      debtCents: total - paid, paymentMethod, convertedAt: new Date().toISOString() });
    for (const write of stockWrites) await tx.setProductQuantity(write.productId, write.nextQuantity);
    await tx.postSaleFinancials({ invoice, customerId: proforma.customerId, paidCents: paid, debtCents: total - paid });
    await tx.markProformaConverted(proforma.id, invoice.id);
    return invoice;
  });
}

export function calculateZakatSummary({ cashBalance = 0, products = [], customers = [], suppliers = [],
  goldPricePerGram24k, valuationMode = 'cost', receivableFilter = row => row.collectible !== false } = {}) {
  const cash = BigInt(toCents(cashBalance));
  const inventory = (Array.isArray(products) ? products : []).reduce((sum, product) => {
    const quantityUnits = decimalToUnits(product?.quantity ?? product?.stock ?? 0, 6);
    if (quantityUnits < 0n) throw new RangeError('INVALID_STOCK_QUANTITY');
    const price = toCents(valuationMode === 'retail'
      ? (product?.price_retail ?? product?.price ?? 0) : (product?.cost_price ?? product?.cost ?? 0));
    if (price < 0) throw new RangeError('NEGATIVE_INVENTORY_VALUE');
    return sum + (quantityUnits * BigInt(price) + 500000n) / 1000000n;
  }, 0n);
  const receivables = (Array.isArray(customers) ? customers : []).reduce((sum, customer) => {
    if (!receivableFilter(customer)) return sum;
    const debt = BigInt(toCents(customer?.collectibleDebt ?? customer?.debt ?? 0));
    return sum + (debt > 0n ? debt : 0n);
  }, 0n);
  const payables = (Array.isArray(suppliers) ? suppliers : []).reduce((sum, supplier) => {
    const value = BigInt(toCents(supplier?.balance ?? supplier?.payable ?? 0));
    return sum + (value > 0n ? value : 0n);
  }, 0n);
  const goldPrice = BigInt(toCents(goldPricePerGram24k));
  if (goldPrice <= 0n) throw new RangeError('GOLD_PRICE_REQUIRED');
  const net = cash + inventory + receivables - payables;
  const zakatable = net > 0n ? net : 0n;
  const nisab = goldPrice * 85n;
  const due = zakatable >= nisab ? (zakatable * 25n + 500n) / 1000n : 0n;
  const output = value => fromCents(safeInteger(value, 'ZAKAT_TOTAL_OVERFLOW'));
  return Object.freeze({ cashBalance: output(cash), inventoryValue: output(inventory),
    goodReceivables: output(receivables), supplierPayables: output(payables),
    netZakatableWealth: output(zakatable), nisabThreshold: output(nisab),
    isNisabReached: zakatable >= nisab, zakatDue: output(due), valuationMode });
}

export function canPerformRoleAction(role, action) {
  const grants = {
    general_manager: new Set(['pos', 'proforma', 'customers', 'inventory_view', 'cash_shift', 'expenses', 'capital', 'cashbox', 'zakat', 'reports', 'users', 'import', 'delete']),
    seller: new Set(['pos', 'proforma', 'customers', 'inventory_view']),
    cashier: new Set(['pos', 'cash_shift'])
  };
  return !!grants[role] && grants[role].has(action);
}


/**
 * Safe import coordinator. Parsing/matching is completed in memory before the
 * repository is asked to persist one complete batch. saveBatchSafe must provide
 * one atomic IndexedDB transaction for the entity snapshot.
 */
export async function executeSafeBulkImport({ rows, mode = 'merge', entityType = 'products',
  storage = globalThis.localStorage, repository, keyFields = null } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('IMPORT_ROWS_MUST_BE_ARRAY');
  if (!/^(products|customers|suppliers|invoices)$/.test(entityType)) throw new TypeError('INVALID_IMPORT_ENTITY');
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new TypeError('IMPORT_STORAGE_REQUIRED');
  }
  if (!repository || typeof repository.saveBatchSafe !== 'function') throw new TypeError('ATOMIC_BATCH_REPOSITORY_REQUIRED');
  const storageKey = 'anas_' + entityType;
  const backupKey = storageKey + '_backup_pre_import';
  const raw = storage.getItem(storageKey) || '[]';
  let existing;
  try { existing = JSON.parse(raw); } catch (_) { throw new Error('EXISTING_DATA_CORRUPT'); }
  if (!Array.isArray(existing)) throw new Error('EXISTING_DATA_NOT_ARRAY');
  storage.setItem(backupKey, raw);
  const effectiveKeyFields = Array.isArray(keyFields) && keyFields.length ? keyFields
    : entityType === 'customers' || entityType === 'suppliers' ? ['phone', 'id']
    : entityType === 'invoices' ? ['id', 'invoiceNumber', 'number'] : ['id', 'barcode'];
  const planned = prepareBulkImport(existing, rows, mode, effectiveKeyFields, {
    strictIdentity: entityType === 'products'
  });
  const serialized = JSON.stringify(planned.rows);
  try {
    // The local mirror is staged first so a failed durable write can restore it.
    storage.setItem(storageKey, serialized);
    await repository.saveBatchSafe(entityType, planned.rows);
    return Object.freeze({ ...planned.stats, durable: true, mirrorSynced: true });
  } catch (error) {
    try { storage.setItem(storageKey, raw); } catch (_) {}
    const wrapped = new Error('SAFE_IMPORT_ROLLED_BACK: ' + (error?.message || String(error)));
    wrapped.cause = error;
    throw wrapped;
  }
}

function stripImportMetadata(row) {
  const clean = { ...row };
  for (const key of ['sourceSheet','identityKey','identityKeys','isDuplicate','identityConflict','duplicateScope','action']) delete clean[key];
  return clean;
}

function normalizeMultiSheetImportRow(type, stagedRow, index, existingRows) {
  const row = stripImportMetadata(stagedRow);
  const name = text(first(row, ['name','الاسم','اسم المنتج','العميل','الزبون','المورد','اسم المورد']));
  if (type !== 'invoices' && !name) throw new Error('IMPORT_NAME_REQUIRED:' + type + ':' + (index + 1));
  if (type === 'products') {
    const explicitId = text(first(row, ['id','product_id','productId','معرف المنتج','رقم المنتج']));
    const barcode = text(first(row, ['barcode','الباركود','sku','code','رمز المنتج']));
    if (!explicitId && !barcode) throw new Error('IMPORT_PRODUCT_IDENTITY_REQUIRED');
    const matched = (existingRows || []).find(item =>
      (explicitId && String(item.id || '') === explicitId) || (barcode && String(item.barcode || '') === barcode));
    if (matched && explicitId && String(matched.id || '') !== explicitId) throw new Error('IMPORT_IDENTITY_CONFLICT');
    const stockRaw = first(row, ['stock','quantity','المخزون','الكمية','الرصيد']);
    const stockUnits = decimalToUnits(stockRaw || '0', 6);
    const priceRaw = first(row, ['price1','price','سعر البيع','السعر','سعر التجزئة']);
    const costRaw = first(row, ['buyPrice','cost','cost_price','سعر التكلفة','سعر الشراء']);
    const priceCents = priceRaw !== '' ? toCents(priceRaw) : (matched ? toCents(matched.price1 ?? matched.price ?? 0) : null);
    if (priceCents === null || priceCents < 0) throw new Error('IMPORT_PRODUCT_PRICE_REQUIRED');
    const costCents = costRaw !== '' ? toCents(costRaw) : (matched ? toCents(matched.buyPrice ?? 0) : 0);
    if (costCents < 0) throw new Error('INVALID_PRODUCT_COST');
    return {
      ...(matched || {}), ...row,
      id: matched?.id || explicitId || ('IMP-PROD-' + barcode),
      barcode: barcode || matched?.barcode || '',
      name,
      stock: matched ? Number(matched.stock ?? matched.quantity ?? 0) : unitsToNumber(stockUnits, 6),
      price1: fromCents(priceCents),
      buyPrice: matched ? Number(matched.buyPrice ?? fromCents(costCents)) : fromCents(costCents),
      unit: text(first(row, ['unit','الوحدة','وحدة القياس'])) || matched?.unit || 'قطعة'
    };
  }
  if (type === 'customers' || type === 'suppliers') {
    const explicitId = text(first(row, ['id', type === 'customers' ? 'customer_id' : 'supplier_id',
      type === 'customers' ? 'customerId' : 'supplierId', type === 'customers' ? 'رقم العميل' : 'رقم المورد']));
    const phoneRaw = text(first(row, ['phone','الهاتف','mobile','telephone','رقم الهاتف']));
    const phone = normalizeAlgeriaPhone(phoneRaw) || phoneRaw;
    if (!explicitId && !phone) throw new Error('IMPORT_PARTY_IDENTITY_REQUIRED:' + type);
    const matched = (existingRows || []).find(item =>
      (explicitId && String(item.id || '') === explicitId) || (phone && String(item.phone || '') === phone));
    const balanceRaw = first(row, type === 'customers'
      ? ['debt','initial_debt','الرصيد','الدين','المبلغ المستحق']
      : ['balance','payable','الرصيد','الدين','المبلغ المستحق']);
    const balanceCents = balanceRaw !== '' ? toCents(balanceRaw) : 0;
    if (balanceCents < 0) throw new Error('INVALID_PARTY_OPENING_BALANCE');
    const limitRaw = first(row, ['credit_limit','حد الائتمان','السقف الائتماني']);
    const limitCents = limitRaw !== '' ? toCents(limitRaw) : null;
    if (limitCents !== null && limitCents < 0) throw new Error('INVALID_CREDIT_LIMIT');
    const id = matched?.id || explicitId || ('IMP-' + (type === 'customers' ? 'CUST-' : 'SUP-') + phone.replace(/\D/g, ''));
    if (type === 'customers') return {
      ...(matched || {}), ...row, id, name, phone: phone || matched?.phone || '',
      debt: matched ? Number(matched.debt ?? matched.initial_debt ?? 0) : fromCents(balanceCents),
      credit_limit: limitCents === null ? (matched?.credit_limit ?? null) : fromCents(limitCents),
      ledgerVersion: matched?.ledgerVersion ?? 0
    };
    return {
      ...(matched || {}), ...row, id, name, phone: phone || matched?.phone || '',
      balance: matched ? Number(matched.balance ?? 0) : fromCents(balanceCents),
      ledgerVersion: matched?.ledgerVersion ?? 0
    };
  }
  if (type === 'invoices') {
    const invoiceNo = text(first(row, ['id','invoice_id','invoiceId','invoice_no','invoiceNumber','number','رقم الفاتورة','رقم الفاتوره']));
    const date = text(first(row, ['date','تاريخ','تاريخ الفاتورة','تاريخ الفاتوره']));
    const customerName = text(first(row, ['customerName','customer','client','العميل','الزبون','اسم العميل']));
    const customerId = text(first(row, ['customerId','customer_id','معرف العميل']));
    const totalRaw = first(row, ['total','الإجمالي','الاجمالي','المبلغ','قيمة الفاتورة']);
    const paidRaw = first(row, ['paid','المدفوع','المبلغ المدفوع']);
    const remainingRaw = first(row, ['remaining','المتبقي','الباقي']);
    if (!invoiceNo || !date || (!customerName && !customerId) || totalRaw === '') throw new Error('IMPORT_INVOICE_REQUIRED_FIELDS');
    if (!Number.isFinite(Date.parse(date))) throw new Error('IMPORT_INVOICE_DATE_INVALID');
    const total = toCents(totalRaw);
    const paid = paidRaw !== '' ? toCents(paidRaw) : 0;
    const remaining = remainingRaw !== '' ? toCents(remainingRaw) : total - paid;
    if (total < 0 || paid < 0 || remaining < 0 || paid > total || paid + remaining !== total) {
      throw new Error('IMPORT_INVOICE_FINANCIAL_MISMATCH');
    }
    return {
      ...row, id: invoiceNo, invoiceNumber: invoiceNo, date,
      customerId: customerId || null, customerName: customerName || '',
      total: fromCents(total), paid: fromCents(paid), remaining: fromCents(remaining),
      items: [], invoiceLedgerVersion: 0, importedHistorical: true,
      financiallyPosted: false, status: 'imported_archive',
      paymentMethod: 'imported_archive', importedAt: new Date().toISOString()
    };
  }
  throw new TypeError('INVALID_IMPORT_ENTITY');
}

/**
 * Stages four entity collections before a single durable repository transaction.
 * Imported invoice headers are archived only: they do not post stock, cash, or debt.
 */
export async function executeSafeMultiSheetImport({ sheetsDataMap, targetBySheet = {}, existingDB = {}, repository } = {}) {
  if (!sheetsDataMap || typeof sheetsDataMap !== 'object' || Array.isArray(sheetsDataMap)) throw new TypeError('IMPORT_SHEETS_REQUIRED');
  if (!repository || typeof repository.saveMultiSheetBatchSafe !== 'function') throw new TypeError('ATOMIC_MULTI_SHEET_REPOSITORY_REQUIRED');
  const staged = classifyAndStageWorkbookSheets(sheetsDataMap, existingDB, targetBySheet);
  const types = ['suppliers','products','customers','invoices'];
  if (staged.sheetCount < 4 || types.some(type => staged[type].length === 0)) throw new Error('MULTI_SHEET_REQUIRED_TYPES_MISSING');
  if (staged.unclassified > 0) throw new Error('MULTI_SHEET_UNCLASSIFIED_ROWS:' + staged.unclassified);
  const batches = {}, stats = {};
  for (const type of types) {
    if (staged[type].some(row => row.identityConflict)) throw new Error('IMPORT_IDENTITY_CONFLICT:' + type);
    const existingRows = Array.isArray(existingDB[type]) ? existingDB[type] : [];
    if (existingDB[type] !== undefined && !Array.isArray(existingDB[type])) throw new Error('EXISTING_DATA_NOT_ARRAY:' + type);
    const sourceRows = type === 'invoices' ? staged[type].filter(row => !row.isDuplicate) : staged[type];
    const normalizedRows = sourceRows.map((row, index) => normalizeMultiSheetImportRow(type, row, index, existingRows));
    const keys = type === 'products' ? ['id','barcode'] : type === 'customers' || type === 'suppliers' ? ['phone','id'] : ['id'];
    const plan = prepareBulkImport(existingRows, normalizedRows, 'merge', keys, { strictIdentity: type === 'products' });
    batches[type] = Object.freeze({ rows: plan.rows, stats: plan.stats });
    stats[type] = Object.freeze({ ...plan.stats, duplicateSkipped: type === 'invoices' ? staged[type].length - sourceRows.length : 0 });
  }
  // Preserve the complete application snapshot, not only the four imported collections.
  // This lets the caller restore every dependent ledger/configuration collection if a durable write fails.
  const fullSnapshot = JSON.parse(JSON.stringify(existingDB));
  const backupPayload = JSON.stringify({
    schema: 'ANAS_MULTI_SHEET_BACKUP_V1', createdAt: new Date().toISOString(),
    snapshot: fullSnapshot,
    collections: Object.fromEntries(types.map(type => [type, Array.isArray(existingDB[type]) ? existingDB[type] : []]))
  });
  try {
    // The repository must persist the backup snapshot first, then all four collections in one IndexedDB transaction.
    await repository.saveMultiSheetBatchSafe(batches, backupPayload);
    return Object.freeze({
      durable: true, sheetCount: staged.sheetCount, totalValidRows: staged.totalValidRows,
      unclassified: staged.unclassified, stats: Object.freeze(stats),
      totalAdded: types.reduce((sum, type) => sum + stats[type].added, 0),
      totalUpdated: types.reduce((sum, type) => sum + stats[type].updated, 0),
      totalSkipped: types.reduce((sum, type) => sum + stats[type].skipped + stats[type].duplicateSkipped, 0)
    });
  } catch (error) {
    throw new Error('SAFE_MULTI_SHEET_IMPORT_ROLLED_BACK: ' + (error?.message || String(error)));
  }
}

export function normalizeAlgeriaPhone(rawPhone) {
  let digits = String(rawPhone ?? '')
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06F0))
    .replace(/\D+/g, '');
  if (digits.startsWith('00213')) digits = '213' + digits.slice(5);
  else if (digits.startsWith('0') && digits.length === 10) digits = '213' + digits.slice(1);
  else if (digits.length === 9 && /^[567]/.test(digits)) digits = '213' + digits;
  return /^213[567]\d{8}$/.test(digits) ? digits : '';
}

export function buildWhatsAppStatementUrl(customer, companyName = 'أصحاب الرقيم للتجارة') {
  const phone = normalizeAlgeriaPhone(customer?.phone);
  if (!phone) return null;
  const debt = toCents(customer?.debt ?? customer?.initial_debt ?? 0);
  const formatted = (debt / 100).toLocaleString('fr-DZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const message = 'السلام عليكم ' + text(customer?.name || 'عميلنا الكريم') +
    '،\nنحيطكم علماً من (' + text(companyName) + ') بأن إجمالي الرصيد المستحق في حسابكم هو: ' +
    formatted + ' DA.\nشكراً لتعاملكم معنا.';
  return 'https://wa.me/' + phone + '?text=' + encodeURIComponent(message);
}

if (typeof window !== 'undefined') {
  window.ANASAdvancedFinancialEngine = Object.freeze({
    classifyAndStageWorkbookSheets, createProformaDraft, convertProformaToActualInvoice,
    calculateZakatSummary, canPerformRoleAction, executeSafeBulkImport, executeSafeMultiSheetImport,
    normalizeAlgeriaPhone, buildWhatsAppStatementUrl
  });
}
