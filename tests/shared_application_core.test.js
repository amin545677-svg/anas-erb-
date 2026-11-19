'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../functions/shared-application-core.js');
const { createHash } = require('node:crypto');
test('normalization delegates to the injected canonical normalizer', () => assert.equal(core.normalizeRequest({ id: 'x' }, value => Object.freeze({ ...value })).id, 'x'));
test('requestHash uses injected sha256Hex and validates its output', () => {
  const hash = 'a'.repeat(64); let input;
  assert.equal(core.requestHash({ a: 1 }, value => { input = value; return hash; }), hash);
  assert.equal(input, '{"a":1}');
  assert.throws(() => core.requestHash({}, () => 'bad'), /64-character/);
});
test('financial scope requires tenantId/storeIds and delegates the RBAC policy', () => {
  const grant = { tenantId: 't1', storeIds: ['s1'] };
  assert.equal(core.authorizeFinancialScope({ grant }, () => true), true);
  assert.throws(() => core.authorizeFinancialScope({ grant: { tenantId: 't1', storeIds: [] } }, () => true), { code: 'permission-denied' });
});
test('operation records and idempotency are immutable and payload-bound', () => {
  const hash = 'b'.repeat(64);
  const record = core.buildOperationRecord({ ownerUid: 'u1', operationId: 'OP-12345678', operationType: 'SALE_RETURN', requestHash: hash, status: 'POSTED', result: { ok: true } });
  assert.equal(Object.isFrozen(record), true);
  assert.deepEqual(core.resolveIdempotency(record, { uid: 'u1', requestHash: hash, operationType: 'SALE_RETURN' }), { replay: true, result: { ok: true } });
  assert.throws(() => core.resolveIdempotency(record, { uid: 'u2', requestHash: hash }), { code: 'already-exists' });
  assert.throws(() => core.resolveIdempotency(record, { uid: 'u1', requestHash: 'c'.repeat(64) }), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
});

test('requestHash is recursively canonical across nested object key order and preserves array order', () => {
  const first = { z: { b: 2, a: [{ y: 4, x: 3 }, 1] }, a: { d: 5, c: 6 } };
  const reordered = { a: { c: 6, d: 5 }, z: { a: [{ x: 3, y: 4 }, 1], b: 2 } };
  const sha256Hex = value => createHash('sha256').update(value, 'utf8').digest('hex');
  const expectedCanonical = '{"a":{"c":6,"d":5},"z":{"a":[{"x":3,"y":4},1],"b":2}}';
  const expectedHash = createHash('sha256').update(expectedCanonical, 'utf8').digest('hex');
  assert.equal(core.canonicalSerialize(first), expectedCanonical);
  assert.equal(core.requestHash(first, sha256Hex), expectedHash);
  assert.equal(core.requestHash(reordered, sha256Hex), expectedHash);
});


test('legacy settlement canonical hashes remain replayable without weakening operation-type checks', () => {
  const normalized = { operationId: 'ALLOC-12345678', periodId: 'FY2026', partyType: 'customer', partyId: 'C1', sourceMovementId: 'PAY1', sourceMovementType: 'customer_debt', allocations: [{ invoiceType: 'sales_invoice', invoiceId: 'INV1', amountCentimes: 1250 }] };
  const sha256Hex = value => createHash('sha256').update(value, 'utf8').digest('hex');
  const legacyHash = sha256Hex(core.legacyCanonicalSerialize(normalized));
  const record = { ownerUid: 'u1', operationType: 'SETTLEMENT_ALLOCATION', status: 'POSTED', requestHash: legacyHash, result: { ok: true, operationId: normalized.operationId } };
  assert.deepEqual(core.resolveIdempotency(record, { uid: 'u1', requestHash: core.requestHash(normalized, sha256Hex), legacyRequestHashes: [legacyHash], operationType: 'SETTLEMENT_ALLOCATION' }), { replay: true, result: record.result });
  assert.throws(() => core.resolveIdempotency(record, { uid: 'u1', requestHash: core.requestHash(normalized, sha256Hex), legacyRequestHashes: [legacyHash], operationType: 'SALE_RETURN' }), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
});

test('legacy reverse-ledger JSON hashes remain replayable', () => {
  const normalized = { operationId: 'RET-12345678', returnType: 'SALE_RETURN', invoiceId: 'INV1', items: [{ productId: 'P1', quantity: 1 }] };
  const sha256Hex = value => createHash('sha256').update(value, 'utf8').digest('hex');
  const legacyHash = sha256Hex(JSON.stringify(normalized));
  const record = { ownerUid: 'u1', operationType: 'SALE_RETURN', status: 'POSTED', requestHash: legacyHash, result: { ok: true } };
  assert.deepEqual(core.resolveIdempotency(record, { uid: 'u1', requestHash: core.requestHash(normalized, sha256Hex), legacyRequestHashes: [legacyHash], operationType: 'SALE_RETURN' }), { replay: true, result: record.result });
});
