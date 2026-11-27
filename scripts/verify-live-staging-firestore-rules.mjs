#!/usr/bin/env node
'use strict';

// Live negative authorization proof for the published Staging Firestore rules.
// This intentionally sends unauthenticated REST writes. A 401 is NOT accepted:
// the request must reach Firestore Rules and be rejected with PERMISSION_DENIED.
const PROJECT = 'anas-erp-staging-a25e1';
const DATABASE = '(default)';
const COLLECTIONS = [
  'reverseLedgerEntries',
  'reverseLedgerOperations',
  'reverseLedgerState',
  'financialPeriods'
];

export async function verifyLiveStagingRules({ fetchImpl = globalThis.fetch, project = PROJECT } = {}) {
  if (project !== PROJECT) throw new Error('Refusing live rules verification outside the isolated Staging project');
  const results = [];
  for (const collection of COLLECTIONS) {
    const docId = 'staging_acceptance_rule_probe_' + crypto.randomUUID().replaceAll('-', '');
    const url = 'https://firestore.googleapis.com/v1/projects/' + project +
      '/databases/' + encodeURIComponent(DATABASE) + '/documents/' +
      collection + '/' + docId;
    const response = await fetchImpl(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { probe: { stringValue: 'must_be_rejected' } } })
    });
    const body = await response.text();
    let payload = {};
    try { payload = JSON.parse(body); } catch {}
    const statusText = String(payload.error?.status || '');
    const message = String(payload.error?.message || body);
    if (response.status === 403 && (statusText === 'PERMISSION_DENIED' || /permission denied|insufficient permissions/i.test(message))) {
      results.push({ collection, result: 'PERMISSION_DENIED', status: response.status });
      continue;
    }
    if (response.ok) {
      // Defensive cleanup if an unexpected permissive rule accepted the probe.
      await fetchImpl(url, { method: 'DELETE' }).catch(() => undefined);
      throw new Error('SECURITY FAILURE: unauthenticated direct write unexpectedly succeeded for ' + collection);
    }
    throw new Error('Rules proof inconclusive for ' + collection + ': HTTP ' + response.status + ' ' + message);
  }
  return { projectId: project, result: 'PASS', unauthenticatedDirectWriteRejections: results };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  verifyLiveStagingRules().then(result => {
    console.log('ANAS_STAGING_FIRESTORE_RULES_PROOF ' + JSON.stringify(result));
  }).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
