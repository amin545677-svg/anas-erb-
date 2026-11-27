import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('smart import routes accepted image files to the existing review-only invoice OCR flow', async () => {
  const html = await readFile('index.html', 'utf8');
  const start = html.indexOf('async function handleSmartAiUpload(e)');
  const end = html.indexOf('async function anasExtractPdfText(file)', start);
  assert.ok(start >= 0 && end > start, 'the upload handler must be present');
  const upload = html.slice(start, end);
  const imageBranch = upload.indexOf("if(['jpg','jpeg','png','webp'].includes(ext))");
  const csvBranch = upload.indexOf("if(ext==='csv' || ext==='txt')");
  assert.ok(imageBranch >= 0 && csvBranch > imageBranch,
    'image files must be routed before the spreadsheet-only parser branch');
  const route = upload.slice(imageBranch, csvBranch);
  assert.ok(route.includes('image' + String.fromCharCode(92) + '/(?:jpeg|png|webp)'),
    'the image route must require a supported image MIME type');
  assert.doesNotThrow(() => new Function('return /^image' + String.fromCharCode(92) + '/(?:jpeg|png|webp)$/i'),
    'the MIME validator regex must remain valid JavaScript');
  assert.match(route, /10\*1024\*1024/,
    'the OCR route must enforce the 10MB image limit');
  assert.match(route, /openInvoiceOcr\('other'\)/,
    'image imports must open the existing local OCR review modal');
  assert.match(route, /invoiceOcrFile/);
  assert.match(route, /new DataTransfer\(\)/);
  assert.match(route, /dispatchEvent\(new Event\('change'/);
  assert.match(route, /مسودة فقط/,
    'the operator must be told OCR output remains a draft and is not auto-posted');
  assert.doesNotMatch(route, /saveScannedInvoiceDraft\(\)|executeSafeBulkImport\(/,
    'routing an image must not save or post records automatically');
});
