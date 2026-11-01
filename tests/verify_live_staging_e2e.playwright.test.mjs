import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateFixture, assertFinancials, verifyLiveStaging } from '../scripts/verify-live-staging-e2e.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('live staging E2E verifier is fail-closed and requires all three operation classes', () => {
  assert.throws(() => validateFixture({ projectId: 'anas-erb', operations: [] }), /Fixture must target/);
  assert.throws(() => validateFixture({ projectId: 'anas-erp-staging-a25e1', operations: [] }), /SALE_RETURN/);
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/reverse-ledger-live-staging.example.json'), 'utf8'));
  assert.doesNotThrow(() => validateFixture(fixture));
});

test('live staging E2E compares centimes and micro-units with BigInt and zero tolerance', () => {
  assert.doesNotThrow(() => assertFinancials({ caisseBalance: '125.50', products: [{ stock: '2.000001' }] }, [
    { path: 'caisseBalance', unit: 'centimes', expected: '12550' },
    { path: 'products.0.stock', unit: 'microUnits', expected: '2000001' }
  ], 'test'));
  assert.throws(() => assertFinancials({ caisseBalance: '125.51' }, [
    { path: 'caisseBalance', unit: 'centimes', expected: '12550' }
  ], 'test'), /delta=1/);
});

const liveReady = ['ANAS_STAGING_URL','ANAS_STAGING_EMAIL','ANAS_STAGING_PASSWORD','ANAS_STAGING_E2E_FIXTURE']
  .every(key => Boolean(process.env[key] && process.env[key].trim()));

test('Staging round-trip or local Firestore Emulator plus Chromium fallback', async () => {
  if (liveReady) {
    const evidence = await verifyLiveStaging({
      url: process.env.ANAS_STAGING_URL,
      email: process.env.ANAS_STAGING_EMAIL,
      password: process.env.ANAS_STAGING_PASSWORD,
      fixturePath: process.env.ANAS_STAGING_E2E_FIXTURE,
      evidencePath: process.env.ANAS_STAGING_EVIDENCE_PATH || ''
    });
    assert.equal(evidence.result, 'PASS');
    assert.equal(evidence.backupRestore.centimeDelta, '0');
    assert.equal(evidence.backupRestore.microUnitDelta, '0');
    return;
  }

  // No live credentials in CI: start an isolated local Firestore Emulator and
  // execute the real transaction/rules regression suites, then exercise the
  // V42 Chromium DOM and fail-closed UI contract. No fake callable is injected
  // into the browser and no local client-side financial posting is permitted.
  const emulatorOutput = execFileSync('npx', [
    '--yes', 'firebase-tools@14.22.0', 'emulators:exec',
    '--only', 'firestore', '--project', 'demo-anas-erp',
    '--config', 'firebase.staging.json',
    'node --test tests/reverse_ledger_firestore_emulator.test.js tests/reverse_ledger_snapshot_rules.test.mjs'
  ], { cwd: root, encoding: 'utf8', timeout: 240000, maxBuffer: 20 * 1024 * 1024 });
  assert.match(emulatorOutput, /All emulators ready/i);
  assert.match(emulatorOutput, /# fail 0/);
  assert.match(emulatorOutput, /# skipped 0/);

  const chromiumOutput = execFileSync(process.execPath, [
    '--test', 'tests/reverse_ledger_chromium.test.mjs'
  ], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
  assert.match(chromiumOutput, /UNIFIED_DOM_ZERO_CONSOLE_REPORT/);
  assert.match(chromiumOutput, /# fail 0/);
  assert.match(chromiumOutput, /# skipped 0/);
  process.stdout.write('LOCAL_EMULATOR_CHROMIUM_FALLBACK_PASS ' + JSON.stringify({
    emulator: 'Firestore transaction and security-rules suites passed',
    chromium: 'V42 DOM, financial modals and fail-closed UI suites passed',
    liveCredentialsRequired: false
  }) + '\\n');
});
