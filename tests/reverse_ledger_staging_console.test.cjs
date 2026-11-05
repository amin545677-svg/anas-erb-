const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../staging/index.html'), 'utf8');
const configExample = fs.readFileSync(path.join(__dirname, '../staging/config.example.js'), 'utf8');
const gateway = fs.readFileSync(path.join(__dirname, '../staging/reverse-ledger-gateway.js'), 'utf8');
const hosting = JSON.parse(fs.readFileSync(path.join(__dirname, '../firebase.staging.hosting.json'), 'utf8'));
const deployWorkflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/deploy-reverse-ledger-console-staging.yml'), 'utf8');
const functionsWorkflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/deploy-reverse-ledger-functions-staging.yml'), 'utf8');
const bootstrapScript = fs.readFileSync(path.join(__dirname, '../scripts/bootstrap-staging-account.mjs'), 'utf8');
const authPreflightScript = fs.readFileSync(path.join(__dirname, '../scripts/prepare-staging-service-account.mjs'), 'utf8');

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
  assert.ok(html.includes('reverse-ledger-gateway.js'));
  assert.ok(gateway.includes("httpsCallable('executeReverseLedger')"));
});

test('staging config example contains placeholders only and no private service-account material', () => {
  assert.match(configExample, /anas-erp-staging-a25e1/);
  assert.match(configExample, /REPLACE_WITH_STAGING_WEB_API_KEY/);
  assert.match(configExample, /REPLACE_WITH_STAGING_RECAPTCHA_V3_SITE_KEY/);
  assert.doesNotMatch(configExample, /BEGIN PRIVATE KEY|client_email|private_key/);
});

test('staging console inline JavaScript parses without browser globals at build time', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'expected one inline console controller');
  assert.doesNotThrow(() => new vm.Script(scripts[0][1], { filename: 'staging/index.html:inline' }));
});

test('staging console deployment waits for the exact successful Gate and requires dedicated staging credentials', () => {
  assert.equal(hosting.hosting.site, 'anas-erp-staging-a25e1');
  assert.equal(hosting.hosting.public, 'staging-site');
  assert.doesNotMatch(deployWorkflow, /workflow_dispatch:/, 'Hosting deployment must be gate-triggered, not manually bypassable');
  assert.match(deployWorkflow, /pull_request:/);
  assert.match(deployWorkflow, /push:\s*\n\s*branches:\s*\n\s*- staging\/unified-release-candidate\s*\n\s*paths:/);
  assert.doesNotMatch(deployWorkflow, /- feat\/reverse-ledger-firebase-functions-v2/);
  assert.ok(deployWorkflow.includes('Enforce staging deployment identity before any deploy action'));
  assert.ok(deployWorkflow.indexOf('Enforce staging deployment identity before any deploy action') < deployWorkflow.indexOf('Deploy only the dedicated staging ERP and console'));
  assert.match(deployWorkflow, /\n\s*- ['"]staging\/\*\*['"]/);
  assert.match(deployWorkflow, /github\.event\.pull_request\.head\.ref == 'staging\/unified-release-candidate'/);
  assert.ok(deployWorkflow.includes("github.event_name == 'push' && github.ref == 'refs/heads/staging/unified-release-candidate'"));
  assert.ok(deployWorkflow.includes('Wait for matching Staging Test Gate success'));
  assert.ok(deployWorkflow.indexOf('Wait for matching Staging Test Gate success') < deployWorkflow.indexOf('Secret Presence Preflight'),
    'Hosting must wait for the matching successful Gate before reading credentials or deploying');
  assert.ok(deployWorkflow.includes("run.name === 'Staging Test Gate'"));
  assert.ok(deployWorkflow.includes('run.head_sha === process.env.GITHUB_SHA'));
  assert.ok(deployWorkflow.includes("gate.conclusion !== 'success'"));
  assert.ok(!deployWorkflow.slice(0, deployWorkflow.indexOf('jobs:')).includes('id-token: write'));
  for (const secret of [
    'FIREBASE_STAGING_WEB_API_KEY',
    'FIREBASE_STAGING_WEB_APP_ID',
    'FIREBASE_STAGING_APP_CHECK_SITE_KEY'
  ]) assert.ok(deployWorkflow.includes(secret), 'missing staging web configuration: ' + secret);
  assert.ok(deployWorkflow.includes('id-token: write'));
  assert.ok(deployWorkflow.includes('google-github-actions/auth@v2'));
  const serviceAccountCredential = 'credentials_json: ${{ env.STAGING_SERVICE_ACCOUNT_JSON }}';
  assert.ok(deployWorkflow.includes(serviceAccountCredential));
  assert.ok(deployWorkflow.includes('secrets.FIREBASE_STAGING_SERVICE_ACCOUNT_V2'));
  assert.ok(deployWorkflow.includes('node scripts/prepare-staging-service-account.mjs'));
  assert.ok(deployWorkflow.includes('workload_identity_provider: ${{ vars.ANAS_STAGING_WIF_PROVIDER }}'));
  assert.ok(deployWorkflow.includes('service_account: ${{ vars.ANAS_STAGING_DEPLOYER_SERVICE_ACCOUNT }}'));
  assert.ok(deployWorkflow.includes("steps.auth_preflight.outputs.auth_mode == 'json'"));
  assert.ok(deployWorkflow.includes("steps.auth_preflight.outputs.auth_mode == 'oidc'"));
  assert.ok(authPreflightScript.includes("console.log('STAGING AUTH MODE: ' +"));
  assert.ok(authPreflightScript.includes('service-account JSON (raw or Base64)'));
  assert.ok(authPreflightScript.includes('OIDC fallback'));
  assert.ok(authPreflightScript.includes("fs.appendFileSync(githubOutput, 'auth_mode=json\\n')"));
  assert.ok(authPreflightScript.includes("fs.appendFileSync(githubOutput, 'auth_mode=oidc\\n')"));
  assert.ok(deployWorkflow.includes('DEPLOY_SERVICE_ACCOUNT_INPUT: ${{ secrets.FIREBASE_STAGING_SERVICE_ACCOUNT || secrets.FIREBASE_STAGING_SERVICE_ACCOUNT_V2 }}'));
  assert.ok(functionsWorkflow.includes(serviceAccountCredential));
  const bootstrapFallback = 'secrets.FIREBASE_STAGING_SERVICE_ACCOUNT || secrets.FIREBASE_STAGING_BOOTSTRAP_SERVICE_ACCOUNT';
  assert.ok(!deployWorkflow.includes(bootstrapFallback), 'console deploy must not reuse the bootstrap credential');
  assert.ok(!functionsWorkflow.includes(bootstrapFallback), 'functions deploy must not reuse the bootstrap credential');
  assert.ok(functionsWorkflow.includes('workload_identity_provider: ${{ vars.ANAS_STAGING_WIF_PROVIDER }}'));
  assert.ok(functionsWorkflow.includes('service_account: ${{ vars.ANAS_STAGING_DEPLOYER_SERVICE_ACCOUNT }}'));
  assert.ok(functionsWorkflow.includes("steps.auth_preflight.outputs.auth_mode == 'json'"));
  assert.ok(functionsWorkflow.includes("steps.auth_preflight.outputs.auth_mode == 'oidc'"));
  assert.match(functionsWorkflow, /deploy-reverse-ledger-staging:\s*\n\s*if: \$\{\{ false \}\}/,
    'Functions deployment must remain frozen while the ActAs prerequisite is unresolved');
  assert.ok(functionsWorkflow.includes('FIREBASE_STAGING_BOOTSTRAP_SERVICE_ACCOUNT'));
  assert.ok(functionsWorkflow.includes('firebase-staging-bootstrap-service-account.json'));
  assert.ok(!functionsWorkflow.slice(0, functionsWorkflow.indexOf('jobs:')).includes('id-token: write'));
  assert.ok(bootstrapScript.includes("credential.project_id !== PROJECT_ID"));
  assert.ok(bootstrapScript.includes('Dedicated Staging Admin SDK bootstrap credential file is unavailable.'));
  assert.ok(bootstrapScript.includes(String.raw`!/^[^@\s]+@[^\s@]+\.[^\s@]+$/.test(email)`),
    'bootstrap email validation must use real whitespace/domain regex escapes');
  assert.ok(bootstrapScript.includes(String.raw`replace(/[\r\n]+/g, ' ').slice(0, 400) + '\n'`),
    'bootstrap logs must sanitize real line breaks and emit a newline');
  assert.ok(bootstrapScript.includes(String.raw`}) + '\n');`),
    'bootstrap success report must terminate with a real newline');

  assert.match(deployWorkflow, /--only hosting/);
  assert.match(deployWorkflow, /--project anas-erp-staging-a25e1/);
  assert.doesNotMatch(deployWorkflow, /--project anas-erb(?:\\s|$)/);
});

