import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildStagingHosting } from '../scripts/build-staging-hosting.mjs';

test('builds a staging-only full ERP/POS PWA and retains the reverse-ledger console', async () => {
  const rootDir = path.resolve('.');
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anas-staging-hosting-'));
  try {
    await buildStagingHosting({
      rootDir,
      outDir,
      env: {
        FIREBASE_STAGING_WEB_API_KEY: 'STAGING_PUBLIC_API_KEY',
        FIREBASE_STAGING_WEB_APP_ID: '1:123456:web:staging',
        GITHUB_SHA: 'abcdef1234567890'
      }
    });
    const erp = await fs.readFile(path.join(outDir, 'erp/index.html'), 'utf8');
    await fs.access(path.join(outDir, 'erp/pos/advanced-financial-engine.mjs'));
    assert.match(erp, /pos\/advanced-financial-engine\.mjs/, 'ERP shell must load the advanced financial domain engine');
    assert.match(erp, /Build SHA: abcdef1 \| SW: r22 \| Env: Staging/, 'built ERP must expose the exact deployment SHA and cache version');
    assert.match(erp, /anas-pos-floating-cart\.js/);
    assert.match(erp, /anas-pos-floating-cart\.css/);
    assert.match(erp, /anas-import-review-cards/);
    assert.match(erp, /anas-sheet-picker-ui/);
    assert.match(erp, /مراجعة البيانات المستخرجة/);
    assert.match(erp, /مطابقة كل البنود تلقائياً/);
    const consoleConfig = await fs.readFile(path.join(outDir, 'config.js'), 'utf8');
    const consoleHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    const serviceWorker = await fs.readFile(path.join(outDir, 'erp/sw.js'), 'utf8');
    assert.match(serviceWorker, /anas-erp-v54-25-r22/, 'built PWA must install the r20 cache namespace');
    const floatingCartSource = await fs.readFile(path.join(outDir, 'erp/anas-pos-floating-cart.js'), 'utf8');
    const posFloatingCss = await fs.readFile(path.join(outDir, 'erp/anas-pos-floating-cart.css'), 'utf8');
    assert.match(floatingCartSource, /anasPosFloatingCart/);
    assert.match(floatingCartSource, /setPosQty/);
    assert.match(posFloatingCss, /\.anas-pos-floating-cart/);
    assert.match(serviceWorker, /anas-pos-floating-cart\.js/);
    assert.match(serviceWorker, /anas-pos-floating-cart\.css/);
    const sourceXlsx = await fs.readFile(path.join(rootDir, 'vendor/xlsx/xlsx.full.min.js'));
    const builtXlsx = await fs.readFile(path.join(outDir, 'erp/vendor/xlsx/xlsx.full.min.js'));
    assert.deepEqual(builtXlsx, sourceXlsx, 'deployed PWA must use the exact vetted offline SheetJS artifact');
    assert.match(builtXlsx.toString('utf8'), /0\.20\.3/, 'deployed PWA must retain the vetted SheetJS 0.20.3 version');

    // Validate the actual built PWA, not just the source manifest: every precached
    // asset must be present under /erp/ or the service worker install will fail.
    const coreMatch = serviceWorker.match(/const CORE = \[(.*?)\];/s);
    assert.ok(coreMatch, 'built service worker must declare a core asset list');
    const coreAssets = [...coreMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
    assert.ok(coreAssets.length > 0, 'built service worker core list must not be empty');
    for (const asset of coreAssets) {
      assert.ok(asset.startsWith('./'), 'core asset must remain relative to /erp/: ' + asset);
      const resolved = path.resolve(outDir, 'erp', asset.slice(2));
      const erpRoot = path.resolve(outDir, 'erp');
      assert.ok(resolved === erpRoot || resolved.startsWith(erpRoot + path.sep),
        'core asset must not escape the /erp/ scope: ' + asset);
      await fs.access(resolved);
    }

    // Every statically declared local script/link dependency in the generated shell
    // must also exist in the generated hosting artifact.
    const localRefs = [...erp.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=['"]([^'"]+)['"]/gi)]
      .map(match => match[1]).filter(value => value.startsWith('./'));
    assert.ok(localRefs.length > 0, 'built ERP shell must expose local runtime dependencies');
    for (const reference of localRefs) {
      const target = new URL(reference, 'https://staging.example/erp/');
      assert.equal(target.origin, 'https://staging.example');
      assert.ok(target.pathname.startsWith('/erp/'), 'local dependency must stay within /erp/: ' + reference);
      await fs.access(path.join(outDir, 'erp', target.pathname.slice('/erp/'.length)));
    }
    assert.ok(erp.includes('src="./vendor/firebase/firebase-compat.js"'));
    assert.equal(erp.includes('www.gstatic.com/firebasejs'), false);
    assert.ok(serviceWorker.includes("'./vendor/firebase/firebase-compat.js'"));
    assert.match(erp, /const firebaseConfig=\{"apiKey":"STAGING_PUBLIC_API_KEY","authDomain":"anas-erp-staging-a25e1\.firebaseapp\.com","projectId":"anas-erp-staging-a25e1","appId":"1:123456:web:staging"\};/);
    assert.equal(erp.includes('www.gstatic.com/firebasejs'), false);
    assert.match(erp, /value="https:\/\/anas-erp-firebase-snapshot-staging\.amin545677\.workers\.dev"/);
    assert.equal(erp.includes('www.gstatic.com/firebasejs'), false);
    const layoutMarker = erp.lastIndexOf('<style id="anas-firebase-mobile-layout-v3">');
    const liveHeadStart = erp.indexOf('<head');
    const liveHeadEnd = erp.indexOf('</head>');
    assert.ok(layoutMarker > liveHeadStart && layoutMarker < liveHeadEnd,
      "Firebase responsive CSS must be a live style element inside the deployed ERP document head");
    assert.equal((erp.match(/<style id="anas-firebase-mobile-layout-v3">/g) || []).length, 1,
      "Firebase responsive CSS must be emitted exactly once as a document style element");
    assert.equal(erp.includes('&lt;style id="anas-firebase-mobile-layout-v3">'), false,
      "Firebase responsive CSS must not be HTML-escaped inside a generated string");
    assert.match(erp, /auth\/api-key-not-valid/);
    assert.match(erp, /تحقق من CORS وقائمة ALLOWED_ORIGINS/);

    for (const file of [
      'erp/sw.js',
      'erp/manifest.webmanifest',
      'erp/storage/android-resilient-storage.js',
      'erp/icons/icon.svg',
      'erp/vendor/firebase/firebase-compat.js',
      'erp/vendor/tesseract/tesseract.min.js',
      'erp/vendor/tesseract/worker.min.js',
      'erp/vendor/tesseract/core/tesseract-core.wasm.js',
      'erp/vendor/tesseract/core/tesseract-core-simd.wasm.js',
      'erp/vendor/tesseract/core/tesseract-core-lstm.wasm.js',
      'erp/vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
      'erp/vendor/tesseract/lang/ara.traineddata.gz',
      'erp/vendor/tesseract/lang/eng.traineddata.gz',
      'erp/vendor/tesseract/lang/fra.traineddata.gz',
      'erp/reverse-ledger/reverse-ledger.js',
      'erp/micro-pos-core.js',
      'erp/pos/micro-pos-engine.mjs',
      'erp/pos/micro-pos-deep-core.mjs',
      'erp/supplier-account-statement.js',
      'erp/cashbox-readonly-ledger.js'
    ]) await fs.access(path.join(outDir, file));
    assert.match(consoleHtml, /ANAS ERP — بيئة اختبار دفتر المرتجعات/);
    assert.match(consoleHtml, /\.\/reverse-ledger\/reverse-ledger\.js/);
    assert.match(consoleConfig, /"projectId":"anas-erp-staging-a25e1"/);
    assert.doesNotMatch(consoleConfig, /appCheckSiteKey/);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('includes App Check in the reverse-ledger console config only when a site key is supplied', async () => {
  const rootDir = path.resolve('.');
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anas-staging-hosting-appcheck-'));
  try {
    await buildStagingHosting({
      rootDir,
      outDir,
      env: {
        FIREBASE_STAGING_WEB_API_KEY: 'STAGING_PUBLIC_API_KEY',
        FIREBASE_STAGING_WEB_APP_ID: '1:123456:web:staging',
        FIREBASE_STAGING_APP_CHECK_SITE_KEY: 'STAGING_RECAPTCHA_SITE_KEY'
      }
    });
    const config = await fs.readFile(path.join(outDir, 'config.js'), 'utf8');
    assert.match(config, /"appCheckSiteKey":"STAGING_RECAPTCHA_SITE_KEY"/);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
