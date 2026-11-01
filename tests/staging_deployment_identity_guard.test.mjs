import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStagingIdentity, STAGING_PROJECT_ID } from '../scripts/assert-staging-deployment-identity.mjs';

test('accepts only the exact isolated staging project and approved service account', () => {
  assert.equal(validateStagingIdentity({
    projectId: STAGING_PROJECT_ID,
    describedProjectId: STAGING_PROJECT_ID,
    activeAccount: 'staging-deployer@anas-erp-staging-a25e1.iam.gserviceaccount.com',
    expectedAccount: 'staging-deployer@anas-erp-staging-a25e1.iam.gserviceaccount.com'
  }), true);
});

test('rejects a production project even when the active account is valid', () => {
  assert.throws(() => validateStagingIdentity({
    projectId: 'anas-erp-production',
    describedProjectId: 'anas-erp-production',
    activeAccount: 'staging-deployer@anas-erp-staging-a25e1.iam.gserviceaccount.com'
  }), /not the isolated staging project/);
});

test('rejects a project mismatch between configured and authenticated target', () => {
  assert.throws(() => validateStagingIdentity({
    projectId: STAGING_PROJECT_ID,
    describedProjectId: 'anas-erp-production',
    activeAccount: 'staging-deployer@anas-erp-staging-a25e1.iam.gserviceaccount.com'
  }), /not the isolated staging project/);
});

test('rejects a principal other than the approved staging deployer', () => {
  assert.throws(() => validateStagingIdentity({
    projectId: STAGING_PROJECT_ID,
    describedProjectId: STAGING_PROJECT_ID,
    activeAccount: 'other@anas-erp-staging-a25e1.iam.gserviceaccount.com',
    expectedAccount: 'staging-deployer@anas-erp-staging-a25e1.iam.gserviceaccount.com'
  }), /does not match/);
});

test('rejects user credentials rather than a service account', () => {
  assert.throws(() => validateStagingIdentity({
    projectId: STAGING_PROJECT_ID,
    describedProjectId: STAGING_PROJECT_ID,
    activeAccount: 'human@example.com'
  }), /not a service account/);
});
