import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildStagingHosting } from '../scripts/build-staging-hosting.mjs';

test('staging ERP builds the AI Excel import experience as local offline-first assets', async () => {
  const rootDir = path.resolve('.');
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anas-ai-import-ui-'));
  try {
    await buildStagingHosting({
      rootDir, outDir,
      env: {
        FIREBASE_STAGING_WEB_API_KEY: 'STAGING_PUBLIC_API_KEY',
        FIREBASE_STAGING_WEB_APP_ID: '1:123456:web:staging'
      }
    });
    const html = await fs.readFile(path.join(outDir, 'erp/index.html'), 'utf8');
    const script = await fs.readFile(path.join(outDir, 'erp/ai-excel-import-ui.js'), 'utf8');
    const css = await fs.readFile(path.join(outDir, 'erp/ai-excel-import-ui.css'), 'utf8');
    const worker = await fs.readFile(path.join(outDir, 'erp/sw.js'), 'utf8');
    assert.match(html, /ai-excel-import-ui\.css/);
    assert.match(html, /ai-excel-import-ui\.js/);
    assert.match(script, /smartAiExcelUpload/);
    assert.match(script, /anas:import-target-selected/);
    assert.match(script, /anas:import-file-selected/);
    assert.match(script, /new DataTransfer\(\)/);
    assert.match(script, /MAX_TABLE_BYTES/);
    assert.match(script, /MAX_IMAGE_PDF_BYTES/);
    assert.match(css, /\.anas-ai-import-pro/);
    assert.match(css, /@media\(max-width:760px\)/);
    assert.match(worker, /ai-excel-import-ui\.js/);
    assert.match(worker, /ai-excel-import-ui\.css/);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
