'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const { chromium } = require('playwright');
const functionsRequire = createRequire(require.resolve('../functions/package.json'));
const { initializeApp, deleteApp } = functionsRequire('firebase-admin/app');
const { getFirestore, FieldValue } = functionsRequire('firebase-admin/firestore');
const ReverseLedger = require('../functions/lib/reverse-ledger.js');
const { createSettlementAllocationHandler } = require('../functions/settlement-allocation-service.js');
const { createReverseLedgerHandler } = require('../functions/reverse-ledger-service.js');
const { authorizePreparedReverseOperation } = require('../functions/reverse-ledger-adapter.js');

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-anas-erp';
const UID = 'emu-dom-bridge-' + crypto.randomUUID();
const PERIOD = 'FY-2026-10';
const app = initializeApp({ projectId: PROJECT_ID }, 'anas-dom-bridge-' + crypto.randomUUID());
const db = getFirestore(app);

class EmulatorHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const token = {
  aud: PROJECT_ID,
  iss: 'https://securetoken.google.com/' + PROJECT_ID,
  auth_time: 1793400000,
  iat: 1793400100,
  exp: 1793403700
};
const getUser = async uid => ({ uid, disabled: false, displayName: 'ANAS Staging E2E Operator' });
const settlementHandler = createSettlementAllocationHandler({
  db, getUser, FieldValue, HttpsError: EmulatorHttpsError, ReverseLedger,
  now: () => 1793400200000
});
const reverseHandler = createReverseLedgerHandler({
  db, getUser, FieldValue, HttpsError: EmulatorHttpsError, ReverseLedger,
  authorizePreparedReverseOperation, projectId: PROJECT_ID,
  now: () => 1793400200000
});

function fixtureState() {
  const state = {
    invoices: [{
      id: 'INV-DOM-1', invoiceNumber: 'DOM-INV-1', invoiceLedgerVersion: 2,
      customerId: 'C-DOM-1', customerObj: { id: 'C-DOM-1', name: 'DOM customer' },
      total: '100.00', paid: '50.00', remaining: '50.00', discount: '0.00',
      items: [{ id: 'P-DOM-1', productId: 'P-DOM-1', name: 'DOM product', qty: 2, price: '50.00' }],
      warehouse: 'المخزن الرئيسي', tenantId: 'TENANT_DEFAULT', storeId: 'STORE_DEFAULT'
    }],
    purchases: [],
    products: [{ id: 'P-DOM-1', name: 'DOM product', stock: 0, buyPrice: '10.00' }],
    customers: [{ id: 'C-DOM-1', name: 'DOM customer', debt: '100.00', ledgerVersion: 2 }],
    suppliers: [],
    cashMovements: [{
      id: 'CASH-DOM-1', type: 'add', amount: '50.00',
      referenceType: 'sales_invoice', referenceId: 'INV-DOM-1'
    }],
    supplierMovements: [],
    clientMovements: [],
    settlementAllocations: [],
    returns: [],
    stockMovements: [{
      id: 'SM-DOM-1', productId: 'P-DOM-1', qty: -2,
      type: 'SALE_OUT', referenceType: 'sales_invoice', referenceId: 'INV-DOM-1',
      originalSaleQuantityMicroUnits: 2000000,
      originalSaleCostCentimes: 2000
    }],
    customerCreditMovements: [],
    caisseBalance: '100.00',
    currentUser: { id: UID, name: 'ANAS Staging E2E Operator' }
  };
  state.clientMovements.push(ReverseLedger.sealClientMovement(state, {
    movementId: 'CL-INVOICE-DOM-1', clientId: 'C-DOM-1',
    type: 'invoice_debit', amountCentimes: 10000, direction: 'debit',
    referenceType: 'sales_invoice', referenceId: 'INV-DOM-1',
    createdAt: '2026-10-31T10:00:00.000Z'
  }));
  state.customers[0].debt = '50.00';
  state.clientMovements.push(ReverseLedger.sealClientMovement(state, {
    movementId: 'CL-RECEIPT-DOM-1', clientId: 'C-DOM-1',
    type: 'receipt', amountCentimes: 5000, direction: 'credit',
    referenceType: 'customer_debt', referenceId: 'C-DOM-1',
    createdAt: '2026-10-31T10:05:00.000Z'
  }));
  ReverseLedger.validateReverseLedgerParity(state);
  return state;
}

async function main() {
  const userRef = db.collection('users').doc(UID);
  const operationIds = [];
  let bridgeFailure = null;
  let browser;
  let server;
  try {
    const initial = fixtureState();
    await userRef.collection('snapshots').doc('latest').set({
      payload: JSON.stringify(initial), createdAt: FieldValue.serverTimestamp()
    });
    await db.collection('reverseLedgerGrants').doc(UID).set({
      uid: UID, active: true, status: 'ACTIVE', schemaVersion: 1,
      tenantId: 'TENANT_DEFAULT', storeIds: ['STORE_DEFAULT'],
      permissions: ['settlement_allocation_post', 'reverse_sale_return']
    });
    await db.collection('financialPeriods').doc(PERIOD).set({
      periodId: PERIOD, status: 'OPEN'
    });

    server = http.createServer((req, res) => {
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
      catch (_) { res.writeHead(400); res.end('Bad request'); return; }
      const target = path.resolve(__dirname, '..', '.' + pathname);
      const root = path.resolve(__dirname, '..');
      if (target !== root && !target.startsWith(root + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      fs.stat(target, (error, stat) => {
        if (error || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(target);
        const types = {
          '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
          '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
          '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
          '.woff2': 'font/woff2'
        };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
        fs.createReadStream(target).pipe(res);
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.exposeFunction('__anasExecuteSettlementAllocation', async data => {
      try {
        const result = await settlementHandler({
          auth: { uid: UID, token }, app: { appId: 'anas-dom-emulator-app' }, data
        });
        if (result && result.operationId) operationIds.push(result.operationId);
        return result;
      } catch (error) {
        bridgeFailure = String(error && error.message || error);
        throw error;
      }
    });
    await page.exposeFunction('__anasExecuteReverseLedger', async data => {
      try {
        const result = await reverseHandler({
          auth: { uid: UID, token }, app: { appId: 'anas-dom-emulator-app' }, data
        });
        if (result && result.operationId) operationIds.push(result.operationId);
        return result;
      } catch (error) {
        bridgeFailure = String(error && error.message || error);
        throw error;
      }
    });
    await page.exposeFunction('__anasBridgeState', () => ({
      operationIds: [...operationIds], failure: bridgeFailure
    }));
    await page.exposeFunction('__anasReadCloudSnapshot', async () => {
      const snap = await userRef.collection('snapshots').doc('latest').get();
      assert.equal(snap.exists, true, 'Firestore snapshot must exist');
      return JSON.parse(snap.get('payload'));
    });

    const indexUrl = 'http://127.0.0.1:' + address.port + '/index.html';
    await page.goto(indexUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() =>
      !!window.ANASSettlementAllocationModal && !!window.ANASReverseLedgerModal,
      { timeout: 30000 }
    );
    await page.evaluate(() => {
      window.alert = () => {};
      window.ANASSettlementAllocationServer = {
        execute: request => window.__anasExecuteSettlementAllocation(request)
      };
      window.ANASReverseLedgerServer = {
        execute: request => window.__anasExecuteReverseLedger(request)
      };
      window.ANASReloadStagingSnapshot = async () => {
        window.AppData = await window.__anasReadCloudSnapshot();
        return window.AppData;
      };
    });
    await page.evaluate(state => { window.AppData = state; }, initial);

    // Drive the actual V42 settlement-allocation modal through its visible DOM.
    await page.evaluate(() => window.ANASSettlementAllocationModal.open());
    await page.waitForSelector('#modal-settlement-allocation.active');
    await page.selectOption('#alloc-party', 'C-DOM-1');
    await page.selectOption('#alloc-source', '0');
    await page.selectOption('#alloc-invoice', '0');
    await page.fill('#alloc-period-id', PERIOD);
    await page.fill('#alloc-amount', '50.00');
    await page.waitForFunction(() => document.querySelector('#alloc-submit')?.disabled === false);
    await page.click('#alloc-submit');
    await page.waitForFunction(async () => {
      const state = await window.__anasBridgeState();
      return state.operationIds.length === 1 || Boolean(state.failure);
    }, { timeout: 30000 });
    assert.equal(bridgeFailure, null, 'settlement service rejected the DOM request: ' + bridgeFailure);
    const allocationStatus = await page.locator('#alloc-status').textContent();
    assert.doesNotMatch(allocationStatus, /فشل|خطأ/, 'DOM must not show an allocation error');
    const allocationSnapshot = await page.evaluate(() => window.__anasReadCloudSnapshot());
    assert.equal(allocationSnapshot.settlementAllocations.length, 1);
    assert.equal(allocationSnapshot.settlementAllocations[0].amountCentimes, 5000);
    assert.equal(allocationSnapshot.settlementAllocations[0].ledgerVersion, 2);
    assert.equal(operationIds.length, 1, 'settlement gateway must return its operation ID');
    const allocationOperation = await db.collection('reverseLedgerOperations').doc(operationIds[0]).get();
    assert.equal(allocationOperation.get('status'), 'POSTED');
    assert.equal(allocationOperation.get('operationType'), 'SETTLEMENT_ALLOCATION');

    // Drive the real partial-sale-return modal and its visible submit control.
    await page.evaluate(() => window.ANASReverseLedgerModal.open('SALE_RETURN'));
    await page.waitForSelector('#modal-reverse-ledger.active');
    await page.selectOption('#rev-invoice-select', '0');
    await page.fill('#rev-period-id', PERIOD);
    await page.fill('#rev-reason-input', 'Staging partial sale return');
    await page.locator('#rev-items-body input[data-line-index="0"]').fill('1');
    try {
      await page.waitForFunction(() => document.querySelector('#rev-submit-btn')?.disabled === false, { timeout: 30000 });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        buttonDisabled: document.querySelector('#rev-submit-btn')?.disabled,
        status: document.querySelector('#rev-eligibility-status')?.textContent,
        previewTotal: document.querySelector('#rev-preview-total')?.textContent,
        invoiceValue: document.querySelector('#rev-invoice-select')?.value,
        itemQuantity: document.querySelector('#rev-items-body input[data-line-index="0"]')?.value,
        customerDebt: window.AppData?.customers?.find(row => row.id === 'C-DOM-1')?.debt,
        allocations: window.AppData?.settlementAllocations?.length,
        stock: window.AppData?.products?.find(row => row.id === 'P-DOM-1')?.stock
      }));
      throw new Error('reverse preview did not enable posting: ' + JSON.stringify(diagnostic) + '; ' + error.message);
    }
    await page.click('#rev-submit-btn');
    try {
      await page.waitForFunction(async () => {
        const state = await window.__anasBridgeState();
        return state.operationIds.length === 2 || Boolean(state.failure);
      }, { timeout: 30000 });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        gatewayType: typeof window.ANASReverseLedgerServer?.execute,
        buttonDisabled: document.querySelector('#rev-submit-btn')?.disabled,
        buttonText: document.querySelector('#rev-submit-btn')?.textContent,
        status: document.querySelector('#rev-eligibility-status')?.textContent,
        previewTotal: document.querySelector('#rev-preview-total')?.textContent,
        invoiceValue: document.querySelector('#rev-invoice-select')?.value
      }));
      throw new Error('reverse DOM bridge timed out: ' + JSON.stringify({
        diagnostic, bridgeFailure, operationIds
      }) + '; ' + error.message);
    }
    assert.equal(bridgeFailure, null, 'reverse service rejected the DOM request: ' + bridgeFailure);
    const reverseModalState = await page.evaluate(() => ({
      active: document.querySelector('#modal-reverse-ledger')?.classList.contains('active'),
      status: document.querySelector('#rev-eligibility-status')?.textContent,
      buttonText: document.querySelector('#rev-submit-btn')?.textContent,
      buttonDisabled: document.querySelector('#rev-submit-btn')?.disabled
    }));
    assert.equal(reverseModalState.active, false,
      'reverse modal must close only after server confirms POSTED: ' + JSON.stringify(reverseModalState));

    const finalSnapshot = await page.evaluate(() => window.__anasReadCloudSnapshot());
    const finalState = await userRef.collection('snapshots').doc('latest').get();
    assert.equal(finalState.exists, true);
    assert.equal(finalSnapshot.returns.length, 1);
    assert.equal(finalSnapshot.returns[0].status, 'POSTED');
    const postedReturn = finalSnapshot.returns[0];
    assert.equal(postedReturn.items[0].quantityMicroUnits, 1000000);
    assert.equal(operationIds.length, 2, 'reverse gateway must return its operation ID');
    const postedOperation = await db.collection('reverseLedgerOperations').doc(operationIds[1]).get();
    assert.equal(postedOperation.get('status'), 'POSTED');
    assert.equal(postedOperation.get('operationType'), 'SALE_RETURN');

    const customer = finalSnapshot.customers.find(row => row.id === 'C-DOM-1');
    const ledgerNet = finalSnapshot.clientMovements
      .filter(row => row.clientId === 'C-DOM-1')
      .reduce((sum, row) => sum + (row.direction === 'debit' ? BigInt(row.amountCentimes) : -BigInt(row.amountCentimes)), 0n);
    const balanceCentimes = BigInt(Math.round(Number(customer.debt) * 100));
    const centimeDelta = (balanceCentimes - ledgerNet).toString();
    assert.equal(centimeDelta, '0', 'customer balance and sealed ledger must reconcile to zero centimes');
    assert.equal(pageErrors.length, 0, 'Chromium page must not emit uncaught JavaScript errors: ' + pageErrors.join(' | '));
    assert.equal(finalSnapshot.settlementAllocations[0].amountCentimes, 5000);
    assert.equal(finalSnapshot.returns.length, 1);
    ReverseLedger.validateReverseLedgerParity(finalSnapshot);
    process.stdout.write('ANAS_EXPOSE_FUNCTION_FIRESTORE_DOM_E2E ' + JSON.stringify({
      allocation: 'POSTED', allocationCentimes: 5000,
      partialSaleReturn: 'POSTED', returnedMicroUnits: 1000000,
      centimeDelta, firestoreReadBack: true, pageExposeFunction: true
    }) + '\n');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise(resolve => server.close(resolve));
    await db.recursiveDelete(userRef).catch(() => {});
    await db.collection('reverseLedgerGrants').doc(UID).delete().catch(() => {});
    await db.collection('financialPeriods').doc(PERIOD).delete().catch(() => {});
    for (const id of operationIds) await db.collection('reverseLedgerOperations').doc(id).delete().catch(() => {});
    await deleteApp(app).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write((error && error.stack) || String(error));
  process.exitCode = 1;
});
