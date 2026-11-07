'use strict';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const DB_KEY = 'ANAS_THE_ENTERPRISE_V11_OFFLINE';
const PORT = 4174;
const PRODUCT_ID = 'STG-POS-LIFECYCLE-001';
const PRODUCT_NAME = 'منتج اختبار دورة POS';

function initialData() {
  return {
    appName: 'Anas ERP',
    storeConfig: { name: 'ANAS ERP POS Lifecycle Staging', footer: 'Staging-only test data' },
    currentUser: { id: 'CI-POS-LIFECYCLE', name: 'POS Lifecycle Chromium', role: 'مدير عام', warehouse: 'المخزن الرئيسي' },
    activePosScreenTab: 1,
    activePriceTier: 1,
    posScreensCarts: { 1: [], 2: [], 3: [], 4: [], quote: [] },
    caisseBalance: 100000,
    products: [{
      id: PRODUCT_ID, name: PRODUCT_NAME, stock: 10, buyPrice: 10,
      lastPurchaseCost: 10, price1: 25, price2: 25, price3: 25,
      barcode: 'STGPOSLIFE001', unit: 'قطعة', supplierId: '', cat: 'عام'
    }],
    customers: [{ id: 'STG-CUSTOMER-001', name: 'زبون اختبار الدفع', phone: '0000000000', debt: 0 }], suppliers: [], supplierMovements: [], purchases: [], purchaseInvoices: [],
    invoices: [], cashMovements: [], stockMovements: [], expenses: [], users: [], alerts: [],
    warehouseTransfers: [], warehouses: [], truckTrips: [], trucks: [], returns: [],
    stocktakeRecords: [], syncUrl: ''
  };
}

function startServer() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.resolve(ROOT, relative);
    if (!target.startsWith(ROOT + path.sep) && target !== path.join(ROOT, 'index.html')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(target, (error, bytes) => {
      if (error) { res.writeHead(404).end('Not found'); return; }
      const ext = path.extname(target);
      const mime = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.json' || ext === '.webmanifest' ? 'application/json; charset=utf-8'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(bytes);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function readCommittedSale(page, invoiceId) {
  return page.evaluate(({ id, productId }) => {
    const storage = window.ANASResilientStorage;
    if (!storage || !storage.ready()) throw new Error('ANAS_STORAGE_NOT_READY_AFTER_HYDRATION');
    const snapshot = storage.getCommittedSnapshot();
    if (!snapshot || !Array.isArray(snapshot.invoices)) throw new Error('COMMITTED_INVOICE_SNAPSHOT_MISSING');
    const invoiceRows = snapshot.invoices.filter(row => row && String(row.id) === String(id));
    const invoice = invoiceRows[0] || null;
    const cash = (snapshot.cashMovements || []).filter(row =>
      row && row.referenceType === 'sales_invoice' && String(row.referenceId) === String(id));
    const stock = (snapshot.stockMovements || []).filter(row =>
      row && row.referenceType === 'sales_invoice' && String(row.referenceId) === String(id));
    const product = (snapshot.products || []).find(row => row && String(row.id) === String(productId));
    return {
      invoiceCount: invoiceRows.length,
      invoice: invoice && {
        id: String(invoice.id), total: invoice.total, paid: invoice.paid,
        remaining: invoice.remaining, paymentMethod: invoice.paymentMethod
      },
      cash: cash.map(row => ({
        id: String(row.id), type: row.type, amount: row.amount,
        referenceType: row.referenceType, referenceId: String(row.referenceId)
      })),
      stock: stock.map(row => ({
        id: String(row.id), type: row.type, qty: row.qty,
        referenceType: row.referenceType, referenceId: String(row.referenceId)
      })),
      productStock: product && product.stock,
      caisseBalance: snapshot.caisseBalance,
      revision: storage.status().revision,
      mode: storage.status().mode
    };
  }, { id: invoiceId, productId: PRODUCT_ID });
}

test('ANAS ERP real POS checkout commits invoice and ledgers and survives page reload', async () => {
  const server = await startServer();
  let browser;
  const pageErrors = [];
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: 'fr-DZ', viewport: { width: 1365, height: 900 } });
    // Seed once only. Re-seeding on reload would overwrite the state being verified.
    await context.addInitScript(({ key, data }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(data));
    }, { key: DB_KEY, data: initialData() });

    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    const dialogMessages = [];
    page.on('dialog', async dialog => { dialogMessages.push(dialog.message()); await dialog.accept(); });

    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-view.active', { timeout: 15000 });
    await page.waitForFunction(() =>
      document.body && document.body.inert === false &&
      window.ANASResilientStorage?.ready() === true &&
      typeof AppData !== 'undefined' && Array.isArray(AppData.products),
      null, { timeout: 15000 }
    );
    assert.deepEqual(pageErrors, [], 'application must boot without uncaught browser errors');

    // Use the rendered POS product button, not a fabricated selector or direct storage write.
    await page.evaluate(() => openView('pos'));
    const productButton = page.locator('#quickProductsContainer button').filter({ hasText: PRODUCT_NAME });
    await productButton.waitFor({ state: 'visible', timeout: 10000 });
    const checkoutBeforeAdd = await page.locator('#posCheckoutBtn').isDisabled();
    assert.equal(checkoutBeforeAdd, true, 'checkout must stay disabled while the cart is empty');
    await productButton.click();
    assert.equal(await page.locator('#posCheckoutBtn').isEnabled(), true,
      'the single guided checkout action must enable after a valid product is added');

    const cartProof = await page.evaluate(() => ({
      count: Array.isArray(posCart) ? posCart.length : -1,
      id: posCart[0] && String(posCart[0].id),
      qty: posCart[0] && posCart[0].qty
    }));
    assert.equal(cartProof.count, 1, 'real POS product interaction must add exactly one cart line');
    assert.equal(cartProof.id, PRODUCT_ID);
    assert.equal(cartProof.qty, 1);

    // Open the original Hasib modal through its actual toolbar control.
    await page.locator('#posCheckoutBtn').click();
    await page.locator('#hasibModal.active').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#hasibCartItems button').filter({ hasText: 'حذف' }).click();
    assert.equal(await page.locator('#hasibConfirmSaleBtn').isDisabled(), true,
      'removing the final cart line must disable checkout immediately');
    assert.equal(await page.locator('#hasibTotalText').textContent(), 'أضف منتجاً للمتابعة');
    await page.locator('#hasibCartEditor button').filter({ hasText: 'إضافة منتجات' }).click();
    await page.locator('#productPickerModal.active').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#productPickerSearch').fill('POS-NO-MATCH-TEST');
    assert.equal(await page.locator('#productPickerList button').count(), 0,
      'product picker search must filter out non-matching products');
    assert.match(await page.locator('#productPickerList').textContent(), /لا توجد منتجات مطابقة/);
    await page.locator('#productPickerSearch').fill(PRODUCT_NAME);
    await page.locator('#productPickerList button').filter({ hasText: PRODUCT_NAME }).click();
    await page.locator('#hasibModal.active').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#hasibConfirmSaleBtn').isEnabled(), true,
      'adding a valid product from the picker must restore checkout');
    await page.evaluate(() => addItemToPosCart('STG-POS-LIFECYCLE-001'));
    assert.equal(await page.evaluate(() => posCart.length), 1,
      'adding the same product twice must merge into one cart line');
    assert.equal(await page.evaluate(() => posCart[0].qty), 2,
      'adding the same product twice must increment the existing quantity');
    // Cart edits can increase the invoice total while the paid amount remains unchanged.
    // Set the intended full-cash payment explicitly so this stock-guard assertion is
    // independent of the registered-customer requirement for partial/credit sales.
    await page.locator('#hasibPaidAmount').fill('50.00');
    assert.equal(await page.locator('#hasibPaymentMethod').inputValue(), 'cash',
      'the stock-overrun case must exercise a fully paid cash sale');
    assert.equal(await page.locator('#hasibCustomerSelect').inputValue(), '',
      'a fully paid cash sale must not require a registered customer');
    assert.equal(await page.locator('#hasibConfirmSaleBtn').isEnabled(), true,
      'full-cash payment must remain confirmable without a registered customer');
    await page.evaluate(() => {
      const original = AppData.products[0];
      AppData.products.push({ ...original });
      addItemToPosCart(original.id);
      AppData.products.pop();
    });
    assert.equal(await page.evaluate(() => posCart.length), 1,
      'duplicate product IDs in the catalog must block ambiguous cart additions');
    assert.equal(await page.evaluate(() => posCart[0].qty), 2,
      'ambiguous product ID must not mutate the cart');
    await page.evaluate(() => {
      AppData.products[0].stock = 0;
      AppData.allowNegativeStock = true;
      if (saveDB() !== true) throw new Error('Could not persist zero-stock policy fixture');
      addItemToPosCart('STG-POS-LIFECYCLE-001');
      setPosQty(0, 3);
    });
    assert.equal(await page.evaluate(() => posCart[0].qty), 2,
      'POS must block stock overrun even if a legacy allowNegativeStock flag is true because warehouse balances reject negatives');
    await page.locator('#hasibModal button[onclick="confirmHasibPaymentDurable()"]').click();
    assert.equal(await page.evaluate(() => AppData.invoices.length), 0,
      'durable sale commit must reject a stock overrun even when the legacy negative-stock flag is enabled');
    assert.ok(dialogMessages.some(message => message.includes('المخزون غير كافٍ')),
      'durable stock guard must explain why the sale was rejected');
    await page.evaluate(() => {
      AppData.products[0].stock = 10;
      AppData.allowNegativeStock = false;
      if (saveDB() !== true) throw new Error('Could not restore stock fixture');
      renderPosTable();
    });
    const commitNumberEditor = async (selector, value) => {
      const editor = page.locator(selector).first(); // target the first cart row when duplicate-row guards are under test
      await editor.fill(value);
      await editor.press('Tab'); // commit the native change event used by the editor
    };
    // fr-DZ may render decimal commas while other Chromium locales render dots.
    // Compare the numeric amount, not a locale-specific currency label.
    const waitForDisplayedTotal = expected => page.waitForFunction(value => {
      const text = document.getElementById('hasibTotalText')?.textContent || '';
      const match = text.match(/[0-9]+(?:[.,][0-9]+)?/);
      return !!match && Math.abs(Number(match[0].replace(',', '.')) - value) < 1e-9;
    }, expected);
    const quantitySelector = '#hasibCartItems input[aria-label^="كمية"]';
    const priceSelector = '#hasibCartItems input[aria-label^="سعر الوحدة"]';
    await commitNumberEditor(quantitySelector, '1.5');
    await waitForDisplayedTotal(37.5);
    assert.equal(await page.evaluate(() => posCart[0].qty), 1.5);
    await commitNumberEditor(quantitySelector, '0');
    assert.equal(await page.evaluate(() => posCart[0].qty), 1.5,
      'zero quantity must be rejected and the last valid fractional quantity restored');
    await commitNumberEditor(quantitySelector, '11');
    assert.equal(await page.evaluate(() => posCart[0].qty), 1.5,
      'quantity above available stock must be rejected without changing the last valid quantity');
    await page.evaluate(() => {
      posCart.push({ ...posCart[0], qty: 9 });
      renderPosTable();
    });
    await commitNumberEditor(quantitySelector, '2');
    assert.equal(await page.evaluate(() => posCart[0].qty), 1.5,
      'quantity editing must include legacy duplicate rows for the same product and preserve the last valid quantity');
    await page.evaluate(() => { posCart.splice(1, 1); renderPosTable(); });
    await commitNumberEditor(priceSelector, '30.00');
    await waitForDisplayedTotal(45); // 1.5 units × 30.00 DZD
    assert.equal(await page.evaluate(() => posCart[0].price), 30);
    await commitNumberEditor(priceSelector, '-1');
    assert.equal(await page.evaluate(() => posCart[0].price), 30,
      'negative unit price must be rejected and restored');
    await commitNumberEditor(priceSelector, '30.005');
    assert.equal(await page.evaluate(() => posCart[0].price), 30,
      'prices with more than two decimal places must be rejected, not silently rounded');
    await commitNumberEditor(priceSelector, '25.00');
    await waitForDisplayedTotal(37.5); // 1.5 units × 25.00 DZD
    assert.equal(await page.evaluate(() => posCart[0].price), 25);
    await commitNumberEditor(priceSelector, '0.10');
    await commitNumberEditor(quantitySelector, '0.15');
    await waitForDisplayedTotal(0.02);
    assert.equal(await page.locator('#posTotalDisplay').textContent(), '0.02 د.ج',
      'main POS and checkout totals must use identical centime rounding');
    await commitNumberEditor(quantitySelector, '1');
    await commitNumberEditor(priceSelector, '25.00');
    await waitForDisplayedTotal(25);
    await page.evaluate(() => {
      window.__posOriginalSaveDBForTest = window.saveDB;
      window.saveDB = () => false;
    });
    await commitNumberEditor(priceSelector, '26.00');
    assert.equal(await page.evaluate(() => posCart[0].price), 25,
      'failed persistence must roll back the edited unit price');
    assert.equal(await page.evaluate(() => AppData.posScreensCarts[AppData.activePosScreenTab][0].price), 25,
      'failed persistence must restore the active persisted cart mirror');
    await page.locator('#hasibCartItems button').filter({ hasText: 'حذف' }).click();
    assert.equal(await page.evaluate(() => posCart.length), 1,
      'failed persistence must roll back a cart-line removal');
    assert.equal(await page.evaluate(() => AppData.posScreensCarts[AppData.activePosScreenTab].length), 1,
      'failed removal must restore the active cart mirror as well');
    await page.evaluate(() => {
      window.saveDB = window.__posOriginalSaveDBForTest;
      delete window.__posOriginalSaveDBForTest;
    });
    assert.equal(await page.locator('#hasibPaymentMethod').inputValue(), 'cash');
    assert.equal(await page.locator('#hasibCustomerSelect').inputValue(), '');
    assert.equal(await page.locator('#hasibConfirmSaleBtn').isEnabled(), true,
      'a fully paid cash sale must not require a registered customer');
    const revisionBeforePayment = await page.evaluate(() => ANASResilientStorage.status().revision);

    // Confirm through the actual modal button; never call the payment function directly.
    await page.locator('#hasibModal button[onclick="confirmHasibPaymentDurable()"]').click();
    await page.waitForFunction(({ beforeRevision, productId }) => {
      const storage = window.ANASResilientStorage;
      const snapshot = storage && storage.getCommittedSnapshot();
      const invoice = snapshot && Array.isArray(snapshot.invoices) &&
        snapshot.invoices.find(row => row && row.items && row.items.some(item => String(item.id) === productId));
      if (!storage || !snapshot || !invoice) return false;
      const cash = (snapshot.cashMovements || []).filter(row =>
        row && row.referenceType === 'sales_invoice' && String(row.referenceId) === String(invoice.id));
      const stock = (snapshot.stockMovements || []).filter(row =>
        row && row.referenceType === 'sales_invoice' && String(row.referenceId) === String(invoice.id));
      return storage.ready() && storage.status().revision > beforeRevision &&
        !document.getElementById('hasibModal')?.classList.contains('active') &&
        cash.length === 1 && stock.length === 1;
    }, { beforeRevision: revisionBeforePayment, productId: PRODUCT_ID }, { timeout: 15000 });

    const invoiceId = await page.evaluate((productId) => {
      const matches = AppData.invoices.filter(row =>
        row && Array.isArray(row.items) && row.items.some(item => String(item.id) === productId));
      if (matches.length !== 1) throw new Error('EXPECTED_EXACTLY_ONE_POS_INVOICE_BEFORE_RELOAD');
      return String(matches[0].id);
    }, PRODUCT_ID);

    const beforeReload = await readCommittedSale(page, invoiceId);
    assert.equal(beforeReload.invoiceCount, 1);
    assert.deepEqual(beforeReload.invoice, {
      id: invoiceId, total: 25, paid: 25, remaining: 0, paymentMethod: 'cash'
    });
    assert.equal(beforeReload.cash.length, 1, 'cash ledger must contain exactly one movement linked to the invoice');
    assert.deepEqual(beforeReload.cash[0], {
      id: 'SALE-CASH-' + invoiceId, type: 'add', amount: 25,
      referenceType: 'sales_invoice', referenceId: invoiceId
    });
    assert.equal(beforeReload.stock.length, 1, 'stock ledger must contain exactly one movement linked to the invoice');
    assert.equal(beforeReload.stock[0].type, 'SALE_OUT');
    assert.equal(beforeReload.stock[0].qty, -1);
    assert.equal(beforeReload.stock[0].referenceType, 'sales_invoice');
    assert.equal(beforeReload.stock[0].referenceId, invoiceId);
    assert.equal(beforeReload.productStock, 9);
    assert.equal(beforeReload.caisseBalance, 100025);
    assert.ok(beforeReload.revision > revisionBeforePayment);

    // Fresh navigation validates hydration from persistence rather than the previous JS heap.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-view.active', { timeout: 15000 });
    await page.waitForFunction(() =>
      document.body && document.body.inert === false &&
      window.ANASResilientStorage?.ready() === true &&
      typeof AppData !== 'undefined' && Array.isArray(AppData.invoices),
      null, { timeout: 15000 }
    );
    assert.deepEqual(pageErrors, [], 'reload must not introduce uncaught browser errors');

    const afterReload = await readCommittedSale(page, invoiceId);
    assert.deepEqual(
      {
        invoiceCount: afterReload.invoiceCount, invoice: afterReload.invoice,
        cash: afterReload.cash, stock: afterReload.stock,
        productStock: afterReload.productStock, caisseBalance: afterReload.caisseBalance
      },
      {
        invoiceCount: beforeReload.invoiceCount, invoice: beforeReload.invoice,
        cash: beforeReload.cash, stock: beforeReload.stock,
        productStock: beforeReload.productStock, caisseBalance: beforeReload.caisseBalance
      },
      'invoice, cash ledger, stock ledger and balances must survive reload unchanged'
    );

    // Local return acceptance: use the real POS invoice created above and the actual drawer entry.
    const returnRevisionBefore = await page.evaluate(() => ANASResilientStorage.status().revision);
    await page.evaluate(() => openDrawer());
    await page.locator('.drawer-nav-row').filter({ hasText: 'ارجاع فاتورة مبيعات' }).click();
    await page.locator('#rev-invoice-select').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#rev-invoice-select').selectOption('0');
    await page.locator('#rev-items-body input[data-line-index="0"]').fill('1');
    await page.locator('#rev-reason-input').fill('اختبار مرتجع محلي من فاتورة POS');
    assert.equal(await page.locator('#rev-submit-btn').isEnabled(), true, 'local return must enable after a valid preview and reason');
    await page.locator('#rev-submit-btn').click();
    await page.waitForFunction(({ beforeRevision, id, productId }) => {
      const storage = window.ANASResilientStorage;
      const snapshot = storage && storage.getCommittedSnapshot();
      const product = snapshot && snapshot.products && snapshot.products.find(row => String(row.id) === productId);
      const returned = snapshot && Array.isArray(snapshot.returns) &&
        snapshot.returns.some(row => row && row.status === 'POSTED' && String(row.originalInvoiceId) === id);
      return storage && storage.ready() && storage.status().revision > beforeRevision &&
        !document.getElementById('modal-reverse-ledger')?.classList.contains('active') &&
        returned && product && product.stock === 10;
    }, { beforeRevision: returnRevisionBefore, id: invoiceId, productId: PRODUCT_ID }, { timeout: 15000 });
    const localReturnProof = await page.evaluate(({ id, productId }) => {
      const snapshot = ANASResilientStorage.getCommittedSnapshot();
      const document = snapshot.returns.find(row => row && row.status === 'POSTED' && String(row.originalInvoiceId) === id);
      const product = snapshot.products.find(row => String(row.id) === productId);
      return {
        returnId: document && document.returnId, returnStatus: document && document.status,
        productStock: product && product.stock, caisseBalance: snapshot.caisseBalance,
        saleReturnMovements: snapshot.stockMovements.filter(row => row && row.referenceType === 'sales_return' &&
          String(row.referenceId) === String(document && document.returnId)).length
      };
    }, { id: invoiceId, productId: PRODUCT_ID });
    assert.equal(localReturnProof.returnStatus, 'POSTED');
    assert.equal(localReturnProof.productStock, 10, 'sales return must restore the sold unit to inventory');
    assert.equal(localReturnProof.caisseBalance, 100000, 'cash refund must reverse the original receipt');
    assert.ok(localReturnProof.saleReturnMovements >= 1, 'local return must write a linked reverse stock movement');

    // Partial payment must collect only the entered amount and allocate the balance to the selected customer.
    await page.evaluate(() => openView('pos'));
    await page.locator('#quickProductsContainer button').filter({ hasText: PRODUCT_NAME }).click();
    await page.locator('#posCheckoutBtn').click();
    await page.locator('#hasibModal.active').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#hasibPaymentMethod').selectOption('partial');
    assert.equal(await page.locator('#hasibPaidAmount').inputValue(), '12.50');
    assert.equal(await page.locator('#hasibSummaryTotal').textContent(), '25.00 د.ج');
    assert.equal(await page.locator('#hasibSummaryPaid').textContent(), '12.50 د.ج');
    assert.equal(await page.locator('#hasibRemainingText').textContent(), '12.50 د.ج');
    await page.locator('#hasibPaidAmount').fill('7.50');
    assert.equal(await page.locator('#hasibPaymentMethod').inputValue(), 'partial');
    assert.equal(await page.locator('#hasibSummaryPaid').textContent(), '7.50 د.ج');
    assert.equal(await page.locator('#hasibRemainingText').textContent(), '17.50 د.ج');
    await page.locator('#hasibPaidAmount').fill('12.50');
    assert.equal(await page.locator('#hasibConfirmSaleBtn').isDisabled(), true,
      'partial payment must require a registered customer before confirmation');
    await page.locator('#hasibCustomerSelect').selectOption('STG-CUSTOMER-001');
    assert.equal(await page.locator('#hasibConfirmSaleBtn').isEnabled(), true);
    const partialRevision = await page.evaluate(() => ANASResilientStorage.status().revision);
    await page.locator('#hasibModal button[onclick="confirmHasibPaymentDurable()"]').click();
    await page.waitForFunction(beforeRevision => {
      const s = ANASResilientStorage.getCommittedSnapshot();
      return ANASResilientStorage.status().revision > beforeRevision &&
        s.invoices.some(row => row && row.paymentMethod === 'partial' && row.paid === 12.5 && row.remaining === 12.5);
    }, partialRevision, { timeout: 15000 });
    const partialProof = await page.evaluate(() => {
      const s = ANASResilientStorage.getCommittedSnapshot();
      const invoice = s.invoices.find(row => row && row.paymentMethod === 'partial');
      const customer = s.customers.find(row => String(row.id) === 'STG-CUSTOMER-001');
      const cash = s.cashMovements.filter(row => row && row.referenceType === 'sales_invoice' && String(row.referenceId) === String(invoice.id));
      return { paid: invoice.paid, remaining: invoice.remaining, customerDebt: customer.debt,
        cashRows: cash.length, cashAmount: cash[0] && cash[0].amount };
    });
    assert.deepEqual(partialProof, { paid: 12.5, remaining: 12.5, customerDebt: 12.5, cashRows: 1, cashAmount: 12.5 });

    // Full credit must create customer debt without adding cash to the cashbox.
    await page.evaluate(() => openView('pos'));
    await page.locator('#quickProductsContainer button').filter({ hasText: PRODUCT_NAME }).click();
    await page.locator('#posCheckoutBtn').click();
    await page.locator('#hasibPaymentMethod').selectOption('credit');
    assert.equal(await page.locator('#hasibPaidAmount').inputValue(), '0.00');
    assert.equal(await page.locator('#hasibSummaryPaid').textContent(), '0.00 د.ج');
    assert.equal(await page.locator('#hasibRemainingText').textContent(), '25.00 د.ج');
    assert.equal(await page.locator('#hasibConfirmSaleBtn').isDisabled(), true,
      'full credit must require a registered customer before confirmation');
    await page.locator('#hasibCustomerSelect').selectOption('STG-CUSTOMER-001');
    assert.equal(await page.locator('#hasibConfirmSaleBtn').isEnabled(), true);
    const creditRevision = await page.evaluate(() => ANASResilientStorage.status().revision);
    await page.locator('#hasibModal button[onclick="confirmHasibPaymentDurable()"]').click();
    await page.waitForFunction(beforeRevision => {
      const s = ANASResilientStorage.getCommittedSnapshot();
      return ANASResilientStorage.status().revision > beforeRevision &&
        s.invoices.some(row => row && row.paymentMethod === 'credit' && row.paid === 0 && row.remaining === 25);
    }, creditRevision, { timeout: 15000 });
    const creditProof = await page.evaluate(() => {
      const s = ANASResilientStorage.getCommittedSnapshot();
      const invoice = s.invoices.find(row => row && row.paymentMethod === 'credit');
      const customer = s.customers.find(row => String(row.id) === 'STG-CUSTOMER-001');
      const cash = s.cashMovements.filter(row => row && row.referenceType === 'sales_invoice' && String(row.referenceId) === String(invoice.id));
      return { paid: invoice.paid, remaining: invoice.remaining, customerDebt: customer.debt,
        cashRows: cash.length, cashBalance: s.caisseBalance };
    });
    assert.deepEqual(creditProof, { paid: 0, remaining: 25, customerDebt: 37.5, cashRows: 0, cashBalance: 100012.5 });

    // Driver advance acceptance with an empty cashbox must persist without a cash deduction.
    const beforeExpenseSetupRevision = await page.evaluate(() => ANASResilientStorage.status().revision);
    await page.evaluate(() => {
      AppData.caisseBalance = 0;
      if (saveDB() !== true) throw new Error('Could not persist zero-cashbox test fixture');
    });
    await page.waitForFunction(beforeRevision => {
      const storage = window.ANASResilientStorage;
      const snapshot = storage && storage.getCommittedSnapshot();
      return storage && storage.status().revision > beforeRevision && snapshot && snapshot.caisseBalance === 0;
    }, beforeExpenseSetupRevision, { timeout: 15000 });
    await page.evaluate(() => openView('expenses'));
    await page.locator('#expAccountInput').fill('مصاريف الطريق');
    await page.locator('#expDescInput').fill('مازوت');
    await page.locator('#expAmountInput').fill('2000');
    await page.locator('#expPaymentMethod').selectOption('driver_advance');
    const beforeExpenseRevision = await page.evaluate(() => ANASResilientStorage.status().revision);
    await page.locator('#view-expenses button[onclick="submitExpenseOperation()"]').click();
    await page.waitForFunction(beforeRevision => {
      const storage = window.ANASResilientStorage;
      const snapshot = storage && storage.getCommittedSnapshot();
      return storage && storage.status().revision > beforeRevision && snapshot &&
        snapshot.expenses.some(row => row && row.desc === 'مازوت' && row.amt === 2000 &&
          row.paymentMethod === 'driver_advance' && row.settlementStatus === 'pending');
    }, beforeExpenseRevision, { timeout: 15000 });
    const expenseProof = await page.evaluate(() => {
      const snapshot = ANASResilientStorage.getCommittedSnapshot();
      const row = snapshot.expenses.find(item => item && item.desc === 'مازوت');
      return { amount: row && row.amt, paymentMethod: row && row.paymentMethod,
        settlementStatus: row && row.settlementStatus, cashBalance: snapshot.caisseBalance };
    });
    assert.deepEqual(expenseProof, {
      amount: 2000, paymentMethod: 'driver_advance', settlementStatus: 'pending', cashBalance: 0
    });
    assert.ok(dialogMessages.some(message => message.includes('تم تسجيل المصروف بنجاح')));
    assert.ok(dialogMessages.every(message => !/يتطلب معرف فترة مفتوحة|طلب الترحيل الخادمي|بوابة ترحيل خادمية/.test(message)),
      'local return and expense flows must not require a server fiscal-period gate');

    const runtimeParity = await page.evaluate(() => ({
      invoices: AppData.invoices.length,
      cashMovements: AppData.cashMovements.filter(row => row && row.referenceType === 'sales_invoice').length,
      stockMovements: AppData.stockMovements.filter(row => row && row.referenceType === 'sales_invoice').length,
      cartLines: Array.isArray(posCart) ? posCart.length : -1,
      modalOpen: document.getElementById('hasibModal')?.classList.contains('active') === true
    }));
    assert.equal(runtimeParity.invoices, 3, 'cash, partial and credit invoices must each persist exactly once');
    assert.equal(runtimeParity.cashMovements, 2, 'cash and partial sales must each persist one receipt; credit must persist none');
    assert.equal(runtimeParity.stockMovements, 3, 'each committed sale must persist one stock movement');
    assert.equal(runtimeParity.cartLines, 0, 'committed cart must remain cleared after reload');
    assert.equal(runtimeParity.modalOpen, false, 'payment modal must remain closed after reload');

    // Purchase search uses the same name/barcode workflow as POS and previews the invoice total live.
    await page.evaluate(() => openView('purchases'));
    await page.locator('#purProductName').fill('STGPOSLIFE001');
    await page.locator('#purProductSearchResults .pos-search-result').first().waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#purProductSearchResults .pos-search-result').first().click();
    await page.locator('#purBuyQty').fill('2');
    await page.waitForFunction(() => Number(document.getElementById('purDraftTotalDisplay')?.dataset.totalCentimes) === 2000,
      null, { timeout: 5000 });
    const purchaseSearchProof = await page.evaluate(() => ({
      selectedId: document.getElementById('purProductId')?.value,
      selectedName: document.getElementById('purProductName')?.value,
      unitCost: Number(document.getElementById('purBuyCost')?.value),
      quantity: Number(document.getElementById('purBuyQty')?.value),
      totalCentimes: Number(document.getElementById('purDraftTotalDisplay')?.dataset.totalCentimes)
    }));
    assert.deepEqual(purchaseSearchProof, {
      selectedId: PRODUCT_ID, selectedName: PRODUCT_NAME, unitCost: 10, quantity: 2, totalCentimes: 2000
    }, 'barcode selection must bind the exact product and refresh the draft invoice total immediately');

    // Quick-add an absent product from the purchase search field without seeding stock.
    await page.locator('#purProductName').fill('صنف شراء سريع تجريبي');
    await page.locator('#purProductSearchResults .pos-search-quick-add').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#purProductSearchResults .pos-search-quick-add').click();
    await page.locator('#addProductModal.active').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#newProdNameInput').inputValue(), 'صنف شراء سريع تجريبي');
    assert.equal(await page.locator('#newProdStockInput').inputValue(), '0');
    const beforeQuickAddRevision = await page.evaluate(() => ANASResilientStorage.status().revision);
    await page.locator('#addProductModal button[onclick="saveNewProductFromModal()"]').click();
    await page.waitForFunction(beforeRevision => {
      const storage = window.ANASResilientStorage;
      const snapshot = storage && storage.getCommittedSnapshot();
      return storage && storage.status().revision > beforeRevision && snapshot &&
        snapshot.products.some(row => row && row.name === 'صنف شراء سريع تجريبي') &&
        document.getElementById('purProductId')?.value;
    }, beforeQuickAddRevision, { timeout: 15000 });
    const quickAddProof = await page.evaluate(() => {
      const snapshot = ANASResilientStorage.getCommittedSnapshot();
      const product = snapshot.products.find(row => row && row.name === 'صنف شراء سريع تجريبي');
      return { productId: product && String(product.id), productStock: product && product.stock,
        selectedId: document.getElementById('purProductId')?.value,
        selectedName: document.getElementById('purProductName')?.value };
    });
    assert.ok(quickAddProof.productId);
    assert.equal(quickAddProof.productStock, 0);
    assert.equal(quickAddProof.selectedId, quickAddProof.productId);
    assert.equal(quickAddProof.selectedName, 'صنف شراء سريع تجريبي');

    // Sales POS search also resolves barcodes and quick-creates absent catalogue items safely.
    await page.evaluate(() => openView('pos'));
    await page.locator('#posSearchField').fill('STGPOSLIFE001');
    await page.locator('#posSearchResults .pos-search-result').first().waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#posSearchResults .pos-search-result').first().click();
    const salesBarcodeProof = await page.evaluate(() => ({
      selected: posCart.some(row => String(row.id) === 'STG-POS-LIFECYCLE-001'),
      resultHidden: document.getElementById('posSearchResults')?.hidden
    }));
    assert.equal(salesBarcodeProof.selected, true, 'sales POS barcode search must add the exact product to the cart');
    assert.equal(salesBarcodeProof.resultHidden, true);

    await page.locator('#posSearchField').fill('صنف مبيعات سريع تجريبي POS-20261107-001');
    // Exercise the quick-add handler directly; popup visibility is covered by the POS search unit assertions.
    await page.evaluate(() => openQuickAddPosProduct());
    await page.locator('#addProductModal.active').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#newProdNameInput').inputValue(), 'صنف مبيعات سريع تجريبي POS-20261107-001');
    assert.equal(await page.locator('#newProdStockInput').inputValue(), '0');
    const beforePosQuickAddRevision = await page.evaluate(() => ANASResilientStorage.status().revision);
    await page.locator('#addProductModal button[onclick="saveNewProductFromModal()"]').click();
    await page.waitForFunction(beforeRevision => {
      const storage = window.ANASResilientStorage;
      const snapshot = storage && storage.getCommittedSnapshot();
      return storage && storage.status().revision > beforeRevision && snapshot &&
        snapshot.products.some(row => row && row.name === 'صنف مبيعات سريع تجريبي POS-20261107-001') &&
        document.getElementById('posSearchField')?.value === 'صنف مبيعات سريع تجريبي POS-20261107-001';
    }, beforePosQuickAddRevision, { timeout: 15000 });
    const salesQuickAddProof = await page.evaluate(() => {
      const snapshot = ANASResilientStorage.getCommittedSnapshot();
      const product = snapshot.products.find(row => row && row.name === 'صنف مبيعات سريع تجريبي POS-20261107-001');
      return { productStock: product && product.stock,
        visibleSearchResult: document.querySelectorAll('#posSearchResults .pos-search-result').length,
        cartContainsNewProduct: posCart.some(row => String(row.id) === String(product && product.id)) };
    });
    assert.equal(salesQuickAddProof.productStock, 0, 'quick-added sales catalogue items must not receive phantom stock');
    assert.ok(salesQuickAddProof.visibleSearchResult >= 1, 'new product must be immediately searchable in POS');
    assert.equal(salesQuickAddProof.cartContainsNewProduct, false, 'zero-stock product must not be added to a sale cart');

    console.log('POS_FULL_LIFECYCLE_CHROMIUM_REPORT ' + JSON.stringify({
      checkout: 'PASS', durableCommit: 'PASS', invoiceCashStockParity: 'PASS',
      reloadHydration: 'PASS', noDuplicatePosting: 'PASS', purchaseBarcodeSearch: 'PASS', purchaseQuickAdd: 'PASS', salesBarcodeSearch: 'PASS', salesQuickAdd: 'PASS', invoiceId,
      revisionBeforePayment, revisionAfterPayment: afterReload.revision, storageMode: afterReload.mode
    }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
