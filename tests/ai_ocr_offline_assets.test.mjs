import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('AI invoice OCR uses only locally bundled Arabic, English and French runtime assets', async () => {
  const [html, worker, packageJson, builder] = await Promise.all([
    readFile('index.html', 'utf8'),
    readFile('sw.js', 'utf8'),
    readFile('package.json', 'utf8').then(JSON.parse),
    readFile('scripts/build-staging-hosting.mjs', 'utf8')
  ]);
  assert.equal(/cdn\.jsdelivr\.net\/npm\/tesseract|tessdata\.projectnaptha\.com/i.test(html), false);
  assert.ok(html.includes("./vendor/tesseract/tesseract.min.js"));
  assert.ok(html.includes("workerPath:new URL('worker.min.js'"));
  assert.ok(html.includes("langPath:new URL('lang/'"));
  assert.ok(html.includes("corePath:new URL('core/'"));
  assert.ok(html.includes("createWorker('ara+eng+fra',1"));
  assert.ok(worker.includes('const OCR_ASSETS = ['));
  for (const language of ['ara', 'eng', 'fra']) {
    assert.ok(worker.includes('vendor/tesseract/lang/' + language + '.traineddata.gz'));
    assert.ok(packageJson.dependencies['@tesseract.js-data/' + language]);
    assert.ok(builder.includes(language + '.traineddata.gz'));
  }
  for (const file of ['tesseract-core.wasm.js','tesseract-core-simd.wasm.js','tesseract-core-lstm.wasm.js','tesseract-core-simd-lstm.wasm.js']) {
    assert.ok(builder.includes(file));
    assert.ok(worker.includes(file));
  }
  // Optional OCR assets are cached independently so one missing/large language pack
  // cannot reject the install or discard other successfully cached offline assets.
  assert.ok(worker.includes('Promise.allSettled(OCR_ASSETS.map(path => cache.add(path)))'));
  assert.ok(worker.includes('.then(() => self.skipWaiting())'));
});
