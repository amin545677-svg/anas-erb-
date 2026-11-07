import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateZakatSummary, classifyAndStageWorkbookSheets, convertProformaToActualInvoice, createProformaDraft,
  executeSafeBulkImport, normalizeAlgeriaPhone, buildWhatsAppStatementUrl
} from '../pos/advanced-financial-engine.mjs';

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    snapshot() { return Object.fromEntries(values); }
  };
}

test('proforma conversion aggregates repeated product lines using exact fractional stock units', async () => {
  const draft = createProformaDraft({ id: 'Q-FRACTION', lines: [
    { productId: 'P-1', quantity: '0.2', unitPrice: '10.00' },
    { productId: 'P-1', quantity: '0.3', unitPrice: '10.00' }
  ] });
  assert.equal(draft.totalCents, 500);
  let stock = '1.0';
  const writes = [];
  const repository = { async runTransaction(work) {
    return work({
      async getProforma() { return draft; },
      async getProduct() { return { id: 'P-1', quantity: stock }; },
      async createSalesInvoice(data) { return { id: 'INV-1', ...data }; },
      async setProductQuantity(id, quantity) { writes.push([id, quantity]); stock = String(quantity); },
      async postSaleFinancials() {},
      async markProformaConverted() {}
    });
  } };
  const invoice = await convertProformaToActualInvoice({ proformaId: draft.id, repository, paidCents: 250 });
  assert.equal(invoice.status, 'partial');
  assert.deepEqual(writes, [['P-1', 0.5]], 'one aggregated stock write is required per product');
  assert.equal(stock, '0.5');
});

test('proforma conversion rejects aggregate duplicate lines that exceed stock before any write', async () => {
  const draft = createProformaDraft({ id: 'Q-OVER', lines: [
    { productId: 'P-1', quantity: '0.7', unitPrice: '1.00' },
    { productId: 'P-1', quantity: '0.6', unitPrice: '1.00' }
  ] });
  let writes = 0;
  const repository = { async runTransaction(work) {
    return work({
      async getProforma() { return draft; },
      async getProduct() { return { id: 'P-1', quantity: '1.0' }; },
      async createSalesInvoice() { throw new Error('MUST_NOT_CREATE_INVOICE'); },
      async setProductQuantity() { writes++; },
      async postSaleFinancials() {},
      async markProformaConverted() {}
    });
  } };
  await assert.rejects(() => convertProformaToActualInvoice({ proformaId: draft.id, repository }), /INSUFFICIENT_STOCK/);
  assert.equal(writes, 0);
});

test('zakat valuation uses exact decimal quantities and centime arithmetic', () => {
  const result = calculateZakatSummary({
    cashBalance: '100.00', goldPricePerGram24k: '100.00',
    products: [{ quantity: '457.8', cost_price: '0.10' }],
    customers: [{ debt: '20.25', collectible: true }],
    suppliers: [{ balance: '5.10' }]
  });
  assert.equal(result.inventoryValue, 45.78);
  assert.equal(result.goodReceivables, 20.25);
  assert.equal(result.supplierPayables, 5.1);
  assert.equal(result.netZakatableWealth, 160.93);
  assert.equal(result.zakatDue, 0);
  assert.throws(() => calculateZakatSummary({
    cashBalance: 0, goldPricePerGram24k: '1',
    products: [{ quantity: '1.0000001', cost_price: '1' }]
  }), /INVALID_QUANTITY_PRECISION/);
});

test('safe bulk import backs up first, commits one complete batch and restores mirror on failure', async () => {
  const storage = memoryStorage({ anas_products: JSON.stringify([{ id: 'P1', barcode: '100', name: 'قديم', quantity: 1 }]) });
  const committed = [];
  const stats = await executeSafeBulkImport({
    rows: [
      { barcode: '100', name: 'محدث', quantity: 2 },
      { barcode: '200', name: 'جديد', quantity: 0.2 },
      { name: '' }
    ],
    storage,
    repository: { async saveBatchSafe(type, rows) { committed.push({ type, rows }); } }
  });
  assert.deepEqual({ total: stats.total, added: stats.added, updated: stats.updated, skipped: stats.skipped },
    { total: 3, added: 1, updated: 1, skipped: 1 });
  assert.equal(stats.durable, true);
  assert.equal(committed.length, 1);
  assert.equal(committed[0].type, 'products');
  assert.equal(JSON.parse(storage.getItem('anas_products_backup_pre_import')).length, 1);
  assert.equal(JSON.parse(storage.getItem('anas_products')).length, 2);

  const beforeFailure = storage.getItem('anas_products');
  await assert.rejects(() => executeSafeBulkImport({
    rows: [{ barcode: '300', name: 'لن يحفظ' }],
    storage,
    repository: { async saveBatchSafe() { throw new Error('IDB_ABORT'); } }
  }), /SAFE_IMPORT_ROLLED_BACK/);
  assert.equal(storage.getItem('anas_products'), beforeFailure);
});

test('Algerian WhatsApp statements normalize valid mobile numbers and omit invalid numbers', () => {
  assert.equal(normalizeAlgeriaPhone('0550 12 34 56'), '213550123456');
  assert.equal(normalizeAlgeriaPhone('+213 660 12 34 56'), '213660123456');
  assert.equal(normalizeAlgeriaPhone('012345'), '');
  const url = buildWhatsAppStatementUrl({ name: 'عميل تجريبي', phone: '0550123456', debt: '1250.50' });
  assert.match(url, /^https:\/\/wa\.me\/213550123456\?text=/);
  assert.equal(buildWhatsAppStatementUrl({ name: 'بدون هاتف', debt: 10 }), null);
});

test('replace imports deduplicate repeated customer rows by normalized phone number', async () => {
  const storage = memoryStorage({ anas_customers: JSON.stringify([{ id: 'C-OLD', name: 'قديم', phone: '0550123456' }]) });
  let saved;
  const stats = await executeSafeBulkImport({
    rows: [
      { id: 'C-NEW', name: 'عميل أول', phone: '0550123456' },
      { id: 'C-NEWER', name: 'عميل محدث', phone: '0550123456' }
    ],
    mode: 'replace', entityType: 'customers', storage,
    repository: { async saveBatchSafe(type, rows) { saved = { type, rows }; } }
  });
  assert.equal(saved.type, 'customers');
  assert.equal(saved.rows.length, 1);
  assert.equal(saved.rows[0].name, 'عميل محدث');
  assert.equal(stats.added, 1);
  assert.equal(stats.updated, 1);
  assert.equal(stats.skipped, 0);
});

test('multi-sheet workbook staging classifies all four entity types and detects database duplicates', () => {
  const staged = classifyAndStageWorkbookSheets({
    'المنتجات': [{ name: 'منتج', barcode: 'P-100', quantity: '7.4', price: '25.00' }],
    'العملاء': [{ name: 'عميل', phone: '0550123456', 'حد الائتمان': '5000' }],
    'الموردون': [{ name: 'مورد', phone: '0660123456', 'الرصيد': '100' }],
    'الفواتير': [{ 'رقم الفاتورة': 'INV-100', 'تاريخ': '2026-11-07', 'الإجمالي': '250', 'العميل': 'عميل' }]
  }, {
    products: [{ name: 'منتج سابق', barcode: 'P-100' }],
    customers: [{ name: 'عميل سابق', phone: '0550123456' }],
    suppliers: [{ name: 'مورد سابق', phone: '0660123456' }],
    invoices: [{ id: 'INV-100' }]
  });
  assert.equal(staged.sheetCount, 4);
  assert.equal(staged.totalValidRows, 4);
  assert.equal(staged.products.length, 1);
  assert.equal(staged.customers.length, 1);
  assert.equal(staged.suppliers.length, 1);
  assert.equal(staged.invoices.length, 1);
  assert.equal(staged.products[0].isDuplicate, true);
  assert.equal(staged.customers[0].isDuplicate, true);
  assert.equal(staged.suppliers[0].isDuplicate, true);
  assert.equal(staged.invoices[0].isDuplicate, true);
  assert.equal(staged.invoices[0].duplicateScope, 'database');
});
