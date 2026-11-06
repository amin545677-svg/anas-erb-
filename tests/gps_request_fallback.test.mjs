import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('GPS request provides visible progress, a longer timeout and manual-entry errors', async () => {
  const html = await readFile('index.html', 'utf8');
  const start = html.indexOf('function gpsErrorMessage(err)');
  const end = html.indexOf('function detectCustomerGPS()', start);
  assert.ok(start >= 0 && end > start, 'GPS helper must exist');
  const gps = html.slice(start, end);
  assert.ok(gps.includes('function requestGPS(onSuccess)'));
  assert.ok(gps.includes("button.textContent = '⏳ جارٍ تحديد الموقع…'"));
  assert.ok(gps.includes('timeout: 25000'));
  assert.ok(gps.includes('maximumAge: 300000'));
  assert.ok(gps.includes('restoreButton(); alert(gpsErrorMessage(error))'));
  assert.ok(gps.includes('أدخل الإحداثيات يدويًا'));
  assert.match(gps, /try\s*\{\s*navigator\.geolocation\.getCurrentPosition/);
  assert.match(gps, /catch\s*\(error\)\s*\{\s*restoreButton\(\);\s*alert\(gpsErrorMessage\(error\)\);/);
  assert.ok(gps.includes('أو أدخل الإحداثيات يدويًا'), 'synchronous failures must expose manual coordinate entry');
});

test('GPS button is restored when Android WebView throws synchronously', async () => {
  const html = await readFile('index.html', 'utf8');
  const start = html.indexOf('function gpsErrorMessage(err)');
  const end = html.indexOf('function detectCustomerGPS()', start);
  assert.ok(start >= 0 && end > start, 'GPS helper must exist');
  const gps = html.slice(start, end);
  const button = { tagName: 'BUTTON', textContent: 'تحديد الموقع', disabled: false, isConnected: true };
  const alerts = [];
  const context = {
    window: { isSecureContext: true },
    location: { protocol: 'https:' },
    document: { activeElement: button },
    navigator: {
      geolocation: {
        getCurrentPosition() { throw new Error('Permissions Policy blocked geolocation'); }
      }
    },
    alert(message) { alerts.push(message); }
  };
  const vm = await import('node:vm');
  vm.runInNewContext(gps + '\\nrequestGPS(() => {});', context);
  assert.equal(button.disabled, false, 'button must be re-enabled after synchronous failure');
  assert.equal(button.textContent, 'تحديد الموقع', 'original button label must be restored');
  assert.equal(alerts.length, 1, 'user must receive one actionable error');
  assert.match(alerts[0], /أدخل الإحداثيات يدويًا/);
});
