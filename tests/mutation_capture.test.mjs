import test from "node:test";
import assert from "node:assert/strict";
import { createMutationEnvelope } from "../sync/mutation_capture.mjs";
import { commitLocalMutation, MUTATION_KEYS } from "../sync/mutation_queue_orchestrator.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

test("mock sale and collection capture distinct opIds and canonical ISO timestamps before queue persistence", () => {
  let sequence = 0;
  const fixed = new Date("2026-10-28T14:05:06.789Z");
  const factory = options => createMutationEnvelope({
    ...options,
    now: () => new Date(fixed),
    uuid: () => `test-uuid-${++sequence}`
  });

  const sale = factory({
    type: "SALE_INVOICE",
    payload: { invoiceId: "inv-mock-1", total: 1200, paid: 700, remaining: 500 }
  });
  const collection = factory({
    type: "DEBT_COLLECTION",
    payload: { customerId: "cust-mock-1", amount: 500 }
  });

  assert.notEqual(sale.opId, collection.opId, "each recorded mutation must have a distinct operation ID");
  for (const operation of [sale, collection]) {
    assert.match(operation.opId, /^op_test-uuid-\d+$/);
    assert.equal(operation.createdAt, "2026-10-28T14:05:06.789Z");
    assert.equal(new Date(operation.createdAt).toISOString(), operation.createdAt);
  }

  const storage = memoryStorage();
  const initial = { caisseBalance: 1000, customers: [], products: [], invoices: [] };
  storage.setItem(MUTATION_KEYS.appData, JSON.stringify(initial));
  commitLocalMutation({ storage, nextAppData: initial, operation: sale });
  commitLocalMutation({ storage, nextAppData: initial, operation: collection });

  const pending = JSON.parse(storage.getItem(MUTATION_KEYS.pending));
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map(item => item.opId), [sale.opId, collection.opId]);
  assert.ok(pending.every(item => item.status === "PENDING"));
  assert.ok(pending.every(item => item.createdAt === "2026-10-28T14:05:06.789Z"));
});

test("capture rejects malformed clocks, UUIDs, payloads, and unsupported operation types", () => {
  assert.throws(() => createMutationEnvelope({
    type: "SALE_INVOICE", payload: {}, now: () => new Date("invalid"), uuid: () => "id"
  }), /valid Date/);
  assert.throws(() => createMutationEnvelope({
    type: "DEBT_COLLECTION", payload: {}, now: () => new Date(), uuid: () => "bad id"
  }), /UUID provider/);
  assert.throws(() => createMutationEnvelope({
    type: "SALE_INVOICE", payload: [], now: () => new Date(), uuid: () => "id"
  }), /payload must be an object/);
  assert.throws(() => createMutationEnvelope({
    type: "TRUCK_SETTLEMENT", payload: {}, now: () => new Date(), uuid: () => "id"
  }), /Unsupported mutation type/);
});
