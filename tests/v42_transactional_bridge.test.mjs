import test from "node:test";
import assert from "node:assert/strict";
import {
  recoverPreparedMutations,
  recoverPreparedMutationsOnBoot
} from "../sync/v42_transactional_bridge.mjs";
import { MUTATION_KEYS } from "../sync/mutation_queue_orchestrator.mjs";

function storage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [
    key, typeof value === "string" ? value : JSON.stringify(value)
  ]));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

const prepared = (opId, extra = {}) => ({
  opId, type: "SALE_INVOICE", status: "PREPARED", createdAt: "2026-10-28T12:00:00.000Z", ...extra
});

test("crash after PREPARED but before AppData save aborts the intent at boot", () => {
  const appData = { invoices: [], cashMovements: [], appliedOpIds: [] };
  const local = storage({
    [MUTATION_KEYS.appData]: appData,
    [MUTATION_KEYS.pending]: [prepared("op_crash_before_save")]
  });

  const result = recoverPreparedMutationsOnBoot(local);

  assert.deepEqual(result, { recovered: [], aborted: ["op_crash_before_save"], remainingPrepared: 0 });
  assert.deepEqual(JSON.parse(local.getItem(MUTATION_KEYS.pending)), []);
  assert.deepEqual(JSON.parse(local.getItem(MUTATION_KEYS.appData)), appData);
});

test("crash after AppData save but before queue promotion promotes PREPARED to PENDING", () => {
  const appData = {
    invoices: [{ id: "invoice_1", syncOpId: "op_crash_after_save" }],
    cashMovements: [],
    appliedOpIds: ["op_crash_after_save"]
  };
  const local = storage({
    [MUTATION_KEYS.appData]: appData,
    [MUTATION_KEYS.pending]: [prepared("op_crash_after_save", { payload: { invoiceId: "invoice_1" } })]
  });

  const result = recoverPreparedMutationsOnBoot(local);
  const queue = JSON.parse(local.getItem(MUTATION_KEYS.pending));

  assert.deepEqual(result, { recovered: ["op_crash_after_save"], aborted: [], remainingPrepared: 0 });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "PENDING");
  assert.equal(queue[0].payload.invoiceId, "invoice_1");
});

test("boot recovery recognizes a persisted cash-movement marker even without appliedOpIds", () => {
  const result = recoverPreparedMutations({
    invoices: [],
    cashMovements: [{ id: "cash_1", opId: "op_collection_500_50", amount: 500.5 }]
  }, [prepared("op_collection_500_50", { type: "DEBT_COLLECTION" })]);

  assert.deepEqual(result.recovered, ["op_collection_500_50"]);
  assert.deepEqual(result.aborted, []);
  assert.equal(result.queue[0].status, "PENDING");
});

test("recovery preserves unrelated pending records and is idempotent on a second boot", () => {
  const appData = { invoices: [{ id: "invoice_2", syncOpId: "op_recover" }], cashMovements: [] };
  const local = storage({
    [MUTATION_KEYS.appData]: appData,
    [MUTATION_KEYS.pending]: [
      prepared("op_recover"),
      { opId: "op_already_pending", status: "PENDING", type: "DEBT_COLLECTION" }
    ]
  });

  const first = recoverPreparedMutationsOnBoot(local);
  const firstQueue = JSON.parse(local.getItem(MUTATION_KEYS.pending));
  const second = recoverPreparedMutationsOnBoot(local);
  const secondQueue = JSON.parse(local.getItem(MUTATION_KEYS.pending));

  assert.deepEqual(first.recovered, ["op_recover"]);
  assert.deepEqual(firstQueue, secondQueue);
  assert.deepEqual(second, { recovered: [], aborted: [], remainingPrepared: 0 });
  assert.equal(secondQueue.length, 2);
  assert.equal(secondQueue[1].opId, "op_already_pending");
});

test("recovery refuses to abort intents when persisted AppData is missing or malformed", () => {
  const missing = storage({ [MUTATION_KEYS.pending]: [prepared("op_unknown")] });
  assert.throws(() => recoverPreparedMutationsOnBoot(missing), /AppData is missing/);

  const malformed = storage({
    [MUTATION_KEYS.appData]: "{bad json",
    [MUTATION_KEYS.pending]: [prepared("op_unknown")]
  });
  assert.throws(() => recoverPreparedMutationsOnBoot(malformed), /Invalid JSON/);
});

test("pure recovery rejects invalid queue and AppData inputs", () => {
  assert.throws(() => recoverPreparedMutations(null, []), /AppData object/);
  assert.throws(() => recoverPreparedMutations({}, {}), /queue must be an array/);
});
