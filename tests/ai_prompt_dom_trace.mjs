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

  // Block persistent-storage writes before application scripts execute.
  // If the app requires these APIs to render, the resulting trace will expose that dependency.
  await page.addInitScript(() => {
    const blocked = [];
    const blockMethod = (target, method, label) => {
      try {
        Object.defineProperty(target, method, {
          configurable: true,
          value: function () {
            blocked.push(label);
            throw new DOMException('Blocked by isolated diagnostic harness', 'SecurityError');
          }
        });
      } catch (_) { blocked.push(label + ':override-failed'); }
    };
    try {
      blockMethod(Storage.prototype, 'setItem', 'storage.setItem');
      blockMethod(Storage.prototype, 'removeItem', 'storage.removeItem');
      blockMethod(Storage.prototype, 'clear', 'storage.clear');
    } catch (_) {}
    try {
      blockMethod(IDBFactory.prototype, 'open', 'indexedDB.open');
      blockMethod(IDBFactory.prototype, 'deleteDatabase', 'indexedDB.deleteDatabase');
    } catch (_) {}
    Object.defineProperty(window, '__anasBlockedStorageAttempts', {
      configurable: false,
      value: blocked
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
  page.on('pageerror', () => add('page_error', { detail: 'message suppressed to avoid leaking app data' }));

  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  add('document_loaded', { readyState: await page.evaluate(() => document.readyState) });
  add('storage_write_block_status', await page.evaluate(() => ({ blockedWriteAttempts: window.__anasBlockedStorageAttempts || [] })));

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
