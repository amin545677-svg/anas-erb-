import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('local product import auto-detects headers and persists a verified IndexedDB snapshot before upsert', async () => {
  const html = await readFile('index.html', 'utf8');
  const start = html.indexOf('function showSmartImportPreview(fileName,rows)');
  const end = html.indexOf('function clearAllSalesInvoices()', start);
  assert.ok(start >= 0 && end > start, 'smart import preview function must exist');
  const preview = html.slice(start, end);
  assert.ok(preview.includes("box.querySelector('#smartImportAiAnalyze').click()"),
    'local header analysis must run automatically when the preview opens');
  assert.ok(preview.includes("price1:['سعر البيع','سعر البيع 1','سعرالبيع1'"),
    'the Lumina workbook sale-price heading must be recognized');
  assert.ok(preview.includes("minStock:['الحد الأدنى','حد الطلب','minstock','minimumstock']"),
    'minimum-stock heading must be recognized');
  assert.ok(preview.includes("box.querySelector('#smartImportBackupAck').checked=true"),
    'local backup option must be enabled by default');
  assert.ok(!preview.includes("if(!box.querySelector('#smartImportBackupAck').checked)"),
    'the automatically verified IndexedDB backup must not require a manual checkbox gate');
  assert.ok(!preview.includes("if(!confirm('فحص الملف نجح"),
    'the primary preview confirmation must not be followed by a second native confirm dialog');
  assert.ok(preview.includes("await saveDBDurably();"),
    'the single confirmation path must await durable IndexedDB persistence');
  assert.ok(preview.includes("indexedDB.open('anas_erp_v42_resilient_db',1)"),
    'the backup must be persisted in the application IndexedDB database');
  assert.ok(preview.includes("tx.objectStore('snapshots').put({key:backupKey"),
    'the backup must be written to the snapshots object store');
  assert.ok(preview.includes("tx.objectStore('snapshots').get(backupKey)"),
    'the backup must be read back and verified before import');
  assert.ok(preview.includes("const byId=next.filter") && preview.includes("const byBarcode=") && preview.includes("const byName="),
    'product upsert must match by code, barcode, and normalized name');
  assert.ok(preview.includes("const liveStock=existingProduct.stock") &&
    preview.includes("existingProduct.stock=liveStock") &&
    preview.includes("const liveBuyPrice=existingProduct.buyPrice"),
    'catalog upsert must preserve posted stock and cost basis for existing inventory');
  assert.ok(!preview.includes('anasGetFirebaseIdToken') && !preview.includes('fetch(url'),
    'local header analysis must not require Firebase login or cloud AI');
  assert.ok(preview.includes("await saveDBDurably();"),
    'the import must wait for the durable IndexedDB application save acknowledgement');
});
