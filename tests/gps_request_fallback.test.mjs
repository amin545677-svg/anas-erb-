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
    document: {
      activeElement: button,
      getElementById(id) {
        return id === 'addCustomerModal' ? { classList: { contains: () => true } } : null;
      }
    },
    navigator: { geolocation },
    setTimeout() { return 1; },
    clearTimeout() {},
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

test('customer save and close handlers both cancel the pending GPS timer', async () => {
  const html = await readFile('index.html', 'utf8');
  const saveStart = html.indexOf('function saveNewCustomerMpos()');
  const saveEnd = html.indexOf('function openCustomerDirectory()', saveStart);
  const closeStart = html.indexOf('function closeModal(id)');
  const closeEnd = html.indexOf('function openMultiScreenModal()', closeStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart, 'customer save handler must exist');
  assert.ok(closeStart >= 0 && closeEnd > closeStart, 'modal close handler must exist');
  assert.match(html.slice(saveStart, saveEnd), /cancelPendingCustomerGpsRequest\(\)/);
  assert.match(html.slice(closeStart, closeEnd), /id === 'addCustomerModal'\) cancelPendingCustomerGpsRequest\(\)/);
});
