#!/usr/bin/env node
'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';

const browserEngine = fs.readFileSync('reverse-ledger/reverse-ledger.js', 'utf8');
const serverEngine = fs.readFileSync('functions/lib/reverse-ledger.js', 'utf8');
const factoryMarker = 'function() {';
const browserStart = browserEngine.indexOf(factoryMarker);
const serverStart = serverEngine.indexOf(factoryMarker);

assert.ok(browserStart > 0 && serverStart > 0, 'both reverse-ledger modules must expose the shared domain factory');
assert.equal(
  browserEngine.slice(browserStart),
  serverEngine.slice(serverStart),
  'shared reverse-ledger domain implementation must remain byte-identical'
);
assert.match(browserEngine.slice(0, browserStart), /localPostReturnTransaction\s*=\s*api\.executeReturnTransaction/,
  'browser wrapper must expose only the explicit local-posting entry point');
assert.match(serverEngine.slice(0, serverStart), /typeof window !== 'undefined'\) delete runtimeApi\.executeReturnTransaction/,
  'server wrapper must keep transaction execution private');
console.log('PASS: shared reverse-ledger domain core is identical; browser-only local posting wrapper is isolated.');
