import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Excel import requires an actual backup-download request and explicit user verification', async () => {
  const html = await readFile('index.html', 'utf8');
  const start = html.indexOf('function showSmartImportPreview(fileName,rows)');
  const end = html.indexOf('function clearAllSalesInvoices()', start);
  assert.ok(start >= 0 && end > start, 'smart import preview function must exist');
  const preview = html.slice(start, end);
  assert.ok(preview.includes("let backupDownloadRequested=false"));
  assert.ok(preview.includes('id="smartImportCreateBackup"'));
  assert.ok(preview.includes('id="smartImportBackupAck" type="checkbox" disabled'));
  assert.ok(preview.includes("typeof exportDataBackup!=='function'||exportDataBackup()!==true"));
  assert.ok(preview.includes('backupDownloadRequested=true'));
  assert.ok(preview.includes("if(!backupDownloadRequested)"));
  assert.ok(preview.includes("if(!box.querySelector('#smartImportBackupAck').checked)"));
  assert.ok(preview.includes('تحقق من ظهور ملف النسخة الاحتياطية في التنزيلات'));
  const exportStart = html.indexOf('function exportDataBackup()');
  const exportEnd = html.indexOf('function anasValidateBackupData', exportStart);
  const exporter = html.slice(exportStart, exportEnd);
  assert.ok(exporter.includes('JSON.stringify(AppData, null, 2)'));
  assert.ok(exporter.includes('URL.createObjectURL(blob)'));
  assert.ok(exporter.includes('a.click()'));
});
