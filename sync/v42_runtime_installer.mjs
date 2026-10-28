import { MUTATION_KEYS } from "./mutation_keys.mjs";
import { createMutationEnvelope } from "./mutation_capture.mjs";

/**
 * Staging-only runtime wiring installer. It never patches production unless a
 * caller explicitly invokes it and supplies the live V42 bindings.
 *
 * The caller must pass getAppData/setAppData callbacks from the classic-script
 * lexical scope because top-level let AppData is not necessarily window.AppData.
 */
export function installV42RuntimeWiring({
  windowObject,
  storage,
  orchestrator,
  getAppData,
  setAppData,
  getSaveDB,
  setSaveDB,
  mapMutation,
  uuid,
  now = () => new Date(),
  onQuarantine = () => {},
  onStatus = () => {}
}) {
  if (!windowObject || !storage || !orchestrator ||
      typeof getAppData !== "function" || typeof setAppData !== "function" ||
      typeof getSaveDB !== "function" || typeof setSaveDB !== "function" || typeof mapMutation !== "function" ||
      typeof orchestrator.pushCurrent !== "function" ||
      typeof orchestrator.reconcileAndSync !== "function") {
    throw new Error("V42 runtime wiring dependencies are incomplete");
  }

  const originalPull = windowObject.anasFirebasePull;
  const originalPush = windowObject.anasFirebasePush;
  const originalSaveDB = getSaveDB();
  if (typeof originalSaveDB !== "function") throw new Error("V42 saveDB binding is unavailable");

  let installed = false;
  let lastSnapshot = null;

  function readStoredAppData() {
    const raw = storage.getItem(MUTATION_KEYS.appData);
    if (raw == null) return lastSnapshot ? structuredClone(lastSnapshot) : null;
    try { return JSON.parse(raw); } catch { throw new Error("Persisted AppData JSON is invalid"); }
  }

  function findNewEntity(current, previous, key) {
    const before = new Set((Array.isArray(previous?.[key]) ? previous[key] : []).map(item => String(item?.id)));
    return (Array.isArray(current?.[key]) ? current[key] : []).find(item =>
      item && item.id != null && !before.has(String(item.id))
    ) || null;
  }

  function makeOperation(current, previous) {
    const invoice = findNewEntity(current, previous, "invoices");
    const movement = invoice ? null : findNewEntity(current, previous, "cashMovements");
    const entity = invoice || movement;
    if (!entity) return null;
    const mapped = mapMutation({
      current: structuredClone(current),
      previous: structuredClone(previous),
      entity: structuredClone(entity),
      kind: invoice ? "sale" : "collection"
    });
    if (!mapped || !["SALE_INVOICE", "DEBT_COLLECTION"].includes(mapped.type) ||
        !mapped.payload || typeof mapped.payload !== "object") {
      throw new Error("mapMutation must return a supported operation type and a valid payload");
    }
    const operation = createMutationEnvelope({ type: mapped.type, payload: mapped.payload, now, uuid });
    return { entity, operation };
  }

  function persistPrepared(operation) {
    const queue = JSON.parse(storage.getItem(MUTATION_KEYS.pending) || "[]");
    if (!Array.isArray(queue)) throw new Error("Pending mutation queue is malformed");
    if (queue.some(item => item?.opId === operation.opId)) {
      throw new Error("Duplicate operation ID detected before saveDB");
    }
    storage.setItem(MUTATION_KEYS.pending, JSON.stringify([
      ...queue, { ...structuredClone(operation), status: "PREPARED" }
    ]));
  }

  function promote(operationId) {
    const queue = JSON.parse(storage.getItem(MUTATION_KEYS.pending) || "[]");
    if (!Array.isArray(queue)) throw new Error("Pending mutation queue is malformed");
    let found = false;
    const next = queue.map(item => {
      if (item?.opId !== operationId) return item;
      found = true;
      return { ...item, status: "PENDING" };
    });
    if (!found) throw new Error("PREPARED mutation disappeared before promotion");
    storage.setItem(MUTATION_KEYS.pending, JSON.stringify(next));
  }

  function wrappedSaveDB(...args) {
    const current = getAppData();
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return originalSaveDB.apply(this, args);
    }
    const previous = readStoredAppData() || lastSnapshot || {};
    const captured = makeOperation(current, previous);
    if (!captured) {
      const ok = originalSaveDB.apply(this, args);
      if (ok === true) lastSnapshot = structuredClone(getAppData());
      return ok;
    }

    const beforeEntityMarker = captured.entity.syncOpId;
    const beforeEntityOpId = captured.entity.opId;
    const beforeApplied = Array.isArray(current.appliedOpIds) ? current.appliedOpIds.slice() : undefined;
    captured.entity.syncOpId = captured.operation.opId;
    captured.entity.syncCreatedAt = captured.operation.createdAt;
    if (captured.operation.type === "DEBT_COLLECTION") captured.entity.opId = captured.operation.opId;
    current.appliedOpIds = [...new Set([...(Array.isArray(current.appliedOpIds) ? current.appliedOpIds : []), captured.operation.opId])];
    // Keep the same audit marker inside the operation payload that will be replayed.
    if (captured.operation.type === "SALE_INVOICE" && captured.operation.payload.invoice) {
      captured.operation.payload.invoice = structuredClone(captured.entity);
    }
    if (captured.operation.type === "DEBT_COLLECTION" && captured.operation.payload.cashMovement) {
      captured.operation.payload.cashMovement = structuredClone(captured.entity);
    }

    try {
      // Strict order: journal intent + marker in memory, then original saveDB writes AppData.
      persistPrepared(captured.operation);
    } catch (error) {
      if (beforeEntityMarker === undefined) delete captured.entity.syncOpId;
      else captured.entity.syncOpId = beforeEntityMarker;
      if (captured.entity.syncCreatedAt === captured.operation.createdAt) delete captured.entity.syncCreatedAt;
      if (beforeEntityOpId === undefined) delete captured.entity.opId;
      else captured.entity.opId = beforeEntityOpId;
      if (beforeApplied === undefined) delete current.appliedOpIds;
      else current.appliedOpIds = beforeApplied;
      throw error;
    }

    let saved;
    try {
      saved = originalSaveDB.apply(this, args);
    } catch (error) {
      storage.setItem(MUTATION_KEYS.pending, JSON.stringify(
        JSON.parse(storage.getItem(MUTATION_KEYS.pending) || "[]").filter(item => item?.opId !== captured.operation.opId)
      ));
      throw error;
    }

    if (saved !== true) {
      storage.setItem(MUTATION_KEYS.pending, JSON.stringify(
        JSON.parse(storage.getItem(MUTATION_KEYS.pending) || "[]").filter(item => item?.opId !== captured.operation.opId)
      ));
      return saved;
    }

    try {
      promote(captured.operation.opId);
      lastSnapshot = structuredClone(getAppData());
      return true;
    } catch (error) {
      // Do not claim success if the durable queue cannot be promoted. Restore the
      // prior AppData snapshot through the original persistence function so V42's
      // own caller receives false and performs its existing in-memory rollback.
      try {
        if (previous && typeof previous === "object") {
          setAppData(structuredClone(previous));
          originalSaveDB.call(this);
        }
      } catch (rollbackError) {
        onStatus({ level: "critical", code: "V42_QUEUE_PROMOTION_ROLLBACK_FAILED", message: String(rollbackError?.message || rollbackError) });
      }
      try {
        storage.setItem(MUTATION_KEYS.pending, JSON.stringify(
          JSON.parse(storage.getItem(MUTATION_KEYS.pending) || "[]").filter(item => item?.opId !== captured.operation.opId)
        ));
      } catch (_) {}
      onStatus({ level: "error", code: "V42_QUEUE_PROMOTION_FAILED", message: String(error?.message || error) });
      return false;
    }
  }

  async function wrappedPush() {
    const result = await orchestrator.pushCurrent();
    if (result?.status === "conflict") {
      onStatus({ level: "warning", code: "V42_SYNC_CONFLICT_RECONCILING" });
      const reconciled = await orchestrator.reconcileAndSync();
      if (reconciled?.quarantined?.length) onQuarantine(reconciled.quarantined);
      onStatus({ level: reconciled?.status === "synced" ? "success" : "error", result: reconciled });
      return reconciled;
    }
    onStatus({ level: result?.status === "pushed" ? "success" : "error", result });
    return result;
  }

  async function wrappedPull() {
    // This is an operational reconciliation pull, intentionally distinct from the
    // legacy destructive full-snapshot restore function.
    const result = await orchestrator.reconcileAndSync();
    if (result?.quarantined?.length) onQuarantine(result.quarantined);
    onStatus({ level: result?.status === "synced" ? "success" : "error", result });
    return result;
  }

  function install() {
    if (installed) throw new Error("V42 runtime wiring is already installed");
    windowObject.anasFirebasePullSnapshotRestore = originalPull;
    windowObject.anasFirebasePushSnapshotBackup = originalPush;
    windowObject.anasFirebasePull = wrappedPull;
    windowObject.anasFirebasePush = wrappedPush;
    setSaveDB(wrappedSaveDB);
    installed = true;
    return { installed: true };
  }

  function uninstall() {
    if (!installed) return false;
    windowObject.anasFirebasePull = originalPull;
    windowObject.anasFirebasePush = originalPush;
    if (windowObject.anasFirebasePullSnapshotRestore === originalPull) delete windowObject.anasFirebasePullSnapshotRestore;
    if (windowObject.anasFirebasePushSnapshotBackup === originalPush) delete windowObject.anasFirebasePushSnapshotBackup;
    setSaveDB(originalSaveDB);
    installed = false;
    return true;
  }

  return { install, uninstall, wrappedSaveDB, wrappedPull, wrappedPush };
}
