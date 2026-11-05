import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStagingIdentity,
  expectedPrincipalFromCredential,
  parseCredentialJson,
  STAGING_PROJECT_ID
} from '../scripts/assert-staging-deployment-identity.mjs';

const approvedAccount = 'staging-deployer@anas-erp-staging-a25e1.iam.gserviceaccount.com';

function validIdentity(overrides = {}) {
  const activeAccount = overrides.activeAccount ?? approvedAccount;
  return {
    firebaseProjectId: STAGING_PROJECT_ID,
    projectId: STAGING_PROJECT_ID,
    googleCloudProjectId: STAGING_PROJECT_ID,
    describedProjectId: STAGING_PROJECT_ID,
    activeAccount,
    activeAccounts: overrides.activeAccounts ?? [activeAccount],
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
      activeAccounts: ['human@example.com'],
      expectedAccount: approvedAccount
    })),
    /not a service account/
  );
});


test('accepts a service-account credential only when its project and principal are staging-bound', () => {
  assert.equal(expectedPrincipalFromCredential({
    type: 'service_account',
    project_id: STAGING_PROJECT_ID,
    client_email: approvedAccount
  }), approvedAccount);
});

test('rejects a service-account credential bound to production', () => {
  assert.throws(() => expectedPrincipalFromCredential({
    type: 'service_account',
    project_id: 'anas-erp-production',
    client_email: approvedAccount
  }), /project is not isolated staging/);
});

test('extracts the impersonated principal from a trusted OIDC credential', () => {
  assert.equal(expectedPrincipalFromCredential({
    type: 'external_account',
    audience: 'projects/123456/locations/global/workloadIdentityPools/anas/providers/github',
    service_account_impersonation_url:
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
      approvedAccount + ':generateAccessToken'
  }, 'projects/123456/locations/global/workloadIdentityPools/anas/providers/github'), approvedAccount);
});

test('rejects an OIDC credential using an untrusted impersonation endpoint', () => {
  assert.throws(() => expectedPrincipalFromCredential({
    type: 'external_account',
    audience: 'projects/123456/locations/global/workloadIdentityPools/anas/providers/github',
    service_account_impersonation_url:
      'https://attacker.example/v1/projects/-/serviceAccounts/' +
      approvedAccount + ':generateAccessToken'
  }, 'projects/123456/locations/global/workloadIdentityPools/anas/providers/github'), /endpoint is not trusted/);
});

test('rejects unsupported credential types', () => {
  assert.throws(() => expectedPrincipalFromCredential({
    type: 'authorized_user'
  }), /unsupported Google credential type/);
});

test('staging deploys are serialized while PR validation is isolated from deployment concurrency', async () => {
  const functionsWorkflow = await (await import('node:fs/promises')).readFile(
    new URL('../.github/workflows/deploy-reverse-ledger-functions-staging.yml', import.meta.url), 'utf8'
  );
  const consoleWorkflow = await (await import('node:fs/promises')).readFile(
    new URL('../.github/workflows/deploy-reverse-ledger-console-staging.yml', import.meta.url), 'utf8'
  );
  const functionsGroup = "group: anas-erp-reverse-ledger-functions-staging-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || 'deploy' }}";
  const consoleGroup = "group: anas-erp-reverse-ledger-console-staging-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || 'deploy' }}";
  assert.ok(functionsWorkflow.includes(functionsGroup), 'Functions PR validation must use a PR-scoped concurrency group');
  assert.ok(consoleWorkflow.includes(consoleGroup), 'Hosting PR validation must use a PR-scoped concurrency group');
  assert.match(functionsWorkflow, /cancel-in-progress:\s*false/);
  assert.match(consoleWorkflow, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(functionsWorkflow, /group:\s*anas-erp-reverse-ledger-console-staging/);
  assert.doesNotMatch(consoleWorkflow, /group:\s*anas-erp-reverse-ledger-functions-staging/);
});

test('live financial E2E workflow is manual, staging-only, explicitly confirmed and preflighted', async () => {
  const fs = await import('node:fs/promises');
  const workflow = await fs.readFile(
    new URL('../.github/workflows/verify-live-staging-e2e.yml', import.meta.url), 'utf8'
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(?:push|pull_request):/m);
  assert.match(workflow, /default:\s*"NO"/);
  assert.match(workflow, /RUN_STAGING_FINANCIAL_E2E/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/staging\/unified-release-candidate'/);
  assert.match(workflow, /environment:\s*staging/);
  assert.match(workflow, /secrets\.ANAS_STAGING_E2E_FIXTURE_JSON/);
  assert.match(workflow, /REPLACE_\[A-Z0-9_\]/);
  assert.match(workflow, /REV-STAGE-/);
  assert.ok(
    workflow.indexOf('Install Playwright') < workflow.indexOf('Fail-closed live Staging credentials'),
    'Playwright must be installed before importing the verifier module in fixture preflight'
  );
  assert.match(workflow, /verify-live-staging-e2e\.mjs/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
});

test('Level 9 identity matrix: rejects empty Firebase project ID', () => {
  assert.throws(() => validateStagingIdentity(validIdentity({ firebaseProjectId: '' })), /FIREBASE_PROJECT_ID/);
});
test('Level 9 identity matrix: rejects production-like project identifiers', () => {
  for (const value of ['anas-erp-prod', 'anas-erp-main', 'anas-erp-live', 'anas-erp-v42']) {
    assert.throws(() => validateStagingIdentity(validIdentity({
      firebaseProjectId: value, projectId: value, googleCloudProjectId: value, describedProjectId: value
    })));
  }
});
test('Level 9 identity matrix: rejects any three-way project variable disagreement', () => {
  assert.throws(() => validateStagingIdentity(validIdentity({ firebaseProjectId: 'other-project' })), /FIREBASE_PROJECT_ID/);
  assert.throws(() => validateStagingIdentity(validIdentity({ projectId: 'other-project' })), /GCLOUD_PROJECT/);
  assert.throws(() => validateStagingIdentity(validIdentity({ googleCloudProjectId: 'other-project' })), /GOOGLE_CLOUD_PROJECT/);
});
test('Level 9 identity matrix: rejects malformed service-account JSON', () => {
  assert.throws(() => parseCredentialJson('{"type":"service_account"'), /malformed/);
});
test('Level 9 identity matrix: rejects cross-project client_email spoofing', () => {
  assert.throws(() => expectedPrincipalFromCredential({
    type: 'service_account', project_id: STAGING_PROJECT_ID,
    client_email: 'attacker@other-project.iam.gserviceaccount.com'
  }), /invalid principal/);
});
test('Level 9 identity matrix: rejects an expected deployer outside the staging project', () => {
  assert.throws(() => validateStagingIdentity(validIdentity({
    expectedAccount: 'deployer@other-project.iam.gserviceaccount.com'
  })), /expected staging deployer/);
});
test('Level 9 identity matrix: accepts JSON mode only for exact staging project and principal', () => {
  assert.equal(expectedPrincipalFromCredential({
    type: 'service_account', project_id: STAGING_PROJECT_ID, client_email: approvedAccount
  }), approvedAccount);
});
test('Level 9 identity matrix: accepts OIDC only for the configured audience and staging deployer', () => {
  const provider = 'projects/123456/locations/global/workloadIdentityPools/anas/providers/github';
  assert.equal(expectedPrincipalFromCredential({
    type: 'external_account', audience: provider,
    service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + approvedAccount + ':generateAccessToken'
  }, provider), approvedAccount);
  assert.throws(() => expectedPrincipalFromCredential({
    type: 'external_account', audience: 'projects/123/other',
    service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + approvedAccount + ':generateAccessToken'
  }, provider), /audience does not match/);
});

test('Hosting staging deployment does not require an App Check site key to publish the static console', async () => {
  const workflow = await (await import('node:fs/promises')).readFile(
    new URL('../.github/workflows/deploy-reverse-ledger-console-staging.yml', import.meta.url), 'utf8'
  );
  assert.match(workflow, /for \(const name of \['FIREBASE_STAGING_WEB_API_KEY','FIREBASE_STAGING_WEB_APP_ID'\]\)/);
  assert.doesNotMatch(workflow, /for \(const name of \[[^\]]*FIREBASE_STAGING_APP_CHECK_SITE_KEY/);
  assert.match(workflow, /node scripts\/build-staging-hosting\.mjs/);
  assert.match(workflow, /FIREBASE_STAGING_APP_CHECK_SITE_KEY: \$\{\{ secrets\.FIREBASE_STAGING_APP_CHECK_SITE_KEY \}\}/);
  const builder = await (await import('node:fs/promises')).readFile(
    new URL('../scripts/build-staging-hosting.mjs', import.meta.url), 'utf8'
  );
  assert.match(builder, /\.\.\.\(siteKey \? \{ appCheckSiteKey: siteKey \} : \{\}\)/);
  assert.match(workflow, /deploy --only hosting/);
  assert.doesNotMatch(workflow, /deploy --only[^\n]*functions/);
});


test('Hosting and Functions share the tested raw-JSON/Base64 staging credential normalizer', async () => {
  const fs = await import('node:fs/promises');
  const hosting = await fs.readFile(
    new URL('../.github/workflows/deploy-reverse-ledger-console-staging.yml', import.meta.url), 'utf8'
  );
  const functions = await fs.readFile(
    new URL('../.github/workflows/deploy-reverse-ledger-functions-staging.yml', import.meta.url), 'utf8'
  );
  for (const workflow of [hosting, functions]) {
    assert.match(workflow, /environment:\s*staging/);
    assert.match(workflow, /secrets\.FIREBASE_STAGING_SERVICE_ACCOUNT_V2/);
    assert.match(workflow, /node scripts\/prepare-staging-service-account\.mjs/);
    assert.match(workflow, /credentials_json:\s*\$\{\{ env\.STAGING_SERVICE_ACCOUNT_JSON \}\}/);
  }
  assert.match(hosting, /secrets\.FIREBASE_STAGING_WEB_API_KEY/);
  assert.match(hosting, /secrets\.FIREBASE_STAGING_WEB_APP_ID/);
});
