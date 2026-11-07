import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadGpsContext(geolocation, button, alerts) {
  const html = await readFile('index.html', 'utf8');
  const start = html.indexOf('function gpsErrorMessage(err)');
  const end = html.indexOf('function detectCustomerGPS()', start);
  assert.ok(start >= 0 && end > start, 'GPS helper must exist');
  const context = {
    window: { isSecureContext: true },
    location: { protocol: 'https:' },
    document: { activeElement: button },
    navigator: { geolocation },
    alert(message) { alerts.push(message); }
  };
  vm.runInNewContext(html.slice(start, end), context);
  return context;
}

test('GPS request restores the button after synchronous Android WebView failure', async () => {
  const button = { tagName:'BUTTON', textContent:'تحديد الموقع', disabled:false, isConnected:true };
  const alerts = [];
  const context = await loadGpsContext({
    getCurrentPosition() { throw new Error('Permissions Policy blocked geolocation'); }
  }, button, alerts);
  context.requestGPS(() => {}, 'customer');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'تحديد الموقع');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /أدخل الإحداثيات يدويًا/);
});

test('saving or closing the customer form invalidates a late geolocation timeout callback', async () => {
  const button = { tagName:'BUTTON', textContent:'تحديد الموقع', disabled:false, isConnected:true };
  const alerts = [];
  let lateError;
  const context = await loadGpsContext({
    getCurrentPosition(_success, error) { lateError = error; }
  }, button, alerts);
  context.requestGPS(() => {}, 'customer');
  assert.equal(button.disabled, true, 'GPS request should show active progress');
  context.cancelPendingCustomerGpsRequest();
  assert.equal(button.disabled, false, 'cancellation must restore the GPS button');
  lateError({ code:3 });
  assert.equal(alerts.length, 0, 'a late timeout after save/close must not alert the user');
});
