import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

const PROJECT_ID = 'anas-erp-staging-a25e1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ERP_FILES = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'anas-erp-ui-safe-enhancements.css',
  'ai-excel-import-ui.js',
  'ai-excel-import-ui.css',
  'anas-pos-floating-cart.js',
  'anas-pos-floating-cart.css',
  'arabic-query-engine.js',
  'cashbox-readonly-ledger.js',
  'customer-debt-protection.js',
  'supplier-account-statement.js',
  'warehouse-transfer-audit.js',
  'icons/icon.svg',
  'reverse-ledger/reverse-ledger.js',
  'reverse-ledger/reverse-ledger-modal.js',
  'reverse-ledger/settlement-allocation-modal.js',
  'storage/android-resilient-storage.js',
  'core/ai-operations-engine.js',
  'core/pos-quick-sale-transaction-bridge.js',
  'micro-pos-core.js',
  'pos/micro-pos-engine.mjs',
  'pos/micro-pos-deep-core.mjs',
  'pos/advanced-financial-engine.mjs',
  'sync/mutation_queue_orchestrator.mjs',
  'sync/mutation_reconciliation.mjs',
  'sync/mutation_keys.mjs',
  'sync/v42_transactional_bridge.mjs',
  'sync/v42-prepared-recovery-runtime.mjs',
  'core/sovereign-kernel.mjs',
  'safe-update-ui.js'
];

function assertInlineClassicScriptsParse(html) {
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let scriptIndex = 0;
  for (const match of html.matchAll(scriptPattern)) {
    const attributes = match[1] || '';
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const typeMatch = attributes.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    const type = (typeMatch?.[1] || '').toLowerCase();
    if (type && type !== 'text/javascript' && type !== 'application/javascript') continue;
    const source = match[2] || '';
    try {
      new vm.Script(source, { filename: 'erp/index.html:inline-script-' + scriptIndex });
    } catch (error) {
      const detail = error?.stack || error?.message || String(error);
      throw new Error('Staging ERP inline classic script #' + scriptIndex +
        ' has invalid JavaScript. Parser detail: ' + detail);
    }
    scriptIndex++;
  }
  if (scriptIndex === 0) throw new Error('Staging ERP shell contains no inline classic scripts to validate');
}

function insertBeforeDocumentHeadClose(html, markup) {
  const headClose = html.indexOf('</head>');
  const bodyOpen = html.indexOf('<body');
  if (headClose < 0 || bodyOpen < 0 || headClose > bodyOpen) {
    throw new Error('Could not locate the actual document head boundary');
  }
  return html.slice(0, headClose) + markup + html.slice(headClose);
}

function insertBeforeLastDocumentTag(html, closingTag, markup) {
  const index = html.lastIndexOf(closingTag);
  const bodyOpen = html.indexOf('<body');
  if (index < 0 || (closingTag === '</body>' && (bodyOpen < 0 || index < bodyOpen))) {
    throw new Error('Could not find the actual document closing tag: ' + closingTag);
  }
  return html.slice(0, index) + markup + html.slice(index);
}

async function copyRelative(rootDir, outDir, relativePath) {
  const source = path.join(rootDir, relativePath);
  const destination = path.join(outDir, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

function requirePublicValue(env, name) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (!value || value.length > 512) throw new Error('Missing or invalid staging web config: ' + name);
  return value;
}

export async function buildStagingHosting(options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT);
  const outDir = path.resolve(options.outDir || path.join(rootDir, 'staging-site'));
  const env = options.env || process.env;
  const buildSha = String(env.GITHUB_SHA || env.ANAS_BUILD_SHA || 'local').trim().slice(0, 7);
  const apiKey = requirePublicValue(env, 'FIREBASE_STAGING_WEB_API_KEY');
  const appId = requirePublicValue(env, 'FIREBASE_STAGING_WEB_APP_ID');
  const siteKey = typeof env.FIREBASE_STAGING_APP_CHECK_SITE_KEY === 'string'
    ? env.FIREBASE_STAGING_APP_CHECK_SITE_KEY.trim()
    : '';
  if (siteKey.length > 512) throw new Error('Invalid optional staging App Check site key');

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  // Bundle the pinned Firebase compat SDK locally; the ERP shell must not depend on gstatic CDN availability.
  const firebaseBundle = path.join(outDir, 'erp/vendor/firebase/firebase-compat.js');
  await fs.mkdir(path.dirname(firebaseBundle), { recursive: true });
  await esbuild({
    entryPoints: [path.join(rootDir, 'staging/firebase-compat-entry.js')],
    outfile: firebaseBundle,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['es2018'],
    minify: true,
    legalComments: 'none'
  });

  // Vendor pinned parsers and OCR runtime into the ERP's local PWA scope.
  for (const [sourceRelative, destinationRelative] of [
    ['vendor/xlsx/xlsx.full.min.js', 'vendor/xlsx/xlsx.full.min.js'],
    ['node_modules/pdfjs-dist/legacy/build/pdf.min.js', 'vendor/pdfjs/pdf.min.js'],
    ['node_modules/pdfjs-dist/legacy/build/pdf.worker.min.js', 'vendor/pdfjs/pdf.worker.min.js'],
    ['node_modules/tesseract.js/dist/tesseract.min.js', 'vendor/tesseract/tesseract.min.js'],
    ['node_modules/tesseract.js/dist/worker.min.js', 'vendor/tesseract/worker.min.js']
  ]) {
    const source = path.join(rootDir, sourceRelative);
    const destination = path.join(outDir, 'erp', destinationRelative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
  const coreDir = path.join(rootDir, 'node_modules/tesseract.js-core');
  const stagedCoreDir = path.join(outDir, 'erp/vendor/tesseract/core');
  await fs.mkdir(stagedCoreDir, { recursive: true });
  for (const file of ['tesseract-core.wasm.js','tesseract-core-simd.wasm.js','tesseract-core-lstm.wasm.js','tesseract-core-simd-lstm.wasm.js']) {
    await fs.copyFile(path.join(coreDir,file),path.join(stagedCoreDir,file));
  }
  async function findTrainedData(dir, language) {
    for (const entry of await fs.readdir(dir,{withFileTypes:true})) {
      const candidate=path.join(dir,entry.name);
      if(entry.isDirectory()){const found=await findTrainedData(candidate,language);if(found)return found;}
      else if(entry.name===language+'.traineddata.gz')return candidate;
    }
    return null;
  }
  for (const language of ['ara','eng','fra']) {
    const trainedData=await findTrainedData(path.join(rootDir,'node_modules/@tesseract.js-data',language),language);
    if(!trainedData)throw new Error('Missing pinned Tesseract language data: '+language);
    const destination=path.join(outDir,'erp/vendor/tesseract/lang',language+'.traineddata.gz');
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.copyFile(trainedData,destination);
  }

  // Full ERP/POS app is isolated below /erp/, including its own PWA scope and offline assets.
  for (const relativePath of ERP_FILES) await copyRelative(rootDir, path.join(outDir, 'erp'), relativePath);

  const erpIndexPath = path.join(outDir, 'erp', 'index.html');
  const erpHtml = await fs.readFile(erpIndexPath, 'utf8');
  // Firebase responsive CSS must remain a live style element in the actual document head.
  const responsiveStyle = '<style id="anas-firebase-mobile-layout-v3">';
  const responsiveStyleCount = erpHtml.split(responsiveStyle).length - 1;
  const responsiveStylePosition = erpHtml.indexOf(responsiveStyle);
  const sourceHeadStart = erpHtml.indexOf('<head');
  const sourceHeadEnd = erpHtml.indexOf('</head>');
  if (responsiveStyleCount !== 1 || responsiveStylePosition <= sourceHeadStart ||
      responsiveStylePosition >= sourceHeadEnd ||
      erpHtml.includes('&lt;style id="anas-firebase-mobile-layout-v3">')) {
    throw new Error('Firebase responsive CSS must exist exactly once as a live style element in the source ERP document head');
  }
  const configPattern = /const firebaseConfig=\{[^;]*\};/g;
  const matches = erpHtml.match(configPattern) || [];
  if (matches.length !== 1 || !/projectId:"anas-erb"/.test(matches[0])) {
    throw new Error('Expected exactly one canonical production Firebase config in the ERP shell; refusing an ambiguous staging rewrite');
  }
  const firebaseConfig = {
    apiKey,
    authDomain: PROJECT_ID + '.firebaseapp.com',
    projectId: PROJECT_ID,
    appId
  };
  let stagedHtml = erpHtml.replace(configPattern, 'const firebaseConfig=' + JSON.stringify(firebaseConfig) + ';');
  if (!stagedHtml.includes('</head>') || !stagedHtml.includes('</body>')) {
    throw new Error('Could not locate ERP document boundaries for the AI import experience');
  }
  // Keep Firebase's responsive layout in the live document head. A CSS block
  // embedded in an HTML string is inert and must never be shipped as a substitute.
  const firebaseLayoutStyle = '<style id="anas-firebase-mobile-layout-v3">';
  const firebaseLayoutStart = stagedHtml.indexOf(firebaseLayoutStyle);
  const liveHeadStart = stagedHtml.indexOf('<head');
  const liveHeadEnd = stagedHtml.indexOf('</head>');
  if (firebaseLayoutStart < 0 || firebaseLayoutStart < liveHeadStart ||
      firebaseLayoutStart > liveHeadEnd ||
      (stagedHtml.match(/<style id="anas-firebase-mobile-layout-v3">/g) || []).length !== 1 ||
      stagedHtml.includes('&lt;style id="anas-firebase-mobile-layout-v3">')) {
    throw new Error('Firebase responsive CSS must be a single live style element inside the deployed ERP document head');
  }
  stagedHtml = insertBeforeDocumentHeadClose(stagedHtml,
    '  <link rel="stylesheet" href="./anas-erp-ui-safe-enhancements.css">\n  <link rel="stylesheet" href="./ai-excel-import-ui.css">\n  ');
  stagedHtml = insertBeforeLastDocumentTag(stagedHtml, '</body>',
    '  <script src="./ai-excel-import-ui.js" defer></script>\n  <script src="./safe-update-ui.js" defer></script>\n  <script type="module" src="./sync/v42-prepared-recovery-runtime.mjs"></script>\n  ');
  if (stagedHtml.includes('projectId:"anas-erb"') || !stagedHtml.includes('"projectId":"' + PROJECT_ID + '"')) {
    throw new Error('Staging ERP shell did not receive the isolated Firebase project configuration');
  }

  // Route the Staging ERP shell to its dedicated snapshot Worker; never point the
  // Staging UI at the Production snapshot Worker or its Production Firebase project.
  const snapshotWorkerInput = /(id="anasWorkerUrl"[^>]*value=")[^"]*(")/;
  if (!snapshotWorkerInput.test(stagedHtml)) {
    throw new Error('Could not find the canonical Firebase snapshot Worker URL input in the ERP shell');
  }
  stagedHtml = stagedHtml.replace(
    snapshotWorkerInput,
    '$1https://anas-erp-firebase-snapshot-staging.amin545677.workers.dev$2'
  );
  if (!stagedHtml.includes('https://anas-erp-firebase-snapshot-staging.amin545677.workers.dev') ||
      stagedHtml.includes('value="https://anas-erp-firebase-snapshot.amin545677.workers.dev"')) {
    throw new Error('Staging ERP shell retained a Production Firebase snapshot Worker URL');
  }
  // The canonical source shell remains r26; this staging build emits the r32 worker generation.
  const stamp = 'Build SHA: __ANAS_BUILD_SHA__ | SW: r26 | Env: Staging';
  if (stagedHtml.split(stamp).length - 1 !== 1) {
    throw new Error('Expected exactly one canonical source staging build stamp');
  }
  stagedHtml = stagedHtml.replace(stamp, 'Build SHA: ' + buildSha + ' | SW: r33 | Env: Staging');
  // Parse the exact transformed staging shell before it can reach Chromium or Hosting.
  assertInlineClassicScriptsParse(stagedHtml);
  await fs.writeFile(erpIndexPath, stagedHtml, 'utf8');

  // Preserve the dedicated reverse-ledger test console at the Hosting root.
  let consoleHtml = await fs.readFile(path.join(rootDir, 'staging/index.html'), 'utf8');
  consoleHtml = consoleHtml.replaceAll('../reverse-ledger/', './reverse-ledger/');
  await fs.writeFile(path.join(outDir, 'index.html'), consoleHtml, 'utf8');
  await copyRelative(rootDir, outDir, 'staging/reverse-ledger-gateway.js');
  await fs.rename(
    path.join(outDir, 'staging/reverse-ledger-gateway.js'),
    path.join(outDir, 'reverse-ledger-gateway.js')
  );
  for (const file of [
    'reverse-ledger/reverse-ledger.js',
    'reverse-ledger/reverse-ledger-modal.js',
    'reverse-ledger/settlement-allocation-modal.js'
  ]) await copyRelative(rootDir, outDir, file);

  const consoleConfig = {
    firebaseConfig: { ...firebaseConfig },
    ...(siteKey ? { appCheckSiteKey: siteKey } : {}),
    allowedOrigins: ['https://' + PROJECT_ID + '.web.app'],
    functionsRegion: 'us-central1'
  };
  await fs.writeFile(
    path.join(outDir, 'config.js'),
    'window.ANAS_REVERSE_LEDGER_STAGING_CONFIG = ' + JSON.stringify(consoleConfig) + ';\n',
    { mode: 0o600 }
  );

  for (const relativePath of [
    'index.html', 'config.js', 'reverse-ledger-gateway.js',
    'erp/index.html', 'erp/sw.js', 'erp/manifest.webmanifest',
    'erp/anas-pos-floating-cart.js', 'erp/anas-pos-floating-cart.css',
    'erp/storage/android-resilient-storage.js',
    'erp/core/ai-operations-engine.js',
    'erp/core/sovereign-kernel.mjs',
    'erp/safe-update-ui.js',
    'erp/sync/v42-prepared-recovery-runtime.mjs',
    'erp/core/pos-quick-sale-transaction-bridge.js',
    'erp/micro-pos-core.js', 'erp/pos/micro-pos-engine.mjs', 'erp/pos/micro-pos-deep-core.mjs', 'erp/pos/advanced-financial-engine.mjs',
    'erp/icons/icon.svg',
    'erp/vendor/firebase/firebase-compat.js',
    'erp/vendor/xlsx/xlsx.full.min.js',
    'erp/vendor/pdfjs/pdf.min.js',
    'erp/vendor/pdfjs/pdf.worker.min.js',
    'erp/vendor/tesseract/tesseract.min.js',
    'erp/vendor/tesseract/worker.min.js',
    'erp/vendor/tesseract/core/tesseract-core.wasm.js',
    'erp/vendor/tesseract/core/tesseract-core-simd.wasm.js',
    'erp/vendor/tesseract/core/tesseract-core-lstm.wasm.js',
    'erp/vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
    'erp/vendor/tesseract/lang/ara.traineddata.gz',
    'erp/vendor/tesseract/lang/eng.traineddata.gz',
    'erp/vendor/tesseract/lang/fra.traineddata.gz',
    'erp/reverse-ledger/reverse-ledger.js'
  ]) {
    await fs.access(path.join(outDir, relativePath));
  }
  return { outDir, projectId: PROJECT_ID, erpPath: '/erp/', consolePath: '/' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildStagingHosting();
  process.stdout.write('Built isolated ANAS ERP staging bundle: ' + result.erpPath +
    ' (full ERP/POS) and ' + result.consolePath + ' (reverse-ledger console).\n');
}
