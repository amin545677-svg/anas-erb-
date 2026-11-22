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
  getSaveDBDurably,
  setSaveDBDurably,
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

  // Keep the explicit backup upload/restore actions untouched. Operational
  // mutation sync has its own names so it cannot silently replace backup UX.
  const originalSyncPull = windowObject.anasFirebaseSyncPull;
  const originalSyncPush = windowObject.anasFirebaseSyncPush;
  const originalSaveDB = getSaveDB();
  if (typeof originalSaveDB !== "function") throw new Error("V42 saveDB binding is unavailable");
  const originalSaveDBDurably = typeof getSaveDBDurably === "function" ? getSaveDBDurably() : null;
  if (originalSaveDBDurably && typeof originalSaveDBDurably !== "function") {
    throw new Error("V42 saveDBDurably binding is invalid");
  }
  if (originalSaveDBDurably && typeof setSaveDBDurably !== "function") {
    throw new Error("A setter is required to guard V42 durable saves");
  }

  let installed = false;
  let isReconcilingWrite = false;
  let lastSnapshot = null;
  let pendingPrepared = null;
  let durableSaveTail = Promise.resolve();
  let unsupportedLocalMutations = Boolean(storage.getItem(MUTATION_KEYS.unsupported));

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
    const fleetChanged = JSON.stringify(current?.anasFleetState ?? null) !== JSON.stringify(previous?.anasFleetState ?? null);
    if (fleetChanged) {
      const nextState = current?.anasFleetState;
      if (!nextState || typeof nextState !== "object" || Array.isArray(nextState) ||
          nextState.schemaVersion !== 1 || !Array.isArray(nextState.products) ||
          !Array.isArray(nextState.trucks) || !Array.isArray(nextState.trips) ||
          !Array.isArray(nextState.movements)) {
        throw new Error("TRUCK_FLEET_STATE_INVALID");
      }
      const fleetReplayCollections = [
        "trucks", "truckTrips", "stockMovements", "expenses",
        "returns", "warehouseTransfers", "auditTrail", "customers", "invoices",
        "cashMovements", "bankMovements", "clientMovements", "settlementAllocations"
      ];
      const collectionDeltas = Object.fromEntries(fleetReplayCollections
        .filter(key => JSON.stringify(current?.[key] ?? null) !== JSON.stringify(previous?.[key] ?? null))
        .map(key => [key, {
          before: structuredClone(previous?.[key] ?? null),
          after: structuredClone(current?.[key] ?? null)
        }]));
      const operation = createMutationEnvelope({
        type: "TRUCK_FLEET_OPERATION",
        payload: {
          baseState: structuredClone(previous?.anasFleetState ?? null),
          nextState: structuredClone(nextState),
          collectionDeltas,
          warehouses: (() => {
            const actorId = current.currentUser?.id == null ? "" : String(current.currentUser.id);
            const latestTrip = [...nextState.trips].reverse().find(trip => String(trip.driverId) === actorId);
            const changedWarehouseName = String(latestTrip?.warehouseName || "");
            return (Array.isArray(current.warehouses) ? current.warehouses : [])
              .filter(row => String(typeof row === "string" ? row : row?.name || "") === changedWarehouseName)
              .map(row => structuredClone(row));
          })(),
          caisseBalanceDelta: JSON.stringify(current?.caisseBalance ?? 0) !== JSON.stringify(previous?.caisseBalance ?? 0)
            ? { before: previous?.caisseBalance ?? 0, after: current?.caisseBalance ?? 0 } : null,
          actorId: current.currentUser?.id == null ? null : String(current.currentUser.id)
        },
        now, uuid
      });
      return { entity: { id: operation.opId }, operation };
    }
    const identityKey = {
      invoices: "id", cashMovements: "id", bankMovements: "id",
      stockMovements: "id", clientMovements: "movementId",
      settlementAllocations: "allocationId", auditTrail: "id"
    };
    function collectRows(key) {
      const field = identityKey[key];
      const currentRows = Array.isArray(current?.[key]) ? current[key] : [];
      const previousRows = Array.isArray(previous?.[key]) ? previous[key] : [];
      const previousById = new Map();
      for (const row of previousRows) {
        if (!row || row[field] == null || String(row[field]).trim() === "") {
          throw new Error("Malformed existing " + key + " ledger row");
        }
        const id = String(row[field]);
        if (previousById.has(id)) throw new Error("Duplicate existing " + key + " ledger ID");
        previousById.set(id, row);
      }
      const currentIds = new Set();
      const added = [];
      for (const row of currentRows) {
        if (!row || row[field] == null || String(row[field]).trim() === "") {
          throw new Error("Malformed current " + key + " ledger row");
        }
        const id = String(row[field]);
        if (currentIds.has(id)) throw new Error("Duplicate current " + key + " ledger ID");
        currentIds.add(id);
        if (previousById.has(id)) {
          if (JSON.stringify(row) !== JSON.stringify(previousById.get(id))) {
            throw new Error("Existing " + key + " ledger row was modified during a new operation");
          }
        } else {
          added.push(row);
        }
      }
      if (previousRows.some(row => !currentIds.has(String(row[field])))) {
        throw new Error("Existing " + key + " ledger row was removed during a new operation");
      }
      return added;
    }

    const ledgerKeys = [
      "invoices", "cashMovements", "bankMovements", "stockMovements",
      "clientMovements", "settlementAllocations", "auditTrail"
    ];
    const deltas = Object.fromEntries(ledgerKeys.map(key => [key, collectRows(key)]));
    if (deltas.invoices.length > 1) return null;

    const invoice = deltas.invoices[0] || null;
    let auditRowsSynthesized = false;
    const auditTrailWasMissing = !Object.prototype.hasOwnProperty.call(current, "auditTrail");
    const auditTrailBefore = Array.isArray(current.auditTrail) ? current.auditTrail.slice() : null;
    if (invoice && deltas.auditTrail.length === 0) {
      if (!auditTrailWasMissing && !Array.isArray(current.auditTrail)) {
        throw new Error("Malformed current auditTrail collection");
      }
      if (Object.prototype.hasOwnProperty.call(previous || {}, "auditTrail") &&
          !Array.isArray(previous.auditTrail)) {
        throw new Error("Malformed previous auditTrail collection");
      }
      const parseCentimes = value => {
        const match = String(value ?? "").trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
        if (!match) return null;
        const cents = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
        return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
      };
      const amountCentimes = parseCentimes(invoice.total);
      const paidCentimes = parseCentimes(invoice.paid ?? invoice.total);
      const remainingCentimes = invoice.remaining == null
        ? (amountCentimes !== null && paidCentimes !== null ? amountCentimes - paidCentimes : null)
        : parseCentimes(invoice.remaining);
      if (amountCentimes === null || paidCentimes === null || remainingCentimes === null ||
          paidCentimes > amountCentimes || remainingCentimes !== amountCentimes - paidCentimes) {
        throw new Error("Cannot synthesize a centime-exact audit event for an incomplete V42 invoice");
      }
      const auditId = "AUD-SALE-" + String(invoice.id);
      if ((Array.isArray(current.auditTrail) ? current.auditTrail : [])
        .some(row => String(row?.id ?? "") === auditId)) {
        throw new Error("V42 sale audit event ID already exists");
      }
      deltas.auditTrail.push({
        id: auditId,
        opId: null,
        eventType: "SALE_COMMITTED",
        entityType: "sales_invoice",
        entityId: String(invoice.id),
        referenceType: "sales_invoice",
        referenceId: String(invoice.id),
        warehouse: String(invoice.warehouse ?? invoice.warehouseName ?? "المخزن الرئيسي"),
        amountCentimes,
        paidCentimes,
        remainingCentimes,
        actorId: current.currentUser?.id == null ? null : String(current.currentUser.id),
        actorName: current.currentUser?.name ? String(current.currentUser.name) : "غير محدد",
        createdAt: now().toISOString()
      });
      auditRowsSynthesized = true;
    }
    if (invoice) {
      const invoiceId = String(invoice.id);
      const belongsToInvoice = row =>
        String(row?.referenceType || "").toLowerCase() === "sales_invoice" &&
        String(row?.referenceId ?? "") === invoiceId;
      for (const key of ["cashMovements", "bankMovements", "stockMovements"]) {
        if (deltas[key].some(row => !belongsToInvoice(row))) {
          throw new Error("Unrelated " + key + " change cannot be bundled into a sale");
        }
      }
      const customerId = invoice.customerObj?.id ?? invoice.customerId ?? null;
      if (deltas.clientMovements.some(row =>
        !belongsToInvoice(row) &&
        !(String(row?.referenceType || "").toLowerCase() === "opening_balance" &&
          customerId != null && String(row?.clientId ?? "") === String(customerId))
      )) {
        throw new Error("Unrelated client ledger change cannot be bundled into a sale");
      }
      if (deltas.settlementAllocations.some(row => String(row?.invoiceId ?? "") !== invoiceId)) {
        throw new Error("Unrelated settlement allocation cannot be bundled into a sale");
      }
      if (deltas.auditTrail.length !== 1 || deltas.auditTrail.some(row =>
        row?.eventType !== "SALE_COMMITTED" || row?.entityType !== "sales_invoice" ||
        String(row?.entityId ?? "") !== invoiceId ||
        String(row?.referenceType ?? "").toLowerCase() !== "sales_invoice" ||
        String(row?.referenceId ?? "") !== invoiceId ||
        !Number.isSafeInteger(row?.amountCentimes) || row.amountCentimes < 0 ||
        !Number.isSafeInteger(row?.paidCentimes) || row.paidCentimes < 0 ||
        !Number.isSafeInteger(row?.remainingCentimes) || row.remainingCentimes < 0
      )) throw new Error("V42 sale audit trail is missing or malformed");

      const mapped = mapMutation({
        current: structuredClone(current),
        previous: structuredClone(previous),
        entity: structuredClone(invoice),
        kind: "sale"
      });
      if (!mapped || mapped.type !== "SALE_INVOICE" ||
          !mapped.payload || typeof mapped.payload !== "object") {
        throw new Error("mapMutation must return a SALE_INVOICE payload for a V42 sale");
      }
      const payload = structuredClone(mapped.payload);
      payload.invoice = structuredClone(invoice);
      payload.v42Ledger = {
        cashMovements: structuredClone(deltas.cashMovements),
        bankMovements: structuredClone(deltas.bankMovements),
        stockMovements: structuredClone(deltas.stockMovements),
        clientMovements: structuredClone(deltas.clientMovements),
        settlementAllocations: structuredClone(deltas.settlementAllocations),
        auditTrail: structuredClone(deltas.auditTrail)
      };
      const operation = createMutationEnvelope({ type: mapped.type, payload, now, uuid });
      return {
        entity: invoice, operation,
        auditRows: deltas.auditTrail,
        auditOpIdsBefore: deltas.auditTrail.map(row => row.opId),
        auditRowsSynthesized,
        auditTrailWasMissing,
        auditTrailBefore
      };
    }

    if (deltas.bankMovements.length || deltas.stockMovements.length) return null;
    const movement = deltas.cashMovements[0] || null;
    if (deltas.cashMovements.length > 1) return null;
    if (!movement) return null;
    if (String(movement.type || "").toLowerCase() !== "add" ||
        String(movement.referenceType || "").toLowerCase() !== "customer_debt" ||
        movement.referenceId == null || String(movement.referenceId).trim() === "") {
      return null;
    }
    const mapped = mapMutation({
      current: structuredClone(current),
      previous: structuredClone(previous),
      entity: structuredClone(movement),
      kind: "collection"
    });
    if (!mapped || mapped.type !== "DEBT_COLLECTION" ||
        !mapped.payload || typeof mapped.payload !== "object") {
      throw new Error("mapMutation must return a DEBT_COLLECTION payload for a customer collection");
    }
    const payload = structuredClone(mapped.payload);
    const customerId = String(movement.referenceId);
    if (deltas.clientMovements.length || deltas.settlementAllocations.length) {
      const receipts = deltas.clientMovements.filter(row =>
        row?.type === "receipt" &&
        String(row?.referenceType || "").toLowerCase() === "customer_debt" &&
        String(row?.referenceId ?? "") === customerId &&
        String(row?.clientId ?? "") === customerId
      );
      const openingRows = deltas.clientMovements.filter(row => row?.type === "opening_balance");
      if (deltas.clientMovements.some(row =>
          !row || String(row.clientId ?? "") !== customerId ||
          !["receipt", "opening_balance"].includes(row.type)) ||
          receipts.length !== 1 ||
          receipts[0].direction !== "credit" ||
          openingRows.length > 1 ||
          openingRows.some(row =>
            String(row.referenceType || "").toLowerCase() !== "opening_balance" ||
            String(row.referenceId ?? "") !== customerId ||
            row.direction !== "debit") ||
          deltas.settlementAllocations.some(row =>
            !row || row.partyType !== "customer" ||
            String(row.partyId) !== customerId ||
            row.invoiceType !== "sales_invoice" ||
            String(row.sourceMovementId) !== String(movement.id) ||
            row.sourceMovementType !== "customer_debt")) {
        throw new Error("V42 customer collection ledger bundle is incomplete or unrelated");
      }
      payload.v42Ledger = {
        clientMovements: structuredClone(deltas.clientMovements),
        settlementAllocations: structuredClone(deltas.settlementAllocations)
      };
    }
    const operation = createMutationEnvelope({ type: mapped.type, payload, now, uuid });
    return { entity: movement, operation };
  }

  function hasUnsupportedBusinessDelta(current, previous) {
    const changed = (left, right) => JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
    if (changed(current.caisseBalance, previous.caisseBalance)) return true;

    // Until a mutation type has an explicit replay contract, every operational
    // collection must remain byte-for-byte stable. Checking only product.stock
    // missed warehouseStock, purchases, expenses, truck trips and other ledgers,
    // allowing those changes to be saved locally without entering the sync queue.
    const businessCollections = [
      "products", "customers", "suppliers", "supplierMovements", "invoices", "purchases",
      "purchaseInvoices", "expenses", "cashMovements", "bankMovements", "stockMovements",
      "clientMovements", "settlementAllocations", "payments", "treasury",
      "warehouseTransfers", "truckTrips", "returns", "trucks", "warehouses",
      "stocktakeRecords", "users", "alerts", "productCategories", "productUnits", "auditTrail", "anasFleetState"
    ];
    return businessCollections.some(key => changed(current[key], previous[key]));
  }

  function hasAdditionalBusinessCollectionDelta(current, previous, allowedCollections) {
    const changed = (left, right) => JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
    const businessCollections = [
      "products", "customers", "suppliers", "supplierMovements", "invoices", "purchases",
      "purchaseInvoices", "expenses", "cashMovements", "bankMovements", "stockMovements",
      "clientMovements", "settlementAllocations", "payments", "treasury",
      "warehouseTransfers", "truckTrips", "returns", "trucks", "warehouses",
      "stocktakeRecords", "users", "alerts", "productCategories", "productUnits", "auditTrail"
    ];
    return businessCollections.filter(key =>
      !allowedCollections.has(key) && changed(current[key], previous[key])
    );
  }

  function persistPrepared(operation) {
    const queue = JSON.parse(storage.getItem(MUTATION_KEYS.pending) || "[]");
    if (!Array.isArray(queue)) throw new Error("Pending mutation queue is malformed");
    if (queue.some(item => item?.opId === operation.opId)) {
      throw new Error("Duplicate operation ID detected before saveDB");
    }
    const currentData = getAppData();
    const previousSequence = Number(currentData?.anasLocalMutationSequence) || 0;
    const maxPendingSequence = queue.reduce((max, item) => Math.max(max, Number(item?.localSeq) || 0), 0);
    const localSeq = Math.max(previousSequence, maxPendingSequence) + 1;
    if (currentData) currentData.anasLocalMutationSequence = localSeq;
    storage.setItem(MUTATION_KEYS.pending, JSON.stringify([
      ...queue, {
        ...structuredClone(operation),
        idempotencyKey: operation.idempotencyKey || ("ANAS:" + operation.type + ":" + operation.opId),
        createdAtMs: Number.isSafeInteger(operation.createdAtMs) ? operation.createdAtMs : Date.parse(operation.createdAt),
        localSeq,
        status: "PREPARED"
      }
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

  function hasCommittedOperationMarker(opId) {
    try {
      const snapshot = typeof storage.getCommittedSnapshot === "function"
        ? storage.getCommittedSnapshot() : null;
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
      if (Array.isArray(snapshot.appliedOpIds) && snapshot.appliedOpIds.includes(opId)) return true;
      for (const key of ["invoices", "cashMovements"]) {
        if (Array.isArray(snapshot[key]) && snapshot[key].some(row =>
          row && (row.syncOpId === opId || row.opId === opId))) return true;
      }
    } catch (_) {}
    return false;
  }

  function discardPrepared(pending) {
    // A late/duplicate ACK no longer owns this lock. It must not roll back
    // capture metadata or remove a PREPARED/PENDING row owned by a later state.
    if (!pending || pendingPrepared !== pending) return;
    try { pending.restoreCaptureMetadata(); } catch (_) {}
    try {
      storage.setItem(MUTATION_KEYS.pending, JSON.stringify(
        JSON.parse(storage.getItem(MUTATION_KEYS.pending) || "[]")
          .filter(item => item?.opId !== pending.operation.opId)
      ));
    } catch (error) {
      onStatus({ level: "critical", code: "V42_PREPARED_MUTATION_CLEANUP_FAILED", message: String(error?.message || error) });
    }
    if (pendingPrepared === pending) pendingPrepared = null;
  }

  function wrappedSaveDBDurably(...args) {
    if (!originalSaveDBDurably) return Promise.reject(new Error("V42 durable save binding is unavailable"));
    const pending = pendingPrepared;
    const receiver = this;
    const execute = async () => {
      try {
        if (typeof storage.flush === "function") await storage.flush();
        const result = await originalSaveDBDurably.apply(receiver, args);
        if (!pending) return result;
        if (result === true || hasCommittedOperationMarker(pending.operation.opId)) {
          try {
            promote(pending.operation.opId);
            if (typeof storage.flush === "function") await storage.flush();
          } catch (error) {
            // The durable business snapshot is authoritative. Keep PREPARED so
            // boot recovery can promote it from the persisted operation marker.
            onStatus({ level: "warning", code: "V42_QUEUE_PROMOTION_DEFERRED", opId: pending.operation.opId, message: String(error?.message || error) });
          }
          if (pendingPrepared === pending) {
            pendingPrepared = null;
            lastSnapshot = structuredClone(getAppData());
          }
          return true;
        }
        discardPrepared(pending);
        if (typeof storage.flush === "function") await storage.flush();
        return result;
      } catch (error) {
        if (pending && hasCommittedOperationMarker(pending.operation.opId)) {
          try { promote(pending.operation.opId); }
          catch (promotionError) {
            onStatus({ level: "warning", code: "V42_QUEUE_PROMOTION_DEFERRED", opId: pending.operation.opId, message: String(promotionError?.message || promotionError) });
          }
          if (pendingPrepared === pending) {
            pendingPrepared = null;
            lastSnapshot = structuredClone(getAppData());
          }
          return true;
        }
        if (pending) {
          discardPrepared(pending);
          if (typeof storage.flush === "function") await storage.flush();
        }
        throw error;
      }
    };
    // Durable writes are serialized even when legacy callers invoke the
    // acknowledgement twice. Capture the prepared operation at call time so
    // an older queued ACK can never release a newer operation's lock.
    const run = durableSaveTail.then(execute, execute);
    durableSaveTail = run.catch(() => {});
    return run;
  }

  function wrappedSaveDB(...args) {
    // A snapshot persisted by reconciliation is not a new local business mutation.
    if (isReconcilingWrite) {
      const saved = originalSaveDB.apply(this, args);
      if (saved === true) lastSnapshot = structuredClone(getAppData());
      return saved;
    }
    const current = getAppData();
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      if (pendingPrepared) {
        throw new Error("A previous V42 mutation is still awaiting its durable save acknowledgement");
      }
      return originalSaveDB.apply(this, args);
    }
    const previous = readStoredAppData() || lastSnapshot || {};
    const hasBusinessDelta = hasUnsupportedBusinessDelta(current, previous);
    // Check before makeOperation: sale capture may synthesize an audit row, so
    // a blocked overlapping write must not leave even that mutation in memory.
    // Cart/UI-only saves may continue while the prepared financial write waits.
    if (pendingPrepared && hasBusinessDelta) {
      let pendingDiagnostic;
      try {
        const pending = pendingPrepared;
        const operation = pending?.operation || {};
        const queue = storage.getItem(MUTATION_KEYS.pending) || [];
        const queueRow = Array.isArray(queue)
          ? queue.find(item => item?.opId === operation.opId) : null;
        const previousData = pending?.previous || {};
        const changedCollections = [...new Set([
          ...Object.keys(previousData), ...Object.keys(current)
        ])].filter(key =>
          JSON.stringify(previousData[key] ?? null) !== JSON.stringify(current[key] ?? null)
        ).sort();
        pendingDiagnostic = JSON.stringify({
          opType: String(operation.type || "unknown"),
          opId: String(operation.opId || ""),
          changedCollections,
          token: queueRow?.idempotencyKey ?? operation.idempotencyKey ?? null,
          seq: queueRow?.localSeq ?? null,
          queueStatus: queueRow?.status ?? "missing",
          lockState: pendingPrepared === pending ? "HELD" : "CHANGED",
          committedMarker: Boolean(operation.opId && hasCommittedOperationMarker(operation.opId))
        });
      } catch (diagnosticError) {
        pendingDiagnostic = JSON.stringify({
          diagnosticError: String(diagnosticError?.message || diagnosticError),
          lockState: pendingPrepared ? "HELD" : "CLEAR"
        });
      }
      throw new Error(
        "A previous V42 mutation is still awaiting its durable save acknowledgement; pending=" +
        pendingDiagnostic
      );
    }
    const captured = makeOperation(current, previous);
    if (!captured) {
      if (hasBusinessDelta) {
        const ok = originalSaveDB.apply(this, args);
        if (ok === true) {
          unsupportedLocalMutations = true;
          storage.setItem(MUTATION_KEYS.unsupported, JSON.stringify({
            version: 1,
            status: "BLOCKED",
            reason: "UNSUPPORTED_BUSINESS_MUTATION_TYPE",
            recordedAt: now().toISOString()
          }));
          lastSnapshot = structuredClone(getAppData());
          onStatus({
            level: "warning",
            code: "V42_UNSUPPORTED_LOCAL_MUTATION_SAVED_LOCALLY",
            message: "The local transaction was saved, but cloud sync is paused until its mutation type has a verified replay contract."
          });
        }
        return ok;
      }
      const ok = originalSaveDB.apply(this, args);
      if (ok === true && !pendingPrepared) lastSnapshot = structuredClone(getAppData());
      return ok;
    }

    const allowedCollections = captured.operation.type === "SALE_INVOICE"
      ? new Set(["products", "customers", "invoices", "cashMovements", "bankMovements",
          "stockMovements", "clientMovements", "settlementAllocations", "auditTrail"])
      : captured.operation.type === "TRUCK_FLEET_OPERATION"
        ? new Set(["products", "warehouses", "anasFleetState", "trucks", "truckTrips",
            "stockMovements", "expenses", "returns", "warehouseTransfers", "auditTrail",
            "customers", "invoices", "cashMovements", "bankMovements", "clientMovements",
            "settlementAllocations"])
        : new Set(["customers", "cashMovements", "clientMovements", "settlementAllocations"]);
    const unsupportedCollections = hasAdditionalBusinessCollectionDelta(current, previous, allowedCollections);
    if (unsupportedCollections.length) {
      throw new Error("Unsupported additional business collection change; no local persistence was performed: " +
        unsupportedCollections.join(", "));
    }

    const beforeEntityMarker = captured.entity.syncOpId;
    const beforeEntityOpId = captured.entity.opId;
    const beforeApplied = Array.isArray(current.appliedOpIds) ? current.appliedOpIds.slice() : undefined;
    const auditRows = Array.isArray(captured.auditRows) ? captured.auditRows : [];
    const beforeAuditOpIds = Array.isArray(captured.auditOpIdsBefore) ? captured.auditOpIdsBefore : [];
    const auditRowsSynthesized = captured.auditRowsSynthesized === true;
    const auditTrailWasMissing = captured.auditTrailWasMissing === true;
    const auditTrailBefore = captured.auditTrailBefore;
    const restoreAuditCapture = () => {
      auditRows.forEach((row, index) => {
        if (beforeAuditOpIds[index] === undefined) delete row.opId;
        else row.opId = beforeAuditOpIds[index];
      });
      if (auditRowsSynthesized) {
        if (auditTrailWasMissing) delete current.auditTrail;
        else current.auditTrail = auditTrailBefore;
      }
    };
    if (auditRowsSynthesized) {
      if (auditTrailWasMissing) current.auditTrail = [];
      current.auditTrail.unshift(...auditRows);
    }
    auditRows.forEach(row => { row.opId = captured.operation.opId; });
    if (captured.operation.payload?.v42Ledger) {
      captured.operation.payload.v42Ledger.auditTrail = structuredClone(auditRows);
    }
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
      restoreAuditCapture();
      throw error;
    }

    const restoreCaptureMetadata = () => {
      if (beforeEntityMarker === undefined) delete captured.entity.syncOpId;
      else captured.entity.syncOpId = beforeEntityMarker;
      if (captured.entity.syncCreatedAt === captured.operation.createdAt) delete captured.entity.syncCreatedAt;
      if (beforeEntityOpId === undefined) delete captured.entity.opId;
      else captured.entity.opId = beforeEntityOpId;
      if (beforeApplied === undefined) delete current.appliedOpIds;
      else current.appliedOpIds = beforeApplied;
      restoreAuditCapture();
    };

    let saved;
    try {
      saved = originalSaveDB.apply(this, args);
    } catch (error) {
      restoreCaptureMetadata();
      storage.setItem(MUTATION_KEYS.pending, JSON.stringify(
        JSON.parse(storage.getItem(MUTATION_KEYS.pending) || "[]").filter(item => item?.opId !== captured.operation.opId)
      ));
      throw error;
    }

    if (saved !== true) {
      restoreCaptureMetadata();
      storage.setItem(MUTATION_KEYS.pending, JSON.stringify(
        JSON.parse(storage.getItem(MUTATION_KEYS.pending) || "[]").filter(item => item?.opId !== captured.operation.opId)
      ));
      return saved;
    }

    if (originalSaveDBDurably) {
      pendingPrepared = {
        operation: captured.operation,
        restoreCaptureMetadata,
        previous: structuredClone(previous),
        context: this
      };
      return true;
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

  function refreshFromPersistedSnapshot() {
    const raw = storage.getItem(MUTATION_KEYS.appData);
    if (raw == null) return false;
    let snapshot;
    try { snapshot = JSON.parse(raw); }
    catch { throw new Error("Persisted reconciled AppData JSON is invalid"); }
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("Persisted reconciled AppData snapshot is invalid");
    }
    setAppData(structuredClone(snapshot));
    lastSnapshot = structuredClone(snapshot);
    // Refresh the real page's visible balances without saving again (which could
    // re-enter mutation capture). Each renderer is best-effort and independent.
    for (const name of ["updateUIState", "updateCashUI", "renderCustomersDebts", "updateDashboardStats", "checkSystemAlerts"]) {
      try {
        if (typeof windowObject[name] === "function") windowObject[name]();
      } catch (error) {
        onStatus({ level: "warning", code: "V42_SYNC_UI_REFRESH_FAILED", renderer: name, message: String(error?.message || error) });
      }
    }
    return true;
  }

  async function withReconcilingWrite(callback) {
    const wasReconciling = isReconcilingWrite;
    isReconcilingWrite = true;
    try { return await callback(); }
    finally { isReconcilingWrite = wasReconciling; }
  }

  function unsupportedBlockResult() {
    if (!unsupportedLocalMutations && !storage.getItem(MUTATION_KEYS.unsupported)) return null;
    const result = {
      status: "blocked-unsupported-local-mutations",
      reason: "UNSUPPORTED_BUSINESS_MUTATIONS_ARE_SAVED_LOCALLY_BUT_NOT_SAFE_TO_REPLAY"
    };
    onStatus({ level: "warning", code: "V42_UNSUPPORTED_LOCAL_MUTATIONS_PRESENT", result });
    return result;
  }

  function clearUnsupportedMutationBlock({ verifiedSnapshot = false } = {}) {
    if (verifiedSnapshot !== true) {
      throw new Error("A verified full-cloud baseline is required before clearing the local-only sync block");
    }
    storage.removeItem(MUTATION_KEYS.unsupported);
    unsupportedLocalMutations = false;
    onStatus({ level: "success", code: "V42_UNSUPPORTED_LOCAL_MUTATION_BLOCK_CLEARED" });
    return true;
  }

  async function waitForDurableMutationBeforeSync() {
    // saveDB prepares the operation synchronously; saveDBDurably serializes its
    // durable acknowledgement through durableSaveTail. A concurrent push/pull
    // must not snapshot AppData in the gap between those two stages.
    await durableSaveTail;
    if (!pendingPrepared) return null;
    const result = {
      status: "blocked-pending-durable-save",
      opId: String(pendingPrepared.operation?.opId || "")
    };
    onStatus({
      level: "warning",
      code: "V42_SYNC_BLOCKED_PENDING_DURABLE_SAVE",
      result,
      message: "Sync was not started because a local V42 mutation has not received its durable save acknowledgement."
    });
    return result;
  }

  async function wrappedPush() {
    const pendingDurable = await waitForDurableMutationBeforeSync();
    if (pendingDurable) return pendingDurable;
    if (typeof storage.flush === "function") await storage.flush();
    const blocked = unsupportedBlockResult();
    if (blocked) return blocked;
    const result = await orchestrator.pushCurrent();
    if (typeof storage.flush === "function") await storage.flush();
    if (result?.status === "conflict") {
      onStatus({ level: "warning", code: "V42_SYNC_CONFLICT_RECONCILING" });
      const reconciled = await withReconcilingWrite(() => orchestrator.reconcileAndSync());
      if (typeof storage.flush === "function") await storage.flush();
      if (reconciled?.status === "synced") refreshFromPersistedSnapshot();
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
    const pendingDurable = await waitForDurableMutationBeforeSync();
    if (pendingDurable) return pendingDurable;
    if (typeof storage.flush === "function") await storage.flush();
    const blocked = unsupportedBlockResult();
    if (blocked) return blocked;
    const result = await withReconcilingWrite(() => orchestrator.reconcileAndSync());
    if (typeof storage.flush === "function") await storage.flush();
    if (result?.status === "synced") refreshFromPersistedSnapshot();
    if (result?.quarantined?.length) onQuarantine(result.quarantined);
    onStatus({ level: result?.status === "synced" ? "success" : "error", result });
    return result;
  }

  function install() {
    if (installed) throw new Error("V42 runtime wiring is already installed");
    windowObject.anasFirebaseSyncPull = wrappedPull;
    windowObject.anasFirebaseSyncPush = wrappedPush;
    setSaveDB(wrappedSaveDB);
    if (originalSaveDBDurably) setSaveDBDurably(wrappedSaveDBDurably);
    installed = true;
    if (unsupportedLocalMutations) unsupportedBlockResult();
    return { installed: true };
  }

  function uninstall() {
    if (!installed) return false;
    if (originalSyncPull === undefined) delete windowObject.anasFirebaseSyncPull;
    else windowObject.anasFirebaseSyncPull = originalSyncPull;
    if (originalSyncPush === undefined) delete windowObject.anasFirebaseSyncPush;
    else windowObject.anasFirebaseSyncPush = originalSyncPush;
    setSaveDB(originalSaveDB);
    if (originalSaveDBDurably) setSaveDBDurably(originalSaveDBDurably);
    installed = false;
    return true;
  }

  return {
    install, uninstall, wrappedSaveDB, wrappedSaveDBDurably, wrappedPull, wrappedPush,
    clearUnsupportedMutationBlock,
    get unsupportedLocalMutations() { return unsupportedLocalMutations; }
  };
}
