'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const modulePath = path.join(process.cwd(), 'reverse-ledger/reverse-ledger.js');
const modalPath = path.join(process.cwd(), 'reverse-ledger/reverse-ledger-modal.js');

function salesState() {
  const customer = { id:'C-LOCAL-RET', name:'Customer', debt:20 };
  return {
    invoices:[{id:'INV-LOCAL-RET',status:'POSTED',customerId:'C-LOCAL-RET',customerObj:customer,total:30,paid:10,remaining:20,
      items:[{id:'P-LOCAL-RET',qty:3,price:10,total:30}],warehouse:'المخزن الرئيسي'}],
    purchases:[],
    products:[{id:'P-LOCAL-RET',name:'Tea',stock:0,buyPrice:10,price1:15,warehouseStock:{}}],
    customers:[customer], suppliers:[],
    cashMovements:[{id:'SALE-CASH-LOCAL',type:'add',amount:10,referenceType:'sales_invoice',referenceId:'INV-LOCAL-RET'}],
    stockMovements:[{id:'SALE-STOCK-LOCAL',productId:'P-LOCAL-RET',qty:-3,type:'SALE_OUT',
      referenceType:'sales_invoice',referenceId:'INV-LOCAL-RET',
      originalSaleQuantityMicroUnits:3000000,originalSaleCostCentimes:3000}],
    supplierMovements:[],clientMovements:[],settlementAllocations:[],returns:[],customerCreditMovements:[],
    caisseBalance:100,currentUser:{id:'U-LOCAL'}
  };
}
function purchaseState() {
  const supplier = { id:'SUP-LOCAL-RET', name:'Supplier', balance:20 };
  return {
    invoices:[],
    purchases:[{id:'PUR-LOCAL-RET',status:'POSTED',supplierId:'SUP-LOCAL-RET',supplier,total:30,paid:10,remaining:20,
      productId:'P-LOCAL-RET',qty:3,cost:10,warehouse:'المخزن الرئيسي'}],
    products:[{id:'P-LOCAL-RET',name:'Tea',stock:3,buyPrice:10,price1:15,warehouseStock:{}}],
    customers:[],suppliers:[supplier],
    cashMovements:[{id:'PUR-CASH-LOCAL',type:'subtract',amount:10,referenceType:'purchase_invoice',referenceId:'PUR-LOCAL-RET'}],
    stockMovements:[{id:'PUR-STOCK-LOCAL',productId:'P-LOCAL-RET',qty:3,type:'PURCHASE_IN',
      referenceType:'purchase_invoice',referenceId:'PUR-LOCAL-RET'}],
    supplierMovements:[{id:'SUP-PUR-LOCAL',supplierId:'SUP-LOCAL-RET',type:'purchase',amount:30,
      referenceType:'purchase_invoice',referenceId:'PUR-LOCAL-RET'}],
    clientMovements:[],settlementAllocations:[],returns:[],customerCreditMovements:[],
    caisseBalance:100,currentUser:{id:'U-LOCAL'}
  };
}

async function mountLocalReturnUi(page, initialState, saveBehavior) {
  await page.setContent('<!doctype html><html><body><main>local return acceptance</main></body></html>');
  await page.addScriptTag({ content:
    'let AppData = ' + JSON.stringify(initialState) + ';' +
    'window.__saveCalls=0; window.__persisted=null;' +
    'window.saveDBDurably=async function(){window.__saveCalls++;' + saveBehavior + '};'
  });
  await page.addScriptTag({ path: modulePath });
  await page.addScriptTag({ path: modalPath });
}

async function openAndFillReturn(page, promptName) {
  await page.evaluate(name => window[name](), promptName);
  await page.locator('#rev-invoice-select').selectOption('0');
  await page.locator('#modal-reverse-ledger input[data-line-index="0"]').fill('3');
  await page.locator('#rev-reason-input').fill('اختبار اعتماد محلي');
  await page.waitForFunction(() => !document.getElementById('rev-submit-btn').disabled);
}

test('Chromium posts sales and purchase returns through the local ledger and durable writer without a cloud period', async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage();
    await mountLocalReturnUi(page, salesState(), 'window.__persisted=JSON.stringify(AppData);return true;');
    const initialBridge = await page.evaluate(() => ({ lexicalData:!!AppData, windowAlias:typeof window.AppData }));
    assert.deepEqual(initialBridge, { lexicalData:true, windowAlias:'undefined' },
      'the modal must resolve the V42 lexical AppData binding, not require window.AppData');

    await openAndFillReturn(page, 'returnSalePrompt');
    await page.locator('#rev-submit-btn').click();
    await page.waitForFunction(() => !document.getElementById('modal-reverse-ledger').classList.contains('active'));
    const sale = await page.evaluate(() => ({
      stock:AppData.products[0].stock,
      customerDebt:AppData.customers[0].debt,
      returnStatus:AppData.returns[0]?.status,
      cash:AppData.caisseBalance,
      saves:window.__saveCalls,
      persisted:window.__persisted === JSON.stringify(AppData)
    }));
    assert.deepEqual(sale, {stock:3,customerDebt:0,returnStatus:'POSTED',cash:90,saves:1,persisted:true});

    await page.evaluate(purchaseJson => { AppData = JSON.parse(purchaseJson); window.__saveCalls=0; window.__persisted=null; }, JSON.stringify(purchaseState()));
    await openAndFillReturn(page, 'returnPurchasePrompt');
    await page.locator('#rev-submit-btn').click();
    await page.waitForFunction(() => !document.getElementById('modal-reverse-ledger').classList.contains('active'));
    const purchase = await page.evaluate(() => ({
      stock:AppData.products[0].stock,
      supplierBalance:AppData.suppliers[0].balance,
      returnStatus:AppData.returns[0]?.status,
      cash:AppData.caisseBalance,
      saves:window.__saveCalls,
      persisted:window.__persisted === JSON.stringify(AppData)
    }));
    assert.deepEqual(purchase, {stock:0,supplierBalance:0,returnStatus:'POSTED',cash:110,saves:1,persisted:true});
  } finally { await browser.close(); }
});


test('Chromium waits for local IndexedDB-backed AppData hydration before filling return invoices', async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><main>delayed local data</main></body></html>');
    await page.addScriptTag({ path: modulePath });
    await page.addScriptTag({ path: modalPath });
    await page.evaluate(() => window.returnSalePrompt());
    await page.waitForFunction(() =>
      document.getElementById('modal-reverse-ledger')?.classList.contains('active') &&
      /جارٍ تحميل فواتير هذا الجهاز/.test(document.getElementById('rev-eligibility-status')?.textContent || '')
    );
    await page.addScriptTag({ content: 'let AppData = ' + JSON.stringify(salesState()) + ';' });
    await page.waitForFunction(() => document.querySelectorAll('#rev-invoice-select option').length > 1);
    const result = await page.evaluate(() => ({
      options: document.querySelectorAll('#rev-invoice-select option').length,
      status: document.getElementById('rev-eligibility-status').textContent,
      buttonDisabled: document.getElementById('rev-submit-btn').disabled
    }));
    assert.ok(result.options > 1, 'local sales invoices must appear after IndexedDB hydration');
    assert.doesNotMatch(result.status, /بيانات التطبيق غير جاهزة/);
    assert.equal(result.buttonDisabled, true, 'posting remains disabled until an invoice and return reason are selected');
  } finally { await browser.close(); }
});

test('Chromium restores invoice, stock and balances when the awaited local durable save fails', async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage();
    const initial = salesState();
    await mountLocalReturnUi(page, initial,
      'if(window.__saveCalls===1)throw new Error("IndexedDB write rejected");window.__persisted=JSON.stringify(AppData);return true;');
    const before = JSON.stringify(initial);
    await openAndFillReturn(page, 'returnSalePrompt');
    await page.locator('#rev-submit-btn').click();
    await page.waitForFunction(() => window.__saveCalls >= 2);
    const result = await page.evaluate(() => ({
      state:JSON.stringify(AppData),
      persisted:window.__persisted,
      returns:AppData.returns.length,
      stock:AppData.products[0].stock,
      debt:AppData.customers[0].debt,
      buttonDisabled:document.getElementById('rev-submit-btn').disabled,
      status:document.getElementById('rev-eligibility-status').textContent
    }));
    assert.equal(result.state,before,'failed durable save must restore the full in-memory state');
    assert.equal(result.persisted,before,'rollback snapshot must be durably re-saved');
    assert.equal(result.returns,0);
    assert.equal(result.stock,0);
    assert.equal(result.debt,20);
    assert.equal(result.buttonDisabled,false);
    assert.match(result.status,/IndexedDB write rejected/);
  } finally { await browser.close(); }
});
