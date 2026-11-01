import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStagingIdentity,
  STAGING_PROJECT_ID
} from '../scripts/assert-staging-deployment-identity.mjs';

const approvedAccount = 'staging-deployer@anas-erp-staging-a25e1.iam.gserviceaccount.com';

function validIdentity(overrides = {}) {
  return {
    projectId: STAGING_PROJECT_ID,
    googleCloudProjectId: STAGING_PROJECT_ID,
    describedProjectId: STAGING_PROJECT_ID,
    activeAccount: approvedAccount,
    activeAccounts: [approvedAccount],
    expectedAccount: approvedAccount,
    ...overrides
  };
}

test('accepts only the exact isolated staging project and approved service account', () => {
  assert.equal(validateStagingIdentity(validIdentity()), true);
});

test('rejects a production project even when the active account is valid', () => {
  assert.throws(
    () => validateStagingIdentity(validIdentity({
      projectId: 'anas-erp-production',
      googleCloudProjectId: 'anas-erp-production',
      describedProjectId: 'anas-erp-production'
    })),
    /not the isolated staging project/
  );
});

test('rejects a mismatch between GCLOUD_PROJECT and GOOGLE_CLOUD_PROJECT', () => {
  assert.throws(
    () => validateStagingIdentity(validIdentity({
      googleCloudProjectId: 'anas-erp-production'
    })),
    /not the isolated staging project/
  );
});

test('rejects a mismatch with the project returned by gcloud config', () => {
  assert.throws(
    () => validateStagingIdentity(validIdentity({
      describedProjectId: 'anas-erp-production'
    })),
    /not the isolated staging project/
  );
});

test('rejects a missing GOOGLE_CLOUD_PROJECT value', () => {
  assert.throws(
    () => validateStagingIdentity(validIdentity({ googleCloudProjectId: '' })),
    /not the isolated staging project/
  );
});

test('rejects a missing expected deployer identity', () => {
  assert.throws(
    () => validateStagingIdentity(validIdentity({ expectedAccount: '' })),
    /expected staging deployer account is required/
  );
});

test('rejects a principal other than the approved staging deployer', () => {
  assert.throws(
    () => validateStagingIdentity(validIdentity({
      activeAccount: 'other@anas-erp-staging-a25e1.iam.gserviceaccount.com'
    })),
    /does not match/
  );
});

test('rejects multiple active gcloud identities', () => {
  assert.throws(
    () => validateStagingIdentity(validIdentity({
      activeAccounts: [
        approvedAccount,
        'second@anas-erp-staging-a25e1.iam.gserviceaccount.com'
      ]
    })),
    /exactly one active/
  );
});

test('rejects an empty active identity list', () => {
  assert.throws(
    () => validateStagingIdentity(validIdentity({ activeAccounts: [] })),
    /exactly one active/
  );
});

test('rejects user credentials rather than a service account', () => {
  assert.throws(
    () => validateStagingIdentity(validIdentity({
      activeAccount: 'human@example.com',
      expectedAccount: 'human@example.com'
    })),
    /not a service account/
  );
});
