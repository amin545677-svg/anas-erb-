import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Excel import and export use the vendored offline SheetJS build', async () => {
  const html = await readFile('index.html', 'utf8');
  const library = await readFile('vendor/xlsx/xlsx.full.min.js', 'utf8');
  assert.match(html, /<script src="\\.\\/vendor\\/xlsx\\/xlsx\\.full\\.min\\.js"><\\/script>/);
  assert.match(library, /0\\.20\\.3/, 'vendored SheetJS version must be 0.20.3');
  assert.doesNotMatch(html, /cdn\\.sheetjs\\.com|cdn\\.jsdelivr\\.net\\/npm\\/xlsx|unpkg\\.com\\/xlsx/);
  const start = html.indexOf('async function anasLoadSheetJs()');
  const end = html.indexOf('async function handleSmartAiUpload(e)', start);
  assert.ok(start >= 0 && end > start, 'SheetJS loader must exist before the upload handler');
  const loader = html.slice(start, end);
  assert.ok(loader.includes("./vendor/xlsx/xlsx.full.min.js"), 'loader must resolve the local vendor file');
  assert.ok(loader.includes('anasSheetJsLoadPromise'), 'concurrent imports must share one library load');
  assert.ok(loader.includes('script.onerror') && loader.includes('setTimeout'),
    'missing or stalled local library must produce a controlled error');
  assert.ok(loader.includes('lib.utils.sheet_to_json'), 'loader must validate the parser API before returning');
  const uploadStart = html.indexOf('async function handleSmartAiUpload(e)');
  const uploadEnd = html.indexOf('async function anasExtractPdfText(file)', uploadStart);
  const upload = html.slice(uploadStart, uploadEnd);
  assert.ok(upload.includes('if(!window.XLSX) await anasLoadSheetJs()'));
  assert.ok(upload.includes("xlsxLib.read(buf,{type:'array',cellDates:false})"));
  assert.ok(upload.includes('xlsxLib.utils.sheet_to_json'));
});

test('smart import counts skipped decisions from its keyed decision map after durable save', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.match(html, /const importDecisions=\\{\\};[\\s\\S]*?importDecisions\\[Number\\(select\\.dataset\\.importDecision\\)\\]=select\\.value;/,
    'review decisions are stored by row index in an object map');
  assert.match(html, /Object\\.values\\(importDecisions\\)\\.filter\\(decision=>decision==='ignore'\\|\\|decision==='delete'\\)\\.length/,
    'skip totals must iterate the keyed decision map instead of calling Array.filter');
  assert.doesNotMatch(html, /importDecisions\\.filter\\(decision=>decision==='ignore'\\|\\|decision==='delete'\\)/,
    'a post-save type error must not prevent the UI from reporting durable import success');
});

test('smart import rejects duplicate customer/supplier IDs and reports complete row totals', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.match(html, /if\\(\\(target!=='products' && existingCodes\\.has\\(norm\\(recordId\\)\\)\\) \\|\\| seenIds\\.has\\(norm\\(recordId\\)\\)\\)/,
    'customer and supplier IDs already in local storage must not be silently duplicated');
  assert.match(html, /const skipped=Object\\.values\\(importDecisions\\)\\.filter\\(decision=>decision==='ignore'\\|\\|decision==='delete'\\)\\.length;/,
    'ignored and deleted preview rows must be counted as skipped from the keyed decision map');
  assert.doesNotMatch(html, /const skipped=importDecisions\\.filter\\(/,
    'the old array-only counter must not return');
  assert.match(html, /إجمالي '\\+staged\\.length\\+'.*أضيف '\\+added\\+'.*حُدث '\\+updated\\+'.*تم تخطي '\\+skipped/,
    'the import summary must report total, added, updated, and skipped counts');
});
