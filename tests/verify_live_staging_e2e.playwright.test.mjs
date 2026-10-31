import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('Playwright live staging round-trip, POSTED idempotency and trusted backup restore', {
  skip: !liveReady ? 'Dedicated staging credentials and a pre-seeded fixture are not available in this CI context.' : false
}, async () => {
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
});
