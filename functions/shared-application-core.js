'use strict';
/** Runtime-neutral financial application primitives. Platform capabilities are injected. */
function normalizeRequest(input, normalizer) {
  if (typeof normalizer !== 'function') throw new TypeError('request normalizer is required');
  return normalizer(input);
}
function authorizeFinancialScope(context, authorize) {
  if (typeof authorize !== 'function') throw new TypeError('financial scope authorizer is required');
  const grant = context && context.grant;
  if (!grant || typeof grant.tenantId !== 'string' || !grant.tenantId.trim() ||
      !Array.isArray(grant.storeIds) || grant.storeIds.length === 0) {
    const error = new Error('Trusted tenantId and storeIds scope is required.');
    error.code = 'permission-denied'; throw error;
  }
  return authorize(context);
}
function requestHash(normalizedRequest, sha256Hex) {
  if (typeof sha256Hex !== 'function') throw new TypeError('sha256Hex dependency is required');
  const digest = sha256Hex(JSON.stringify(normalizedRequest));
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/i.test(digest)) throw new TypeError('sha256Hex must return a 64-character hexadecimal digest');
  return digest.toLowerCase();
}
function buildOperationRecord(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('operation record fields are required');
  for (const key of ['ownerUid', 'operationId', 'operationType', 'requestHash', 'status'])
    if (typeof fields[key] !== 'string' || !fields[key]) throw new TypeError('operation record ' + key + ' is required');
  if (!/^[a-f0-9]{64}$/i.test(fields.requestHash)) throw new TypeError('operation record requestHash is invalid');
  return Object.freeze({ ...fields });
}
function resolveIdempotency(previous, { uid, requestHash: expectedHash, operationType }) {
  if (!previous) return Object.freeze({ replay: false });
  if (previous.ownerUid !== uid) { const error = new Error('operationId belongs to another Firebase user.'); error.code = 'already-exists'; throw error; }
  if (previous.status === 'POSTED') {
    if (previous.requestHash !== expectedHash || (operationType && previous.operationType !== operationType) || !previous.result) {
      const error = new Error('IDEMPOTENCY_PAYLOAD_MISMATCH: operationId was already used for a different financial operation.');
      error.code = 'already-exists'; error.details = { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' }; throw error;
    }
    return Object.freeze({ replay: true, result: previous.result });
  }
  return Object.freeze({ replay: false, previous });
}
module.exports = Object.freeze({ normalizeRequest, authorizeFinancialScope, requestHash, buildOperationRecord, resolveIdempotency });
