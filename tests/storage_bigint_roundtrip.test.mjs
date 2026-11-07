/**
 * tests/storage_bigint_roundtrip.test.mjs
 * ANAS ERP — Level 26.5 Acceptance Test: BigInt Round-Trip & Envelope Safety
 */

import test from 'node:test';
import assert from 'node:assert';
import { 
  serializeBigIntDeep, 
  deserializeBigIntDeep, 
  isStrictBigIntEnvelope 
} from '../storage/bigint_envelope.mjs';

test('BigInt Round-Trip — Positive, negative, and zero values', () => {
  const original = {
    rev: 9007199254740995n,
    balanceMicro: -150050n,
    zero: 0n,
    nested: {
      items: [10n, 20n]
    }
  };

  const serialized = serializeBigIntDeep(original);
  assert.strictEqual(typeof serialized.rev.__anas_bigint_v1__, 'string');
  assert.strictEqual(serialized.rev.__anas_bigint_v1__, '9007199254740995');

  const roundtripped = deserializeBigIntDeep(serialized);
  assert.strictEqual(roundtripped.rev, 9007199254740995n);
  assert.strictEqual(roundtripped.balanceMicro, -150050n);
  assert.strictEqual(roundtripped.zero, 0n);
  assert.strictEqual(roundtripped.nested.items[0], 10n);
  assert.strictEqual(roundtripped.nested.items[1], 20n);
});

test('BigInt JSON round-trip preserves arbitrary precision', () => {
  const original = {
    huge: 123456789012345678901234567890123456789n,
    negative: -98765432109876543210987654321n
  };

  const serialized = serializeBigIntDeep(original);
  const json = JSON.stringify(serialized);
  const parsed = JSON.parse(json);
  const restored = deserializeBigIntDeep(parsed);

  assert.strictEqual(restored.huge, original.huge);
  assert.strictEqual(restored.negative, original.negative);
});

test('Shared references are handled correctly', () => {
  const shared = { amount: 500n };
  const original = { first: shared, second: shared };

  const serialized = serializeBigIntDeep(original);
  const restored = deserializeBigIntDeep(serialized);

  assert.strictEqual(restored.first.amount, 500n);
  assert.strictEqual(restored.second.amount, 500n);
});

test('Actual circular references are rejected', () => {
  const original = {};
  original.self = original;

  assert.throws(
    () => serializeBigIntDeep(original),
    /CIRCULAR_REFERENCE_IN_SERIALIZATION/
  );
});

test('Non-canonical BigInt representations are rejected', () => {
  for (const raw of ['-0', '0001', '-001', '+1']) {
    assert.strictEqual(
      isStrictBigIntEnvelope({ __anas_bigint_v1__: raw }),
      false
    );
  }
});

test('Malformed BigInt envelope is rejected during decoding', () => {
  assert.throws(
    () => deserializeBigIntDeep({
      __anas_bigint_v1__: '123',
      extra: true
    }),
    /INVALID_BIGINT_ENVELOPE_REJECTED/
  );
});
