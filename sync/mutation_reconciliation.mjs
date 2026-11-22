import { sha256Canonical } from "../core/sovereign-kernel.mjs";
/**
 * Pure reconciliation primitives for the isolated ANAS ERP sync prototype.
 *
 * This module is deliberately NOT wired into production index.html. It returns a
 * new snapshot and explicit review items; callers must persist atomically and must
 * not upload until every operation has been reconciled or quarantined.
 */
function normalizeForCanonicalHash(value, inArray = false) {
  if (value === undefined) {
    if (inArray) throw new TypeError("NON_CANONICAL_UNDEFINED_ARRAY_VALUE");
    return undefined;
  }
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    const error = new TypeError("NON_CANONICAL_NUMERIC_VALUE");
    error.code = "NON_CANONICAL_NUMERIC_VALUE";
    throw error;
  }
  if (Array.isArray(value)) return value.map(item => normalizeForCanonicalHash(item, true));
  if (value && typeof value === "object" && typeof value !== "bigint") {
    const normalized = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw new TypeError("NON_CANONICAL_ACCESSOR");
      }
      if (descriptor.value !== undefined) normalized[key] = normalizeForCanonicalHash(descriptor.value, false);
    }
    return normalized;
  }
  return value;
}
function canonicalOperationHash(value) {
  return sha256Canonical(normalizeForCanonicalHash(value));
}

const MERGE_MISSING = Symbol("MERGE_MISSING");
function findConcurrentActiveTripOwnershipConflicts(baseState, localState, cloudState) {
  const rows = state => Array.isArray(state?.trips) ? state.trips : [];
  const byId = list => new Map(list.filter(row => row && row.id != null).map(row => [String(row.id), row]));
  const baseTrips = byId(rows(baseState));
  const localTrips = byId(rows(localState));
  const cloudTrips = rows(cloudState);
  const changedTruckIds = new Set();
  const equal = (a, b) => a === undefined || b === undefined
    ? a === b
    : canonicalOperationHash(a) === canonicalOperationHash(b);
  for (const id of new Set([...baseTrips.keys(), ...localTrips.keys()])) {
    const before = baseTrips.get(id), after = localTrips.get(id);
    if (!equal(before, after)) {
      if (before?.truckId != null) changedTruckIds.add(String(before.truckId));
      if (after?.truckId != null) changedTruckIds.add(String(after.truckId));
    }
  }
  const baseTrucks = byId(Array.isArray(baseState?.trucks) ? baseState.trucks : []);
  const localTrucks = byId(Array.isArray(localState?.trucks) ? localState.trucks : []);
  for (const id of new Set([...baseTrucks.keys(), ...localTrucks.keys()])) {
    const before = baseTrucks.get(id), after = localTrucks.get(id);
    if (!equal(before, after)) changedTruckIds.add(String(id));
  }
  if (!changedTruckIds.size) return [];
  const active = trip => ["OPEN", "ACTIVE"].includes(String(trip?.status || "").toUpperCase());
  const conflicts = [];
  for (const trip of cloudTrips) {
    if (!active(trip) || trip?.truckId == null) continue;
    const before = baseTrips.get(String(trip.id));
    if (before && active(before)) continue;
    const truckId = String(trip.truckId);
    if (!changedTruckIds.has(truckId)) continue;
    conflicts.push({
      path: "$.trips",
      reason: "REMOTE_ACTIVE_TRIP_OVERLAPS_LOCAL_TRUCK_MUTATION",
      truckId,
      remoteTripId: String(trip.id ?? ""),
      localTripIds: [...localTrips.values()]
        .filter(row => String(row?.truckId ?? "") === truckId)
        .map(row => String(row.id ?? ""))
    });
  }
  return conflicts;
}

function findConcurrentTruckMutationConflicts(baseState, localState, cloudState, collectionDeltas, cloudSnapshot) {
  const equal = (a, b) => a === undefined || b === undefined
    ? a === b
    : canonicalOperationHash(a) === canonicalOperationHash(b);
  const tripLookup = (...states) => {
    const result = new Map();
    for (const state of states) {
      for (const trip of Array.isArray(state?.trips) ? state.trips : []) {
        if (trip?.id != null && trip?.truckId != null) result.set(String(trip.id), String(trip.truckId));
      }
    }
    return result;
  };
  const localTrips = tripLookup(baseState, localState);
  const cloudTrips = tripLookup(baseState, cloudState);
  const localChanges = new Map();
  const cloudChanges = new Map();
  const add = (target, truckId, source) => {
    if (truckId == null || String(truckId).trim() === "") return;
    const id = String(truckId);
    if (!target.has(id)) target.set(id, new Set());
    target.get(id).add(source);
  };
  const identityOf = (row, collection) => {
    const field = ({ clientMovements: "movementId", settlementAllocations: "allocationId" })[collection] || "id";
    return row?.[field];
  };
  const truckIdOf = (row, collection, trips) => {
    if (!row) return null;
    if (collection === "trucks") return row.id;
    const direct = row.truckId ?? row.truck_id ?? row.truckID ?? row.truck?.id;
    if (direct != null && String(direct).trim() !== "") return direct;
    const tripId = row.tripId ?? row.trip_id;
    return tripId == null ? null : (trips.get(String(tripId)) ?? null);
  };
  const collectChangedRows = (target, beforeRows, afterRows, collection, trips) => {
    const toMap = rows => new Map((Array.isArray(rows) ? rows : [])
      .filter(row => row && typeof row === "object" && !Array.isArray(row) && identityOf(row, collection) != null)
      .map(row => [String(identityOf(row, collection)), row]));
    const before = toMap(beforeRows), after = toMap(afterRows);
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const oldRow = before.get(id), newRow = after.get(id);
      if (equal(oldRow, newRow)) continue;
      const source = collection + ":" + id;
      add(target, truckIdOf(oldRow, collection, trips), source);
      add(target, truckIdOf(newRow, collection, trips), source);
    }
  };
  const collectStateChanges = (target, before, after, trips) => {
    for (const collection of ["trucks", "trips", "movements"]) {
      collectChangedRows(target, before?.[collection], after?.[collection], collection, trips);
    }
  };
  collectStateChanges(localChanges, baseState, localState, localTrips);
  collectStateChanges(cloudChanges, baseState, cloudState, cloudTrips);
  for (const [collection, delta] of Object.entries(collectionDeltas)) {
    collectChangedRows(localChanges, delta.before, delta.after, collection, localTrips);
    collectChangedRows(cloudChanges, delta.before, cloudSnapshot?.[collection], collection, cloudTrips);
  }
  const conflicts = [];
  for (const [truckId, localSources] of localChanges) {
    const cloudSources = cloudChanges.get(truckId);
    if (!cloudSources) continue;
    conflicts.push({
      path: "$.trucks[" + truckId + "]",
      reason: "CONCURRENT_LOCAL_AND_CLOUD_MUTATION_ON_SAME_TRUCK",
      truckId,
      localSources: [...localSources].sort(),
      cloudSources: [...cloudSources].sort()
    });
  }
  return conflicts;
}

function mergeFleetValue(base, local, cloud, path = "$", context = null) {
  if (path === "$" && context) {
    const ownershipConflicts = findConcurrentActiveTripOwnershipConflicts(
      context.baseState, context.localState, context.cloudState
    );
    if (ownershipConflicts.length) return { ok: false, conflicts: ownershipConflicts };
  }
  const same = (a, b) => a === MERGE_MISSING || b === MERGE_MISSING
    ? a === b
    : canonicalOperationHash(a) === canonicalOperationHash(b);
  if (same(local, base)) return { ok: true, value: cloud };
  if (same(cloud, base) || same(local, cloud)) return { ok: true, value: local };
  const isRecord = value => value !== MERGE_MISSING && value !== null &&
    typeof value === "object" && !Array.isArray(value);
  if (isRecord(base) && isRecord(local) && isRecord(cloud)) {
    const out = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(cloud)]);
    const conflicts = [];
    for (const key of [...keys].sort()) {
      const child = mergeFleetValue(
        Object.prototype.hasOwnProperty.call(base, key) ? base[key] : MERGE_MISSING,
        Object.prototype.hasOwnProperty.call(local, key) ? local[key] : MERGE_MISSING,
        Object.prototype.hasOwnProperty.call(cloud, key) ? cloud[key] : MERGE_MISSING,
        path + "." + key
      );
      if (!child.ok) conflicts.push(...child.conflicts);
      else if (child.value !== MERGE_MISSING) out[key] = child.value;
    }
    return conflicts.length ? { ok: false, conflicts } : { ok: true, value: out };
  }
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(cloud)) {
    const identityFields = ["id", "key", "allocationId", "movementId"];
    const identityField = identityFields.find(field =>
      [base, local, cloud].every(rows => rows.every(row =>
        row && typeof row === "object" && row[field] != null && String(row[field]).trim() !== ""))
    );
    if (identityField) {
      const toMap = rows => new Map(rows.map(row => [String(row[identityField]), row]));
      const bm = toMap(base), lm = toMap(local), cm = toMap(cloud);
      if (bm.size !== base.length || lm.size !== local.length || cm.size !== cloud.length) {
        return { ok: false, conflicts: [{ path, reason: "DUPLICATE_ARRAY_IDENTITY", identityField }] };
      }
      const keys = [...new Set([...cloud.map(row => String(row[identityField])), ...local.map(row => String(row[identityField])), ...base.map(row => String(row[identityField]))])];
      const out = [], conflicts = [];
      for (const key of keys) {
        const child = mergeFleetValue(
          bm.has(key) ? bm.get(key) : MERGE_MISSING,
          lm.has(key) ? lm.get(key) : MERGE_MISSING,
          cm.has(key) ? cm.get(key) : MERGE_MISSING,
          path + "[" + identityField + "=" + key + "]"
        );
        if (!child.ok) conflicts.push(...child.conflicts);
        else if (child.value !== MERGE_MISSING) out.push(child.value);
      }
      return conflicts.length ? { ok: false, conflicts } : { ok: true, value: out };
    }
    // Unkeyed ledgers may only be merged as append-only histories. Editing or
    // deleting a committed prefix is ambiguous and must remain quarantined.
    const prefixMatches = (rows, prefix) => rows.length >= prefix.length &&
      prefix.every((row, index) => same(row, rows[index]));
    if (!prefixMatches(local, base) || !prefixMatches(cloud, base)) {
      return { ok: false, conflicts: [{ path, reason: "UNKEYED_ARRAY_PREFIX_CHANGED" }] };
    }
    const out = cloud.slice();
    const seen = new Set(cloud.map(row => canonicalOperationHash(row)));
    for (const row of local.slice(base.length)) {
      const key = canonicalOperationHash(row);
      if (!seen.has(key)) { out.push(row); seen.add(key); }
    }
    return { ok: true, value: out };
  }
  return { ok: false, conflicts: [{ path, reason: "OVERLAPPING_STATE_CHANGE" }] };
}

function validateMergedFleetState(state, context = null) {
  const activeByTruck = new Map();
  for (const trip of state?.trips || []) {
    if (!["OPEN", "ACTIVE"].includes(String(trip?.status || "").toUpperCase())) continue;
    const truckId = String(trip?.truckId ?? "");
    if (!truckId) continue;
    const rows = activeByTruck.get(truckId) || [];
    rows.push(String(trip?.id ?? ""));
    activeByTruck.set(truckId, rows);
  }
  const conflicts = [...activeByTruck.entries()]
    .filter(([, tripIds]) => tripIds.length > 1)
    .map(([truckId, tripIds]) => ({ path: "$.trips", reason: "MULTIPLE_ACTIVE_TRIPS_FOR_TRUCK", truckId, tripIds }));
  if (context) conflicts.push(...findConcurrentActiveTripOwnershipConflicts(
    context.baseState, context.localState, context.cloudState
  ));
  return conflicts;
}

/** Stable local queue ordering: sequence first, then normalized UTF-16 opId. */
export function comparePendingMutationsDeterministically(a, b) {
  const hasA = a?.localSeq !== undefined && a?.localSeq !== null;
  const hasB = b?.localSeq !== undefined && b?.localSeq !== null;
  // Missing sequence values form a deterministic final bucket. This preserves
  // transitivity (required by Array#sort) while ordering that bucket by opId.
  if (hasA !== hasB) return hasA ? -1 : 1;
  if (hasA) {
    const seqA = BigInt(a.localSeq);
    const seqB = BigInt(b.localSeq);
    if (seqA < seqB) return -1;
    if (seqA > seqB) return 1;
  }
  const idA = String(a?.opId ?? "").normalize("NFC");
  const idB = String(b?.opId ?? "").normalize("NFC");
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

function parseMoneyCentsV42(value) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0)))) return null;
  const raw = String(value).trim();
  // Parse the supplied decimal text directly. Never multiply a binary float by
  // 100: that can accept/reject values based on representation noise.
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.exec(raw);
  if (!match) return null;
  const fraction = (match[2] || "").padEnd(2, "0");
  const cents = BigInt(match[1]) * 100n + BigInt(fraction || "0");
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}
function normalizeMoneyV42(value) {
  const cents = parseMoneyCentsV42(value);
  return cents === null ? null : cents / 100;
}
function finiteAmount(value, label) {
  const cents = parseMoneyCentsV42(value);
  if (cents === null || cents <= 0) throw new Error(`${label} must be a positive amount with at most two decimal places`);
  return cents / 100;
}
function moneyCents(value) {
  return parseMoneyCentsV42(value);
}
function fromMoneyCents(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid safe integer money cents");
  return cents / 100;
}

function findById(items, id) {
  return Array.isArray(items) ? items.find(item => item && item.id === id) : undefined;
}

function cloneSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Cloud snapshot must be an object");
  }
  return structuredClone(snapshot);
}

/**
 * Replays supported pending operations against a cloud snapshot.
 * Unknown or unsafe operations are quarantined rather than guessed or discarded.
 *
 * DEBT_COLLECTION payload:
 * { customerId, amount, cashMovementId, cashMovement? }
 *
 * SALE_INVOICE payload:
 * { productId, quantity, invoice, stockMovement, cashMovement? }
 * The sale is quarantined if the cloud stock is insufficient. A complete sale is
 * only applied when required invoice/stock movement IDs and structures are present.
 */
export function reconcilePendingMutations(cloudSnapshot, pendingMutations) {
  if (!Array.isArray(pendingMutations)) throw new Error("Pending mutations must be an array");

  const snapshot = cloneSnapshot(cloudSnapshot);
  const applied = new Set(Array.isArray(snapshot.appliedOpIds) ? snapshot.appliedOpIds : []);
  snapshot.appliedOpIds = [...applied];
  if (!Array.isArray(snapshot.appliedOperations)) snapshot.appliedOperations = [];
  const appliedRecords = new Map(snapshot.appliedOperations.map(record => [record.opId, record]));
  const review = [];
  const appliedNow = [];
  const seenPending = new Set();

  const orderedPending = pendingMutations.slice().sort(comparePendingMutationsDeterministically);
  for (const op of orderedPending) {
    if (!op || typeof op !== "object" || typeof op.opId !== "string" || !op.opId.trim()) {
      review.push({ opId: op?.opId ?? null, reason: "INVALID_OPERATION_ID", operation: op ?? null });
      continue;
    }
    if (seenPending.has(op.opId)) {
      review.push({ opId: op.opId, reason: "DUPLICATE_ID_IN_PENDING_QUEUE", operation: op });
      continue;
    }
    seenPending.add(op.opId);

    const payload = op.payload;
    if (!payload || typeof payload !== "object") {
      review.push({ opId: op.opId, reason: "INVALID_PAYLOAD", operation: op });
      continue;
    }
    let operationPayloadHash;
    try { operationPayloadHash = canonicalOperationHash({ type: op.type, payload }); }
    catch (error) {
      review.push({ opId: op.opId, reason: error.code || "NON_CANONICAL_PAYLOAD", operation: op });
      continue;
    }
    const priorAppliedRecord = appliedRecords.get(op.opId);
    if (priorAppliedRecord) {
      if (priorAppliedRecord.payloadHash !== operationPayloadHash) {
        const error = new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
        error.code = "IDEMPOTENCY_PAYLOAD_MISMATCH";
        throw error;
      }
      appliedNow.push({ opId: op.opId, outcome: "folded-duplicate" });
      continue;
    }
    const markApplied = () => {
      const record = {
        opId: op.opId,
        payloadHash: operationPayloadHash,
        parentStateHash: canonicalOperationHash(snapshot)
      };
      applied.add(op.opId);
      snapshot.appliedOpIds = [...applied];
      snapshot.appliedOperations.push(record);
      appliedRecords.set(op.opId, record);
    };

    if (op.type === "TRUCK_FLEET_OPERATION") {
      const baseState = payload.baseState ?? null;
      const nextState = payload.nextState;
      if (!nextState || typeof nextState !== "object" || Array.isArray(nextState) ||
          nextState.schemaVersion !== 1 || !Array.isArray(nextState.products) ||
          !Array.isArray(nextState.trucks) || !Array.isArray(nextState.trips) ||
          !Array.isArray(nextState.movements)) {
        review.push({ opId: op.opId, reason: "INVALID_TRUCK_FLEET_STATE", operation: op });
        continue;
      }
      const cloudState = snapshot.anasFleetState ?? null;
      const hash = value => canonicalOperationHash(value);
      if (hash(cloudState) === hash(nextState)) {
        markApplied();
        appliedNow.push({ opId: op.opId, outcome: "already-applied" });
        continue;
      }
      const collectionDeltas = payload.collectionDeltas ?? {};
      if (!collectionDeltas || typeof collectionDeltas !== "object" || Array.isArray(collectionDeltas)) {
        review.push({opId:op.opId,reason:"TRUCK_FLEET_COLLECTION_DELTAS_INVALID",operation:op});
        continue;
      }
      const sameTruckConflicts = findConcurrentTruckMutationConflicts(baseState, nextState, cloudState, collectionDeltas, snapshot);
      if (sameTruckConflicts.length) {
        const ownershipConflicts = findConcurrentActiveTripOwnershipConflicts(baseState, nextState, cloudState);
        review.push({
          opId: op.opId,
          reason: "TRUCK_FLEET_SAME_TRUCK_CONFLICT",
          conflicts: [...sameTruckConflicts, ...ownershipConflicts],
          operation: op,
          cloudState: structuredClone(cloudState),
          baseState: structuredClone(baseState),
          localState: structuredClone(nextState)
        });
        continue;
      }
      const fleetMergeContext = { baseState, localState: nextState, cloudState };
      const stateMerge = mergeFleetValue(baseState, nextState, cloudState, "$", fleetMergeContext);
      const stateConflicts = stateMerge.ok
        ? validateMergedFleetState(stateMerge.value, fleetMergeContext)
        : stateMerge.conflicts;
      if (!stateMerge.ok || stateConflicts.length) {
        review.push({opId:op.opId,reason:"TRUCK_FLEET_STATE_CONFLICT",conflicts:stateConflicts,
          operation:op,cloudState:structuredClone(cloudState),baseState:structuredClone(baseState),
          localState:structuredClone(nextState)});
        continue;
      }
      const mergedFleetState = stateMerge.value;
      const targetSnapshot = structuredClone(snapshot);
      const fleetCollectionKeys = new Set([
        "trucks", "truckTrips", "stockMovements", "expenses",
        "returns", "warehouseTransfers", "auditTrail", "customers", "invoices",
        "cashMovements", "bankMovements", "clientMovements", "settlementAllocations"
      ]);
      const immutableFleetLedgers = new Set([
        "stockMovements", "expenses", "returns", "warehouseTransfers", "auditTrail", "invoices",
        "cashMovements", "bankMovements", "clientMovements", "settlementAllocations"
      ]);
      const fleetIdentityFields = {
        trucks: "id", truckTrips: "id", stockMovements: "id", expenses: "id",
        returns: "id", warehouseTransfers: "id", auditTrail: "id", customers: "id",
        invoices: "id", cashMovements: "id", bankMovements: "id",
        clientMovements: "movementId", settlementAllocations: "allocationId"
      };
      for (const [key, delta] of Object.entries(collectionDeltas)) {
        if (!fleetCollectionKeys.has(key) || !delta || typeof delta !== "object" ||
            !(delta.before === null || Array.isArray(delta.before)) ||
            !(delta.after === null || Array.isArray(delta.after))) {
          review.push({opId:op.opId,reason:"TRUCK_FLEET_COLLECTION_DELTA_INVALID",collection:key,operation:op});
          continue;
        }
        const validateRows = (rows, collection) => {
          if (rows === null) return new Map();
          const idField = fleetIdentityFields[collection] || "id";
          const byId = new Map();
          for (const row of rows) {
            const id = row?.[idField];
            if (!row || typeof row !== "object" || Array.isArray(row) ||
                id == null || String(id).trim() === "" || byId.has(String(id))) return null;
            byId.set(String(id), row);
          }
          return byId;
        };
        const beforeRows = validateRows(delta.before, key), afterRows = validateRows(delta.after, key);
        if (!beforeRows || !afterRows) {
          review.push({opId:op.opId,reason:"TRUCK_FLEET_COLLECTION_ROWS_INVALID",collection:key,operation:op});
          continue;
        }
        const addedRows = [...afterRows.entries()]
          .filter(([id]) => !beforeRows.has(id)).map(([, row]) => row);
        const validQuantity = value => {
          const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,3}))?$/.exec(String(value ?? "").trim());
          if (!match) return false;
          const units = BigInt(match[2]) * 1000n + BigInt((match[3] || "").padEnd(3, "0") || "0");
          return (match[1] ? -units : units) !== 0n;
        };
        const validLedgerRow = row => {
          if (key === "cashMovements" || key === "bankMovements") {
            const cents = moneyCents(row.amount);
            return cents !== null && cents > 0;
          }
          if (key === "stockMovements") return validQuantity(row.qty ?? row.quantity);
          if (key === "clientMovements" || key === "settlementAllocations") {
            return Number.isSafeInteger(row.amountCentimes) && row.amountCentimes >= 0;
          }
          if (key === "expenses" && row.amount !== undefined) {
            const cents = moneyCents(row.amount);
            return cents !== null && cents > 0;
          }
          if (key === "invoices") {
            const total = moneyCents(row.total);
            const paid = moneyCents(row.paid ?? row.total);
            const remaining = row.remaining == null
              ? (total !== null && paid !== null ? total - paid : null)
              : moneyCents(row.remaining);
            return total !== null && paid !== null && remaining !== null &&
              paid <= total && remaining === total - paid;
          }
          if (key === "auditTrail") {
            return ["amountCentimes", "paidCentimes", "remainingCentimes"].every(field =>
              row[field] === undefined || (Number.isSafeInteger(row[field]) && row[field] >= 0));
          }
          return true;
        };
        let unsafeLedgerEdit = key === "customers" && afterRows.size !== beforeRows.size;
        if (immutableFleetLedgers.has(key) && addedRows.some(row => !validLedgerRow(row))) {
          unsafeLedgerEdit = true;
        }
        for (const [id, beforeRow] of beforeRows) {
          const afterRow = afterRows.get(id);
          if (!afterRow || (immutableFleetLedgers.has(key) && hash(beforeRow) !== hash(afterRow))) {
            unsafeLedgerEdit = true;
            break;
          }
          if (key === "customers") {
            const stripDebtFields = row => {
              const copy = structuredClone(row);
              delete copy.debt;
              delete copy.debtDate;
              delete copy.ledgerVersion;
              return copy;
            };
            const beforeDebt = moneyCents(beforeRow.debt ?? 0);
            const afterDebt = moneyCents(afterRow.debt ?? 0);
            if (hash(stripDebtFields(beforeRow)) !== hash(stripDebtFields(afterRow)) ||
                beforeDebt === null || afterDebt === null ||
                (afterRow.debtDate != null &&
                  (typeof afterRow.debtDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(afterRow.debtDate))) ||
                (afterRow.ledgerVersion != null && ![1, 2].includes(afterRow.ledgerVersion))) {
              unsafeLedgerEdit = true;
              break;
            }
          }
        }
        if (unsafeLedgerEdit) {
          review.push({opId:op.opId,reason:"TRUCK_FLEET_COLLECTION_DELTA_NOT_APPEND_ONLY",collection:key,operation:op});
          continue;
        }
        const cloudRows = targetSnapshot[key] ?? null;
        const beforeValue = delta.before ?? null, afterValue = delta.after ?? null;
        if (hash(cloudRows) === hash(afterValue)) continue;
        if (hash(cloudRows) !== hash(beforeValue)) {
          review.push({opId:op.opId,reason:"TRUCK_FLEET_COLLECTION_CONFLICT",collection:key,
            cloudValue:structuredClone(cloudRows),baseValue:structuredClone(beforeValue),
            localValue:structuredClone(afterValue),operation:op});
          continue;
        }
        if (afterValue === null) delete targetSnapshot[key];
        else targetSnapshot[key] = structuredClone(afterValue);
      }
      const cashBalanceDelta = payload.caisseBalanceDelta;
      const cashCollectionDelta = collectionDeltas.cashMovements;
      const cashBeforeRows = Array.isArray(cashCollectionDelta?.before) ? cashCollectionDelta.before : [];
      const cashAfterRows = Array.isArray(cashCollectionDelta?.after) ? cashCollectionDelta.after : [];
      const cashBeforeIds = new Set(cashBeforeRows.map(row => String(row?.id ?? "")));
      const appendedCashRows = cashAfterRows.filter(row => !cashBeforeIds.has(String(row?.id ?? "")));
      const cashRowsAlreadyApplied = appendedCashRows.length > 0 && appendedCashRows.every(row =>
        (Array.isArray(snapshot.cashMovements) ? snapshot.cashMovements : []).some(existing =>
          String(existing?.id ?? "") === String(row?.id ?? "") && hash(existing) === hash(row)));
      if (cashBalanceDelta != null || appendedCashRows.length) {
        const beforeCents = cashBalanceDelta == null ? null : moneyCents(cashBalanceDelta.before);
        const afterCents = cashBalanceDelta == null ? null : moneyCents(cashBalanceDelta.after);
        const cloudCents = moneyCents(snapshot.caisseBalance ?? 0);
        let ledgerDelta = 0n, ledgerValid = true;
        for (const row of appendedCashRows) {
          const cents = moneyCents(row?.amount);
          const type = String(row?.type || "").toLowerCase();
          if (cents === null || cents <= 0 || !["add", "subtract"].includes(type)) {
            ledgerValid = false; break;
          }
          ledgerDelta += type === "add" ? BigInt(cents) : -BigInt(cents);
        }
        if (beforeCents === null || afterCents === null || cloudCents === null ||
            !ledgerValid || appendedCashRows.length === 0 ||
            BigInt(afterCents) - BigInt(beforeCents) !== ledgerDelta) {
          review.push({opId:op.opId,reason:"TRUCK_FLEET_CASH_BALANCE_LEDGER_MISMATCH",operation:op});
        } else if (!cashRowsAlreadyApplied) {
          const rebasedCash = BigInt(cloudCents) + ledgerDelta;
          if (rebasedCash < 0n || rebasedCash > BigInt(Number.MAX_SAFE_INTEGER)) {
            review.push({opId:op.opId,reason:"TRUCK_FLEET_CASH_BALANCE_OUT_OF_RANGE",operation:op});
          } else {
            targetSnapshot.caisseBalance = Number(rebasedCash) / 100;
          }
        }
      }
      if (review.some(item => item.opId === op.opId)) continue;
      if (payload.actorId && targetSnapshot.currentUser &&
          String(targetSnapshot.currentUser.id ?? "") === String(payload.actorId)) {
        const ownTrip = [...nextState.trips].reverse().find(trip => String(trip.driverId) === String(payload.actorId));
        if (ownTrip && (ownTrip.status === "OPEN" || ownTrip.status === "ACTIVE")) {
          targetSnapshot.currentUser.secondaryWarehouse = String(ownTrip.warehouseName || "");
        } else if (ownTrip && (ownTrip.status === "CLOSED" || ownTrip.status === "CANCELLED")) {
          targetSnapshot.currentUser.secondaryWarehouse = String(ownTrip.previousUserWarehouse || "");
        }
      }
      const warehouseRows = Array.isArray(payload.warehouses) ? payload.warehouses : [];
      if (targetSnapshot.warehouses !== undefined && !Array.isArray(targetSnapshot.warehouses)) {
        review.push({ opId: op.opId, reason: "TRUCK_FLEET_CLOUD_WAREHOUSES_MALFORMED", operation: op });
        continue;
      }
      if (!Array.isArray(targetSnapshot.warehouses)) targetSnapshot.warehouses = [];
      // The fleet engine stores warehouseName on the truck, not on the trip.
      // Recover it from the actor's latest trip/truck when an older capture
      // envelope contains a warehouse row whose name is absent.
      const actorTrip = [...nextState.trips].reverse().find(trip =>
        String(trip?.driverId ?? "") === String(payload.actorId ?? "")
      );
      const actorTruck = actorTrip
        ? nextState.trucks.find(truck => String(truck?.id ?? "") === String(actorTrip.truckId ?? ""))
        : null;
      const baseActorTruck = actorTrip && Array.isArray(baseState?.trucks)
        ? baseState.trucks.find(truck => String(truck?.id ?? "") === String(actorTrip.truckId ?? ""))
        : null;
      const derivedWarehouseName = String(
        actorTruck?.warehouseName || baseActorTruck?.warehouseName || ""
      ).trim();
      const invoiceDelta = collectionDeltas.invoices;
      if (invoiceDelta) {
        const priorInvoiceIds = new Set((invoiceDelta.before || []).map(row => String(row?.id ?? "")));
        const appendedInvoices = (invoiceDelta.after || []).filter(row => !priorInvoiceIds.has(String(row?.id ?? "")));
        if (appendedInvoices.some(row =>
          !derivedWarehouseName ||
          String(row?.warehouse || row?.warehouseName || "").trim() !== derivedWarehouseName
        )) {
          review.push({opId:op.opId,reason:"TRUCK_FLEET_INVOICE_NOT_LINKED_TO_TRUCK_WAREHOUSE",operation:op});
        }
      }
      // Validate linked POS invoices before warehouse metadata so an offline
      // fleet sale is quarantined for its actual dependency, not a stale capture
      // envelope that omitted the warehouse name.
      const baseTripSales = new Map((Array.isArray(baseState?.trips) ? baseState.trips : [])
        .map(trip => [String(trip.id), new Set((trip.sales || []).map(row => String(row.id)))]));
      for (const trip of nextState.trips) {
        const priorSales = baseTripSales.get(String(trip.id)) || new Set();
        for (const sale of trip.sales || []) {
          if (!priorSales.has(String(sale.id)) && sale.invoiceId &&
              !(Array.isArray(targetSnapshot.invoices) ? targetSnapshot.invoices : [])
                .some(row => String(row?.id ?? "") === String(sale.invoiceId))) {
            review.push({ opId: op.opId, reason: "TRUCK_FLEET_LINKED_INVOICE_NOT_SYNCED",
              invoiceId: String(sale.invoiceId), operation: op });
          }
        }
      }
      if (review.some(item => item.opId === op.opId)) continue;
      for (const warehouse of warehouseRows) {
        const suppliedName = String(
          typeof warehouse === "string" ? warehouse : warehouse?.name || ""
        ).trim();
        const name = suppliedName || derivedWarehouseName;
        if (!name) {
          review.push({ opId: op.opId, reason: "TRUCK_FLEET_WAREHOUSE_INVALID", operation: op });
          continue;
        }
        const normalizedWarehouse = warehouse && typeof warehouse === "object"
          ? { ...warehouse, name }
          : warehouse;
        const existing = targetSnapshot.warehouses.find(row =>
          String(typeof row === "string" ? row : row?.name || "").trim() === name
        );
        if (!existing) targetSnapshot.warehouses.push(structuredClone(normalizedWarehouse));
        else {
          const sameIdentity = typeof existing === "object" && typeof normalizedWarehouse === "object" &&
            String(existing.id ?? "") === String(normalizedWarehouse.id ?? "") &&
            String(existing.name ?? "") === String(normalizedWarehouse.name ?? "") &&
            String(existing.type ?? "") === String(normalizedWarehouse.type ?? "");
          const existingOwner = existing && typeof existing === "object" ? existing.assigned_user_id ?? null : null;
          const requestedOwner = normalizedWarehouse && typeof normalizedWarehouse === "object" ? normalizedWarehouse.assigned_user_id ?? null : null;
          const allowedRelease = sameIdentity && String(existingOwner ?? "") === String(payload.actorId ?? "") && requestedOwner == null;
          const allowedClaim = sameIdentity && existingOwner == null && String(requestedOwner ?? "") === String(payload.actorId ?? "");
          if (sameIdentity && (canonicalOperationHash(existing) === canonicalOperationHash(normalizedWarehouse) || allowedRelease || allowedClaim)) {
            if (allowedRelease || allowedClaim) existing.assigned_user_id = requestedOwner;
          } else {
            review.push({ opId: op.opId, reason: "TRUCK_FLEET_WAREHOUSE_CONFLICT", warehouseName: name, cloudWarehouse: structuredClone(existing), localWarehouse: structuredClone(normalizedWarehouse), operation: op });
          }
        }
      }
      if (review.some(item => item.opId === op.opId)) continue;
      const big = value => {
        if (typeof value === "bigint") return value;
        if (typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value)) return BigInt(value);
        if (value && typeof value === "object" && typeof value.__anasFleetBigInt === "string" &&
            /^-?(0|[1-9]\d*)$/.test(value.__anasFleetBigInt)) return BigInt(value.__anasFleetBigInt);
        throw new TypeError("INVALID_FLEET_BIGINT");
      };
      const tagged = value => ({__anasFleetBigInt:value.toString()});
      const quantity = value => {
        const m=/^(0|[1-9]\d*)(?:\.(\d{1,3}))?$/.exec(String(value??"0").trim());
        if(!m)throw new TypeError("INVALID_CLOUD_STOCK_QUANTITY");
        return BigInt(m[1])*1000n+BigInt((m[2]||"").padEnd(3,"0")||"0");
      };
      const formatQuantity=value=>{const n=big(value);return(n/1000n).toString()+"."+String(n%1000n).padStart(3,"0");};
      const rebased=structuredClone(mergedFleetState);
      const localNextState=structuredClone(nextState);
      const baseProducts=new Map((Array.isArray(baseState?.products)?baseState.products:[]).map(row=>[String(row.id),row]));
      const nextProducts=new Map(localNextState.products.map(row=>[String(row.id),row]));
      const mergedProducts=new Map(rebased.products.map(row=>[String(row.id),row]));
      const productRows=new Map();
      for(const [id,localNextProduct] of nextProducts){
        const mergedProduct=mergedProducts.get(id);
        const matches=(Array.isArray(targetSnapshot.products)?targetSnapshot.products:[]).filter(row=>row&&String(row.id)===id);
        if(!mergedProduct||matches.length!==1){review.push({opId:op.opId,reason:"TRUCK_FLEET_PRODUCT_MISSING_OR_AMBIGUOUS",productId:id,operation:op});continue;}
        productRows.set(id,matches[0]);
        let cloudMain,baseMain,nextMain;
        try{cloudMain=quantity(matches[0].stock??0);baseMain=baseProducts.has(id)?big(baseProducts.get(id).mainStockUnits):cloudMain;nextMain=big(localNextProduct.mainStockUnits);}
        catch(_){review.push({opId:op.opId,reason:"TRUCK_FLEET_INVALID_MAIN_STOCK",productId:id,operation:op});continue;}
        const rebasedMain=cloudMain+(nextMain-baseMain);
        if(rebasedMain<0n){review.push({opId:op.opId,reason:"TRUCK_FLEET_MAIN_STOCK_UNDERFLOW",productId:id,operation:op});continue;}
        matches[0].stock=formatQuantity(rebasedMain);mergedProduct.mainStockUnits=tagged(rebasedMain);
      }
      if(review.some(item=>item.opId===op.opId))continue;
      const baseTrucks=new Map((Array.isArray(baseState?.trucks)?baseState.trucks:[]).map(row=>[String(row.id),row]));
      const baseTrips=new Map((Array.isArray(baseState?.trips)?baseState.trips:[]).map(row=>[String(row.id),row]));
      const newTripSales=[];
      for(const trip of localNextState.trips){
        const oldTrip=baseTrips.get(String(trip.id)),oldSales=new Set((oldTrip?.sales||[]).map(row=>String(row.id)));
        for(const sale of trip.sales||[])if(!oldSales.has(String(sale.id))&&sale.invoiceId)newTripSales.push({invoiceId:String(sale.invoiceId),productId:String(sale.productId),quantityUnits:big(sale.quantityUnits)});
      }
      const localNextTrucks=new Map(localNextState.trucks.map(row=>[String(row.id),row]));
      const mergedTrucks=new Map(rebased.trucks.map(row=>[String(row.id),row]));
      for(const [truckId,localNextTruck] of localNextTrucks){
        const nextTruck=mergedTrucks.get(truckId);
        if(!nextTruck){review.push({opId:op.opId,reason:"TRUCK_FLEET_TRUCK_MISSING_AFTER_MERGE",truckId,operation:op});continue;}
        const baseTruck=baseTrucks.get(truckId),warehouseName=String(localNextTruck.warehouseName||baseTruck?.warehouseName||"").trim();
        if(!warehouseName)continue;
        const baseStock=baseTruck?.stockUnits||{},nextStock=localNextTruck.stockUnits||{};
        for(const [productId,product] of productRows){
          let delta;try{delta=big(nextStock[productId]??"0")-big(baseStock[productId]??"0");}catch(_){review.push({opId:op.opId,reason:"TRUCK_FLEET_INVALID_TRUCK_STOCK",truckId,productId,operation:op});continue;}
          if(product.warehouseStock!==undefined&&(!product.warehouseStock||typeof product.warehouseStock!=="object"||Array.isArray(product.warehouseStock))){review.push({opId:op.opId,reason:"TRUCK_FLEET_MALFORMED_WAREHOUSE_STOCK",truckId,productId,operation:op});continue;}
          const map=product.warehouseStock||(product.warehouseStock={});
          let current;try{current=quantity(map[warehouseName]??0);}catch(_){review.push({opId:op.opId,reason:"TRUCK_FLEET_INVALID_WAREHOUSE_STOCK",truckId,productId,operation:op});continue;}
          // POS may have reduced this warehouse stock before the fleet mutation
          // reached the cloud. Compensate only when the cloud balance already
          // equals the post-sale truck balance; a newly bundled invoice must
          // still apply the sale delta exactly once.
          for(const sale of newTripSales)if(sale.productId===productId){
            const invoice=targetSnapshot.invoices.find(row=>String(row?.id??"")===sale.invoiceId);
            if(invoice&&String(invoice.warehouse||invoice.warehouseName||"")===warehouseName&&
               current===big(nextStock[productId]??"0"))delta+=sale.quantityUnits;
          }
          const updated=current+delta;
          if(updated<0n){review.push({opId:op.opId,reason:"TRUCK_FLEET_TRUCK_STOCK_UNDERFLOW",truckId,productId,operation:op});continue;}
          map[warehouseName]=formatQuantity(updated);
          if(updated===0n&&!Object.prototype.hasOwnProperty.call(nextStock,productId)&&!Object.prototype.hasOwnProperty.call(baseStock,productId))delete nextTruck.stockUnits[productId];
          else nextTruck.stockUnits[productId]=tagged(updated);
        }
      }
      if(review.some(item=>item.opId===op.opId))continue;
      snapshot.products=targetSnapshot.products;
      snapshot.warehouses=targetSnapshot.warehouses;
      for (const key of Object.keys(collectionDeltas)) {
        if (targetSnapshot[key] === undefined) delete snapshot[key];
        else snapshot[key] = targetSnapshot[key];
      }
      if(Object.prototype.hasOwnProperty.call(targetSnapshot,"caisseBalance"))snapshot.caisseBalance=targetSnapshot.caisseBalance;
      if(targetSnapshot.currentUser!==undefined)snapshot.currentUser=targetSnapshot.currentUser;
      snapshot.anasFleetState=rebased;
      markApplied();appliedNow.push({opId:op.opId,outcome:"applied"});continue;
    }

    if (op.type === "DEBT_COLLECTION") {
      let amount;
      try { amount = finiteAmount(payload.amount, "Collection amount"); }
      catch (error) {
        review.push({ opId: op.opId, reason: "INVALID_AMOUNT", detail: error.message, operation: op });
        continue;
      }
      const amountCents = moneyCents(amount);
      const movementId = payload.cashMovementId;
      if (typeof movementId !== "string" || !movementId.trim()) {
        review.push({ opId: op.opId, reason: "MISSING_CASH_MOVEMENT_ID", operation: op });
        continue;
      }
      if (!Array.isArray(snapshot.cashMovements)) snapshot.cashMovements = [];
      const v42Ledger = payload.v42Ledger;
      const existingMovement = snapshot.cashMovements.find(movement => movement?.id === movementId);
      if (existingMovement) {
        const existingAmountCents = moneyCents(existingMovement.amount);
        const customerMatches = existingMovement.customerId == null ||
          String(existingMovement.customerId) === String(payload.customerId);
        const operationMatches = existingMovement.opId === op.opId;
        let completeBundle = true;
        if (v42Ledger !== undefined) {
          if (!v42Ledger || !Array.isArray(v42Ledger.clientMovements) ||
              !Array.isArray(v42Ledger.settlementAllocations)) {
            completeBundle = false;
          } else {
            const existingCustomer = findById(snapshot.customers, payload.customerId);
            const postDebtCents = moneyCents(existingCustomer?.debt);
            const expectedOpeningCents = postDebtCents === null
              ? null : postDebtCents + amountCents;
            completeBundle = expectedOpeningCents !== null &&
              v42Ledger.clientMovements.every(row => {
                const expected = row?.type === "opening_balance"
                  ? { ...row, amountCentimes: expectedOpeningCents }
                  : row;
                return (Array.isArray(snapshot.clientMovements) ? snapshot.clientMovements : [])
                  .some(existing => JSON.stringify(existing) === JSON.stringify(expected));
              }) &&
              v42Ledger.settlementAllocations.every(row =>
                (Array.isArray(snapshot.settlementAllocations) ? snapshot.settlementAllocations : [])
                  .some(existing => JSON.stringify(existing) === JSON.stringify(row)));
          }
        }
        if (existingAmountCents === amountCents && customerMatches && operationMatches && completeBundle) {
          markApplied();
          appliedNow.push({ opId: op.opId, outcome: "already-applied", reason: "CASH_MOVEMENT_ENTITY_EXISTS" });
        } else {
          review.push({
            opId: op.opId,
            reason: !customerMatches || !operationMatches || existingAmountCents !== amountCents
              ? "CASH_MOVEMENT_ID_COLLISION"
              : "V42_COLLECTION_LEDGER_INCOMPLETE",
            operation: op
          });
        }
        continue;
      }
      if (applied.has(op.opId)) {
        review.push({ opId: op.opId, reason: "APPLIED_OPERATION_ENTITY_MISSING", operation: op });
        continue;
      }
      const customer = findById(snapshot.customers, payload.customerId);
      if (!customer) {
        review.push({ opId: op.opId, reason: "CUSTOMER_NOT_FOUND", operation: op });
        continue;
      }
      const debtCents = moneyCents(customer.debt);
      if (debtCents === null || debtCents < amountCents) {
        review.push({ opId: op.opId, reason: "COLLECTION_EXCEEDS_RECORDED_DEBT_OR_INVALID_DEBT", operation: op });
        continue;
      }
      const cashCents = moneyCents(snapshot.caisseBalance);
      if (cashCents === null) {
        review.push({ opId: op.opId, reason: "INVALID_CASH_BALANCE", operation: op });
        continue;
      }
      if (cashCents + amountCents > Number.MAX_SAFE_INTEGER) {
        review.push({ opId: op.opId, reason: "CASH_BALANCE_OVERFLOW", operation: op });
        continue;
      }

      let clientRows = [];
      let allocationRows = [];
      if (v42Ledger !== undefined) {
        clientRows = v42Ledger?.clientMovements;
        allocationRows = v42Ledger?.settlementAllocations;
        if (!Array.isArray(clientRows) || !Array.isArray(allocationRows)) {
          review.push({ opId: op.opId, reason: "INCOMPLETE_V42_COLLECTION_LEDGER_BUNDLE", operation: op });
          continue;
        }
        const receipts = clientRows.filter(row => row?.type === "receipt");
        const openings = clientRows.filter(row => row?.type === "opening_balance");
        const needsOpening = customer.ledgerVersion !== 2;
        const validReceipt = receipts.length === 1 &&
          receipts[0].direction === "credit" &&
          String(receipts[0].clientId) === String(customer.id) &&
          String(receipts[0].referenceType) === "customer_debt" &&
          String(receipts[0].referenceId) === String(customer.id) &&
          receipts[0].amountCentimes === amountCents;
        const validOpening = openings.length === (needsOpening ? 1 : 0) &&
          openings.every(row => row.direction === "debit" &&
            String(row.clientId) === String(customer.id) &&
            String(row.referenceType) === "opening_balance" &&
            String(row.referenceId) === String(customer.id) &&
            Number.isSafeInteger(row.amountCentimes) && row.amountCentimes > 0);
        const invoiceRows = Array.isArray(snapshot.invoices) ? snapshot.invoices : [];
        const existingAllocations = Array.isArray(snapshot.settlementAllocations)
          ? snapshot.settlementAllocations : [];
        const customerInvoices = invoiceRows.filter(invoice =>
          String(invoice?.customerId ?? invoice?.customerObj?.id ?? "") === String(customer.id));
        const invoiceById = new Map();
        const priorByInvoice = new Map();
        const eligibleBalances = [];
        let validAllocations = allocationRows.length > 0;
        for (const invoice of customerInvoices) {
          const invoiceId = String(invoice?.id ?? "");
          if (!invoiceId || invoiceById.has(invoiceId)) {
            validAllocations = false;
            break;
          }
          invoiceById.set(invoiceId, invoice);
          const totalCents = moneyCents(invoice.total);
          const paidCents = moneyCents(invoice.paid ?? 0);
          const originalRemainingCents = moneyCents(invoice.remaining);
          if (![totalCents, paidCents, originalRemainingCents].every(Number.isSafeInteger) ||
              totalCents <= 0 || paidCents < 0 || originalRemainingCents < 0 ||
              paidCents + originalRemainingCents !== totalCents) {
            validAllocations = false;
            break;
          }
          priorByInvoice.set(invoiceId, 0);
        }
        if (validAllocations) {
          for (const prior of existingAllocations) {
            if (prior?.partyType !== "customer" ||
                String(prior.partyId) !== String(customer.id) ||
                prior.invoiceType !== "sales_invoice" ||
                prior.sourceMovementType !== "customer_debt") continue;
            const invoiceId = String(prior.invoiceId ?? "");
            if (!invoiceById.has(invoiceId) ||
                !Number.isSafeInteger(prior.amountCentimes) || prior.amountCentimes <= 0) {
              validAllocations = false;
              break;
            }
            const accumulated = (priorByInvoice.get(invoiceId) || 0) + prior.amountCentimes;
            if (!Number.isSafeInteger(accumulated)) {
              validAllocations = false;
              break;
            }
            priorByInvoice.set(invoiceId, accumulated);
          }
        }
        if (validAllocations) {
          for (const [invoiceId, invoice] of invoiceById.entries()) {
            const totalCents = moneyCents(invoice.total);
            const paidCents = moneyCents(invoice.paid ?? 0);
            const remainingCents = totalCents - paidCents - (priorByInvoice.get(invoiceId) || 0);
            if (!Number.isSafeInteger(remainingCents) || remainingCents < 0) {
              validAllocations = false;
              break;
            }
            if (remainingCents > 0) {
              const dateValue = invoice.date || invoice.createdAt || invoice.timestamp || invoice.invoiceDate || "";
              const parsedDate = Date.parse(dateValue);
              eligibleBalances.push({
                invoiceId,
                remaining: remainingCents,
                date: Number.isFinite(parsedDate) && parsedDate ? parsedDate : 0
              });
            }
          }
        }
        if (validAllocations) {
          eligibleBalances.sort((a, b) => a.date - b.date || a.invoiceId.localeCompare(b.invoiceId));
          let remainingToAllocate = amountCents;
          const expectedAllocations = [];
          for (const invoice of eligibleBalances) {
            if (remainingToAllocate <= 0) break;
            const allocated = Math.min(invoice.remaining, remainingToAllocate);
            if (!Number.isSafeInteger(allocated) || allocated <= 0) {
              validAllocations = false;
              break;
            }
            expectedAllocations.push({ invoiceId: invoice.invoiceId, amountCentimes: allocated });
            remainingToAllocate -= allocated;
          }
          if (remainingToAllocate !== 0 || expectedAllocations.length !== allocationRows.length) {
            validAllocations = false;
          } else {
            for (let index = 0; index < expectedAllocations.length; index++) {
              const actual = allocationRows[index];
              const expected = expectedAllocations[index];
              if (!actual?.allocationId || actual.partyType !== "customer" ||
                  String(actual.partyId) !== String(customer.id) ||
                  actual.invoiceType !== "sales_invoice" ||
                  String(actual.invoiceId) !== expected.invoiceId ||
                  actual.sourceMovementType !== "customer_debt" ||
                  String(actual.sourceMovementId) !== movementId ||
                  actual.amountCentimes !== expected.amountCentimes) {
                validAllocations = false;
                break;
              }
            }
          }
        }
        const validClientRows = clientRows.length === receipts.length + openings.length &&
          clientRows.every(row => row?.movementId &&
            String(row.clientId) === String(customer.id) &&
            (row.type === "receipt" || row.type === "opening_balance"));
        const collections = [
          ["clientMovements", "movementId", clientRows],
          ["settlementAllocations", "allocationId", allocationRows]
        ];
        let collision = false;
        for (const [key, idKey, rows] of collections) {
          const ids = new Set();
          const existing = Array.isArray(snapshot[key]) ? snapshot[key] : [];
          for (const row of rows) {
            const id = row?.[idKey];
            if (id == null || String(id).trim() === "" || ids.has(String(id)) ||
                existing.some(old => String(old?.[idKey] ?? "") === String(id))) {
              collision = true;
              break;
            }
            ids.add(String(id));
          }
          if (collision) break;
        }
        if (!validReceipt || !validOpening || !validAllocations || !validClientRows || collision) {
          review.push({ opId: op.opId, reason: "V42_COLLECTION_LEDGER_MISMATCH", operation: op });
          continue;
        }
      }

      const normalizedClientRows = v42Ledger === undefined
        ? [] : structuredClone(clientRows);
      if (v42Ledger !== undefined && customer.ledgerVersion !== 2) {
        const opening = normalizedClientRows.find(row => row?.type === "opening_balance");
        if (!opening) {
          review.push({ opId: op.opId, reason: "V42_COLLECTION_OPENING_BALANCE_MISSING", operation: op });
          continue;
        }
        // The opening-balance row migrates the authoritative cloud legacy debt,
        // not the stale local debt that existed when the device captured the receipt.
        opening.amountCentimes = debtCents;
      }
      customer.debt = fromMoneyCents(debtCents - amountCents);
      snapshot.caisseBalance = fromMoneyCents(cashCents + amountCents);
      if (v42Ledger !== undefined) customer.ledgerVersion = 2;
      const movement = payload.cashMovement && typeof payload.cashMovement === "object"
        ? structuredClone(payload.cashMovement)
        : { id: movementId, type: "debt_collection", amount, customerId: payload.customerId, opId: op.opId };
      movement.id = movementId;
      movement.opId = op.opId;
      snapshot.cashMovements.unshift(movement);
      if (v42Ledger !== undefined) {
        if (!Array.isArray(snapshot.clientMovements)) snapshot.clientMovements = [];
        if (!Array.isArray(snapshot.settlementAllocations)) snapshot.settlementAllocations = [];
        snapshot.clientMovements.push(...normalizedClientRows);
        snapshot.settlementAllocations.push(...structuredClone(allocationRows));
      }
      markApplied();
      appliedNow.push({ opId: op.opId, outcome: "applied" });
      continue;
    }

    if (op.type === "SALE_INVOICE") {
      const invoice = payload.invoice;
      if (!invoice || typeof invoice !== "object" || Array.isArray(invoice) ||
          typeof invoice.id !== "string" || !invoice.id.trim()) {
        review.push({ opId: op.opId, reason: "INCOMPLETE_SALE_INVOICE", operation: op });
        continue;
      }
      if (!Array.isArray(snapshot.invoices)) snapshot.invoices = [];
      const matchingInvoices = snapshot.invoices.filter(item => item?.id === invoice.id);
      if (matchingInvoices.length) {
        const existingInvoice = matchingInvoices[0];
        const existingCopy = structuredClone(existingInvoice);
        const incomingCopy = structuredClone(invoice);
        // The V42 bridge writes syncOpId into the invoice before saveDB. Require
        // that durable marker and compare the complete invoice payload before
        // treating an existing ID as proof that this operation already landed.
        delete existingCopy.syncOpId;
        delete existingCopy.syncCreatedAt;
        delete incomingCopy.syncOpId;
        delete incomingCopy.syncCreatedAt;
        const stableJson = value => {
          if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
          if (value && typeof value === "object") {
            return "{" + Object.keys(value).sort().map(key =>
              JSON.stringify(key) + ":" + stableJson(value[key])
            ).join(",") + "}";
          }
          return JSON.stringify(value);
        };
        const sameInvoice = stableJson(existingCopy) === stableJson(incomingCopy);
        let sameLedgerBundle = true;
        if (payload.v42Ledger !== undefined) {
          const bundle = payload.v42Ledger;
          const idKeys = {
            cashMovements: "id", bankMovements: "id", stockMovements: "id",
            clientMovements: "movementId", settlementAllocations: "allocationId", auditTrail: "id"
          };
          const customerId = payload.customerId ?? invoice.customerId ?? invoice.customerObj?.id;
          const customer = customerId == null ? null : findById(snapshot.customers, customerId);
          const totalCents = moneyCents(invoice.total);
          const paidCents = moneyCents(invoice.paid ?? invoice.total);
          const remainingCents = invoice.remaining == null
            ? (totalCents !== null && paidCents !== null ? totalCents - paidCents : null)
            : moneyCents(invoice.remaining);
          const debtAfterCents = customer ? moneyCents(customer.debt ?? 0) : null;
          for (const [key, idKey] of Object.entries(idKeys)) {
            if (key === "auditTrail" && bundle?.auditTrail === undefined) continue;
            if (!Array.isArray(bundle?.[key])) { sameLedgerBundle = false; break; }
            for (const row of bundle[key]) {
              let expected = row;
              if (key === "clientMovements" && row?.type === "opening_balance") {
                const openingCents = debtAfterCents !== null && remainingCents !== null
                  ? debtAfterCents - remainingCents : null;
                if (!Number.isSafeInteger(openingCents) || openingCents <= 0) {
                  sameLedgerBundle = false; break;
                }
                expected = { ...row, amountCentimes: openingCents };
              }
              if (!(Array.isArray(snapshot[key]) ? snapshot[key] : []).some(existing =>
                String(existing?.[idKey] ?? "") === String(expected?.[idKey] ?? "") &&
                stableJson(existing) === stableJson(expected))) {
                sameLedgerBundle = false; break;
              }
            }
            if (!sameLedgerBundle) break;
          }
        }
        if (matchingInvoices.length === 1 &&
            existingInvoice.syncOpId === op.opId &&
            sameInvoice && sameLedgerBundle) {
          markApplied();
          appliedNow.push({ opId: op.opId, outcome: "already-applied", reason: "VERIFIED_INVOICE_AND_LEDGER_BUNDLE" });
        } else {
          review.push({
            opId: op.opId,
            reason: sameInvoice && payload.v42Ledger !== undefined
              ? "INVOICE_LEDGER_BUNDLE_INCOMPLETE" : "INVOICE_ID_COLLISION",
            operation: op
          });
        }
        continue;
      }
      if (applied.has(op.opId)) {
        review.push({ opId: op.opId, reason: "APPLIED_OPERATION_ENTITY_MISSING", operation: op });
        continue;
      }
      const items = Array.isArray(invoice.items) ? invoice.items : [];
      const warehouse = String(payload.warehouse ?? invoice.warehouse ?? invoice.warehouseName ?? "المخزن الرئيسي");
      const required = new Map();
      for (const item of items) {
        const id = String(item?.id ?? item?.productId ?? "");
        const qty = Number(item?.qty ?? item?.quantity);
        if (!id || !Number.isFinite(qty) || qty <= 0 || qty > Number.MAX_SAFE_INTEGER) {
          review.push({ opId: op.opId, reason: "INVALID_SALE_LINE", operation: op });
          break;
        }
        required.set(id, (required.get(id) || 0) + qty);
      }
      if (review.some(item => item.opId === op.opId)) continue;
      if (!required.size && payload.productId != null) {
        const qty = Number(payload.quantity);
        if (!Number.isFinite(qty) || qty <= 0 || qty > Number.MAX_SAFE_INTEGER) {
          review.push({ opId: op.opId, reason: "INVALID_SALE_QUANTITY", operation: op });
          continue;
        }
        required.set(String(payload.productId), qty);
      }
      if (!required.size) {
        review.push({ opId: op.opId, reason: "SALE_ITEMS_MISSING", operation: op });
        continue;
      }
      const productUpdates = [];
      let invalidStock = false;
      for (const [productId, quantity] of required) {
        const matches = (Array.isArray(snapshot.products) ? snapshot.products : [])
          .filter(item => item && String(item.id) === productId);
        if (matches.length !== 1) {
          review.push({ opId: op.opId, reason: matches.length ? "DUPLICATE_PRODUCT_ID" : "PRODUCT_NOT_FOUND", operation: op });
          invalidStock = true; break;
        }
        const product = matches[0];
        const warehouseSale = warehouse !== "المخزن الرئيسي";
        const stock = warehouseSale
          ? Number(product.warehouseStock?.[warehouse] ?? 0)
          : Number(product.stock ?? 0);
        if (!Number.isFinite(stock) || stock < quantity) {
          review.push({ opId: op.opId, reason: "INSUFFICIENT_CLOUD_STOCK", operation: op });
          invalidStock = true; break;
        }
        productUpdates.push({ product, quantity, warehouseSale, warehouse, stock });
      }
      if (invalidStock) continue;

      const totalCents = moneyCents(invoice.total);
      const paidCents = moneyCents(invoice.paid ?? invoice.total);
      // Derive omitted remaining amounts in integer centimes. Subtracting decimal
      // Numbers first can produce values such as 0.19999999999999998 and wrongly
      // quarantine a valid sale even though both source amounts are exact cents.
      const remainingCents = invoice.remaining == null
        ? (totalCents !== null && paidCents !== null ? totalCents - paidCents : null)
        : moneyCents(invoice.remaining);
      if (totalCents === null || paidCents === null || remainingCents === null ||
          paidCents > totalCents || remainingCents !== totalCents - paidCents) {
        review.push({ opId: op.opId, reason: "INVALID_SALE_PAYMENT_SPLIT", operation: op });
        continue;
      }
      const cashCents = moneyCents(snapshot.caisseBalance ?? 0);
      if (cashCents === null) {
        review.push({ opId: op.opId, reason: "INVALID_CASH_BALANCE", operation: op });
        continue;
      }
      let customer = null;
      const saleCustomerId = payload.customerId ?? invoice.customerId ?? invoice.customerObj?.id;
      if (saleCustomerId != null) {
        const matches = (Array.isArray(snapshot.customers) ? snapshot.customers : [])
          .filter(item => item && String(item.id) === String(saleCustomerId));
        if (matches.length !== 1) {
          review.push({ opId: op.opId, reason: matches.length ? "DUPLICATE_CUSTOMER_ID" : "CUSTOMER_NOT_FOUND", operation: op });
          continue;
        }
        customer = matches[0];
      }
      if (remainingCents > 0) {
        if (typeof op.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(op.createdAt) || !Number.isFinite(Date.parse(op.createdAt))) {
          review.push({ opId: op.opId, reason: "SALE_OPERATION_TIMESTAMP_MISSING", operation: op });
          continue;
        }
        if (!customer) {
          review.push({ opId: op.opId, reason: "CUSTOMER_REQUIRED_FOR_CREDIT_SALE", operation: op });
          continue;
        }
        const debtCents = moneyCents(customer.debt ?? 0);
        if (debtCents === null || debtCents + remainingCents > Number.MAX_SAFE_INTEGER) {
          review.push({ opId: op.opId, reason: "INVALID_CUSTOMER_DEBT", operation: op });
          continue;
        }
      }
      const v42Ledger = payload.v42Ledger;
      const hasAuditTrail = Boolean(v42Ledger && Object.prototype.hasOwnProperty.call(v42Ledger, "auditTrail"));
      const auditRows = hasAuditTrail ? v42Ledger.auditTrail : null;
      let normalizedClientRows = null;
      if (v42Ledger !== undefined) {
        const ledgerKeys = ["cashMovements", "bankMovements", "stockMovements", "clientMovements", "settlementAllocations"];
        if (!v42Ledger || typeof v42Ledger !== "object" || Array.isArray(v42Ledger) ||
            ledgerKeys.some(key => !Array.isArray(v42Ledger[key])) ||
            (hasAuditTrail && !Array.isArray(auditRows))) {
          review.push({ opId: op.opId, reason: "INCOMPLETE_V42_SALE_LEDGER_BUNDLE", operation: op });
          continue;
        }
        const channel = String(invoice.paymentChannel || "cash").toLowerCase();
        const cashRows = v42Ledger.cashMovements;
        const bankRows = v42Ledger.bankMovements;
        const stockRows = v42Ledger.stockMovements;
        const clientRows = v42Ledger.clientMovements;
        const allocationRows = v42Ledger.settlementAllocations;
        const cashChannel = channel === "cash";
        if (hasAuditTrail && (auditRows.length !== 1 || auditRows.some(row =>
          !row || !row.id || row.opId !== op.opId || row.eventType !== "SALE_COMMITTED" ||
          row.entityType !== "sales_invoice" || String(row.entityId ?? "") !== String(invoice.id) ||
          String(row.referenceType ?? "").toLowerCase() !== "sales_invoice" ||
          String(row.referenceId ?? "") !== String(invoice.id) ||
          String(row.warehouse ?? "") !== warehouse ||
          row.amountCentimes !== totalCents || row.paidCentimes !== paidCents ||
          row.remainingCentimes !== remainingCents ||
          typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
        ))) {
          review.push({ opId: op.opId, reason: "SALE_AUDIT_TRAIL_MISMATCH", operation: op });
          continue;
        }
        const paymentRows = cashChannel ? cashRows : bankRows;
        const wrongPaymentRows = cashChannel ? bankRows : cashRows;
        const paymentId = paymentRows.length === 1 ? paymentRows[0]?.id : null;
        if (wrongPaymentRows.length !== 0 ||
            paymentRows.length !== (paidCents > 0 ? 1 : 0) ||
            (paidCents > 0 && (
              !paymentId || moneyCents(paymentRows[0]?.amount) !== paidCents ||
              String(paymentRows[0]?.referenceType || "").toLowerCase() !== "sales_invoice" ||
              String(paymentRows[0]?.referenceId ?? "") !== String(invoice.id) ||
              String(paymentRows[0]?.paymentChannel || channel).toLowerCase() !== channel ||
              (paymentRows[0]?.cashImpact !== undefined &&
                Boolean(paymentRows[0]?.cashImpact) !== cashChannel)
            ))) {
          review.push({ opId: op.opId, reason: "SALE_PAYMENT_LEDGER_MISMATCH", operation: op });
          continue;
        }
        if (stockRows.length !== productUpdates.length ||
            productUpdates.some(update => {
              const matches = stockRows.filter(row =>
                String(row?.productId ?? "") === String(update.product.id) &&
                String(row?.referenceType || "").toLowerCase() === "sales_invoice" &&
                String(row?.referenceId ?? "") === String(invoice.id) &&
                String(row?.warehouse ?? "المخزن الرئيسي") === warehouse &&
                Number(row?.qty) === -update.quantity
              );
              return matches.length !== 1;
            })) {
          review.push({ opId: op.opId, reason: "SALE_STOCK_LEDGER_MISMATCH", operation: op });
          continue;
        }
        const customerId = customer ? String(customer.id) : null;
        const invoiceDebits = clientRows.filter(row =>
          row?.type === "invoice_debit" &&
          String(row?.referenceType || "").toLowerCase() === "sales_invoice" &&
          String(row?.referenceId ?? "") === String(invoice.id)
        );
        const openingRows = clientRows.filter(row => row?.type === "opening_balance");
        const customerDebtCents = customer ? moneyCents(customer.debt ?? 0) : null;
        const expectsOpening = Boolean(customer && customer.ledgerVersion !== 2 &&
          customerDebtCents !== null && customerDebtCents > 0);
        const existingClientRows = customer
          ? (Array.isArray(snapshot.clientMovements) ? snapshot.clientMovements : [])
              .filter(row => String(row?.clientId ?? "") === customerId)
          : [];
        if (clientRows.some(row => !row || !row.movementId ||
            (row.type !== "invoice_debit" && row.type !== "opening_balance") ||
            !customer || String(row.clientId) !== customerId) ||
            invoiceDebits.length !== (customer && remainingCents > 0 ? 1 : 0) ||
            invoiceDebits.some(row => Number(row.amountCentimes) !== remainingCents ||
              row.direction !== "debit" || String(row.clientId) !== customerId) ||
            openingRows.length !== (expectsOpening ? 1 : 0) ||
            openingRows.some(row => row.direction !== "debit" ||
              !Number.isSafeInteger(row.amountCentimes) || row.amountCentimes <= 0) ||
            (customer && customer.ledgerVersion !== 2 && existingClientRows.length > 0)) {
          review.push({ opId: op.opId, reason: "SALE_CLIENT_LEDGER_MISMATCH", operation: op });
          continue;
        }
        normalizedClientRows = structuredClone(clientRows);
        if (expectsOpening) {
          const opening = normalizedClientRows.find(row => row?.type === "opening_balance");
          opening.amountCentimes = customerDebtCents;
        }
        if (allocationRows.length !== (customer && paidCents > 0 ? 1 : 0) ||
            allocationRows.some(row => !row?.allocationId ||
              row.partyType !== "customer" ||
              String(row.partyId) !== customerId ||
              row.invoiceType !== "sales_invoice" ||
              String(row.invoiceId) !== String(invoice.id) ||
              row.amountCentimes !== paidCents ||
              String(row.sourceMovementId) !== String(paymentId))) {
          review.push({ opId: op.opId, reason: "SALE_SETTLEMENT_ALLOCATION_MISMATCH", operation: op });
          continue;
        }

        const ledgerCollections = [
          ["cashMovements", "id"], ["bankMovements", "id"], ["stockMovements", "id"],
          ["clientMovements", "movementId"], ["settlementAllocations", "allocationId"]
        ];
        if (hasAuditTrail) ledgerCollections.push(["auditTrail", "id"]);
        let ledgerCollision = false;
        for (const [key, idKey] of ledgerCollections) {
          const rows = v42Ledger[key];
          const ids = new Set();
          const existing = Array.isArray(snapshot[key]) ? snapshot[key] : [];
          for (const row of rows) {
            const id = row?.[idKey];
            if (id == null || String(id).trim() === "" || ids.has(String(id)) ||
                existing.some(old => String(old?.[idKey] ?? "") === String(id))) {
              ledgerCollision = true;
              break;
            }
            ids.add(String(id));
          }
          if (ledgerCollision) break;
        }
        if (ledgerCollision) {
          review.push({ opId: op.opId, reason: "SALE_LEDGER_ENTITY_ID_COLLISION", operation: op });
          continue;
        }
        if (cashChannel && cashCents + paidCents > Number.MAX_SAFE_INTEGER) {
          review.push({ opId: op.opId, reason: "INVALID_CASH_BALANCE", operation: op });
          continue;
        }
      }

      for (const update of productUpdates) {
        if (update.warehouseSale) {
          if (!update.product.warehouseStock || typeof update.product.warehouseStock !== "object" || Array.isArray(update.product.warehouseStock)) {
            update.product.warehouseStock = {};
          }
          update.product.warehouseStock[update.warehouse] = update.stock - update.quantity;
        } else {
          update.product.stock = update.stock - update.quantity;
        }
      }
      if (customer && v42Ledger !== undefined &&
          (v42Ledger.clientMovements.length || v42Ledger.settlementAllocations.length)) {
        customer.ledgerVersion = 2;
      }
      if (customer && remainingCents > 0) {
        customer.debt = fromMoneyCents(moneyCents(customer.debt ?? 0) + remainingCents);
        // V42 records debtDate as an ISO date, independent of the invoice's localized display date.
        customer.debtDate = op.createdAt.slice(0, 10);
      }
      const cashChannel = v42Ledger === undefined ||
        String(invoice.paymentChannel || "cash").toLowerCase() === "cash";
      if (paidCents > 0 && cashChannel) snapshot.caisseBalance = fromMoneyCents(cashCents + paidCents);
      if (v42Ledger !== undefined) {
        for (const [key, rows] of Object.entries(v42Ledger)) {
          // Preserve the exact V42 storage shape: an absent optional ledger remains absent
          // when this mutation has no rows for it (for example, no bank movement on a cash sale).
          // A non-empty collection is materialized only when there is a real row to commit.
          if (!Array.isArray(snapshot[key])) {
            // V42 materializes settlementAllocations even when a credit-only sale has no
            // settlement rows. Cash and bank ledgers remain absent when they have no movement.
            if (rows.length === 0 && key !== "settlementAllocations") continue;
            snapshot[key] = [];
          }
          const committedRows = key === "clientMovements" && normalizedClientRows !== null
            ? normalizedClientRows : rows;
          if (committedRows.length > 0) snapshot[key].unshift(...structuredClone(committedRows));
        }
      }
      snapshot.invoices.unshift(structuredClone(invoice));
      markApplied();
      appliedNow.push({ opId: op.opId, outcome: "applied" });
      continue;
    }

    review.push({ opId: op.opId, reason: "UNSUPPORTED_OPERATION_TYPE", operation: op });
  }

  return { snapshot, appliedNow, review };
}
