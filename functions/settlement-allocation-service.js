'use strict';

const crypto = require('node:crypto');
const { PERMISSIONS } = require('./lib/authorization.js');
const { authorizeFinancialScope } = require('./lib/user-rbac-bridge.js');

const MAX_SNAPSHOT_BYTES = 700 * 1024;
const MAX_ALLOCATIONS = 200;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' +
    Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function requiredText(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + ' is invalid');
  return value.trim();
}

function toCentimes(value, label) {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error(label + ' must be a finite currency amount');
  }
  const raw = String(value).trim();
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.exec(raw);
  if (!match) throw new Error(label + ' must be a non-negative amount with at most two decimals');
  const result = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(label + ' exceeds the safe range');
  return Number(result);
}

function integerCentimes(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const amount = BigInt(value.trim());
    if (amount <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(amount);
  }
  throw new Error(label + ' must be a non-negative safe integer number of centimes');
}

function normalizeAllocationRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('allocation request is required');
  const allowed = new Set(['operationId', 'periodId', 'partyType', 'partyId', 'sourceMovementId', 'sourceMovementType', 'allocations']);
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error('unsupported allocation request fields: ' + unknown.join(', '));
  const operationId = requiredText(input.operationId, 'operationId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(operationId)) throw new Error('operationId format is invalid');
  const periodId = requiredText(input.periodId, 'periodId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(periodId)) throw new Error('periodId format is invalid');
  const partyType = input.partyType;
  if (!['customer', 'supplier'].includes(partyType)) throw new Error('partyType must be customer or supplier');
  const partyId = requiredText(input.partyId, 'partyId');
  const sourceMovementId = requiredText(input.sourceMovementId, 'sourceMovementId');
  const sourceMovementType = input.sourceMovementType;
  const permittedSources = partyType === 'customer' ? ['customer_debt', 'sales_invoice'] : ['supplier_payment', 'purchase_invoice'];
  if (!permittedSources.includes(sourceMovementType)) throw new Error('source movement type does not match party type');
  if (!Array.isArray(input.allocations) || input.allocations.length < 1 || input.allocations.length > MAX_ALLOCATIONS)
    throw new Error('allocations must contain between 1 and ' + MAX_ALLOCATIONS + ' rows');
  const seen = new Set();
  const invoiceType = partyType === 'customer' ? 'sales_invoice' : 'purchase_invoice';
  const allocations = input.allocations.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('allocation row ' + index + ' is invalid');
    const fields = Object.keys(row).filter(key => !['invoiceId', 'amountCentimes'].includes(key));
    if (fields.length) throw new Error('unsupported allocation row fields: ' + fields.join(', '));
    const invoiceId = requiredText(row.invoiceId, 'invoiceId');
    if (seen.has(invoiceId)) throw new Error('duplicate invoice allocation');
    seen.add(invoiceId);
    const amountCentimes = integerCentimes(row.amountCentimes, 'allocation amount');
    if (!Number.isSafeInteger(amountCentimes) || amountCentimes <= 0) throw new Error('allocation amount must be positive safe integer centimes');
    return Object.freeze({ invoiceType, invoiceId, amountCentimes });
  });
  return Object.freeze({
    operationId, periodId, partyType, partyId, sourceMovementId, sourceMovementType,
    allocations: Object.freeze(allocations)
  });
}

function recordId(row) { return row && (row.id ?? row.movementId); }

function sourceRows(state, request) {
  if (request.partyType === 'customer') {
    const rows = Array.isArray(state.cashMovements) ? state.cashMovements : [];
    return rows.filter(row => row && String(recordId(row)) === request.sourceMovementId &&
      row.referenceType === request.sourceMovementType &&
      (request.sourceMovementType === 'customer_debt'
        ? String(row.referenceId) === request.partyId
        : true));
  }
  const rows = Array.isArray(state.supplierMovements) ? state.supplierMovements : [];
  return rows.filter(row => row && String(recordId(row)) === request.sourceMovementId &&
    row.type === 'payment' && row.referenceType === request.sourceMovementType &&
    String(row.supplierId ?? '') === request.partyId &&
    (request.sourceMovementType !== 'supplier_payment' || String(row.referenceId ?? '') === request.sourceMovementId));
}

function invoicePartyId(invoice, partyType) {
  return String(partyType === 'customer'
    ? (invoice.customerId ?? invoice.customerObj?.id ?? '')
    : (invoice.supplierId ?? invoice.supplier?.id ?? ''));
}

function invoiceAmount(invoice, field) {
  const centsField = field + 'Centimes';
  return own(invoice, centsField) ? integerCentimes(invoice[centsField], field + ' centimes') : toCentimes(invoice[field], field);
}

function createSettlementAllocationHandler({ db, getUser, FieldValue, HttpsError, ReverseLedger, now = Date.now }) {
  function fail(code, message) { throw new HttpsError(code, message); }
  function mapError(error) {
    if (error instanceof HttpsError) return error;
    const message = String(error && error.message || 'Settlement allocation failed');
    const code = /permission|grant|role|disabled/i.test(message) ? 'permission-denied' :
      /duplicate|already|operationId/i.test(message) ? 'already-exists' :
      /missing|required|invalid|exceed|mismatch|not OPEN|unallocated|ambiguous|ledger|source|invoice/i.test(message)
        ? 'failed-precondition' : 'internal';
    return new HttpsError(code, message.slice(0, 400));
  }

  return async request => {
    if (!request.auth || !request.auth.uid) fail('unauthenticated', 'A verified Firebase user session is required.');
    if (!request.app) fail('failed-precondition', 'A valid Firebase App Check token is required.');
    if (request.data && typeof request.data === 'object' &&
        (Object.prototype.hasOwnProperty.call(request.data, 'tenantId') ||
         Object.prototype.hasOwnProperty.call(request.data, 'storeId'))) {
      fail('permission-denied', 'Client-supplied tenant/store scope is not trusted.');
    }
    let normalized;
    try { normalized = normalizeAllocationRequest(request.data); }
    catch (error) { fail('invalid-argument', String(error.message || error).slice(0, 300)); }
    const uid = request.auth.uid;
    const authUser = await getUser(uid);
    if (authUser.disabled) fail('permission-denied', 'Firebase account is disabled.');
    const grantRef = db.collection('reverseLedgerGrants').doc(uid);
    const periodRef = db.collection('financialPeriods').doc(normalized.periodId);
    const snapshotRef = db.collection('users').doc(uid).collection('snapshots').doc('latest');
    const operationRef = db.collection('reverseLedgerOperations').doc(normalized.operationId);
    const requestHash = sha256(canonical(normalized));
    const nowMs = now();

    try {
      return await db.runTransaction(async transaction => {
        const [snapshotSnap, grantSnap, periodSnap, operationSnap] = await Promise.all([
          transaction.get(snapshotRef), transaction.get(grantRef),
          transaction.get(periodRef), transaction.get(operationRef)
        ]);
        if (operationSnap.exists) {
          const prior = operationSnap.data();
          if (prior.ownerUid !== uid) fail('already-exists', 'operationId belongs to another Firebase user.');
          if (prior.status === 'POSTED') {
            if (prior.requestHash !== requestHash || prior.operationType !== 'SETTLEMENT_ALLOCATION' || !prior.result)
              fail('already-exists', 'operationId was already used for a different financial operation.');
            return prior.result;
          }
          fail('already-exists', 'operationId is already reserved by another financial operation.');
        }
        if (!snapshotSnap.exists || typeof snapshotSnap.get('payload') !== 'string')
          fail('failed-precondition', 'A valid cloud snapshot is required before allocation.');
        if (!grantSnap.exists) fail('permission-denied', 'No trusted financial authorization grant exists.');
        if (!periodSnap.exists || periodSnap.get('status') !== 'OPEN')
          fail('failed-precondition', 'The requested financial period is not OPEN.');
        const grant = grantSnap.data();
        const grantStatus = String(grant.status || (grant.active === true ? 'active' : '')).toLowerCase();
        if (grant.uid !== uid || grantStatus !== 'active' || grant.schemaVersion !== 1 ||
            !Array.isArray(grant.permissions) || !grant.permissions.includes(PERMISSIONS.SETTLEMENT_ALLOCATION))
          fail('permission-denied', 'An active financial settlement-allocation permission is required.');
        if (grant.role && !['admin', 'owner', 'accountant', 'finance', 'financial_manager'].includes(String(grant.role).toLowerCase()))
          fail('permission-denied', 'The Firebase grant role is not authorized for financial allocation.');

        const payload = snapshotSnap.get('payload');
        if (Buffer.byteLength(payload, 'utf8') > MAX_SNAPSHOT_BYTES)
          fail('resource-exhausted', 'Cloud snapshot exceeds the 700 KiB transaction safety limit.');
        let state;
        try { state = JSON.parse(payload); }
        catch (_) { fail('failed-precondition', 'Cloud snapshot payload is not valid JSON.'); }
        if (!state || typeof state !== 'object' || Array.isArray(state))
          fail('failed-precondition', 'Cloud snapshot payload is malformed.');
        for (const name of ['invoices', 'purchases', 'customers', 'suppliers', 'settlementAllocations'])
          if (state[name] !== undefined && !Array.isArray(state[name])) fail('failed-precondition', name + ' collection is malformed.');
        state.currentUser = { id: uid, name: authUser.displayName || uid };
        ReverseLedger.validateReverseLedgerParity(state);

        const sources = sourceRows(state, normalized);
        if (sources.length !== 1) fail('failed-precondition', 'Source movement is missing or ambiguous.');
        const source = sources[0];
        if (source.tenantId || source.storeId || source.warehouseId) {
          try {
            authorizeFinancialScope({
              uid, grant, action: PERMISSIONS.SETTLEMENT_ALLOCATION, resource: source, state
            });
          } catch (error) {
            fail('permission-denied', String(error.message || error));
          }
        }
        if (normalized.sourceMovementType === 'sales_invoice' &&
            String(source.referenceId ?? '') === '') fail('failed-precondition', 'Linked sales invoice source is malformed.');
        if (normalized.sourceMovementType === 'purchase_invoice' &&
            String(source.referenceId ?? '') === '') fail('failed-precondition', 'Linked purchase invoice source is malformed.');
        const sourceAmount = source.amountCentimes != null
          ? integerCentimes(source.amountCentimes, 'source movement amount centimes')
          : toCentimes(source.amount ?? source.amt, 'source movement amount');
        const previousSourceAllocated = (state.settlementAllocations || [])
          .filter(row => row && row.partyType === normalized.partyType &&
            row.sourceMovementType === normalized.sourceMovementType &&
            String(row.sourceMovementId) === normalized.sourceMovementId &&
            String(row.partyId) === normalized.partyId)
          .reduce((sum, row) => sum + BigInt(row.amountCentimes), 0n);
        const requestedTotal = normalized.allocations.reduce((sum, row) => sum + BigInt(row.amountCentimes), 0n);
        if (previousSourceAllocated + requestedTotal !== BigInt(sourceAmount))
          fail('failed-precondition', 'The submitted allocation total must exactly close the remaining source movement to zero centimes.');

        const invoices = normalized.partyType === 'customer' ? state.invoices : state.purchases;
        if (!Array.isArray(invoices)) fail('failed-precondition', 'Target invoice collection is missing.');
        const sealed = [];
        for (const allocation of normalized.allocations) {
          const matches = invoices.filter(row => row && String(row.id) === allocation.invoiceId);
          if (matches.length !== 1) fail('failed-precondition', 'Target invoice is missing or ambiguous.');
          const invoice = matches[0];
          try {
            authorizeFinancialScope({
              uid, grant, action: PERMISSIONS.SETTLEMENT_ALLOCATION, resource: invoice, state
            });
          } catch (error) {
            fail('permission-denied', String(error.message || error));
          }
          if (invoicePartyId(invoice, normalized.partyType) !== normalized.partyId)
            fail('failed-precondition', 'Target invoice belongs to a different customer or supplier.');
          if (normalized.sourceMovementType === 'sales_invoice' && String(source.referenceId) !== allocation.invoiceId)
            fail('failed-precondition', 'A sales-invoice payment can only be allocated to its linked invoice.');
          if (normalized.sourceMovementType === 'purchase_invoice' && String(source.referenceId) !== allocation.invoiceId)
            fail('failed-precondition', 'A purchase-invoice payment can only be allocated to its linked invoice.');
          const total = invoiceAmount(invoice, 'total');
          const paid = invoiceAmount(invoice, 'paid');
          const invoiceRows = (state.settlementAllocations || []).filter(row =>
            row && row.invoiceType === allocation.invoiceType && String(row.invoiceId) === allocation.invoiceId);
          const initialSourceType = allocation.invoiceType;
          const laterSourceType = normalized.partyType === 'customer' ? 'customer_debt' : 'supplier_payment';
          const initialAllocated = invoiceRows.filter(row => row.sourceMovementType === initialSourceType)
            .reduce((sum, row) => sum + BigInt(row.amountCentimes), 0n);
          const laterAllocated = invoiceRows.filter(row => row.sourceMovementType === laterSourceType)
            .reduce((sum, row) => sum + BigInt(row.amountCentimes), 0n);
          const amount = BigInt(allocation.amountCentimes);
          if (initialAllocated > BigInt(paid))
            fail('failed-precondition', 'Initial invoice-linked allocations exceed the invoice paid amount.');
          if (normalized.sourceMovementType === initialSourceType) {
            if (initialAllocated + amount > BigInt(paid))
              fail('failed-precondition', 'Initial allocation exceeds the invoice paid amount not yet allocated.');
          } else if (BigInt(paid) + laterAllocated + amount > BigInt(total)) {
            fail('failed-precondition', 'Allocation exceeds the invoice-derived outstanding balance after paid and prior settlements.');
          }
          if (initialAllocated + laterAllocated + amount > BigInt(total))
            fail('failed-precondition', 'Total invoice allocations exceed the invoice total.');
          const record = ReverseLedger.sealSettlementAllocation(state, {
            allocationId: 'ALLOC-' + sha256(uid + ':' + normalized.operationId + ':' + allocation.invoiceId).slice(0, 28),
            partyType: normalized.partyType,
            partyId: normalized.partyId,
            invoiceType: allocation.invoiceType,
            invoiceId: allocation.invoiceId,
            sourceMovementId: normalized.sourceMovementId,
            sourceMovementType: normalized.sourceMovementType,
            amountCentimes: allocation.amountCentimes,
            createdAt: new Date(nowMs).toISOString()
          });
          state.settlementAllocations = [...(state.settlementAllocations || []), record];
          sealed.push(record);
        }

        if (normalized.partyType === 'customer' && normalized.sourceMovementType === 'customer_debt') {
          const client = (state.customers || []).find(row => row && String(row.id) === normalized.partyId);
          if (!client || client.ledgerVersion !== 2)
            fail('failed-precondition', 'Customer must have a reconciled version-2 client ledger before posting a receipt allocation.');
          const receiptExists = (state.clientMovements || []).some(row => row &&
            row.type === 'receipt' && row.referenceType === 'customer_debt' &&
            row.referenceId === normalized.partyId && String(row.movementId) === normalized.sourceMovementId);
          if (!receiptExists) {
            const movement = ReverseLedger.sealClientMovement(state, {
              movementId: normalized.sourceMovementId,
              clientId: normalized.partyId,
              type: 'receipt',
              amountCentimes: sourceAmount,
              direction: 'credit',
              referenceType: 'customer_debt',
              referenceId: normalized.partyId,
              createdAt: new Date(nowMs).toISOString()
            });
            state.clientMovements = [...(state.clientMovements || []), movement];
          }
        }

        ReverseLedger.validateReverseLedgerParity(state);
        const nextPayload = JSON.stringify(state);
        if (Buffer.byteLength(nextPayload, 'utf8') > MAX_SNAPSHOT_BYTES)
          fail('resource-exhausted', 'Updated snapshot exceeds the 700 KiB transaction safety limit.');
        const result = {
          ok: true, operationId: normalized.operationId, status: 'POSTED',
          allocationCount: sealed.length, allocations: sealed
        };
        transaction.update(snapshotRef, {
          payload: nextPayload,
          updatedAt: FieldValue.serverTimestamp(),
          lastSettlementAllocationOperationId: normalized.operationId
        });
        transaction.create(operationRef, {
          ownerUid: uid,
          operationId: normalized.operationId,
          operationType: 'SETTLEMENT_ALLOCATION',
          requestHash,
          status: 'POSTED',
          result,
          periodId: normalized.periodId,
          allocationIds: sealed.map(row => row.allocationId),
          schemaVersion: 1,
          postedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp()
        });
        return result;
      }, { maxAttempts: 5 });
    } catch (error) {
      throw mapError(error);
    }
  };
}

module.exports = Object.freeze({ toCentimes, integerCentimes, normalizeAllocationRequest, createSettlementAllocationHandler });
