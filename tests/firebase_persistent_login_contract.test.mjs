import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('index.html', 'utf8');

test('Firebase email and Google login both persist sessions on this device', () => {
  assert.match(html, /auth\.setPersistence\(window\.firebase\.auth\.Auth\.Persistence\.LOCAL\)/,
    'Firebase Auth must use LOCAL persistence before observing the restored session');
  assert.match(html, /auth\.setPersistence\(firebase\.auth\.Auth\.Persistence\.LOCAL\)/,
    'email and Google sign-in must explicitly retain LOCAL persistence');
  assert.match(html, /auth\.onAuthStateChanged\(u=>\{/,
    'startup must restore the saved Firebase account and update the visible session status');
  assert.match(html, /auth\.getRedirectResult\(\)/,
    'Google redirect completion must be processed after returning to the app');
  assert.match(html, /window\.anasFirebaseLogout=async function\(\)/,
    'the user must retain an explicit sign-out control');
  assert.doesNotMatch(html, /provider\.setCustomParameters\(\{prompt:'select_account'\}\)/,
    'Google login must not force an account chooser on every manual re-authentication');
});
