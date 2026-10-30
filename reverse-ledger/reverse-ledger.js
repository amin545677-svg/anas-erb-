'use strict';
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ANASReverseLedger = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const RETURN_TYPES = Object.freeze(['SALE_RETURN', 'PURCHASE_RETURN', 'INVOICE_CANCEL']);
  const PARTY_TYPES = Object.freeze(['customer', 'supplier']);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const id = (v, label) => {
    if (typeof v !== 'string' || !v.trim() || v.length > 160) throw new Error(label + ': invalid identifier');
    return v.trim();
  };
  const safeInt = (v, label, allowZero) => {
    if (!Number.isSafeInteger(v) || (allowZero ? v < 0 : v <= 0)) throw new Error(label + ': expected ' + (allowZero ? 'non-negative' : 'positive') + ' safe integer');
    return v;
  };
  const asBigInt = (v, label) => {
    if (typeof v === 'bigint') return v;
    if (!Number.isSafeInteger(v)) throw new Error(label + ': unsafe integer');
    return BigInt(v);
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  function ensureCollections(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('state must be an object');
    const names = ['clientMovements', 'settlementAllocations', 'returns'];
    for (const name of names) {
      if (own(state, name) && !Array.isArray(state[name])) throw new Error(name + ' must be an array');
    }
    const next = { ...state };
    for (const name of names) next[name] = own(state, name) ? state[name] : [];
    return next;
  }
  function makeClientMovement(input) {
    if (!input || typeof input !== 'object') throw new Error('client movement is required');
    const amountCentimes = safeInt(input.amountCentimes, 'amountCentimes', false);
    if (!['opening_balance', 'invoice_debit', 'receipt', 'return_credit', 'adjustment'].includes(input.type)) throw new Error('unsupported client movement type');
    return Object.freeze({
      movementId: id(input.movementId, 'movementId'),
      clientId: id(input.clientId, 'clientId'),
      type: input.type,
      amountCentimes,
      direction: input.direction === 'debit' || input.direction === 'credit' ? input.direction : (() => { throw new Error('direction must be debit or credit'); })(),
      referenceType: id(input.referenceType, 'referenceType'),
      referenceId: id(input.referenceId, 'referenceId'),
      createdAt: id(input.createdAt, 'createdAt'),
      ledgerVersion: 2
    });
  }
  function makeSettlementAllocation(input) {
    if (!input || typeof input !== 'object') throw new Error('settlement allocation is required');
    if (!PARTY_TYPES.includes(input.partyType)) throw new Error('partyType must be customer or supplier');
    if (!['sales_invoice', 'purchase_invoice'].includes(input.invoiceType)) throw new Error('unsupported invoiceType');
    if ((input.partyType === 'customer') !== (input.invoiceType === 'sales_invoice')) throw new Error('party and invoice types do not match');
    return Object.freeze({
      allocationId: id(input.allocationId, 'allocationId'),
      partyType: input.partyType,
      partyId: id(input.partyId, 'partyId'),
      invoiceType: input.invoiceType,
      invoiceId: id(input.invoiceId, 'invoiceId'),
      sourceMovementId: id(input.sourceMovementId, 'sourceMovementId'),
      sourceMovementType: id(input.sourceMovementType, 'sourceMovementType'),
      amountCentimes: safeInt(input.amountCentimes, 'amountCentimes', false),
      createdAt: id(input.createdAt, 'createdAt'),
      ledgerVersion: 2
    });
  }
  function makeReturnDocument(input) {
    if (!input || typeof input !== 'object') throw new Error('return document is required');
    if (!RETURN_TYPES.includes(input.returnType)) throw new Error('unsupported returnType');
    if (!['DRAFT', 'POSTED', 'REJECTED'].includes(input.status)) throw new Error('unsupported return status');
    if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('return items are required');
    const seen = new Set();
    const items = input.items.map((line) => {
      const productId = id(line.productId, 'productId');
      if (seen.has(productId)) throw new Error('duplicate product line');
      seen.add(productId);
      const quantityMicroUnits = safeInt(line.quantityMicroUnits, 'quantityMicroUnits', false);
      const unitPriceCentimes = safeInt(line.unitPriceCentimes, 'unitPriceCentimes', true);
      const lineTotalCentimes = safeInt(line.lineTotalCentimes, 'lineTotalCentimes', true);
      const product = asBigInt(quantityMicroUnits, 'quantityMicroUnits') * asBigInt(unitPriceCentimes, 'unitPriceCentimes');
      if (product % 1000000n !== 0n) throw new Error('return line produces a fractional centime');
      const exact = product / 1000000n;
      if (exact !== BigInt(lineTotalCentimes)) throw new Error('return line total does not match exact micro-unit arithmetic');
      return Object.freeze({ productId, quantityMicroUnits, unitPriceCentimes, lineTotalCentimes });
    });
    const total = items.reduce((sum, line) => sum + BigInt(line.lineTotalCentimes), 0n);
    const totalCentimes = safeInt(input.totalCentimes, 'totalCentimes', true);
    if (total !== BigInt(totalCentimes)) throw new Error('return total does not equal line totals');
    const debtReductionCentimes = safeInt(input.debtReductionCentimes, 'debtReductionCentimes', true);
    const cashRefundCentimes = safeInt(input.cashRefundCentimes, 'cashRefundCentimes', true);
    if (BigInt(debtReductionCentimes) + BigInt(cashRefundCentimes) > total) throw new Error('settlement exceeds return value');
    return Object.freeze({
      returnId: id(input.returnId, 'returnId'),
      originalInvoiceId: id(input.originalInvoiceId, 'originalInvoiceId'),
      returnType: input.returnType,
      items: Object.freeze(items),
      totalCentimes,
      debtReductionCentimes,
      cashRefundCentimes,
      status: input.status,
      createdAt: id(input.createdAt, 'createdAt'),
      operatorId: id(input.operatorId, 'operatorId'),
      reason: id(input.reason, 'reason'),
      ledgerVersion: 2
    });
  }
  function computeReturnableMicroUnits(originalMicroUnits, previouslyReturnedMicroUnits) {
    const original = asBigInt(originalMicroUnits, 'originalMicroUnits');
    const returned = asBigInt(previouslyReturnedMicroUnits, 'previouslyReturnedMicroUnits');
    if (original < 0n || returned < 0n || returned > original) throw new Error('invalid return quantity ceiling');
    return original - returned;
  }
  function validateSettlementAllocations(state) {
    const data = ensureCollections(state);
    const allocations = data.settlementAllocations;
    const clientMovements = data.clientMovements || [];
    const supplierMovements = data.supplierMovements || [];
    const cashMovements = data.cashMovements || [];
    const invoices = [...(data.invoices || []).map(x => ({...x, __type:'sales_invoice', __party:'customer', __partyId:String(x.customerId ?? x.customerObj?.id ?? '')})),
      ...(data.purchases || []).map(x => ({...x, __type:'purchase_invoice', __party:'supplier', __partyId:String(x.supplierId ?? '')}))];
    const allocationIds = new Set();
    const sourceTotals = new Map();
    for (const a of allocations) {
      if (!a || typeof a !== 'object') throw new Error('invalid settlement allocation');
      if (allocationIds.has(String(a.allocationId))) throw new Error('duplicate allocationId');
      allocationIds.add(String(a.allocationId));
      const invoice = invoices.find(x => String(x.id) === String(a.invoiceId) && x.__type === a.invoiceType);
      if (!invoice) throw new Error('orphan settlement allocation');
      if (String(invoice.__partyId) !== String(a.partyId)) throw new Error('allocation party does not match invoice');
      let source;
      if (a.partyType === 'customer' && a.sourceMovementType === 'customer_debt') {
        source = cashMovements.filter(x => String(x.id ?? '') === String(a.sourceMovementId) && x.referenceType === 'customer_debt');
      } else if (a.partyType === 'supplier' && a.sourceMovementType === 'supplier_payment') {
        source = supplierMovements.filter(x => String(x.id ?? '') === String(a.sourceMovementId) && x.type === 'payment');
      } else if (a.sourceMovementType === 'sales_invoice' || a.sourceMovementType === 'purchase_invoice') {
        source = cashMovements.filter(x => String(x.id ?? '') === String(a.sourceMovementId) && x.referenceType === a.sourceMovementType);
      } else {
        throw new Error('unsupported allocation source movement type');
      }
      if (source.length !== 1) throw new Error('allocation source movement missing or ambiguous');
      const key = a.partyType + ':' + a.sourceMovementType + ':' + a.sourceMovementId;
      sourceTotals.set(key, (sourceTotals.get(key) || 0n) + asBigInt(a.amountCentimes, 'allocation amount'));
      sourceTotals.set(key + ':source', source[0]);
    }
    for (const [key, total] of sourceTotals) {
      if (key.endsWith(':source')) continue;
      const source = sourceTotals.get(key + ':source');
      let amount = source && source.amountCentimes;
      if (amount === undefined && source && (typeof source.amount === 'number' || typeof source.amount === 'string')) {
        const text = String(source.amount);
        const match = /^(0|[1-9]\\d*)(?:\\.(\\d{1,2}))?$/.exec(text);
        if (match) amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
      }
      if (!Number.isSafeInteger(amount) || total > BigInt(amount)) throw new Error('allocations exceed source movement amount');
    }
    return true;
  }
  function appendUnique(list, record, key) {
    if (!Array.isArray(list)) throw new Error('target ledger must be an array');
    if (list.some(x => String(x && x[key]) === String(record[key]))) throw new Error('duplicate ' + key);
    return [...list, clone(record)];
  }
  return Object.freeze({ ensureCollections, makeClientMovement, makeSettlementAllocation, makeReturnDocument,
    computeReturnableMicroUnits, validateSettlementAllocations, appendUnique, RETURN_TYPES, PARTY_TYPES });
});
