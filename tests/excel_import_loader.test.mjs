import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Excel import loads SheetJS locally first and falls back to the pinned official build', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.ok(html.includes('onerror="this.onerror=null;this.src=\'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js\';"'),
    'workbook export controls must also have a startup fallback when the local script is absent');
  const start = html.indexOf('async function anasLoadSheetJs()');
  const end = html.indexOf('async function handleSmartAiUpload(e)', start);
  assert.ok(start >= 0 && end > start, 'SheetJS loader must exist before the upload handler');
  const loader = html.slice(start, end);
  assert.ok(loader.includes("./vendor/xlsx/xlsx.full.min.js"), 'local offline library path must be preferred');
  assert.ok(loader.includes('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'),
    'online fallback must use the pinned official SheetJS release');
  assert.ok(loader.includes('anasSheetJsLoadPromise'), 'concurrent imports must share one library load');
  assert.ok(loader.includes('script.onerror') && loader.includes('setTimeout'),
    'load failures and stalled network requests must be handled');
  assert.ok(loader.includes('lib.utils.sheet_to_json'), 'loader must validate the parser API before returning');
  const uploadStart = html.indexOf('async function handleSmartAiUpload(e)');
  const uploadEnd = html.indexOf('async function anasExtractPdfText(file)', uploadStart);
  const upload = html.slice(uploadStart, uploadEnd);
  assert.ok(upload.includes('const xlsxLib = await anasLoadSheetJs()'));
  assert.ok(upload.includes('xlsxLib.read(buf,{type:\'array\',cellDates:false})'));
  assert.ok(upload.includes('xlsxLib.utils.sheet_to_json'));
});
