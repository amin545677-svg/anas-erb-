import test from "node:test";
import assert from "node:assert/strict";
import { runV42PreparedRecovery } from "../sync/v42-prepared-recovery-runtime.mjs";
import { MUTATION_KEYS } from "../sync/mutation_keys.mjs";

function fixture({ marked = true } = {}) {
  const appData = { appliedOpIds: marked ? ["sale-001"] : [], invoices: [], cashMovements: [] };
  const values = new Map([
    [MUTATION_KEYS.appData, appData],
    [MUTATION_KEYS.pending, JSON.stringify([
      { opId: "sale-001", status: "PREPARED", type: "SALE_INVOICE" },
      { opId: "unrelated-pending", status: "PENDING", type: "DEBT_COLLECTION" }
    ])]
  ]);
  let hydrations = 0;
  const storage = {
    async hydrate() { hydrations++; return { status: "READY" }; },
    ready() { return true; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeSync(key) { values.delete(key); }
  };
  return { global: { ANASResilientStorage: storage }, values, get hydrations() { return hydrations; } };
}

test("boot recovery promotes a committed PREPARED operation once and preserves existing pending work", async () => {
  const f = fixture();
  const first = await runV42PreparedRecovery(f.global);
  const second = await runV42PreparedRecovery(f.global);
  assert.deepEqual(first, {
    status: "recovered", recovered: 1, aborted: 0, remainingPrepared: 0
  });
  assert.equal(second, first, "subsequent calls share the idempotent boot result");
  assert.equal(f.hydrations, 1, "storage hydration is joined only once");
  const queue = JSON.parse(f.values.get(MUTATION_KEYS.pending));
  assert.equal(queue[0].status, "PENDING");
  assert.equal(queue[1].status, "PENDING");
});

test("boot recovery discards an uncommitted PREPARED intent without mutating AppData", async () => {
  const f = fixture({ marked: false });
  const before = structuredClone(f.values.get(MUTATION_KEYS.appData));
  const result = await runV42PreparedRecovery(f.global);
  assert.deepEqual(result, {
    status: "recovered", recovered: 0, aborted: 1, remainingPrepared: 0
  });
  assert.deepEqual(f.values.get(MUTATION_KEYS.appData), before);
  assert.deepEqual(JSON.parse(f.values.get(MUTATION_KEYS.pending)), [{
    opId: "unrelated-pending", status: "PENDING", type: "DEBT_COLLECTION"
  }]);
});

test("boot recovery fails closed when resilient storage is unavailable", async () => {
  await assert.rejects(
    runV42PreparedRecovery({}),
    /ANAS_RESILIENT_STORAGE_UNAVAILABLE/
  );
});
