const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../staging/index.html'), 'utf8');
const configExample = fs.readFileSync(path.join(__dirname, '../staging/config.example.js'), 'utf8');

test('staging page is isolated from production V42 entrypoint and targets only the dedicated Firebase project', () => {
  assert.match(html, /ANAS_REVERSE_LEDGER_STAGING_CONFIG/);
  assert.match(html, /anas-erp-staging-a25e1/);
  assert.doesNotMatch(html, /firebaseConfig\.projectId\s*=\s*['"]anas-erb['"]/);
  assert.match(html, /firebase\.app\('anas-erp-reverse-ledger-staging'\)/);
  assert.match(html, /noindex,nofollow/);
  assert.match(html, /reverse-ledger-gateway\.js/);
});

test('staging UI reads only the authenticated user cloud snapshot and exposes no direct control-plane writes', () => {
  assert.match(html, /collection\('users'\)\.doc\(user\.uid\)\.collection\('snapshots'\)\.doc\('latest'\)\.get\(\)/);
  assert.doesNotMatch(html, /reverseLedgerGrants|reverseLedgerOperations|financialPeriods/);
  assert.doesNotMatch(html, /\.set\(|\.update\(|\.create\(/);
});

test('staging UI uses callable endpoints for trusted backup and restore', () => {
  assert.match(html, /httpsCallable\(name\)/);
  assert.match(html, /createTrustedReverseLedgerBackup/);
  assert.match(html, /restoreTrustedReverseLedgerBackup/);
  assert.match(html, /executeReverseLedger/);
});

test('staging config example contains placeholders only and no private service-account material', () => {
  assert.match(configExample, /anas-erp-staging-a25e1/);
  assert.match(configExample, /REPLACE_WITH_STAGING_WEB_API_KEY/);
  assert.match(configExample, /REPLACE_WITH_STAGING_RECAPTCHA_V3_SITE_KEY/);
  assert.doesNotMatch(configExample, /BEGIN PRIVATE KEY|client_email|private_key/);
});

test('staging console inline JavaScript parses without browser globals at build time', () => {
  const scripts = [...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)];
  assert.equal(scripts.length, 1, 'expected one inline console controller');
  assert.doesNotThrow(() => new vm.Script(scripts[0][1], { filename: 'staging/index.html:inline' }));
});
