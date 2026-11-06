import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('AI invoice OCR uses only the locally bundled Arabic, English and French runtime', async () => {
  const [html, worker, packageJson, builder] = await Promise.all([
    readFile('index.html', 'utf8'),
    readFile('sw.js', 'utf8'),
    readFile('package.json', 'utf8').then(JSON.parse),
    readFile('scripts/build-staging-hosting.mjs', 'utf8')
  ]);
  assert.doesNotMatch(html, /cdn\\.jsdelivr\\.net\\/npm\\/tesseract|tessdata\\.projectnaptha\\.com/i);
  assert.match(html, /vendor\\/tesseract\\/tesseract\\.min\\.js/);
  assert.match(html, /workerPath:new URL\\('worker\\.min\\.js'/);
  assert.match(html, /langPath:new URL\\('lang\\/'/);
  assert.match(html, /corePath:new URL\\('core\\/'/);
  assert.match(html, /createWorker\\('ara\\+eng\\+fra',1/);
  assert.match(worker, /const OCR_ASSETS = \\[([\\s\\S]*?)\\]/);
  for (const asset of ['ara','eng','fra']) {
    assert.match(worker, new RegExp('vendor/tesseract/lang/' + asset + '\\\\.traineddata\\\\.gz'));
    assert.ok(packageJson.dependencies['@tesseract.js-data/' + asset], 'pinned ' + asset + ' traineddata dependency is required');
    assert.ok(builder.includes(asset + '.traineddata.gz'), 'build must stage ' + asset + ' traineddata');
  }
  for (const file of ['tesseract-core.wasm.js','tesseract-core-simd.wasm.js','tesseract-core-lstm.wasm.js','tesseract-core-simd-lstm.wasm.js']) {
    assert.ok(builder.includes(file), 'build must stage ' + file);
    assert.ok(worker.includes(file), 'service worker must cache ' + file);
  }
  assert.match(worker, /cache\\.addAll\\(OCR_ASSETS\\)\\.catch\\(\\(\\) => undefined\\)/);
});
