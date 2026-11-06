import { appendFile } from 'node:fs/promises';

const PROJECT_ID = 'anas-erp-staging-a25e1';
const STAGING_ERP_URL = 'https://anas-erp-staging-a25e1.web.app/erp/';
const API_KEY_PATTERN = /AIza[0-9A-Za-z_-]{35}/g;

function extractKeys(value) {
  return [...new Set(String(value || '').match(API_KEY_PATTERN) || [])];
}

async function validateKey(key) {
  const response = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=' + encodeURIComponent(key),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        referer: 'https://anas-erp-staging-a25e1.web.app/'
      },
      body: JSON.stringify({
        identifier: 'staging-preflight@example.invalid',
        continueUri: 'https://anas-erp-staging-a25e1.web.app'
      })
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (response.ok) return true;
  const message = payload.error?.message || '';
  if (/API_KEY_INVALID|keyInvalid|INVALID_API_KEY/i.test(message)) return false;
  throw new Error('Firebase key validation returned HTTP ' + response.status +
    ' (' + (message || 'unclassified response') + '); no account was created.');
}

async function getLiveFallbackKey() {
  const response = await fetch(STAGING_ERP_URL, {
    redirect: 'follow',
    headers: { accept: 'text/html' }
  });
  if (!response.ok) throw new Error('Staging fallback page returned HTTP ' + response.status);
  const html = await response.text();
  const projectMatches = [
    ...html.matchAll(/["']?projectId["']?\s*:\s*["']([^"']+)["']/g)
  ].map(match => match[1]);
  if (!projectMatches.includes(PROJECT_ID)) {
    throw new Error('Live fallback page does not identify the expected Staging Firebase project.');
  }
  const keys = extractKeys(html);
  if (keys.length === 0) {
    throw new Error('No Firebase Web API key was found in the verified live Staging page.');
  }
  for (const key of keys) {
    if (await validateKey(key)) return key;
  }
  throw new Error('Firebase rejected every API key extracted from the verified live Staging page.');
}

const secretCandidates = extractKeys(process.env.FIREBASE_STAGING_WEB_API_KEY);
let selectedKey = '';
let selectedSource = '';

for (const candidate of secretCandidates) {
  try {
    if (await validateKey(candidate)) {
      selectedKey = candidate;
      selectedSource = 'repository-secret';
      break;
    }
  } catch {
    // A malformed or rejected repository value must not block the verified live fallback.
  }
}

if (!selectedKey) {
  selectedKey = await getLiveFallbackKey();
  selectedSource = 'verified-live-staging-fallback';
}

if (!/^AIza[0-9A-Za-z_-]{35}$/.test(selectedKey)) {
  throw new Error('Resolved Firebase Web API key failed the strict format check.');
}

process.stdout.write('::add-mask::' + selectedKey + '\n');
const githubEnv = process.env.GITHUB_ENV;
if (!githubEnv) throw new Error('GITHUB_ENV is unavailable; refusing to continue.');
await appendFile(githubEnv, 'FIREBASE_STAGING_WEB_API_KEY=' + selectedKey + '\n', { encoding: 'utf8', mode: 0o600 });
process.stdout.write('PASS: Firebase Web API key resolved and validated; source=' + selectedSource + '.\n');
