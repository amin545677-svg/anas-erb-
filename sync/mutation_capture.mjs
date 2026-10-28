/**
 * Isolated mutation-envelope factory for the ANAS ERP sync prototype.
 *
 * Creates immutable identity metadata before the queue write. This helper is
 * intentionally not wired into production V42 index.html yet.
 */
const SUPPORTED_MUTATION_TYPES = new Set(["SALE_INVOICE", "DEBT_COLLECTION"]);

export function createMutationEnvelope({
  type,
  payload,
  now = () => new Date(),
  uuid = () => {
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      throw new Error("A cryptographically strong randomUUID implementation is required");
    }
    return globalThis.crypto.randomUUID();
  }
}) {
  if (!SUPPORTED_MUTATION_TYPES.has(type)) {
    throw new Error("Unsupported mutation type");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Mutation payload must be an object");
  }

  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error("Mutation clock must return a valid Date");
  }
  const createdAt = date.toISOString();
  const id = uuid();
  if (typeof id !== "string" || !id.trim() || /\s/.test(id)) {
    throw new Error("Mutation UUID provider must return a non-empty token without whitespace");
  }

  return Object.freeze({
    opId: `op_${id}`,
    type,
    createdAt,
    payload: structuredClone(payload)
  });
}
