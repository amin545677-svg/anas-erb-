#!/usr/bin/env node
'use strict';

/**
 * Live, opt-in E2E verifier for the isolated ANAS ERP Firebase Staging console.
 * It never creates users, grants, periods, invoices, or financial fixtures.
 * A dedicated staging account and pre-seeded version-2 invoices are required.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const STAGING_PROJECT = 'anas-erp-staging-a25e1';
const REQUIRED_TYPES = ['SALE_RETURN', 'PURCHASE_RETURN', 'INVOICE_CANCEL'];
const required = (name) => {
  const value = process.env[name];
  if (!value || !String(value).trim()) throw new Error('Missing required environment variable: ' + name);
  return String(value).trim();
};
const stable = value => {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function scaledUnits(value, scale, label) {
  const raw = String(value ?? '').trim();
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(raw);
  if (!match) throw new Error(label + ' is not a non-negative decimal');
  const places = scale === 100n ? 2 : 6;
  if ((match[2] || '').length > places) throw new Error(label + ' exceeds permitted precision');
  return BigInt(match[1]) * scale + BigInt((match[2] || '').padEnd(places, '0') || '0');
}
function getPath(root, dotted) {
  return dotted.split('.').reduce((value, key) => value == null ? undefined : value[key], root);
}
function validateFixture(fixture) {
  if (!fixture || fixture.projectId !== STAGING_PROJECT || !Array.isArray(fixture.operations)) {
    throw new Error('Fixture must target ' + STAGING_PROJECT + ' and contain operations[].');
  }
  const types = new Set(fixture.operations.map(x => x?.request?.returnType));
  for (const type of REQUIRED_TYPES) if (!types.has(type)) throw new Error('Fixture is missing required operation type: ' + type);
  const saleReturn = fixture.operations.find(x => x?.request?.returnType === 'SALE_RETURN')?.request;
  const cancellation = fixture.operations.find(x => x?.request?.returnType === 'INVOICE_CANCEL')?.request;
  if (saleReturn?.invoiceId !== cancellation?.invoiceId ||
      saleReturn?.originalInvoiceType !== 'sales_invoice' ||
      cancellation?.originalInvoiceType !== 'sales_invoice' ||
      saleReturn?.invoiceId !== fixture.saleSettlement?.invoiceId) {
    throw new Error('SALE_RETURN, settlement allocation and INVOICE_CANCEL must target the same sales invoice.');
  }
  if (!fixture.saleSettlement || !fixture.saleSettlement.invoiceId || !fixture.saleSettlement.partyId ||
      !fixture.saleSettlement.sourceMovementId || !fixture.saleSettlement.sourceMovementType ||
      !fixture.saleSettlement.expectedPaidCentimes || !fixture.saleSettlement.expectedAllocatedCentimes ||
      !fixture.saleSettlement.periodId) {
    throw new Error('Fixture must provide an unpaid/part-paid invoice, a real receipt source, period ID and exact allocation centimes.');
  }
  if (!['customer_debt', 'sales_invoice'].includes(fixture.saleSettlement.sourceMovementType)) {
    throw new Error('Sale settlement sourceMovementType must be customer_debt or sales_invoice.');
  }
  for (const row of fixture.operations) {
    const r = row && row.request;
    if (!r || !r.operationId || !r.periodId || !r.invoiceId || !r.originalInvoiceType || !r.returnType || !r.reason) {
      throw new Error('Each operation requires a complete trusted callable request.');
    }
    if (r.returnType !== 'INVOICE_CANCEL' && (!Array.isArray(r.items) || !r.items.length)) {
      throw new Error('Return operations require explicit item quantities.');
    }
    if (r.returnType === 'INVOICE_CANCEL' && Object.prototype.hasOwnProperty.call(r, 'items')) {
      throw new Error('INVOICE_CANCEL must derive lines from the original invoice; omit items.');
    }
  }
  if (!Array.isArray(fixture.expectedFinancials) || !fixture.expectedFinancials.length) {
    throw new Error('Fixture must include expectedFinancials[] for exact centime/micro-unit checks.');
  }
}
function assertFinancials(snapshot, rows, label) {
  for (const row of rows) {
    const actual = getPath(snapshot, row.path);
    const scale = row.unit === 'centimes' ? 100n : row.unit === 'microUnits' ? 1000000n : null;
    if (!scale) throw new Error('Unsupported financial assertion unit: ' + row.unit);
    const actualUnits = scaledUnits(actual, scale, label + '.' + row.path);
    const expected = BigInt(row.expected);
    const delta = actualUnits - expected;
    if (delta !== 0n) throw new Error(label + ' mismatch at ' + row.path + ': delta=' + delta.toString() + ' ' + row.unit);
  }
}
async function verifyLiveStaging({ url, email, password, fixturePath, evidencePath }) {
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.hostname !== 'anas-erp-staging-a25e1.web.app') {
    throw new Error('Refusing non-Staging origin; expected https://anas-erp-staging-a25e1.web.app');
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  validateFixture(fixture);
  let browser;
  const evidence = {
    projectId: STAGING_PROJECT,
    origin: origin.origin,
    startedAt: new Date().toISOString(),
    operations: [],
    idempotency: [],
    backupRestore: null
  };
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const response = await page.goto(origin.href, { waitUntil: 'domcontentloaded' });
    if (!response || response.status() !== 200) throw new Error('Staging console did not return HTTP 200.');
    await page.locator('#email').waitFor();
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('#sign-in').click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.locator('#load-snapshot').click();
    await page.getByText('حالة القراءة: نجاح').waitFor();

    const initial = await page.evaluate(async () => {
      const app = firebase.app('anas-erp-reverse-ledger-staging');
      const user = firebase.auth(app).currentUser;
      if (!user) throw new Error('Staging authentication session is missing.');
      const doc = await firebase.firestore(app).collection('users').doc(user.uid)
        .collection('snapshots').doc('latest').get();
      if (!doc.exists || typeof doc.get('payload') !== 'string') throw new Error('Staging snapshot is missing.');
      return { uid: user.uid, payload: doc.get('payload') };
    });
    let state = JSON.parse(initial.payload);
    const settlement = fixture.saleSettlement;
    const invoice = (state.invoices || []).find(x => String(x.id) === String(settlement.invoiceId));
    if (!invoice) throw new Error('Pre-seeded sale invoice for allocation proof was not found.');
    const paid = scaledUnits(invoice.paid ?? 0, 100n, 'sale invoice paid');
    if (paid !== BigInt(settlement.expectedPaidCentimes)) throw new Error('Sale invoice paid amount does not match fixture centimes.');
    const sourceRows = (state.cashMovements || []).filter(row => row &&
      String(row.id ?? row.movementId) === String(settlement.sourceMovementId) &&
      row.referenceType === settlement.sourceMovementType &&
      (settlement.sourceMovementType !== 'customer_debt' || String(row.referenceId) === String(settlement.partyId)));
    if (sourceRows.length !== 1) throw new Error('Expected exactly one real customer receipt source movement.');
    const sourceAmount = scaledUnits(sourceRows[0].amountCentimes != null ? String(BigInt(sourceRows[0].amountCentimes) / 100n) + '.' + String(BigInt(sourceRows[0].amountCentimes) % 100n).padStart(2, '0') : sourceRows[0].amount ?? sourceRows[0].amt, 100n, 'receipt source amount');
    const priorSourceAllocated = (state.settlementAllocations || []).filter(row => row &&
      row.partyType === 'customer' && String(row.partyId) === String(settlement.partyId) &&
      row.sourceMovementType === settlement.sourceMovementType &&
      String(row.sourceMovementId) === String(settlement.sourceMovementId))
      .reduce((sum, row) => sum + BigInt(row.amountCentimes || 0), 0n);
    const expectedAllocation = BigInt(settlement.expectedAllocatedCentimes);
    if (priorSourceAllocated !== 0n) throw new Error('Staging E2E receipt source must start without pre-made settlement allocations.');
    if (sourceAmount !== expectedAllocation) throw new Error('Fixture allocation amount must equal the source movement remaining centimes exactly.');
    if (expectedAllocation <= 0n) throw new Error('Fixture allocation amount must be positive.');

    await page.locator('#settlement-allocation').click();
    await page.locator('#modal-settlement-allocation.active').waitFor({ state: 'visible' });
    await page.locator('#alloc-party-type').selectOption('customer');
    await page.locator('#alloc-party').selectOption(String(settlement.partyId));
    const sourceOption = await page.locator('#alloc-source').evaluate((select, sourceId) => {
      const option = [...select.options].find(row => row.textContent.includes(sourceId));
      return option ? option.value : null;
    }, String(settlement.sourceMovementId));
    if (sourceOption === null) throw new Error('Settlement modal did not list the real receipt source movement.');
    await page.locator('#alloc-source').selectOption(sourceOption);
    const invoiceNumber = String(invoice.invoiceNumber ?? invoice.number ?? invoice.code ?? invoice.id);
    const invoiceOption = await page.locator('#alloc-invoice').evaluate((select, number) => {
      const option = [...select.options].find(row => row.textContent.includes(number));
      return option ? option.value : null;
    }, invoiceNumber);
    if (invoiceOption === null) throw new Error('Settlement modal did not list the target invoice.');
    await page.locator('#alloc-invoice').selectOption(invoiceOption);
    const whole = expectedAllocation / 100n;
    const fraction = (expectedAllocation % 100n).toString().padStart(2, '0');
    await page.locator('#alloc-amount').fill(whole.toString() + '.' + fraction);
    await page.locator('#alloc-period-id').fill(String(settlement.periodId));
    await page.waitForFunction(() => { const button = document.getElementById('alloc-submit'); return button && !button.disabled; });
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#alloc-submit').click();
    await page.waitForFunction(details => (window.AppData?.settlementAllocations || []).some(row =>
      row && row.partyType === 'customer' && String(row.partyId) === details.partyId &&
      String(row.sourceMovementId) === details.sourceMovementId && String(row.invoiceId) === details.invoiceId &&
      BigInt(row.amountCentimes) === BigInt(details.amountCentimes)), {
        partyId: String(settlement.partyId), sourceMovementId: String(settlement.sourceMovementId),
        invoiceId: String(settlement.invoiceId), amountCentimes: expectedAllocation.toString()
      });
    await page.locator('#alloc-close').click();
    state = await page.evaluate(() => window.AppData);
    const allocationRows = (state.settlementAllocations || []).filter(row => row &&
      row.invoiceType === 'sales_invoice' && String(row.invoiceId) === String(settlement.invoiceId) &&
      String(row.partyId) === String(settlement.partyId) && row.partyType === 'customer' &&
      row.sourceMovementType === settlement.sourceMovementType);
    const allocated = allocationRows.reduce((sum, row) => sum + BigInt(row.amountCentimes || 0), 0n);
    if (allocated !== expectedAllocation) throw new Error('Server-posted settlement allocation total differs from the exact fixture centimes.');
    evidence.saleSettlement = {
      invoiceId: String(invoice.id), partyId: String(settlement.partyId), sourceMovementId: String(settlement.sourceMovementId),
      paidCentimes: paid.toString(), allocatedCentimes: allocated.toString(), allocationRows: allocationRows.length,
      allocationPostedThroughModal: true, partialReturnValidated: true, fullCancellationTargetsSameInvoice: true
    };
    const saleReturnRequest = fixture.operations.find(x => x.request.returnType === 'SALE_RETURN').request;
    for (const line of saleReturnRequest.items) {
      const sourceLine = (invoice.items || []).find(item =>
        String(item.productId ?? item.id ?? item.product?.id ?? '') === String(line.productId));
      if (!sourceLine) throw new Error('Partial return product is absent from the allocated sales invoice: ' + line.productId);
      const originalQuantity = scaledUnits(sourceLine.qty ?? sourceLine.quantity, 1000000n, 'original invoice quantity');
      const requestedQuantity = scaledUnits(line.quantity, 1000000n, 'partial return quantity');
      if (requestedQuantity <= 0n || requestedQuantity >= originalQuantity) {
        throw new Error('SALE_RETURN must be strictly partial for product ' + line.productId);
      }
    }
    evidence.saleSettlement = {
      invoiceId: String(invoice.id),
      paidCentimes: paid.toString(),
      allocatedCentimes: allocated.toString(),
      allocationRows: allocationRows.length,
      partialReturnValidated: true,
      fullCancellationTargetsSameInvoice: true
    };

    await page.evaluate(() => {
      const gateway = window.ANASReverseLedgerServer;
      if (!gateway || typeof gateway.execute !== 'function') throw new Error('Trusted staging gateway is unavailable.');
      window.__anasE2EOriginalExecute = gateway.execute.bind(gateway);
      window.__anasE2ELastRequest = null;
      window.__anasE2ELastResult = null;
      window.ANASReverseLedgerServer = Object.freeze({
        ...gateway,
        execute: async request => {
          const operationId = window.__anasE2ENextOperationId;
          if (!operationId) throw new Error('E2E operation ID was not armed.');
          const actualRequest = { ...request, operationId };
          window.__anasE2ELastRequest = structuredClone(actualRequest);
          const result = await window.__anasE2EOriginalExecute(actualRequest);
          window.__anasE2ELastResult = result;
          return result;
        }
      });
    });

    for (const row of fixture.operations) {
      const request = row.request;
      const modeButton = request.returnType === 'SALE_RETURN' ? '#sale-return' :
        request.returnType === 'PURCHASE_RETURN' ? '#purchase-return' : '#invoice-cancel';
      await page.locator(modeButton).click();
      await page.locator('#modal-reverse-ledger.active').waitFor({ state: 'visible' });
      const invoiceOption = await page.locator('#rev-invoice-select').evaluate((select, details) => {
        const collection = details.originalInvoiceType === 'sales_invoice' ? window.AppData?.invoices : window.AppData?.purchases;
        const invoice = (Array.isArray(collection) ? collection : []).find(row => String(row?.id) === String(details.invoiceId));
        if (!invoice) return null;
        const displayNumber = String(invoice.invoiceNumber ?? invoice.number ?? invoice.code ?? invoice.id);
        const expectedPrefix = details.requestType === 'INVOICE_CANCEL'
          ? (details.originalInvoiceType === 'sales_invoice' ? 'مبيعات — ' : 'مشتريات — ')
          : '';
        const match = [...select.options].find(option =>
          option.textContent.includes(displayNumber) && (!expectedPrefix || option.textContent.startsWith(expectedPrefix)));
        return match ? match.value : null;
      }, { invoiceId: request.invoiceId, requestType: request.returnType, originalInvoiceType: request.originalInvoiceType });
      if (invoiceOption === null) throw new Error('Reverse modal did not list fixture invoice ' + request.invoiceId);
      await page.locator('#rev-invoice-select').selectOption(invoiceOption);
      if (request.returnType !== 'INVOICE_CANCEL') {
        for (const item of request.items) {
          const selector = '#rev-items-body input[aria-label="' + 'كمية الإرجاع للصنف ' + item.productId + '"]';
          await page.locator(selector).fill(String(item.quantity));
        }
      }
      await page.locator('#rev-period-id').fill(request.periodId);
      await page.locator('#rev-reason-input').fill(request.reason);
      await page.locator('#rev-excess-mode').selectOption(request.settlementMode);
      await page.evaluate(operationId => { window.__anasE2ENextOperationId = operationId; }, request.operationId);
      await page.waitForFunction(() => {
        const button = document.getElementById('rev-submit-btn');
        return button && !button.disabled;
      });
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#rev-submit-btn').click();
      await page.waitForFunction(() => {
        const modal = document.getElementById('modal-reverse-ledger');
        return modal && !modal.classList.contains('active') &&
          document.getElementById('rev-eligibility-status')?.textContent.includes('أكد الخادم نجاح الترحيل');
      });
      const captured = await page.evaluate(() => ({
        request: window.__anasE2ELastRequest,
        result: window.__anasE2ELastResult
      }));
      const actual = captured.request;
      const posted = captured.result;
      if (!actual || !posted || posted.ok !== true || posted.document?.status !== 'POSTED' ||
          posted.operationId !== request.operationId || actual.invoiceId !== request.invoiceId ||
          actual.returnType !== request.returnType) {
        throw new Error('Modal-to-callable path did not confirm POSTED for ' + request.operationId);
      }
      if (stable({ ...actual, operationId: request.operationId }) !== stable(request)) {
        throw new Error('Reverse modal submitted a payload different from the approved E2E fixture for ' + request.operationId);
      }
      const [replayA, replayB] = await page.evaluate(async req => {
        const gateway = window.ANASReverseLedgerServer;
        return await Promise.all([gateway.execute(req), gateway.execute(req)]);
      }, actual);
      if (stable(replayA) !== stable(posted) || stable(replayB) !== stable(posted)) {
        throw new Error('Concurrent duplicate replay returned a different result for ' + request.operationId);
      }
      const mismatch = { ...actual, reason: request.reason + ' [different-payload]' };
      const mismatchResult = await page.evaluate(async req => {
        try { await window.ANASReverseLedgerServer.execute(req); return { rejected: false }; }
        catch (error) { return { rejected: true, code: String(error.code || ''), message: String(error.message || '') }; }
      }, mismatch);
      if (!mismatchResult.rejected || !/already-exists/.test(mismatchResult.code + ' ' + mismatchResult.message)) {
        throw new Error('Different payload reuse was not rejected as already-exists for ' + request.operationId);
      }
      evidence.operations.push({
        operationId: request.operationId,
        type: request.returnType,
        status: posted.document.status,
        returnId: posted.document.returnId
      });
      evidence.idempotency.push({
        operationId: request.operationId,
        sequentialReplay: 'same-result',
        concurrentReplayCount: 2,
        mismatchedPayload: 'already-exists'
      });
    }

    const beforeBackup = await page.evaluate(async () => {
      const app = firebase.app('anas-erp-reverse-ledger-staging');
      const uid = firebase.auth(app).currentUser.uid;
      const doc = await firebase.firestore(app).collection('users').doc(uid)
        .collection('snapshots').doc('latest').get();
      return doc.get('payload');
    });
    state = JSON.parse(beforeBackup);
    assertFinancials(state, fixture.expectedFinancials, 'before-backup');
    const beforeHash = sha256(beforeBackup);
    await page.locator('#create-backup').click();
    await page.getByText(/تم إنشاء النسخة الموثوقة/).waitFor();
    const backupId = await page.locator('#created-backup-id').inputValue();
    if (!/^BKP-[A-Za-z0-9-]{12,100}$/.test(backupId)) throw new Error('Trusted backup ID is malformed.');
    await page.locator('#restore-backup').click();
    await page.getByText(/اكتملت الاستعادة والتحقق/).waitFor();
    const afterRestore = await page.evaluate(async () => {
      const app = firebase.app('anas-erp-reverse-ledger-staging');
      const uid = firebase.auth(app).currentUser.uid;
      const doc = await firebase.firestore(app).collection('users').doc(uid)
        .collection('snapshots').doc('latest').get();
      return doc.get('payload');
    });
    const afterHash = sha256(afterRestore);
    if (beforeHash !== afterHash) throw new Error('Snapshot payload changed during same-state backup/restore.');
    assertFinancials(JSON.parse(afterRestore), fixture.expectedFinancials, 'after-restore');
    evidence.backupRestore = { backupId, beforeSnapshotSha256: beforeHash, afterSnapshotSha256: afterHash, exactMatch: true, centimeDelta: '0', microUnitDelta: '0' };
    if (pageErrors.length) throw new Error('Browser page errors: ' + pageErrors.join(' | '));
    evidence.result = 'PASS';
    evidence.completedAt = new Date().toISOString();
    if (evidencePath) fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    return evidence;
  } finally {
    if (browser) await browser.close();
  }
}

export { verifyLiveStaging, validateFixture, assertFinancials };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const evidence = await verifyLiveStaging({
    url: required('ANAS_STAGING_URL'),
    email: required('ANAS_STAGING_EMAIL'),
    password: required('ANAS_STAGING_PASSWORD'),
    fixturePath: required('ANAS_STAGING_E2E_FIXTURE'),
    evidencePath: process.env.ANAS_STAGING_EVIDENCE_PATH || ''
  });
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
}
