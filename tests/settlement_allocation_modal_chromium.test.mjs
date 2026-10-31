import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('settlement allocation modal uses the callable, rejects safely, and reloads only server-posted state', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><head></head><body></body></html>');
    await page.addScriptTag({ path: path.join(root, 'reverse-ledger/reverse-ledger.js') });
    await page.evaluate(() => {
      window.AppData = {
        customers: [{ id: 'C1', name: 'Customer', debt: 50, ledgerVersion: 2 }],
        suppliers: [],
        invoices: [{ id: 'I1', customerId: 'C1', total: 100, paid: 50, remaining: 50, items: [] }],
        purchases: [], products: [],
        cashMovements: [{ id: 'M1', type: 'add', amount: 50, referenceType: 'customer_debt', referenceId: 'C1' }],
        supplierMovements: [], clientMovements: [], settlementAllocations: [], returns: [],
        caisseBalance: 50
      };
      window.localWrites = 0;
      window.alert = () => {};
      window.saveDB = () => { window.localWrites++; return true; };
      window.failNext = true;
      window.ANASSettlementAllocationServer = {
        execute: async request => {
          if (window.failNext) { window.failNext = false; throw new Error('server rejected'); }
          window.received = request;
          window.posted = {
            allocationId: 'A1', partyType: 'customer', partyId: 'C1',
            invoiceType: 'sales_invoice', invoiceId: 'I1',
            sourceMovementId: 'M1', sourceMovementType: 'customer_debt',
            amountCentimes: 5000, createdAt: '2026-10-31T12:00:00.000Z', ledgerVersion: 2
          };
          return { ok: true, status: 'POSTED', operationId: request.operationId, allocations: [window.posted] };
        }
      };
      window.ANASReloadStagingSnapshot = async () => {
        AppData.settlementAllocations = [...AppData.settlementAllocations, window.posted];
      };
    });
    await page.addScriptTag({ path: path.join(root, 'reverse-ledger/settlement-allocation-modal.js') });
    await page.evaluate(() => {
      window.openSettlementAllocationModal();
      document.getElementById('alloc-party').value = 'C1';
      document.getElementById('alloc-party').dispatchEvent(new Event('change'));
      document.getElementById('alloc-source').value = '0';
      document.getElementById('alloc-source').dispatchEvent(new Event('change'));
      document.getElementById('alloc-invoice').value = '0';
      document.getElementById('alloc-invoice').dispatchEvent(new Event('change'));
      document.getElementById('alloc-amount').value = '50.00';
      document.getElementById('alloc-amount').dispatchEvent(new Event('input'));
      document.getElementById('alloc-period-id').value = 'FY-2026-10';
    });
    await page.click('#alloc-submit');
    await page.waitForFunction(() => document.getElementById('alloc-status').textContent.includes('server rejected'));
    assert.equal(await page.evaluate(() => AppData.settlementAllocations.length), 0);
    assert.equal(await page.evaluate(() => window.localWrites), 0);
    await page.click('#alloc-submit');
    await page.waitForFunction(() => AppData.settlementAllocations.length === 1);
    const result = await page.evaluate(() => ({
      count: AppData.settlementAllocations.length,
      amount: AppData.settlementAllocations[0].amountCentimes,
      paid: AppData.invoices[0].paid,
      remaining: AppData.invoices[0].remaining,
      localWrites: window.localWrites,
      periodId: window.received.periodId,
      submittedAmount: window.received.allocations[0].amountCentimes
    }));
    assert.deepEqual(result, {
      count: 1, amount: 5000, paid: 50, remaining: 50,
      localWrites: 0, periodId: 'FY-2026-10', submittedAmount: 5000
    });
  } finally {
    await browser.close();
  }
});
