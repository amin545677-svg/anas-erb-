#!/usr/bin/env node
'use strict';

// Read-only release-candidate audit. Run from the checked-out candidate repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const EXPECTED_MAIN_INDEX_BLOB = '526cd060b331cdd9cb2415033673f1943ce60a09';
const run = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

run(['fetch', '--no-tags', '--depth=1', 'origin', 'main']);
const mainBlob = run(['rev-parse', 'origin/main:index.html']).trim();
assert.equal(mainBlob, EXPECTED_MAIN_INDEX_BLOB, 'Production V42 index.html blob changed; audit refuses to continue.');

const mainHtml = run(['show', 'origin/main:index.html']);
const candidateHtml = fs.readFileSync('index.html', 'utf8');
const extract = (source, pattern) => [...new Set([...source.matchAll(pattern)].map((match) => match[1]))];
const mainIds = extract(mainHtml, /\bid\s*=\s*["']([^"']+)["']/g);
const candidateIds = new Set(extract(candidateHtml, /\bid\s*=\s*["']([^"']+)["']/g));
const mainFunctions = extract(mainHtml, /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g);
const candidateFunctions = new Set(extract(candidateHtml, /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g));
const missingIds = mainIds.filter((id) => !candidateIds.has(id));
const missingFunctions = mainFunctions.filter((name) => !candidateFunctions.has(name));
assert.equal(missingIds.length, 0, 'V42 DOM identifiers are missing: ' + missingIds.join(', '));
assert.equal(missingFunctions.length, 0, 'V42 functions are missing: ' + missingFunctions.join(', '));

const tracked = run(['ls-files']).split('\n').filter(Boolean);
const sourceFiles = tracked.filter((p) => /\.(?:js|mjs|cjs)$/.test(p) && !/(^|\/)(?:tests?|__tests__|node_modules|vendor)\//.test(p));
const byHash = new Map();
for (const path of sourceFiles) {
  if (!fs.existsSync(path)) continue;
  const hash = run(['hash-object', path]).trim();
  const prior = byHash.get(hash) || [];
  prior.push(path);
  byHash.set(hash, prior);
}
const intentionalMirrors = new Set([
  ['reverse-ledger/reverse-ledger.js', 'functions/lib/reverse-ledger.js'].sort().join('|'),
  ['reverse-ledger/authorization.js', 'functions/lib/authorization.js'].sort().join('|')
]);
const duplicateGroups = [...byHash.values()].filter((paths) => paths.length > 1);
const unexpectedDuplicates = duplicateGroups.filter((paths) => !intentionalMirrors.has(paths.slice().sort().join('|')));
assert.equal(unexpectedDuplicates.length, 0, 'Byte-identical duplicate source modules found: ' + JSON.stringify(unexpectedDuplicates));

const storageSource = fs.readFileSync('storage/android-resilient-storage.js', 'utf8');
const hasIndexedDb = /indexedDB\\s*\\.\\s*open\\s*\\(/i.test(storageSource);
assert.ok(hasIndexedDb, 'Android resilient storage module must open the IndexedDB database.');
assert.ok(storageSource.includes('anas_erp_v42_resilient_db'), 'Canonical V42 resilient IndexedDB database name is missing.');
const hasLocalStorage = /localStorage\s*\./i.test(candidateHtml);
const hasStorageErrorHandling = /try\s*\{[\s\S]{0,1200}(?:indexedDB|localStorage)[\s\S]{0,1200}\}\s*catch/i.test(candidateHtml);

assert.ok(hasLocalStorage, 'localStorage fallback/reference is missing from the V42 application shell.');
assert.ok(hasStorageErrorHandling, 'Storage operations lack a nearby try/catch failure boundary.');
console.log(JSON.stringify({
  audit: 'PASS',
  productionMainBlob: mainBlob,
  domIds: { checked: mainIds.length, missing: missingIds.length, retentionPercent: 100 },
  functions: { checked: mainFunctions.length, missing: missingFunctions.length, retentionPercent: 100 },
  duplicateSourceGroups: duplicateGroups.length,
  unexpectedDuplicateSourceGroups: unexpectedDuplicates.length,
  androidStorageStaticSmoke: { indexedDbOpen: hasIndexedDb, localStorageFallback: hasLocalStorage, guardedStorageAccess: hasStorageErrorHandling },
  note: 'Static source audit only; Android WebView/device behavior still requires field testing.'
}, null, 2));
