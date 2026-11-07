const test = require('node:test');
const assert = require('node:assert/strict');
const gatewayModule = require('../staging/reverse-ledger-gateway.js');

const baseConfig = {
  firebaseConfig: { apiKey: 'staging-public-api-key', appId: '1:123:web:staging', projectId: gatewayModule.stagingProjectId },
  allowedOrigins: ['https://anas-erp-staging-a25e1.web.app'],
  functionsRegion: 'us-central1'
};
const location = { protocol: 'https:', hostname: 'anas-erp-staging-a25e1.web.app', origin: 'https://anas-erp-staging-a25e1.web.app' };

function makeFirebase({ withAppCheck = false } = {}) {
  const calls = { activated: [], tokenReads: 0, callable: [] };
  const app = { options: { ...baseConfig.firebaseConfig } };
  const user = { async getIdToken(forceRefresh) { assert.equal(forceRefresh, true); return 'staging-id-token'; } };
  const functions = { httpsCallable(name) { return async request => {
    calls.callable.push({ name, request });
    return { data: name === 'executeReverseLedger'
      ? { ok: true, operationId: request.operationId, document: { status: 'POSTED', returnId: 'RET-STAGE-1' } }
      : { ok: true, status: 'POSTED', operationId: request.operationId, allocations: [{ id: 'ALLOC-1' }] } };
  }; } };
  const firebase = {
    initializeApp(config) { assert.deepEqual(config, baseConfig.firebaseConfig); return app; },
    app(name) { if (name) throw new Error('named app not initialized'); return app; },
    auth() { return { currentUser: user }; },
    functions() { return functions; }
  };
  if (withAppCheck) firebase.appCheck = () => ({
    activate(key, autoRefresh) { calls.activated.push({ key, autoRefresh }); },
    async getToken(forceRefresh) { calls.tokenReads++; assert.equal(forceRefresh, false); return { token: 'valid-staging-app-check-token' }; }
  });
  return { firebase, calls };
}
const reverseRequest = { operationId: 'REV-STAGE-00000001', periodId: 'PERIOD-STAGE-1', invoiceId: 'INV-STAGE-1' };
const allocationRequest = { operationId: 'ALLOC-STAGE-0000001', periodId: 'PERIOD-STAGE-1' };

test('App Check site key is optional during staging client configuration validation', () => {
  assert.equal(gatewayModule.validateConfig(baseConfig, location), baseConfig);
  assert.equal(gatewayModule.validateConfig({ ...baseConfig, appCheckSiteKey: '' }, location).firebaseConfig.projectId, gatewayModule.stagingProjectId);
});

test('initializes staging Auth and Functions without App Check SDK or site key', () => {
  const { firebase, calls } = makeFirebase();
  const client = gatewayModule.initialize(baseConfig, { firebase, location });
  assert.equal(client.appCheck, null);
  assert.ok(client.auth.currentUser);
  assert.equal(typeof client.gateway.execute, 'function');
  assert.equal(typeof client.settlementAllocationGateway.execute, 'function');
  assert.deepEqual(calls.activated, []);
});

test('without App Check, protected reverse-ledger and settlement calls fail closed before network invocation', async () => {
  const { firebase, calls } = makeFirebase();
  const client = gatewayModule.initialize(baseConfig, { firebase, location });
  await assert.rejects(client.gateway.execute(reverseRequest), /requires a valid staging App Check token/);
  await assert.rejects(client.settlementAllocationGateway.execute(allocationRequest), /requires a valid staging App Check token/);
  assert.equal(calls.callable.length, 0);
});

test('with App Check site key, activates App Check and permits protected reverse-ledger call with token', async () => {
  const { firebase, calls } = makeFirebase({ withAppCheck: true });
  const client = gatewayModule.initialize({ ...baseConfig, appCheckSiteKey: 'staging-recaptcha-site-key' }, { firebase, location });
  assert.deepEqual(calls.activated, [{ key: 'staging-recaptcha-site-key', autoRefresh: true }]);
  const result = await client.gateway.execute(reverseRequest);
  assert.equal(result.ok, true);
  assert.equal(result.document.status, 'POSTED');
  assert.equal(calls.tokenReads, 1);
  assert.equal(calls.callable.length, 1);
});

test('with App Check site key, permits protected settlement allocation call with token', async () => {
  const { firebase, calls } = makeFirebase({ withAppCheck: true });
  const client = gatewayModule.initialize({ ...baseConfig, appCheckSiteKey: 'staging-recaptcha-site-key' }, { firebase, location });
  const result = await client.settlementAllocationGateway.execute(allocationRequest);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'POSTED');
  assert.equal(calls.tokenReads, 1);
  assert.equal(calls.callable[0].name, 'executeSettlementAllocation');
});

test('rejects an invalid App Check token before protected network calls', async () => {
  const { firebase, calls } = makeFirebase({ withAppCheck: true });
  firebase.appCheck = () => ({ activate() {}, async getToken() { return { token: '' }; } });
  const client = gatewayModule.initialize({ ...baseConfig, appCheckSiteKey: 'staging-recaptcha-site-key' }, { firebase, location });
  await assert.rejects(client.gateway.execute(reverseRequest), /valid staging App Check token is required/);
  assert.equal(calls.callable.length, 0);
});

test('requires App Check compat SDK only when a site key is configured', () => {
  const { firebase } = makeFirebase();
  assert.doesNotThrow(() => gatewayModule.initialize(baseConfig, { firebase, location }));
  assert.throws(() => gatewayModule.initialize({ ...baseConfig, appCheckSiteKey: 'staging-recaptcha-site-key' }, { firebase, location }), /App Check compat SDK is required/);
});

test('Firebase enforces shared App Check options server-side on all protected staging callables', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../functions/index.js'), 'utf8');
  const sharedStart = source.indexOf('const CALLABLE_BASE_OPTIONS = Object.freeze({');
  const sharedEnd = source.indexOf('});', sharedStart);
  assert.ok(sharedStart >= 0 && sharedEnd > sharedStart, 'all callables must inherit the shared runtime policy');
  const shared = source.slice(sharedStart, sharedEnd);
  assert.match(shared, /region:\\s*['"]us-central1['"]/);
  assert.match(shared, /enforceAppCheck:\\s*true/, 'shared options must enforce App Check');
  assert.match(shared, /timeoutSeconds:\\s*60/);
  for (const name of [
    'executeReverseLedger',
    'executeSettlementAllocation',
    'createTrustedReverseLedgerBackup',
    'restoreTrustedReverseLedgerBackup'
  ]) {
    const declarationStart = source.indexOf('exports.' + name + ' = onCall({');
    const declarationEnd = source.indexOf('},', declarationStart);
    assert.ok(declarationStart >= 0 && declarationEnd > declarationStart, name + ' must be registered as a Firebase callable');
    assert.ok(source.slice(declarationStart, declarationEnd).includes('...CALLABLE_BASE_OPTIONS'),
      name + ' must inherit the shared App Check policy');
  }
});