/**
 * storage/bigint_envelope.mjs
 * ANAS ERP — Level 26.5 Strict BigInt Serializer & Deserializer
 * Fully hardened against circular references, shared references, and prototype pollution.
 */

const BIGINT_ENVELOPE_KEY = '__anas_bigint_v1__';
const CANONICAL_DIGITS_RE = /^(?:0|-[1-9]\d*|[1-9]\d*)$/;

export function isStrictBigIntEnvelope(value) {
  if (value === null || typeof value !== 'object') return false;

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;

  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== BIGINT_ENVELOPE_KEY) {
    return false;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, BIGINT_ENVELOPE_KEY);
  if (!descriptor || !('value' in descriptor)) return false;

  return typeof descriptor.value === 'string' && CANONICAL_DIGITS_RE.test(descriptor.value);
}

function defineSafe(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  });
}

export function serializeBigIntDeep(value, ancestors = new Set()) {
  if (typeof value === 'bigint') {
    return {
      [BIGINT_ENVELOPE_KEY]: value.toString(10)
    };
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (ancestors.has(value)) {
    throw new Error('CIRCULAR_REFERENCE_IN_SERIALIZATION');
  }

  if (isStrictBigIntEnvelope(value)) {
    return {
      [BIGINT_ENVELOPE_KEY]: value[BIGINT_ENVELOPE_KEY]
    };
  }

  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error('UNSUPPORTED_SERIALIZATION_OBJECT');
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map(item => serializeBigIntDeep(item, ancestors));
    }

    const copy = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('ACCESSOR_PROPERTY_REJECTED');
      }
      defineSafe(copy, key, serializeBigIntDeep(descriptor.value, ancestors));
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

export function deserializeBigIntDeep(value, ancestors = new Set()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (ancestors.has(value)) {
    throw new Error('CIRCULAR_REFERENCE_IN_DESERIALIZATION');
  }

  if (Object.prototype.hasOwnProperty.call(value, BIGINT_ENVELOPE_KEY)) {
    if (!isStrictBigIntEnvelope(value)) {
      throw new Error('INVALID_BIGINT_ENVELOPE_REJECTED');
    }
    return BigInt(value[BIGINT_ENVELOPE_KEY]);
  }

  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error('UNSUPPORTED_DESERIALIZATION_OBJECT');
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map(item => deserializeBigIntDeep(item, ancestors));
    }

    const copy = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('ACCESSOR_PROPERTY_REJECTED');
      }
      defineSafe(copy, key, deserializeBigIntDeep(descriptor.value, ancestors));
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}
