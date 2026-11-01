import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STAGING_PROJECT_ID = 'anas-erp-staging-a25e1';

function requireStagingProject(value, source) {
  if (value !== STAGING_PROJECT_ID) {
    throw new Error(
      'Refusing deployment: ' + source +
      ' is missing or is not the isolated staging project.'
    );
  }
}

export function validateStagingIdentity({
  projectId,
  googleCloudProjectId,
  activeAccount,
  activeAccounts,
  expectedAccount,
  describedProjectId
}) {
  requireStagingProject(projectId, 'GCLOUD_PROJECT');
  requireStagingProject(googleCloudProjectId, 'GOOGLE_CLOUD_PROJECT');
  requireStagingProject(describedProjectId, 'gcloud config project');

  if (!expectedAccount || !expectedAccount.endsWith('.iam.gserviceaccount.com')) {
    throw new Error('Refusing deployment: expected staging deployer account is required.');
  }

  const accounts = Array.isArray(activeAccounts)
    ? activeAccounts.filter(Boolean)
    : (activeAccount ? [activeAccount] : []);

  if (accounts.length !== 1) {
    throw new Error('Refusing deployment: exactly one active gcloud identity is required.');
  }

  const principal = accounts[0];
  if (!principal.endsWith('.iam.gserviceaccount.com')) {
    throw new Error('Refusing deployment: active principal is not a service account.');
  }

  if (principal !== expectedAccount) {
    throw new Error('Refusing deployment: active principal does not match the approved staging deployer.');
  }

  return true;
}

function expectedPrincipalFromCredentials(credentialsPath) {
  if (!credentialsPath) return '';
  const credential = JSON.parse(readFileSync(credentialsPath, 'utf8'));

  if (credential.type === 'service_account') {
    return credential.client_email || '';
  }

  const impersonationUrl = credential.service_account_impersonation_url || '';
  const match = impersonationUrl.match(/serviceAccounts\/([^/:]+):generateAccessToken/);
  return match ? decodeURIComponent(match[1]) : '';
}

function parseActiveAccounts(output) {
  return String(output)
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
}

export function runStagingIdentityGuard(env = process.env, run = execFileSync) {
  const projectId = env.GCLOUD_PROJECT || '';
  const googleCloudProjectId = env.GOOGLE_CLOUD_PROJECT || '';
  const expectedAccount = env.ANAS_STAGING_DEPLOYER_SERVICE_ACCOUNT ||
    expectedPrincipalFromCredentials(env.GOOGLE_APPLICATION_CREDENTIALS);

  if (!expectedAccount) {
    throw new Error('Refusing deployment: expected staging deployer account is required.');
  }

  const activeAccountsOutput = run(
    'gcloud',
    ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
    { encoding: 'utf8' }
  );
  const activeAccounts = parseActiveAccounts(activeAccountsOutput);
  const activeAccount = activeAccounts.length === 1 ? activeAccounts[0] : '';

  const describedProjectId = run(
    'gcloud',
    ['config', 'get-value', 'project'],
    { encoding: 'utf8' }
  ).trim();

  const authenticatedProjectId = run(
    'gcloud',
    ['projects', 'describe', STAGING_PROJECT_ID, '--format=value(projectId)'],
    { encoding: 'utf8' }
  ).trim();

  if (authenticatedProjectId !== STAGING_PROJECT_ID) {
    throw new Error('Refusing deployment: authenticated Google Cloud project is not the isolated staging project.');
  }

  validateStagingIdentity({
    projectId,
    googleCloudProjectId,
    activeAccount,
    activeAccounts,
    expectedAccount,
    describedProjectId
  });

  return {
    projectId,
    googleCloudProjectId,
    activeAccount,
    describedProjectId
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = runStagingIdentityGuard();
    console.log(
      'STAGING IDENTITY VERIFIED: ' +
      result.projectId +
      ' via ' +
      result.activeAccount
    );
  } catch (error) {
    console.error('STAGING IDENTITY GUARD BLOCKED DEPLOYMENT: ' + error.message);
    process.exitCode = 1;
  }
}
