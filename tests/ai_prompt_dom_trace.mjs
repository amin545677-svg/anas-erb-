import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const port = 4173;
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
  stdio: 'ignore'
});
const events = [];
const add = (event, details = {}) => {
  events.push({ at: new Date().toISOString(), event, ...details });
};
let browser;
try {
  await delay(700);
  browser = await chromium.launch({ headless: true });
  // A brand-new in-memory browser context: no user profile, cookies, or saved app data.
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  // Storage belongs only to this fresh, disposable browser context.
  // Preserve normal app startup while recording API access without recording keys or values.
  await page.addInitScript(() => {
    const accesses = [];
    const record = label => {
      accesses.push(label);
      if (accesses.length > 100) accesses.shift();
    };
    try {
      for (const method of ['getItem', 'setItem', 'removeItem', 'clear']) {
        const original = Storage.prototype[method];
        Object.defineProperty(Storage.prototype, method, {
          configurable: true,
          value: function (...args) {
            record('storage.' + method);
            return original.apply(this, args);
          }
        });
      }
    } catch (_) { record('storage.instrumentation-unavailable'); }
    try {
      for (const method of ['open', 'deleteDatabase']) {
        const original = IDBFactory.prototype[method];
        Object.defineProperty(IDBFactory.prototype, method, {
          configurable: true,
          value: function (...args) {
            record('indexedDB.' + method);
            return original.apply(this, args);
          }
        });
      }
    } catch (_) { record('indexedDB.instrumentation-unavailable'); }
    Object.defineProperty(window, '__anasStorageAccessLabels', {
      configurable: false,
      value: accesses
    });
  });

  // Allow only the local test server. External scripts/APIs and remote data are blocked.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' && url.port === String(port)) {
      await route.continue();
    } else {
      add('external_request_blocked', { resourceType: route.request().resourceType() });
      await route.abort('blockedbyclient');
    }
  });

  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[AnasAI Trace]')) {
      // Preserve only the diagnostic label, never arbitrary console payloads.
      const match = text.match(/\[AnasAI Trace\]\s*([^\s]+)/);
      add('console_trace', { label: match?.[1] ?? 'trace' });
    }
  });
  page.on('pageerror', error => add('page_error', { errorClass: String(error?.name || 'Error') }));

  await page.goto(`http://127.0.0.1:${port}/index.html?anasDiagIsolated=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const isolation = await page.evaluate(() => ({
    diagnosticMode: window.__ANAS_ISOLATED_DIAGNOSTIC__ === true,
    firebaseInitialized: !!window.firebase,
    serviceWorkerController: !!navigator.serviceWorker?.controller
  }));
  add('isolation_guards', isolation);
  if (!isolation.diagnosticMode || isolation.firebaseInitialized || isolation.serviceWorkerController) {
    add('isolation_guard_failed');
    throw new Error('Isolated preview guard verification failed');
  }
  add('document_loaded', { readyState: await page.evaluate(() => document.readyState) });
  add('isolated_storage_access_status', await page.evaluate(() => ({ ephemeralContextOnly: true, recordedApiLabels: window.__anasStorageAccessLabels || [] })));

  const hubButton = page.getByRole('button', { name: /مركز الذكاء الاصطناعي/ }).first();
  if (await hubButton.count()) {
    await hubButton.click({ timeout: 10000 }).catch(() => add('hub_button_click_failed'));
  } else {
    add('hub_button_not_found');
  }
  await page.waitForTimeout(1200);
  add('ai_hub_state', await page.evaluate(() => ({
    hubContainerFound: !!document.getElementById('aiHubTabContent'),
    questionFound: !!document.getElementById('anasAiQuestion'),
    questionConnected: !!document.getElementById('anasAiQuestion')?.isConnected,
    renderFunctionAvailable: typeof window.renderAiHub === 'function',
    promptFunctionAvailable: typeof window.anasSetAiPrompt === 'function'
  })));

  const inventoryButton = page.getByRole('button', { name: /مراجعة المخزون/ }).first();
  if (await inventoryButton.count()) {
    await inventoryButton.click({ timeout: 10000 }).catch(() => add('inventory_button_click_failed'));
    await page.waitForTimeout(300);
    add('inventory_prompt_result', await page.evaluate(() => {
      const input = document.getElementById('anasAiQuestion');
      return {
        inputFound: !!input,
        inputConnected: !!input?.isConnected,
        promptInserted: !!input && input.value.length > 0,
        focused: document.activeElement === input
      };
    }));
  } else {
    add('inventory_button_not_found');
  }

  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/ai-prompt-trace.json', JSON.stringify({
    mode: 'isolated-local-browser',
    externalNetwork: 'blocked',
    serviceWorkers: 'blocked',
    browserProfile: 'fresh-ephemeral-context',
    businessDataCaptured: false,
    secretsCaptured: false,
    events
  }, null, 2));
  await context.close();
  const last = events.find(e => e.event === 'inventory_prompt_result');
  if (!last || !last.promptInserted) process.exitCode = 1;
} catch (error) {
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/ai-prompt-trace.json', JSON.stringify({
    mode: 'isolated-local-browser',
    error: String(error?.name || 'Error'),
    detail: 'exception message suppressed',
    events
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill('SIGTERM');
}
