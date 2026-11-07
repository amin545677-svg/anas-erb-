import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('smart import defaults to local product mapping and requires a verified IndexedDB snapshot before upsert', async () => {
  const html = await readFile('index.html', 'utf8');
  const start = html.indexOf('function showSmartImportPreview(fileName,rows)');
  const end = html.indexOf('function clearAllSalesInvoices()', start);
  assert.ok(start >= 0 && end > start, 'smart import preview function must exist');
  const preview = html.slice(start, end);
  assert.match(preview, /smartImportAiAnalyze['"]\)\.click\(\)/, 'local header analysis must run automatically');
  assert.match(preview, /id="smartImportBackupAck" type="checkbox" checked/);
  assert.match(preview, /indexedDB\.open\('anas_erp_v42_resilient_db',1\)/, 'backup must be written to local IndexedDB');
  assert.match(preview, /store\('snapshots'\)\.put\(\{key:backupKey,payload:JSON\.stringify\(backup\)/);
  assert.match(preview, /store\('snapshots'\)\.get\(backupKey\)/, 'backup must be read back before import');
  assert.match(preview, /const byId=next\.filter/);
  assert.match(preview, /const byBarcode=item\.barcode/);
  assert.match(preview, /updated\+\+/);
  assert.doesNotMatch(preview, /anasGetFirebaseIdToken|Authorization:.*Bearer|تعذر AI السحابي/);
  assert.doesNotMatch(preview, /backupDownloadRequested\)/);
});
