/**
 * Isolated durable mutation queue orchestration for ANAS ERP.
 *
 * This adapter is not wired into V42. It uses a localStorage-compatible
 * interface and injected cloud transport so the lifecycle can be tested
 * deterministically before any production integration.
 */
import { reconcilePendingMutations } from "./mutation_reconciliation.mjs";
import { MUTATION_KEYS } from "./mutation_keys.mjs";
import { recoverPreparedMutationsOnBoot } from "./v42_transactional_bridge.mjs";

export { MUTATION_KEYS } from "./mutation_keys.mjs";

const readJson = (storage, key, fallback) => {
  const raw = storage.getItem(key);
  if (raw == null || raw === "") return structuredClone(fallback);
  try { return JSON.parse(raw); }
  catch { throw new Error(`Invalid JSON in storage key ${key}`); }
};
const writeJson = (storage, key, value) => storage.setItem(key, JSON.stringify(value));
const uniqueByOpId = items => {
  const seen = new Set();
  return items.filter(item => {
    if (!item || typeof item.opId !== "string" || !item.opId || seen.has(item.opId)) return false;
    seen.add(item.opId);
    return true;
  });
};
const statusOf = response => response?.status ?? response?.httpStatus ?? 200;
const isConflict = error => statusOf(error) === 409 || error?.status === 409 || error?.httpStatus === 409;

function captureStorage(storage, keys) {
  return Object.fromEntries(keys.map(key => [key, storage.getItem(key)]));
}
function restoreStorage(storage, captured) {
  for (const [key, value] of Object.entries(captured)) {
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, value);
  }
}

/**
 * Persist a local mutation with a recoverable write-ahead journal.
 * The intent is written before AppData so a crash between keys can be recovered.
 * LocalStorage has no multi-key transaction; rescue+PREPARED state makes the
 * sequence detectable and recoverable rather than pretending it is atomic.
 */
export function commitLocalMutation({ storage, nextAppData, operation }) {
  if (!storage || !operation || typeof operation.opId !== "string" || !operation.opId.trim()) {
    throw new Error("Storage and a mutation with a non-empty opId are required");
  }
  const keys = [MUTATION_KEYS.appData, MUTATION_KEYS.pending, MUTATION_KEYS.rescue];
  const before = captureStorage(storage, keys);
  const rescue = {
    schema: 1, phase: "LOCAL_MUTATION_PREPARE", before,
    operation: structuredClone(operation), createdAt: new Date().toISOString()
  };
  writeJson(storage, MUTATION_KEYS.rescue, rescue);
  try {
    const pending = readJson(storage, MUTATION_KEYS.pending, []);
    if (!Array.isArray(pending)) throw new Error("Pending queue must be an array");
    if (!pending.some(item => item?.opId === operation.opId)) {
      writeJson(storage, MUTATION_KEYS.pending, [...pending, { ...structuredClone(operation), status: "PREPARED" }]);
    }
    const committed = structuredClone(nextAppData);
    if (!committed || typeof committed !== "object" || Array.isArray(committed)) {
      throw new Error("AppData must be an object");
    }
    const ids = new Set(Array.isArray(committed.appliedOpIds) ? committed.appliedOpIds : []);
    ids.add(operation.opId);
    committed.appliedOpIds = [...ids];
    writeJson(storage, MUTATION_KEYS.appData, committed);
    const prepared = readJson(storage, MUTATION_KEYS.pending, []);
    writeJson(storage, MUTATION_KEYS.pending, prepared.map(item =>
      item?.opId === operation.opId ? { ...item, status: "PENDING" } : item
    ));
    storage.removeItem(MUTATION_KEYS.rescue);
    return { appData: committed, operationId: operation.opId };
  } catch (error) {
    restoreStorage(storage, before);
    throw error;
  }
}

/** Recover a leftover write-ahead snapshot after an interrupted local commit. */
export function recoverInterruptedLocalMutation(storage) {
  const rescue = readJson(storage, MUTATION_KEYS.rescue, null);
  if (!rescue || !["LOCAL_MUTATION_PREPARE", "PRE_RECONCILE"].includes(rescue.phase) || !rescue.before) return false;
  restoreStorage(storage, rescue.before);
  storage.removeItem(MUTATION_KEYS.rescue);
  return true;
}

export function createMutationQueueOrchestrator({
  storage,
  pullCloud,
  pushCloud,
  reconcile = reconcilePendingMutations,
  maxConflictRetries = 3
}) {
  if (!storage || typeof pullCloud !== "function" || typeof pushCloud !== "function") {
    throw new Error("storage, pullCloud and pushCloud are required");
  }
  if (!Number.isSafeInteger(maxConflictRetries) || maxConflictRetries < 1) {
    throw new Error("maxConflictRetries must be a positive safe integer");
  }

  async function pushCurrent() {
    recoverInterruptedLocalMutation(storage);
    recoverPreparedMutationsOnBoot(storage);
    const pendingAtStart = readJson(storage, MUTATION_KEYS.pending, []);
    const capturedIds = new Set(pendingAtStart.filter(x => x?.status === "PENDING").map(x => x?.opId).filter(Boolean));
    const appData = readJson(storage, MUTATION_KEYS.appData, null);
    if (!appData) throw new Error("Local AppData is missing");
    const revision = readJson(storage, MUTATION_KEYS.revision, null);
    try {
      const response = await pushCloud({ data: structuredClone(appData), baseRevision: revision });
      if (statusOf(response) === 409) return { status: "conflict", retained: capturedIds.size };
      if (statusOf(response) < 200 || statusOf(response) >= 300) {
        return { status: "failed", httpStatus: statusOf(response), retained: capturedIds.size };
      }
      const current = readJson(storage, MUTATION_KEYS.pending, []);
      writeJson(storage, MUTATION_KEYS.pending, current.filter(item => !capturedIds.has(item?.opId)));
      if (response?.revision != null) writeJson(storage, MUTATION_KEYS.revision, response.revision);
      return { status: "pushed", removed: capturedIds.size };
    } catch (error) {
      if (isConflict(error)) return { status: "conflict", retained: capturedIds.size };
      return { status: "network-error", retained: capturedIds.size, error: String(error?.message || error) };
    }
  }

  async function reconcileAndSync() {
    recoverInterruptedLocalMutation(storage);
    recoverPreparedMutationsOnBoot(storage);
    let lastConflict = null;
    for (let attempt = 1; attempt <= maxConflictRetries; attempt++) {
      const keys = [MUTATION_KEYS.appData, MUTATION_KEYS.pending, MUTATION_KEYS.quarantined, MUTATION_KEYS.revision];
      const before = captureStorage(storage, keys);
      const pending = readJson(storage, MUTATION_KEYS.pending, []);
      if (!Array.isArray(pending)) throw new Error("Pending queue must be an array");
      const replayable = pending.filter(item => item?.status === "PENDING");
      const capturedIds = new Set(replayable.map(item => item?.opId).filter(Boolean));
      let cloud;
      try {
        cloud = await pullCloud();
        const hasRevision = cloud && Object.prototype.hasOwnProperty.call(cloud, "revision");
        const validRevision = hasRevision && (
          cloud.revision === null ||
          Number.isInteger(cloud.revision) ||
          (typeof cloud.revision === "string" && cloud.revision.length > 0)
        );
        if (!cloud || !cloud.data || !validRevision) {
          throw new Error("Cloud response must include data and a valid revision (string, integer, or null for create-only)");
        }
        writeJson(storage, MUTATION_KEYS.rescue, {
          schema: 1, phase: "PRE_RECONCILE", before,
          cloudRevision: cloud.revision, createdAt: new Date().toISOString()
        });
        const result = reconcile(cloud.data, replayable);
        const quarantinedNow = result.review.map(item => ({
          ...structuredClone(item),
          status: "QUARANTINED",
          quarantinedAt: new Date().toISOString()
        }));
        const priorQuarantine = readJson(storage, MUTATION_KEYS.quarantined, []);
        if (!Array.isArray(priorQuarantine)) throw new Error("Quarantine store must be an array");
        const quarantineIds = new Set(priorQuarantine.map(item => item?.opId).filter(Boolean));
        const quarantine = [...priorQuarantine];
        for (const item of quarantinedNow) {
          const idx = quarantine.findIndex(old => old?.opId && old.opId === item.opId);
          if (idx >= 0) quarantine[idx] = item;
          else quarantine.push(item);
          quarantineIds.add(item.opId);
        }

        // Do not remove queue entries or persist quarantine as final until cloud accepts
        // this exact revision. Rescue allows rollback if any local write fails.
        writeJson(storage, MUTATION_KEYS.appData, result.snapshot);
        writeJson(storage, MUTATION_KEYS.revision, cloud.revision);
        const response = await pushCloud({ data: structuredClone(result.snapshot), baseRevision: cloud.revision });
        if (statusOf(response) === 409) {
          lastConflict = { attempt, revision: cloud.revision };
          restoreStorage(storage, before);
          storage.removeItem(MUTATION_KEYS.rescue);
          continue;
        }
        if (statusOf(response) < 200 || statusOf(response) >= 300) {
          throw Object.assign(new Error(`Cloud push failed with HTTP ${statusOf(response)}`), { status: statusOf(response) });
        }

        const currentPending = readJson(storage, MUTATION_KEYS.pending, []);
        // Remove only operations present at the start of this attempt; operations
        // appended while the network request was in flight remain untouched.
        writeJson(storage, MUTATION_KEYS.pending, currentPending.filter(item => !capturedIds.has(item?.opId)));
        writeJson(storage, MUTATION_KEYS.quarantined, quarantine);
        if (response?.revision != null) writeJson(storage, MUTATION_KEYS.revision, response.revision);
        storage.removeItem(MUTATION_KEYS.rescue);
        return {
          status: "synced", attempts: attempt, baseRevision: cloud.revision,
          applied: result.appliedNow.filter(item => item.outcome === "applied").map(item => item.opId),
          skippedDuplicate: result.appliedNow.filter(item => item.outcome === "already-applied").map(item => item.opId),
          quarantined: quarantinedNow.map(item => ({ opId: item.opId, reason: item.reason }))
        };
      } catch (error) {
        // A network error after the remote server accepted a request is ambiguous.
        // Restore local state but retain pending operations; retry relies on opId and
        // entity-level idempotency in the next pull/reconcile cycle.
        restoreStorage(storage, before);
        storage.removeItem(MUTATION_KEYS.rescue);
        if (isConflict(error)) {
          lastConflict = { attempt, revision: cloud?.revision ?? null };
          continue;
        }
        return { status: "failed", attempts: attempt, error: String(error?.message || error) };
      }
    }
    return { status: "conflict-limit", attempts: maxConflictRetries, lastConflict };
  }

  return { pushCurrent, reconcileAndSync };
}
