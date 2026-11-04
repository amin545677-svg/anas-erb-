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
        FIREBASE_STAGING_WEB_APP_ID: '1:123456:web:staging'
      }
    });
    const erp = await fs.readFile(path.join(outDir, 'erp/index.html'), 'utf8');
    const consoleConfig = await fs.readFile(path.join(outDir, 'config.js'), 'utf8');
    const consoleHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.match(erp, /const firebaseConfig=\{"apiKey":"STAGING_PUBLIC_API_KEY","authDomain":"anas-erp-staging-a25e1\.firebaseapp\.com","projectId":"anas-erp-staging-a25e1","appId":"1:123456:web:staging"\};/);
    assert.doesNotMatch(erp, /projectId:"anas-erb"/);
    for (const file of [
      'erp/sw.js',
      'erp/manifest.webmanifest',
      'erp/storage/android-resilient-storage.js',
      'erp/icons/icon.svg',
      'erp/reverse-ledger/reverse-ledger.js',
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
