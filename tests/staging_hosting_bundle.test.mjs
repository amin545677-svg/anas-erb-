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
    const actualHeadClose = erp.indexOf('</head>');
    const actualBodyClose = erp.lastIndexOf('</body>');
    const safeCssLink = erp.lastIndexOf('<link rel="stylesheet" href="./anas-erp-ui-safe-enhancements.css">');
    const importCssLink = erp.lastIndexOf('<link rel="stylesheet" href="./ai-excel-import-ui.css">');
    const importScript = erp.lastIndexOf('<script src="./ai-excel-import-ui.js" defer></script>');
    const safeUpdateScript = erp.lastIndexOf('<script src="./safe-update-ui.js" defer></script>');
    assert.ok(safeCssLink > erp.indexOf('<head') && safeCssLink < actualHeadClose,
      'safe visual stylesheet must be injected into the real document head, not a printable HTML string');
    assert.ok(importCssLink > erp.indexOf('<head') && importCssLink < actualHeadClose,
      'AI import stylesheet must be injected into the real document head');
    assert.ok(importScript > erp.indexOf('<body') && importScript < actualBodyClose,
      'AI import script must be injected before the real document body close');
    assert.ok(safeUpdateScript > erp.indexOf('<body') && safeUpdateScript < actualBodyClose,
      'safe update script must be injected before the real document body close');
    assert.ok(erp.includes("root.innerHTML + '</body></html>'"),
      'printable HTML closing tags inside JavaScript strings must remain untouched');
    await fs.access(path.join(outDir, 'erp/pos/advanced-financial-engine.mjs'));
    const kernel = await fs.readFile(path.join(outDir, 'erp/core/sovereign-kernel.mjs'), 'utf8');
    assert.ok(kernel.startsWith('const SHA256_K = ['), 'deployed sovereign kernel must be the canonical JavaScript module, not an HTML fallback');
    assert.match(erp, /pos\/advanced-financial-engine\.mjs/, 'ERP shell must load the advanced financial domain engine');
    assert.match(erp, /Build SHA: abcdef1 \| SW: r31 \| Env: Staging/, 'built ERP must expose the exact deployment SHA and cache version');
    assert.match(erp, /anas-pos-floating-cart\.js/);
    assert.match(erp, /anas-pos-floating-cart\.css/);
    assert.match(erp, /anas-pos-search-first-v1/, 'the deployed ERP shell must carry the search-first POS presentation');
    assert.match(erp, /safe-update-ui\.js/, 'staging shell must load the safe update controller');
    assert.match(erp, /safeUpdateAppUI/, 'settings must expose the safe update action');
    assert.match(erp, /<link rel="stylesheet" href="\.\/anas-erp-ui-safe-enhancements\.css">/, 'staging ERP must load the neutral eye-comfort palette stylesheet');
    assert.match(erp, /anas-import-review-cards/);
    assert.match(erp, /anas-sheet-picker-ui/);
    assert.match(erp, /مراجعة البيانات المستخرجة/);
    assert.match(erp, /مطابقة كل البنود تلقائياً/);
    const consoleConfig = await fs.readFile(path.join(outDir, 'config.js'), 'utf8');
    const consoleHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    const serviceWorker = await fs.readFile(path.join(outDir, 'erp/sw.js'), 'utf8');
    const visualCss = await fs.readFile(path.join(outDir, 'erp/anas-erp-ui-safe-enhancements.css'), 'utf8');
    const importCss = await fs.readFile(path.join(outDir, 'erp/ai-excel-import-ui.css'), 'utf8');
    assert.match(visualCss, /--anas-accent-primary:#1e3a8a/, 'visual repair must use a calm navy accent');
    assert.match(visualCss, /\.pos-products-grid[\s\S]*?grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/,
      'mobile POS products must use a readable two-column grid');
    assert.match(visualCss, /\.inventory-item-card[\s\S]*?flex-direction:column/,
      'inventory cards must stack content without overlay positioning');
    assert.match(visualCss, /\.anas-inventory-product-card\{[^}]*display:flex!important;[^}]*flex-direction:column!important;[^}]*gap:6px!important;[^}]*height:auto!important;/,
      'mobile inventory product cards must use a six-pixel vertical flex gap and natural height');
    assert.ok(visualCss.includes('.anas-inventory-product-card *{position:static!important}'),
      'all inventory card descendants must remain in normal document flow');
    assert.doesNotMatch(erp, /#38bdf8|#29b6f6/i,
      'the deployed ERP shell must not retain the eye-straining cyan palette');
    assert.match(visualCss, /#pdfImportCard[\s\S]*?background:#1e293b/,
      'PDF import card must have a dark readable surface');
    assert.match(visualCss, /anas-ai-file-actions > label\[data-anas-ai-action="pdf"\]/,
      'PDF upload tile must use the neutral readable surface');
    assert.match(visualCss, /#anasAiExecutiveMetrics[\s\S]*?background:#f2f3f0/,
      'AI executive metrics must have a high-contrast neutral surface');
    assert.match(importCss, /\.anas-ai-import-head \{ background:linear-gradient\(115deg,#1e293b,#334155\)/,
      'AI import header must use a calm navy palette');

    assert.match(serviceWorker, /anas-erp-v54-25-r31/, 'built PWA must install the r31 cache namespace');
    const floatingCartSource = await fs.readFile(path.join(outDir, 'erp/anas-pos-floating-cart.js'), 'utf8');
    const posFloatingCss = await fs.readFile(path.join(outDir, 'erp/anas-pos-floating-cart.css'), 'utf8');
    assert.match(floatingCartSource, /anasPosFloatingCart/);
    assert.match(posFloatingCss, /position:sticky!important/, 'the floating cart must stay in document flow and not cover tablet POS controls');
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
    for (const syncAsset of ['./sync/mutation_queue_orchestrator.mjs', './sync/mutation_reconciliation.mjs', './sync/mutation_keys.mjs', './sync/v42_transactional_bridge.mjs', './core/sovereign-kernel.mjs', './safe-update-ui.js']) {
      assert.ok(coreAssets.includes(syncAsset), 'sync module must be precached for the ERP runtime: ' + syncAsset);
    }
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
      'erp/sync/mutation_queue_orchestrator.mjs',
      'erp/sync/mutation_reconciliation.mjs',
      'erp/sync/mutation_keys.mjs',
      'erp/sync/v42_transactional_bridge.mjs',
      'erp/core/sovereign-kernel.mjs',
      'erp/safe-update-ui.js',
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


test('live staging verification binds hosted ERP to the exact deployment SHA and r31 cache namespace', async () => {
  const rootDir = path.resolve('.');
  const workflow = await fs.readFile(
    path.join(rootDir, '.github/workflows/deploy-reverse-ledger-console-staging.yml'),
    'utf8'
  );
  assert.ok(workflow.includes('DEPLOY_SHA: ${{ github.sha }}'),
    'live verification must receive the exact GitHub deployment SHA');
  assert.ok(workflow.includes('short_sha="${DEPLOY_SHA:0:7}"'),
    'live verification must derive the build stamp from the deployment SHA');
  assert.ok(workflow.includes(
    'fetch_expect "/erp/" "exact deployed commit and r31 build stamp" "Build SHA: ${short_sha} | SW: r31 | Env: Staging"'
  ), 'live ERP HTML must prove the exact deployed commit and r31 build stamp');
  assert.ok(workflow.includes(
    'fetch_expect "/erp/sw.js" "r31 service-worker cache namespace" "const CACHE = \'anas-erp-v54-25-r31\';"'
  ), 'live service worker must prove the expected r31 cache namespace');
});
