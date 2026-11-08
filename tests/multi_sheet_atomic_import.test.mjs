import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSafeMultiSheetImport } from '../pos/advanced-financial-engine.mjs';

function fixture() {
  return {
    sheetsDataMap: {
      'الموردون': [{ id: 'S-1', name: 'مورد الاختبار', phone: '0550000001', balance: '0' }],
      'المنتجات': [{ id: 'P-1', barcode: '111000', name: 'منتج الاختبار', stock: '4', price1: '25.00', buyPrice: '10.00', unit: 'قطعة' }],
      'العملاء': [{ id: 'C-1', name: 'عميل الاختبار', phone: '0550000002', debt: '0', credit_limit: '1000' }],
      'الفواتير': [{ id: 'INV-H-1', name: 'فاتورة INV-H-1', date: '2026-11-01', customerId: 'C-1', total: '50.00', paid: '20.00', remaining: '30.00' }]
    },
    targetBySheet: {
      'الموردون': 'suppliers', 'المنتجات': 'products',
      'العملاء': 'customers', 'الفواتير': 'invoices'
    },
    existingDB: {
      suppliers: [], products: [], customers: [], invoices: [],
      storeConfig: { name: 'ANAS ERP' }, cashMovements: [{ id: 'KEEP-CASH' }],
      stockMovements: [{ id: 'KEEP-STOCK' }]
    }
  };
}

test('multi-sheet import submits all four collections in one durable repository call and archives invoices only', async () => {
  const input = fixture();
  let calls = 0;
  const result = await executeSafeMultiSheetImport({
    ...input,
    repository: {
      async saveMultiSheetBatchSafe(batches, backupPayload) {
        calls++;
        const backup = JSON.parse(backupPayload);
        assert.equal(backup.snapshot.storeConfig.name, 'ANAS ERP');
        assert.equal(backup.snapshot.cashMovements[0].id, 'KEEP-CASH');
        for (const type of ['suppliers', 'products', 'customers', 'invoices']) {
          assert.equal(Array.isArray(batches[type].rows), true);
          assert.equal(batches[type].rows.length, 1);
        }
        assert.equal(batches.invoices.rows[0].financiallyPosted, false);
        assert.equal(batches.invoices.rows[0].status, 'imported_archive');
      }
    }
  });
  assert.equal(calls, 1, 'all entity collections must use one repository transaction boundary');
  assert.equal(result.durable, true);
  assert.equal(result.sheetCount, 4);
});

test('multi-sheet import reports a rollback when the single durable repository transaction fails', async () => {
  const input = fixture();
  await assert.rejects(() => executeSafeMultiSheetImport({
    ...input,
    repository: { async saveMultiSheetBatchSafe() { throw new Error('simulated durable transaction failure'); } }
  }), /SAFE_MULTI_SHEET_IMPORT_ROLLED_BACK/);
});

test('multi-sheet atomic apply rejects partial workbooks instead of silently preserving absent tabs', async () => {
  const existingDB = {
    suppliers: [{ id: 'S-KEEP', name: 'مورد قائم' }],
    products: [], customers: [], invoices: [{ id: 'INV-KEEP', importedHistorical: true }]
  };
  let calls = 0;
  await assert.rejects(() => executeSafeMultiSheetImport({
    sheetsDataMap: {
      'المنتجات': [{ id: 'P-ONLY', barcode: 'P-ONLY', name: 'منتج', stock: '1', price1: '10' }],
      'العملاء': [{ id: 'C-ONLY', name: 'عميل', phone: '0550000003', debt: '0' }]
    },
    targetBySheet: { 'المنتجات': 'products', 'العملاء': 'customers' },
    existingDB,
    repository: { async saveMultiSheetBatchSafe() { calls++; } }
  }), /MULTI_SHEET_REQUIRED_TYPES_MISSING/);
  assert.equal(calls, 0, 'a partial workbook must be rejected before the single atomic commit');
});
