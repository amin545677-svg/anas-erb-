import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateZakatSummary, canPerformRoleAction, classifyAndStageWorkbookSheets,
  convertProformaToActualInvoice, createProformaDraft
} from '../pos/advanced-financial-engine.mjs';

test('multi-sheet staging classifies entities and detects both database and in-file duplicates', () => {
  const result = classifyAndStageWorkbookSheets({
    'الموردين': [{ الاسم: 'مورد أ', الهاتف: '0550000000', شركة: 'أ' }, { الاسم: 'مورد أ', الهاتف: '0550000000', شركة: 'أ' }],
    'المنتجات': [{ 'اسم المنتج': 'سكر', الباركود: '100', 'سعر البيع': 50, كمية: 3 }],
    'العملاء': [{ العميل: 'عميل أ', الهاتف: '0660000000', 'حد الائتمان': 1000 }]
  }, { products: [{ barcode: '100', name: 'سكر' }] });
  assert.equal(result.sheetCount, 3);
  assert.equal(result.totalValidRows, 4);
  assert.equal(result.suppliers[1].duplicateScope, 'workbook');
  assert.equal(result.products[0].duplicateScope, 'database');
  assert.equal(result.customers.length, 1);
});

test('proforma drafts validate lines and remain non-posting records', () => {
  const draft = createProformaDraft({ id: 'Q-1', customerId: 'C-1',
    lines: [{ productId: 'P-1', quantity: '1.5', unitPrice: '100.00' }] });
  assert.equal(draft.status, 'proforma');
  assert.equal(draft.totalCents, 15000);
  assert.throws(() => createProformaDraft({ id: 'Q-2', lines: [] }), /LINES_REQUIRED/);
});

test('proforma conversion is transaction-bound, stock-checked, and idempotency guarded', async () => {
  let committed = false;
  const state = { proforma: { id: 'Q-1', status: 'proforma', totalCents: 10000, customerId: 'C-1',
    lines: [{ productId: 'P-1', quantity: '2' }] }, quantity: 5, invoice: null };
  const tx = {
    async getProforma() { return state.proforma; },
    async getProduct() { return { id: 'P-1', quantity: state.quantity }; },
    async createSalesInvoice(data) { state.invoice = { id: 'I-1', ...data }; return state.invoice; },
    async setProductQuantity(_id, value) { state.quantity = value; },
    async postSaleFinancials() {},
    async markProformaConverted() { state.proforma.status = 'converted'; }
  };
  const repository = { async runTransaction(fn) { const value = await fn(tx); committed = true; return value; } };
  const invoice = await convertProformaToActualInvoice({ proformaId: 'Q-1', repository, paidCents: 5000 });
  assert.equal(invoice.status, 'partial');
  assert.equal(state.quantity, 3);
  assert.equal(state.proforma.status, 'converted');
  assert.equal(committed, true);
  await assert.rejects(() => convertProformaToActualInvoice({ proformaId: 'Q-1', repository }), /ALREADY_CONVERTED/);
});

test('failed stock validation does not write invoice, stock, or proforma status', async () => {
  const state = { status: 'proforma', quantity: 1, invoiceCreated: false };
  const repository = { async runTransaction(fn) { return fn({
    async getProforma() { return { id: 'Q', status: state.status, totalCents: 100, lines: [{ productId: 'P', quantity: '2' }] }; },
    async getProduct() { return { id: 'P', quantity: state.quantity }; },
    async createSalesInvoice() { state.invoiceCreated = true; },
    async setProductQuantity() {},
    async postSaleFinancials() {},
    async markProformaConverted() { state.status = 'converted'; }
  }); } };
  await assert.rejects(() => convertProformaToActualInvoice({ proformaId: 'Q', repository }), /INSUFFICIENT_STOCK/);
  assert.equal(state.invoiceCreated, false);
  assert.equal(state.status, 'proforma');
});

test('zakat uses 85g gold nisab, excludes uncollectible debt, and values stock at cost by default', () => {
  const result = calculateZakatSummary({
    cashBalance: '100000', goldPricePerGram24k: '1000',
    products: [{ quantity: 10, cost_price: '1000', price_retail: '2500' }],
    customers: [{ debt: '5000', collectible: false }, { debt: '10000', collectible: true }],
    suppliers: [{ balance: '2000' }]
  });
  assert.equal(result.inventoryValue, 10000);
  assert.equal(result.goodReceivables, 10000);
  assert.equal(result.supplierPayables, 2000);
  assert.equal(result.nisabThreshold, 85000);
  assert.equal(result.netZakatableWealth, 118000);
  assert.equal(result.zakatDue, 2950);
});

test('role permissions enforce least privilege for seller and cashier', () => {
  assert.equal(canPerformRoleAction('general_manager', 'capital'), true);
  assert.equal(canPerformRoleAction('seller', 'proforma'), true);
  assert.equal(canPerformRoleAction('seller', 'expenses'), false);
  assert.equal(canPerformRoleAction('cashier', 'cash_shift'), true);
  assert.equal(canPerformRoleAction('cashier', 'inventory_view'), false);
});
