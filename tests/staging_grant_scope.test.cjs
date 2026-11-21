'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readStagingGrantScope,
  assertExistingGrantScope
} = require('../scripts/staging-grant-scope.cjs');

test('staging grant scope requires one explicit tenant and unique store IDs', () => {
  const scope = readStagingGrantScope({
    ANAS_STAGING_TENANT_ID: 'tenant-stage-01',
    ANAS_STAGING_STORE_IDS_JSON: '["store-stage-a","store-stage-b"]'
  });
  assert.equal(scope.tenantId, 'tenant-stage-01');
  assert.deepEqual(scope.storeIds, ['store-stage-a', 'store-stage-b']);
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(Object.isFrozen(scope.storeIds), true);
});

test('staging grant scope rejects missing, malformed, empty, duplicate and unsafe identifiers', () => {
  assert.throws(() => readStagingGrantScope({
    ANAS_STAGING_STORE_IDS_JSON: '["store-stage-a"]'
  }), /ANAS_STAGING_TENANT_ID/);
  assert.throws(() => readStagingGrantScope({
    ANAS_STAGING_TENANT_ID: 'tenant-stage-01',
    ANAS_STAGING_STORE_IDS_JSON: 'not-json'
  }), /JSON array/);
  for (const raw of ['[]', '["store-a","store-a"]', '[1]', '["bad\\nstore"]']) {
    assert.throws(() => readStagingGrantScope({
      ANAS_STAGING_TENANT_ID: 'tenant-stage-01',
      ANAS_STAGING_STORE_IDS_JSON: raw
    }));
  }
});

test('bootstrap refuses to rewrite a grant already bound to a different tenant or store scope', () => {
  const expected = Object.freeze({ tenantId: 'tenant-stage-01', storeIds: ['store-stage-a'] });
  assert.equal(assertExistingGrantScope({ uid: 'user-1' }, expected), true);
  assert.equal(assertExistingGrantScope({
    tenantId: 'tenant-stage-01',
    storeIds: ['store-stage-a']
  }, expected), true);
  assert.throws(() => assertExistingGrantScope({
    tenantId: 'tenant-production',
    storeIds: ['store-stage-a']
  }, expected), /different tenant/);
  assert.throws(() => assertExistingGrantScope({
    tenantId: 'tenant-stage-01',
    storeIds: ['store-stage-b']
  }, expected), /different store scope/);
});

