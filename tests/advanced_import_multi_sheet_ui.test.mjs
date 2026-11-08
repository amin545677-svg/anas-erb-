import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('multi-sheet import UI exposes one atomic Apply All action and warns that imported invoices are not posted', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /showSmartImportMultiSheetPreview/);
  assert.match(html, /smartImportMultiApplyAll/);
  assert.match(html, /معاملة ذرية واحدة/);
  assert.match(html, /غير مرحّلة/);
  assert.match(html, /saveMultiSheetBatchSafe/);
  assert.match(html, /executeSafeMultiSheetImport/);
  assert.match(html, /const backup=JSON\.parse\(backupPayload\)/,
    'the durable commit adapter must validate the complete pre-import snapshot');
  assert.match(html, /Restore the complete application snapshot/,
    'failed commits must restore dependent ledgers and settings, not only four visible tabs');
  assert.match(html, /for\(const \[key,value\] of Object\.entries\(before\)\)app\[key\]=value/);
});

test('staging build stamp is visible in the About section and names the current service-worker generation', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /id="anasBuildStamp"/);
  assert.match(html, /Build SHA: __ANAS_BUILD_SHA__ \| SW: r25 \| Env: Staging/);
});
