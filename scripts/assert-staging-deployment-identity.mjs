import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STAGING_PROJECT_ID = 'anas-erp-staging-a25e1';

export function validateStagingIdentity({ projectId, activeAccount, expectedAccount, describedProjectId }) {
  if (projectId !== STAGING_PROJECT_ID || describedProjectId !== STAGING_PROJECT_ID) {
    throw new Error('Refusing deployment: authenticated Google Cloud project is not the isolated staging project.');
  }
  if (!activeAccount || !activeAccount.endsWith('.iam.gserviceaccount.com')) {
    throw new Error('Refusing deployment: active principal is not a service account.');
  }
  if (expectedAccount && activeAccount !== expectedAccount) {
    throw new Error('Refusing deployment: active principal does not match the approved staging deployer.');
  }
  return true;
}

function expectedPrincipalFromCredentials(path) {
  if (!path) return '';
  const credential = JSON.parse(readFileSync(path, 'utf8'));
  if (credential.type === 'service_account') return credential.client_email || '';
  const impersonationUrl = credential.service_account_impersonation_url || '';
  const match = impersonationUrl.match(/serviceAccounts\/([^/:]+):generateAccessToken/);
  return match ? decodeURIComponent(match[1]) : '';
}

export function runStagingIdentityGuard(env = process.env, run = execFileSync) {
  const projectId = env.GCLOUD_PROJECT || '';
  const expectedAccount = env.ANAS_STAGING_DEPLOYER_SERVICE_ACCOUNT ||
    expectedPrincipalFromCredentials(env.GOOGLE_APPLICATION_CREDENTIALS);
  const activeAccount = run('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], { encoding: 'utf8' }).trim();
  const describedProjectId = run('gcloud', ['projects', 'describe', STAGING_PROJECT_ID, '--format=value(projectId)'], { encoding: 'utf8' }).trim();
  validateStagingIdentity({ projectId, activeAccount, expectedAccount, describedProjectId });
  return { projectId, activeAccount, describedProjectId };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = runStagingIdentityGuard();
    console.log('STAGING IDENTITY VERIFIED: ' + result.projectId + ' via ' + result.activeAccount);
  } catch (error) {
    console.error('STAGING IDENTITY GUARD BLOCKED DEPLOYMENT: ' + error.message);
    process.exitCode = 1;
  }
}
