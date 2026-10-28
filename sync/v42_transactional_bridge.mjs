/**
 * Isolated recovery helper for the future V42 transactional bridge.
 *
 * localStorage cannot atomically commit AppData and the pending queue together.
 * The bridge therefore persists the operation identity marker in AppData and
 * leaves a PREPARED queue record before saveDB. On boot, this module resolves
 * leftover PREPARED records from the durable AppData evidence.
 *
 * This module is intentionally NOT wired into production index.html.
 */
import { MUTATION_KEYS } from "./mutation_queue_orchestrator.mjs";

function hasOperationMarker(appData, opId) {
  if (!appData || typeof appData !== "object" || Array.isArray(appData)) return false;

  if (Array.isArray(appData.appliedOpIds) && appData.appliedOpIds.includes(opId)) {
    return true;
  }

  // V42 entity-level markers make the decision auditable even if a future
  // schema does not retain a global appliedOpIds list.
  for (const collectionName of ["invoices", "cashMovements"]) {
    const collection = appData[collectionName];
    if (!Array.isArray(collection)) continue;
    if (collection.some(item =>
      item && typeof item === "object" &&
      (item.syncOpId === opId || item.opId === opId)
    )) return true;
  }

  return false;
}

/**
 * Purely resolve PREPARED operations.
 *
 * - Marker exists in persisted AppData: promote PREPARED -> PENDING.
 * - Marker is absent: remove PREPARED (the AppData commit did not persist).
 * - Existing PENDING/other records are preserved unchanged.
 *
 * The caller must ensure the marker is attached to the same AppData snapshot
 * that saveDB persists. This is recoverability, not a cross-key atomic write.
 */
export function recoverPreparedMutations(appData, queue) {
  if (!appData || typeof appData !== "object" || Array.isArray(appData)) {
    throw new Error("A valid persisted AppData object is required for recovery");
  }
  if (!Array.isArray(queue)) {
    throw new Error("The pending mutation queue must be an array");
  }

  const recovered = [];
  const aborted = [];
  const nextQueue = [];

  for (const item of queue) {
    if (!item || item.status !== "PREPARED") {
      nextQueue.push(item);
      continue;
    }
    if (typeof item.opId !== "string" || !item.opId.trim()) {
      // A malformed intent cannot be safely matched to a persisted mutation.
      aborted.push(null);
      continue;
    }

    if (hasOperationMarker(appData, item.opId)) {
      nextQueue.push({ ...item, status: "PENDING" });
      recovered.push(item.opId);
    } else {
      aborted.push(item.opId);
    }
  }

  return { queue: nextQueue, recovered, aborted };
}

function parseStoredJson(storage, key) {
  const raw = storage.getItem(key);
  if (raw == null || raw === "") {
    throw new Error(`Required storage key ${key} is missing during mutation recovery`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in storage key ${key} during mutation recovery`);
  }
}

/**
 * Run at application boot before sync/pull or any queue mutation.
 * Queue resolution is persisted as one localStorage key write, so repeating
 * recovery after another interruption is safe and idempotent.
 */
export function recoverPreparedMutationsOnBoot(storage) {
  if (!storage || typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function") {
    throw new Error("A localStorage-compatible storage adapter is required");
  }

  const appData = parseStoredJson(storage, MUTATION_KEYS.appData);
  const queue = JSON.parse(storage.getItem(MUTATION_KEYS.pending) || "[]");
  if (!Array.isArray(queue)) {
    throw new Error("The pending mutation queue must be an array");
  }

  const result = recoverPreparedMutations(appData, queue);
  if (result.recovered.length || result.aborted.length) {
    storage.setItem(MUTATION_KEYS.pending, JSON.stringify(result.queue));
  }
  return {
    recovered: result.recovered,
    aborted: result.aborted,
    remainingPrepared: result.queue.filter(item => item?.status === "PREPARED").length
  };
}
