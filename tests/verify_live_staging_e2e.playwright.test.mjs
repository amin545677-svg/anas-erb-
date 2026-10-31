import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFixture, assertFinancials } from '../scripts/verify-live-staging-e2e.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('live staging E2E verifier is fail-closed and requires all three operation classes', () => {
  assert.throws(() => validateFixture({ projectId: 'anas-erb', operations: [] }), /projectId/);
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
