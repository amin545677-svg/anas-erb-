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
      // Check the durable ledger entity before balances/customer state: another
      // device may already have applied this movement and changed the debt.
      const existingMovement = snapshot.cashMovements.find(movement => movement?.id === movementId);
      if (existingMovement) {
        const existingAmountCents = moneyCents(existingMovement.amount);
        const customerMatches = existingMovement.customerId == null ||
          String(existingMovement.customerId) === String(payload.customerId);
        const operationMatches = existingMovement.opId === op.opId;
        if (existingAmountCents === amountCents && customerMatches && operationMatches) {
          markApplied();
          appliedNow.push({ opId: op.opId, outcome: "already-applied", reason: "CASH_MOVEMENT_ENTITY_EXISTS" });
        } else {
          review.push({ opId: op.opId, reason: "CASH_MOVEMENT_ID_COLLISION", operation: op });
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

      customer.debt = fromMoneyCents(debtCents - amountCents);
      snapshot.caisseBalance = fromMoneyCents(cashCents + amountCents);
      const movement = payload.cashMovement && typeof payload.cashMovement === "object"
        ? structuredClone(payload.cashMovement)
        : { id: movementId, type: "debt_collection", amount, customerId: payload.customerId, opId: op.opId };
      movement.id = movementId;
      movement.opId = op.opId;
      snapshot.cashMovements.push(movement);
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
        if (matchingInvoices.length === 1 &&
            existingInvoice.syncOpId === op.opId &&
            sameInvoice) {
          markApplied();
          appliedNow.push({ opId: op.opId, outcome: "already-applied", reason: "VERIFIED_INVOICE_OPERATION_MARKER" });
        } else {
          review.push({ opId: op.opId, reason: "INVOICE_ID_COLLISION", operation: op });
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
        if (debtCents === null || debtCents + remainingCents > Number.MAX_SAFE_INTEGER) {
          review.push({ opId: op.opId, reason: "INVALID_CUSTOMER_DEBT", operation: op });
          continue;
        }
      }
      if (cashCents + paidCents > Number.MAX_SAFE_INTEGER) {
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
      markApplied();
      appliedNow.push({ opId: op.opId, outcome: "applied" });
      continue;
    }

    review.push({ opId: op.opId, reason: "UNSUPPORTED_OPERATION_TYPE", operation: op });
  }

  return { snapshot, appliedNow, review };
}
