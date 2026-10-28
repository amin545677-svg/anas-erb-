/**
 * Pure reconciliation primitives for the isolated ANAS ERP sync prototype.
 *
 * This module is deliberately NOT wired into production index.html. It returns a
 * new snapshot and explicit review items; callers must persist atomically and must
 * not upload until every operation has been reconciled or quarantined.
 */
function normalizeMoneyV42(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > Number.MAX_SAFE_INTEGER) return null;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}
function finiteAmount(value, label) {
  const amount = normalizeMoneyV42(value);
  if (amount === null || amount <= 0) throw new Error(`${label} must be a positive amount with at most two decimal places`);
  return amount;
}
function moneyCents(value) {
  const amount = normalizeMoneyV42(value);
  if (amount === null) return null;
  return Math.round(amount * 100);
}
function fromMoneyCents(cents) {
  return Math.round(cents) / 100;
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
      const debtCents = moneyCents(customer.debt);
      const amountCents = moneyCents(amount);
      if (debtCents === null || debtCents < amountCents) {
        review.push({ opId: op.opId, reason: "COLLECTION_EXCEEDS_RECORDED_DEBT_OR_INVALID_DEBT", operation: op });
        continue;
      }
      const cashCents = moneyCents(snapshot.caisseBalance);
      if (cashCents === null) {
        review.push({ opId: op.opId, reason: "INVALID_CASH_BALANCE", operation: op });
        continue;
      }

      customer.debt = fromMoneyCents(debtCents - amountCents);
      snapshot.caisseBalance = fromMoneyCents(cashCents + amountCents);
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
      const invoice = payload.invoice;
      if (!invoice || typeof invoice !== "object" || Array.isArray(invoice) ||
          typeof invoice.id !== "string" || !invoice.id.trim()) {
        review.push({ opId: op.opId, reason: "INCOMPLETE_SALE_INVOICE", operation: op });
        continue;
      }
      if (!Array.isArray(snapshot.invoices)) snapshot.invoices = [];
      if (snapshot.invoices.some(item => item?.id === invoice.id)) {
        applied.add(op.opId);
        snapshot.appliedOpIds = [...applied];
        appliedNow.push({ opId: op.opId, outcome: "already-applied", reason: "INVOICE_ENTITY_EXISTS" });
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
      const remainingCents = moneyCents(invoice.remaining ?? Math.max(0, Number(invoice.total) - Number(invoice.paid ?? invoice.total)));
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
      if (remainingCents > 0) {
        if (typeof op.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(op.createdAt) || !Number.isFinite(Date.parse(op.createdAt))) {
          review.push({ opId: op.opId, reason: "SALE_OPERATION_TIMESTAMP_MISSING", operation: op });
          continue;
        }
        const customerId = payload.customerId ?? invoice.customerId ?? invoice.customerObj?.id;
        if (customerId == null) {
          review.push({ opId: op.opId, reason: "CUSTOMER_REQUIRED_FOR_CREDIT_SALE", operation: op });
          continue;
        }
        const matches = (Array.isArray(snapshot.customers) ? snapshot.customers : [])
          .filter(item => item && String(item.id) === String(customerId));
        if (matches.length !== 1) {
          review.push({ opId: op.opId, reason: matches.length ? "DUPLICATE_CUSTOMER_ID" : "CUSTOMER_NOT_FOUND", operation: op });
          continue;
        }
        customer = matches[0];
        const debtCents = moneyCents(customer.debt ?? 0);
        if (debtCents === null || debtCents + remainingCents > Number.MAX_SAFE_INTEGER * 100) {
          review.push({ opId: op.opId, reason: "INVALID_CUSTOMER_DEBT", operation: op });
          continue;
        }
      }
      if (cashCents + paidCents > Number.MAX_SAFE_INTEGER * 100) {
        review.push({ opId: op.opId, reason: "INVALID_CASH_BALANCE", operation: op });
        continue;
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
      if (customer && remainingCents > 0) {
        customer.debt = fromMoneyCents(moneyCents(customer.debt ?? 0) + remainingCents);
        // V42 records debtDate as an ISO date, independent of the invoice's localized display date.
        customer.debtDate = op.createdAt.slice(0, 10);
      }
      if (paidCents > 0) snapshot.caisseBalance = fromMoneyCents(cashCents + paidCents);
      // V42 uses unshift and does not create cashMovements/stockMovements in this function.
      snapshot.invoices.unshift(structuredClone(invoice));
      applied.add(op.opId);
      snapshot.appliedOpIds = [...applied];
      appliedNow.push({ opId: op.opId, outcome: "applied" });
      continue;
    }

    review.push({ opId: op.opId, reason: "UNSUPPORTED_OPERATION_TYPE", operation: op });
  }

  return { snapshot, appliedNow, review };
}
