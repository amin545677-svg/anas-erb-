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
  assert.match(gps, /try\\s*\\{\\s*navigator\\.geolocation\\.getCurrentPosition/);
  assert.match(gps, /catch\\s*\\(error\\)\\s*\\{\\s*restoreButton\\(\\);\\s*alert\\(gpsErrorMessage\\(error\\)\\);/);
  assert.ok(gps.includes('أو أدخل الإحداثيات يدويًا'), 'synchronous failures must expose manual coordinate entry');
});
