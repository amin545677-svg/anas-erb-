const test = require('node:test');
const assert = require('node:assert/strict');
const Client = require('../staging/reverse-ledger-gateway.js');

const config = {
  firebaseConfig: {
    apiKey: 'staging-public-api-key',
    appId: '1:123:web:staging',
    projectId: 'anas-erp-staging-a25e1'
  },
  appCheckSiteKey: 'staging-app-check-site-key',
  allowedOrigins: ['https://staging.example.test'],
  functionsRegion: 'us-central1'
};
const location = { protocol: 'https:', hostname: 'staging.example.test', origin: 'https://staging.example.test' };

function fakeFirebase(options = {}) {
  const calls = { initialized: [], appCheckActivated: [], callable: [], refreshed: 0 };
  const app = { name: 'anas-erp-reverse-ledger-staging', options: config.firebaseConfig };
  const auth = { currentUser: options.signedIn === false ? null : { getIdToken: async force => {
    assert.equal(force, true); calls.refreshed++; return 'staging-id-token';
  } } };
  const appCheck = {
    activate: (key, refresh) => calls.appCheckActivated.push([key, refresh]),
    getToken: async () => options.missingAppCheck ? null : { token: 'staging-app-check-token' }
  };
  const functions = { httpsCallable: name => async request => {
    calls.callable.push({ name, request });
    if (options.callableError) throw options.callableError;
    return { data: options.result || { ok: true, operationId: request.operationId, document: { returnId: 'RET-STAGE-1', status: 'POSTED' } } };
  } };
  const firebase = {
    initializeApp: (cfg, name) => { calls.initialized.push({ cfg, name }); return app; },
    app: () => { const error = new Error('app/no-app'); error.code = 'app/no-app'; throw error; },
    auth: () => auth,
    appCheck: () => appCheck,
    functions: () => functions
  };
  return { firebase, calls };
}
const request = {
  operationId: 'REV-STAGE-00000001',
  periodId: 'FY-2026-10',
  invoiceId: 'INV-STAGE-1',
  originalInvoiceType: 'sales_invoice',
  returnType: 'SALE_RETURN',
  items: [{ productId: 'P-1', quantity: '1' }],
  settlementMode: 'credit',
  reason: 'staging verification'
};

test('refuses production Firebase project configuration', () => {
  assert.throws(() => Client.validateConfig({
    ...config, firebaseConfig: { ...config.firebaseConfig, projectId: 'anas-erb' }
  }, location), /outside the dedicated staging Firebase project/);
});

test('requires HTTPS and an explicit allowed staging origin', () => {
  assert.throws(() => Client.validateConfig(config, { ...location, protocol: 'http:' }), /requires HTTPS/);
  assert.throws(() => Client.validateConfig(config, { ...location, origin: 'https://other.example.test' }), /not allowlisted/);
  assert.throws(() => Client.validateConfig({ ...config, allowedOrigins: [] }, location), /allowedOrigins/);
});

test('initializes the named staging app, App Check and callable endpoint', async () => {
  const { firebase, calls } = fakeFirebase();
  const client = Client.initialize(config, { firebase, location });
  assert.equal(calls.initialized.length, 1);
  assert.equal(calls.initialized[0].name, 'anas-erp-reverse-ledger-staging');
  assert.deepEqual(calls.appCheckActivated, [['staging-app-check-site-key', true]]);
  const result = await client.gateway.execute(request);
  assert.equal(result.ok, true);
  assert.equal(result.document.status, 'POSTED');
  assert.equal(calls.refreshed, 1);
  assert.equal(calls.callable.length, 1);
  assert.equal(calls.callable[0].name, 'executeReverseLedger');
  assert.equal(calls.callable[0].request, request);
});

test('blocks posting without a signed-in staging user or App Check token', async () => {
  const unsigned = fakeFirebase({ signedIn: false });
  const clientA = Client.initialize(config, unsigned);
  await assert.rejects(clientA.gateway.execute(request), /Sign in to the dedicated/);
  assert.equal(unsigned.calls.callable.length, 0);

  const noAppCheck = fakeFirebase({ missingAppCheck: true });
  const clientB = Client.initialize(config, noAppCheck);
  await assert.rejects(clientB.gateway.execute(request), /App Check token/);
  assert.equal(noAppCheck.calls.callable.length, 0);
});

test('rejects malformed operation IDs and unconfirmed callable responses', async () => {
  const { firebase } = fakeFirebase();
  const client = Client.initialize(config, { firebase, location });
  await assert.rejects(client.gateway.execute({ ...request, operationId: 'bad' }), /operationId format/);
  const invalid = fakeFirebase({ result: { ok: true, document: {} } });
  const invalidClient = Client.initialize(config, invalid);
  await assert.rejects(invalidClient.gateway.execute(request), /confirmed posted document/);
});

test('propagates callable failures without reporting a local success', async () => {
  const { firebase } = fakeFirebase({ callableError: new Error('permission-denied') });
  const client = Client.initialize(config, { firebase, location });
  await assert.rejects(client.gateway.execute(request), /permission-denied/);
});
