/**
 * Pure reconciliation primitives for the isolated ANAS ERP sync prototype.
 *
 * This module is deliberately NOT wired into production index.html. It returns a
 * new snapshot and explicit review items; callers must persist atomically and must
 * not upload until every operation has been reconciled or quarantined.
 */
function finiteAmount(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer in the smallest currency unit`);
  }
  return value;
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
  const review = [];
  const appliedNow = [];
  const seenPending = new Set();

  for (const op of pendingMutations) {
    if (!op || typeof op !== "object" || typeof op.opId !== "string" || !op.opId.trim()) {
      review.push({ opId: op?.opId ?? null, reason: "INVALID_OPERATION_ID", operation: op ?? null });
      continue;
    }
    if (seenPending.has(op.opId)) {
      review.push({ opId: op.opId, reason: "DUPLICATE_ID_IN_PENDING_QUEUE", operation: op });
      continue;
    }
    seenPending.add(op.opId);

    if (applied.has(op.opId)) {
      appliedNow.push({ opId: op.opId, outcome: "already-applied" });
      continue;
    }

    const payload = op.payload;
    if (!payload || typeof payload !== "object") {
      review.push({ opId: op.opId, reason: "INVALID_PAYLOAD", operation: op });
      continue;
    }

    if (op.type === "DEBT_COLLECTION") {
      let amount;
      try { amount = finiteAmount(payload.amount, "Collection amount"); }
      catch (error) {
        review.push({ opId: op.opId, reason: "INVALID_AMOUNT", detail: error.message, operation: op });
        continue;
      }
      const movementId = payload.cashMovementId;
      if (typeof movementId !== "string" || !movementId.trim()) {
        review.push({ opId: op.opId, reason: "MISSING_CASH_MOVEMENT_ID", operation: op });
        continue;
      }
      if (!Array.isArray(snapshot.cashMovements)) snapshot.cashMovements = [];
      // Check the durable ledger entity before balances/customer state: another
      // device may already have applied this movement and changed the debt.
      if (snapshot.cashMovements.some(movement => movement?.id === movementId)) {
        applied.add(op.opId);
        snapshot.appliedOpIds = [...applied];
        appliedNow.push({ opId: op.opId, outcome: "already-applied", reason: "CASH_MOVEMENT_ENTITY_EXISTS" });
        continue;
      }
      const customer = findById(snapshot.customers, payload.customerId);
      if (!customer) {
        review.push({ opId: op.opId, reason: "CUSTOMER_NOT_FOUND", operation: op });
        continue;
      }
      if (!Number.isSafeInteger(customer.debt) || customer.debt < amount) {
        review.push({ opId: op.opId, reason: "COLLECTION_EXCEEDS_RECORDED_DEBT_OR_INVALID_DEBT", operation: op });
        continue;
      }
      if (!Number.isSafeInteger(snapshot.caisseBalance)) {
        review.push({ opId: op.opId, reason: "INVALID_CASH_BALANCE", operation: op });
        continue;
      }

      customer.debt -= amount;
      snapshot.caisseBalance += amount;
      const movement = payload.cashMovement && typeof payload.cashMovement === "object"
        ? structuredClone(payload.cashMovement)
        : { id: movementId, type: "debt_collection", amount, customerId: payload.customerId, opId: op.opId };
      movement.id = movementId;
      movement.opId = op.opId;
      snapshot.cashMovements.push(movement);
      applied.add(op.opId);
      snapshot.appliedOpIds = [...applied];
      appliedNow.push({ opId: op.opId, outcome: "applied" });
      continue;
    }

    if (op.type === "SALE_INVOICE") {
      const quantity = payload.quantity;
      const product = findById(snapshot.products, payload.productId);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        review.push({ opId: op.opId, reason: "INVALID_SALE_QUANTITY", operation: op });
        continue;
      }
      if (!product) {
        review.push({ opId: op.opId, reason: "PRODUCT_NOT_FOUND", operation: op });
        continue;
      }
      if (!Number.isSafeInteger(product.stock) || product.stock < quantity) {
        review.push({ opId: op.opId, reason: "INSUFFICIENT_CLOUD_STOCK", operation: op });
        continue;
      }
      const invoice = payload.invoice;
      const stockMovement = payload.stockMovement;
      if (!invoice || typeof invoice.id !== "string" || !invoice.id ||
          !stockMovement || typeof stockMovement.id !== "string" || !stockMovement.id) {
        review.push({ opId: op.opId, reason: "INCOMPLETE_SALE_LEDGER_PAYLOAD", operation: op });
        continue;
      }
      if (!Array.isArray(snapshot.invoices)) snapshot.invoices = [];
      if (!Array.isArray(snapshot.stockMovements)) snapshot.stockMovements = [];
      if (snapshot.invoices.some(item => item?.id === invoice.id)) {
        applied.add(op.opId);
        snapshot.appliedOpIds = [...applied];
        appliedNow.push({ opId: op.opId, outcome: "already-applied", reason: "INVOICE_ENTITY_EXISTS" });
        continue;
      }
      if (snapshot.stockMovements.some(item => item?.id === stockMovement.id)) {
        review.push({ opId: op.opId, reason: "SALE_LEDGER_ID_COLLISION", operation: op });
        continue;
      }
      product.stock -= quantity;
      snapshot.invoices.push({ ...structuredClone(invoice), opId: op.opId });
      snapshot.stockMovements.push({ ...structuredClone(stockMovement), opId: op.opId });
      if (payload.cashMovement) {
        if (!Array.isArray(snapshot.cashMovements)) snapshot.cashMovements = [];
        if (typeof payload.cashMovement.id !== "string" ||
            snapshot.cashMovements.some(item => item?.id === payload.cashMovement.id)) {
          // Do not partially apply a sale if its cash movement cannot be recorded.
          product.stock += quantity;
          snapshot.invoices.pop();
          snapshot.stockMovements.pop();
          review.push({ opId: op.opId, reason: "SALE_CASH_MOVEMENT_ID_COLLISION_OR_INVALID", operation: op });
          continue;
        }
        snapshot.cashMovements.push({ ...structuredClone(payload.cashMovement), opId: op.opId });
      }
      applied.add(op.opId);
      snapshot.appliedOpIds = [...applied];
      appliedNow.push({ opId: op.opId, outcome: "applied" });
      continue;
    }

    review.push({ opId: op.opId, reason: "UNSUPPORTED_OPERATION_TYPE", operation: op });
  }

  return { snapshot, appliedNow, review };
}
