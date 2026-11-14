import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Firebase compat SDK is bundled locally and included in the offline ERP shell', async () => {
  const [html, worker, packageJson, builder, entry] = await Promise.all([
    readFile('index.html', 'utf8'),
    readFile('sw.js', 'utf8'),
    readFile('package.json', 'utf8').then(JSON.parse),
    readFile('scripts/build-staging-hosting.mjs', 'utf8'),
    readFile('staging/firebase-compat-entry.js', 'utf8')
  ]);
  assert.match(html, /src="\.\/vendor\/firebase\/firebase-compat\.js"/);
  assert.doesNotMatch(html, /www\.gstatic\.com\/firebasejs|firebase-(?:app|auth|firestore)-compat\.js"/i);
  assert.ok(worker.includes("'./vendor/firebase/firebase-compat.js'"), 'service worker must precache the Firebase bundle');
  const cacheRevision = worker.match(/const CACHE = 'anas-erp-v54-25-r(\d+)'/);
  assert.ok(cacheRevision, 'service worker cache revision must be versioned');
  assert.ok(Number(cacheRevision[1]) >= 8, 'cache revision must be at least r8');
  assert.equal(packageJson.dependencies.firebase, '10.12.2');
  assert.equal(packageJson.dependencies.esbuild, '0.24.2');
  assert.ok(entry.includes("firebase/compat/app"));
  assert.ok(entry.includes("firebase/compat/auth"));
  assert.ok(entry.includes("firebase/compat/firestore"));
  assert.ok(entry.includes('globalThis.firebase = firebase'));
  assert.ok(builder.includes("import { build as esbuild } from 'esbuild'"));
  assert.ok(builder.includes("staging/firebase-compat-entry.js"));
  assert.ok(builder.includes("erp/vendor/firebase/firebase-compat.js"));
});
