import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = file => file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';

test('staging console signs in, reads cloud snapshot, uses trusted backup callables and opens reverse modal', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anas-staging-console-'));
  const stagingDir = path.join(temp, 'staging');
  const reverseDir = path.join(temp, 'reverse-ledger');
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(reverseDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'staging/index.html'), path.join(stagingDir, 'index.html'));
  fs.copyFileSync(path.join(repoRoot, 'staging/reverse-ledger-gateway.js'), path.join(stagingDir, 'reverse-ledger-gateway.js'));
  fs.copyFileSync(path.join(repoRoot, 'reverse-ledger/reverse-ledger.js'), path.join(reverseDir, 'reverse-ledger.js'));
  fs.copyFileSync(path.join(repoRoot, 'reverse-ledger/reverse-ledger-modal.js'), path.join(reverseDir, 'reverse-ledger-modal.js'));
  fs.copyFileSync(path.join(repoRoot, 'reverse-ledger/settlement-allocation-modal.js'), path.join(reverseDir, 'settlement-allocation-modal.js'));

  const snapshotPayload = JSON.stringify({ invoices: [], purchases: [], products: [], customers: [], suppliers: [], returns: [] });
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const target = path.resolve(temp, '.' + pathname);
    if (!target.startsWith(temp + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': mime(target), 'cache-control': 'no-store' });
    fs.createReadStream(target).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  fs.writeFileSync(path.join(stagingDir, 'config.js'), `window.ANAS_REVERSE_LEDGER_STAGING_CONFIG = {
    firebaseConfig: { apiKey: "public-staging-key", authDomain: "anas-erp-staging-a25e1.firebaseapp.com", projectId: "anas-erp-staging-a25e1", appId: "1:123:web:staging" },
    appCheckSiteKey: "public-app-check-site-key",
    allowedOrigins: [${JSON.stringify(origin)}],
    functionsRegion: "us-central1"
  };`);

  const fakeSdk = `(() => {
    const app = { name: 'anas-erp-reverse-ledger-staging', options: { projectId: 'anas-erp-staging-a25e1', apiKey: 'public-staging-key', appId: '1:123:web:staging' } };
    let currentUser = null, authListener = null;
    const calls = [];
    const auth = {
      get currentUser() { return currentUser; },
      onAuthStateChanged(fn) { authListener = fn; fn(currentUser); return () => {}; },
      async signInWithEmailAndPassword(email, password) {
        if (!email || !password) throw new Error('missing credentials');
        currentUser = { uid: 'staging-test-user', getIdToken: async () => 'staging-id-token' };
        if (authListener) authListener(currentUser);
        return { user: currentUser };
      },
      async signOut() { currentUser = null; if (authListener) authListener(null); }
    };
    const db = { collection(name) { return { doc(uid) { return { collection(sub) { return { doc(id) { return { async get() {
      if (name !== 'users' || sub !== 'snapshots' || id !== 'latest' || uid !== 'staging-test-user') throw new Error('unexpected snapshot path');
      return { exists: true, get(field) { return field === 'payload' ? ${JSON.stringify(snapshotPayload)} : undefined; } };
    } }; } }; } }; } }; } };
    const functions = {
      httpsCallable(name) {
        return async data => {
          calls.push({ name, data });
          if (name === 'createTrustedReverseLedgerBackup') return { data: { ok: true, backupId: 'BKP-STAGING-00000001', operationCount: 0 } };
          if (name === 'restoreTrustedReverseLedgerBackup') return { data: { ok: true, restoredOperations: 0 } };
          if (name === 'executeReverseLedger') return { data: { ok: true, operationId: data.operationId, document: { returnId: 'RET-STAGING-1', status: 'POSTED' } } };
          if (name === 'executeSettlementAllocation') return { data: { ok: true, status: 'POSTED', operationId: data.operationId, allocations: [{ allocationId: 'ALLOC-STAGING-1', amountCentimes: data.allocations[0].amountCentimes }] } };
          throw new Error('unexpected callable ' + name);
        };
      }
    };
    globalThis.__stagingCalls = calls;
    globalThis.firebase = {
      initializeApp: () => app,
      app: name => { if (!name) { const error = new Error('app/no-app'); error.code = 'app/no-app'; throw error; } return app; },
      auth: () => auth,
      firestore: () => db,
      functions: () => functions,
      appCheck: () => ({ activate() {}, async getToken() { return { token: 'staging-app-check-token' }; } })
    };
  })();`;

  assert.doesNotThrow(() => new vm.Script(fakeSdk, { filename: 'fake-firebase-sdk.js' }));

  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  await page.route('https://www.gstatic.com/firebasejs/**', async route => {
    if (route.request().url().endsWith('/firebase-app-compat.js')) {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: fakeSdk });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: '// compat surface supplied by firebase-app-compat.js' });
    }
  });
  await page.goto(origin + '/staging/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('config-status').textContent.includes('تم التحقق'));
  await page.locator('#email').fill('staging@example.test');
  await page.locator('#password').fill('staging-only-password');
  await page.locator('#sign-in').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('#load-snapshot').click();
  await page.getByText('حالة القراءة: نجاح').waitFor();
  assert.equal(await page.locator('#sale-return').isEnabled(), true);
  assert.equal(await page.locator('#settlement-allocation').isEnabled(), true);
  await page.locator('#settlement-allocation').click();
  await page.locator('#modal-settlement-allocation.active').waitFor();
  const posted = await page.evaluate(() => window.ANASReverseLedgerServer.execute({
    operationId: 'REV-STAGING-00000001',
    periodId: 'FY-2026-10',
    invoiceId: 'INV-STAGE-1',
    originalInvoiceType: 'sales_invoice',
    returnType: 'SALE_RETURN',
    items: [{ productId: 'P-1', quantity: '1' }],
    settlementMode: 'cash',
    reason: 'Chromium callable smoke test'
  }));
  assert.equal(posted.document.returnId, 'RET-STAGING-1');
  const allocationPosted = await page.evaluate(() => window.ANASSettlementAllocationServer.execute({
    operationId: 'ALLOC-STAGING-00000001', periodId: 'FY-2026-10', partyType: 'customer', partyId: 'C-1',
    sourceMovementId: 'CASH-1', sourceMovementType: 'customer_debt',
    allocations: [{ invoiceId: 'INV-STAGE-1', amountCentimes: 1000 }]
  }));
  assert.equal(allocationPosted.status, 'POSTED');
  await page.locator('#create-backup').click();
  await page.getByText(/تم إنشاء النسخة الموثوقة/).waitFor();
  assert.equal(await page.locator('#backup-id').inputValue(), 'BKP-STAGING-00000001');
  await page.locator('#restore-backup').click();
  await page.getByText(/اكتملت الاستعادة والتحقق/).waitFor();
  await page.locator('#sale-return').click();
  await page.locator('#modal-reverse-ledger.active').waitFor();
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  const calls = await page.evaluate(() => globalThis.__stagingCalls.map(row => row.name));
  assert.deepEqual(calls, ['executeReverseLedger', 'executeSettlementAllocation', 'createTrustedReverseLedgerBackup', 'restoreTrustedReverseLedgerBackup']);
});
