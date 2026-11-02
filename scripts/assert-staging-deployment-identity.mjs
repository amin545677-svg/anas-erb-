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
  firebaseProjectId,
  projectId,
  googleCloudProjectId,
  activeAccount,
  activeAccounts,
  expectedAccount,
  describedProjectId
}) {
  requireStagingProject(firebaseProjectId, 'FIREBASE_PROJECT_ID');
  requireStagingProject(projectId, 'GCLOUD_PROJECT');
  requireStagingProject(googleCloudProjectId, 'GOOGLE_CLOUD_PROJECT');
  requireStagingProject(describedProjectId, 'gcloud config project');

  if (!expectedAccount || !expectedAccount.endsWith('@' + STAGING_PROJECT_ID + '.iam.gserviceaccount.com')) {
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

export function parseCredentialJson(raw) {
  let credential;
  try { credential = JSON.parse(String(raw)); }
  catch { throw new Error('Refusing deployment: service-account JSON is malformed.'); }
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new Error('Refusing deployment: Google credential configuration is invalid.');
  }
  if (!['service_account', 'external_account'].includes(credential.type)) {
    throw new Error('Refusing deployment: unsupported Google credential type.');
  }
  return credential;
}

export function expectedPrincipalFromCredential(credential, expectedWifProvider = '') {
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new Error('Refusing deployment: Google credential configuration is invalid.');
  }

  if (credential.type === 'service_account') {
    if (credential.project_id !== STAGING_PROJECT_ID) {
      throw new Error('Refusing deployment: service-account credential project is not isolated staging.');
    }
    const email = credential.client_email || '';
    if (!email.endsWith('@' + STAGING_PROJECT_ID + '.iam.gserviceaccount.com')) {
      throw new Error('Refusing deployment: service-account credential has an invalid principal.');
    }
    return email;
  }

  if (credential.type === 'external_account') {
    if (!expectedWifProvider || credential.audience !== expectedWifProvider) {
      throw new Error('Refusing deployment: OIDC audience does not match the approved staging WIF provider.');
    }
    const raw = credential.service_account_impersonation_url || '';
    let url;
    try { url = new URL(raw); } catch {
      throw new Error('Refusing deployment: OIDC credential lacks a valid service-account impersonation URL.');
    }
    if (url.protocol !== 'https:' || url.hostname !== 'iamcredentials.googleapis.com') {
      throw new Error('Refusing deployment: OIDC impersonation endpoint is not trusted.');
    }
    const match = url.pathname.match(/\/serviceAccounts\/([^/:]+):generateAccessToken$/);
    const email = match ? decodeURIComponent(match[1]) : '';
    if (!email.endsWith('@' + STAGING_PROJECT_ID + '.iam.gserviceaccount.com')) {
      throw new Error('Refusing deployment: OIDC credential has no approved service-account principal.');
    }
    return email;
  }

  throw new Error('Refusing deployment: unsupported Google credential type.');
}

function expectedPrincipalFromCredentials(credentialsPath, expectedWifProvider) {
  if (!credentialsPath) return '';
  const credential = parseCredentialJson(readFileSync(credentialsPath, 'utf8'));
  return expectedPrincipalFromCredential(credential, expectedWifProvider);
}
function parseActiveAccounts(output) {
  return String(output)
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
}

export function runStagingIdentityGuard(env = process.env, run = execFileSync) {
  const firebaseProjectId = env.FIREBASE_PROJECT_ID || '';
  const projectId = env.GCLOUD_PROJECT || '';
  const googleCloudProjectId = env.GOOGLE_CLOUD_PROJECT || '';
  const wifProvider = env.ANAS_STAGING_WIF_PROVIDER || '';
  const credentialAccount = expectedPrincipalFromCredentials(env.GOOGLE_APPLICATION_CREDENTIALS, wifProvider);
  const configuredAccount = env.ANAS_STAGING_DEPLOYER_SERVICE_ACCOUNT || '';
  if (configuredAccount && credentialAccount && configuredAccount !== credentialAccount) {
    throw new Error('Refusing deployment: configured deployer does not match the authenticated credential principal.');
  }
  const expectedAccount = configuredAccount || credentialAccount;

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
    firebaseProjectId,
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
