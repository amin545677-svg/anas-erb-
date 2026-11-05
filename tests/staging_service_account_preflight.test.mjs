import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeServiceAccountInput,
  prepareCredential,
  validateOidc
} from '../scripts/prepare-staging-service-account.mjs';

const credential = {
  type: 'service_account',
  project_id: 'anas-erp-staging-a25e1',
  client_email: 'anas-staging-deployer@anas-erp-staging-a25e1.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nTEST_ONLY_NOT_A_REAL_KEY\n-----END PRIVATE KEY-----\n'
};
const raw = JSON.stringify(credential);
const encoded = Buffer.from(raw, 'utf8').toString('base64');

test('accepts valid raw staging service-account JSON and trims surrounding whitespace', () => {
  assert.equal(decodeServiceAccountInput('  \n' + raw + '\n  ').credential.project_id, credential.project_id);
});

test('repairs literal line breaks inside private_key in otherwise valid raw JSON', () => {
  const damaged = raw.replace(/\\n/g, '\n');
  const parsed = decodeServiceAccountInput(damaged);
  assert.equal(parsed.credential.project_id, credential.project_id);
  assert.match(parsed.jsonText, /-----BEGIN PRIVATE KEY-----\\nTEST_ONLY_NOT_A_REAL_KEY/);
});

test('accepts valid Base64 staging service-account JSON', () => {
  assert.equal(decodeServiceAccountInput(encoded).credential.client_email, credential.client_email);
});

test('accepts Base64 with line wrapping and surrounding whitespace', () => {
  const wrapped = encoded.match(/.{1,24}/g).join('\n');
  assert.equal(decodeServiceAccountInput('  ' + wrapped + '  ').credential.project_id, credential.project_id);
});

test('rejects malformed Base64 and decoded non-JSON input', () => {
  assert.throws(() => decodeServiceAccountInput('not base64!'), /neither JSON nor valid Base64/);
  assert.throws(() => decodeServiceAccountInput(Buffer.from('not json').toString('base64')), /not valid JSON/);
});

test('rejects credentials for any project other than isolated staging', () => {
  const wrong = Buffer.from(JSON.stringify({ ...credential, project_id: 'production' })).toString('base64');
  assert.throws(() => decodeServiceAccountInput(wrong), /not valid for isolated staging/);
});

test('rejects a credential whose service account email is not staging-bound', () => {
  assert.throws(() => decodeServiceAccountInput(JSON.stringify({
    ...credential, client_email: 'deployer@production.iam.gserviceaccount.com'
  })), /not valid for isolated staging/);
});

test('accepts only correctly shaped staging OIDC provider and deployer', () => {
  assert.equal(validateOidc(
    'projects/123/locations/global/workloadIdentityPools/anas/providers/github',
    credential.client_email
  ), true);
  assert.equal(validateOidc('bad-provider', credential.client_email), false);
});

test('writes normalized credential to the GitHub environment without logging its content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anas-staging-'));
  try {
    const envFile = join(dir, 'env');
    const outputFile = join(dir, 'output');
    const result = prepareCredential({
      input: encoded, githubEnv: envFile, githubOutput: outputFile
    });
    assert.equal(result.mode, 'json');
    assert.match(readFileSync(envFile, 'utf8'), /STAGING_SERVICE_ACCOUNT_JSON<<ANAS_STAGING_/);
    assert.ok(readFileSync(envFile, 'utf8').includes(raw));
    assert.equal(readFileSync(outputFile, 'utf8'), 'auth_mode=json\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
