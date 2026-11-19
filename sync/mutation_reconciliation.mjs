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
        const incomingByInvoice = new Map();
        let validAllocations = allocationRows.length > 0;
        let allocationTotalCents = 0;
        for (const row of allocationRows) {
          const matches = invoiceRows.filter(invoice =>
            String(invoice?.id) === String(row?.invoiceId) &&
            String(invoice?.customerId ?? invoice?.customerObj?.id ?? "") === String(customer.id));
          if (!row?.allocationId || row.partyType !== "customer" ||
              String(row.partyId) !== String(customer.id) ||
              row.invoiceType !== "sales_invoice" ||
              row.sourceMovementType !== "customer_debt" ||
              String(row.sourceMovementId) !== movementId ||
              !Number.isSafeInteger(row.amountCentimes) || row.amountCentimes <= 0 ||
              matches.length !== 1) {
            validAllocations = false;
            break;
          }
          const invoice = matches[0];
          const totalCents = moneyCents(invoice.total);
          const paidCents = moneyCents(invoice.paid ?? 0);
          const originalRemainingCents = moneyCents(invoice.remaining);
          if (![totalCents, paidCents, originalRemainingCents].every(Number.isSafeInteger) ||
              totalCents <= 0 || paidCents < 0 || originalRemainingCents < 0 ||
              paidCents + originalRemainingCents !== totalCents) {
            validAllocations = false;
            break;
          }
          let priorLaterAllocations = 0;
          for (const prior of existingAllocations) {
            if (prior?.partyType === "customer" &&
                prior.invoiceType === "sales_invoice" &&
                String(prior.invoiceId) === String(invoice.id) &&
                prior.sourceMovementType === "customer_debt") {
              if (!Number.isSafeInteger(prior.amountCentimes) || prior.amountCentimes <= 0 ||
                  !Number.isSafeInteger(priorLaterAllocations + prior.amountCentimes)) {
                validAllocations = false;
                break;
              }
              priorLaterAllocations += prior.amountCentimes;
            }
          }
          if (!validAllocations) break;
          const currentRemainingCents = totalCents - paidCents - priorLaterAllocations;
          const alreadyIncoming = incomingByInvoice.get(String(invoice.id)) || 0;
          if (currentRemainingCents < 0 ||
              row.amountCentimes > currentRemainingCents - alreadyIncoming ||
              !Number.isSafeInteger(allocationTotalCents + row.amountCentimes)) {
            validAllocations = false;
            break;
          }
          incomingByInvoice.set(String(invoice.id), alreadyIncoming + row.amountCentimes);
          allocationTotalCents += row.amountCentimes;
        }
        validAllocations = validAllocations && allocationTotalCents === amountCents;
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
            clientMovements: "movementId", settlementAllocations: "allocationId"
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
      let normalizedClientRows = null;
      if (v42Ledger !== undefined) {
        const ledgerKeys = ["cashMovements", "bankMovements", "stockMovements", "clientMovements", "settlementAllocations"];
        if (!v42Ledger || typeof v42Ledger !== "object" || Array.isArray(v42Ledger) ||
            ledgerKeys.some(key => !Array.isArray(v42Ledger[key]))) {
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
          if (!Array.isArray(snapshot[key])) snapshot[key] = [];
          const committedRows = key === "clientMovements" && normalizedClientRows !== null
            ? normalizedClientRows : rows;
          snapshot[key].unshift(...structuredClone(committedRows));
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
