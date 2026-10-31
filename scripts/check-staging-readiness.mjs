#!/usr/bin/env node
'use strict';

// Fail-closed contract preflight for the isolated Firebase Staging financial callables.
// This check intentionally prints no secret values and never contacts Firebase.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const checks = [];
function requireText(file, text, label) {
  const source = read(file);
  const ok = source.includes(text);
  checks.push({ label, file, ok });
  if (!ok) throw new Error('Staging readiness contract failed: ' + label + ' (' + file + ')');
  return source;
}
function requirePattern(file, pattern, label) {
  const source = read(file);
  const ok = pattern.test(source);
  checks.push({ label, file, ok });
  if (!ok) throw new Error('Staging readiness contract failed: ' + label + ' (' + file + ')');
  return source;
}

const functionsIndex = requireText('functions/index.js', 'exports.executeSettlementAllocation', 'Callable is exported');
requirePattern('functions/index.js', /executeSettlementAllocation[\s\S]*?enforceAppCheck:\s*true/, 'Callable enforces App Check');
const service = requireText('functions/settlement-allocation-service.js', 'db.runTransaction', 'Allocation uses Firestore transaction');
requireText('functions/settlement-allocation-service.js', 'request.auth.uid', 'Allocation requires Firebase Auth');
requireText('functions/settlement-allocation-service.js', 'request.app', 'Allocation validates App Check context');
requireText('functions/settlement-allocation-service.js', 'PERMISSIONS.SETTLEMENT_ALLOCATION', 'Allocation checks financial grant permission');
requireText('functions/settlement-allocation-service.js', 'ReverseLedger.sealSettlementAllocation', 'Allocation seals immutable ledger records');
requireText('functions/settlement-allocation-service.js', "status: 'POSTED'", 'Operation is committed as POSTED');
requireText('functions/settlement-allocation-service.js', 'requestHash', 'Operation idempotency hash is enforced');
requireText('staging/reverse-ledger-gateway.js', 'executeSettlementAllocation', 'Staging gateway exposes allocation callable');
requireText('staging/reverse-ledger-gateway.js', 'httpsCallable', 'Staging gateway uses Firebase callable transport');
const modal = requireText('reverse-ledger/settlement-allocation-modal.js', 'ANASSettlementAllocationServer', 'Allocation modal requires trusted gateway');
requireText('reverse-ledger/settlement-allocation-modal.js', 'gateway.execute(request)', 'Allocation modal invokes callable adapter');
requirePattern('reverse-ledger/settlement-allocation-modal.js', /async function submit\([\s\S]*?gateway\.execute\(request\)/, 'Allocation submit awaits server result');
if (/saveDB\s*\(/.test(modal)) throw new Error('Staging readiness contract failed: modal must not persist allocations through saveDB().');
checks.push({ label: 'Allocation modal has no local saveDB posting', file: 'reverse-ledger/settlement-allocation-modal.js', ok: true });
const deploy = requireText('.github/workflows/deploy-reverse-ledger-functions-staging.yml', 'functions:executeSettlementAllocation', 'Staging deployment allowlists allocation callable');
requireText('.github/workflows/deploy-reverse-ledger-functions-staging.yml', 'anas-erp-staging-a25e1', 'Deployment targets isolated Staging project');
requireText('scripts/verify-live-staging-e2e.mjs', 'allocationPostedThroughModal: true', 'Live E2E records browser allocation proof');
requireText('tests/reverse_ledger_firestore_emulator.test.js', 'createSettlementHandler', 'Firestore Emulator covers allocation callable');
requireText('tests/reverse_ledger_firestore_emulator.test.js', 'serializes two-device allocation races', 'Firestore Emulator covers concurrent allocation ceiling');
requireText('tests/settlement_allocation_modal_chromium.test.mjs', 'uses the callable', 'Chromium covers allocation modal gateway');
requireText('index.html', 'V42', 'Production shell retains V42 identity');

const report = {
  ok: true,
  projectId: 'anas-erp-staging-a25e1',
  callable: 'executeSettlementAllocation',
  checks: checks.length,
  passed: checks.filter(x => x.ok).length,
  failed: checks.filter(x => !x.ok).length,
  files: [...new Set(checks.map(x => x.file))],
  indexSha256: crypto.createHash('sha256').update(read('index.html')).digest('hex')
};
process.stdout.write('STAGING_READINESS_REPORT ' + JSON.stringify(report) + '\\n');
