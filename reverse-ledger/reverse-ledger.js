'use strict';
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ANASReverseLedger = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const RETURN_TYPES = Object.freeze(['SALE_RETURN', 'PURCHASE_RETURN', 'INVOICE_CANCEL']);
  const PARTY_TYPES = Object.freeze(['customer', 'supplier']);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const identifier = (v, label) => {
    if ((typeof v !== 'string' && typeof v !== 'number') || !String(v).trim() || String(v).length > 160)
      throw new Error(label + ': invalid identifier');
    return String(v).trim();
  };
  const safeInt = (v, label, allowZero) => {
    if (!Number.isSafeInteger(v) || (allowZero ? v < 0 : v <= 0))
      throw new Error(label + ': expected ' + (allowZero ? 'non-negative' : 'positive') + ' safe integer');
    return v;
  };
  const asBigInt = (v, label) => {
    if (typeof v === 'bigint') return v;
    if (!Number.isSafeInteger(v)) throw new Error(label + ': unsafe integer');
    return BigInt(v);
  };
  function decimalUnits(value, scale, label) {
    if ((typeof value !== 'number' && typeof value !== 'string') || value === null || String(value).trim() === '')
      throw new Error(label + ': invalid decimal');
    const raw = String(value).trim();
    const places = scale === 100 ? 2 : 6;
    const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(raw);
    if (!match || ((match[2] || '').length > places)) throw new Error(label + ': invalid precision');
    const fraction = (match[2] || '').padEnd(places, '0');
    return BigInt(match[1]) * BigInt(scale) + BigInt(fraction || '0');
  }
  const currencyToCentimes = (value, label) => decimalUnits(value, 100, label);
  const quantityToMicroUnits = (value, label) => decimalUnits(value, 1000000, label);
  const clone = value => JSON.parse(JSON.stringify(value));
  const recordId = row => row && (row.id ?? row.movementId ?? row.returnId ?? row.allocationId);
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
    if (!['opening_balance', 'invoice_debit', 'receipt', 'return_credit', 'adjustment'].includes(input.type))
      throw new Error('unsupported client movement type');
    return Object.freeze({
      movementId: identifier(input.movementId, 'movementId'),
      clientId: identifier(input.clientId, 'clientId'),
      type: input.type,
      amountCentimes,
      direction: input.direction === 'debit' || input.direction === 'credit' ? input.direction : (() => { throw new Error('direction must be debit or credit'); })(),
      referenceType: identifier(input.referenceType, 'referenceType'),
      referenceId: identifier(input.referenceId, 'referenceId'),
      createdAt: identifier(input.createdAt, 'createdAt')
    });
  }
  function makeSettlementAllocation(input) {
    if (!input || typeof input !== 'object') throw new Error('settlement allocation is required');
    if (!PARTY_TYPES.includes(input.partyType)) throw new Error('partyType must be customer or supplier');
    if (!['sales_invoice', 'purchase_invoice'].includes(input.invoiceType)) throw new Error('unsupported invoiceType');
    if ((input.partyType === 'customer') !== (input.invoiceType === 'sales_invoice'))
      throw new Error('party and invoice types do not match');
    return Object.freeze({
      allocationId: identifier(input.allocationId, 'allocationId'),
      partyType: input.partyType,
      partyId: identifier(input.partyId, 'partyId'),
      invoiceType: input.invoiceType,
      invoiceId: identifier(input.invoiceId, 'invoiceId'),
      sourceMovementId: identifier(input.sourceMovementId, 'sourceMovementId'),
      sourceMovementType: identifier(input.sourceMovementType, 'sourceMovementType'),
      amountCentimes: safeInt(input.amountCentimes, 'amountCentimes', false),
      createdAt: identifier(input.createdAt, 'createdAt')
    });
  }
  function makeReturnDocument(input) {
    if (!input || typeof input !== 'object') throw new Error('return document is required');
    if (!RETURN_TYPES.includes(input.returnType)) throw new Error('unsupported returnType');
    if (!['sales_invoice', 'purchase_invoice'].includes(input.originalInvoiceType)) throw new Error('originalInvoiceType is required');
    if (input.returnType === 'SALE_RETURN' && input.originalInvoiceType !== 'sales_invoice') throw new Error('sale return must reference a sales invoice');
    if (input.returnType === 'PURCHASE_RETURN' && input.originalInvoiceType !== 'purchase_invoice') throw new Error('purchase return must reference a purchase invoice');
    if (!['DRAFT', 'POSTED', 'REJECTED'].includes(input.status)) throw new Error('unsupported return status');
    if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('return items are required');
    const seen = new Set();
    const items = input.items.map(line => {
      const productId = identifier(line.productId, 'productId');
      if (seen.has(productId)) throw new Error('duplicate product line');
      seen.add(productId);
      const quantityMicroUnits = safeInt(line.quantityMicroUnits, 'quantityMicroUnits', false);
      const unitPriceCentimes = safeInt(line.unitPriceCentimes, 'unitPriceCentimes', true);
      const lineTotalCentimes = safeInt(line.lineTotalCentimes, 'lineTotalCentimes', true);
      const product = asBigInt(quantityMicroUnits, 'quantityMicroUnits') * asBigInt(unitPriceCentimes, 'unitPriceCentimes');
      if (product % 1000000n !== 0n) throw new Error('return line produces a fractional centime');
      if (product / 1000000n !== BigInt(lineTotalCentimes))
        throw new Error('return line total does not match exact micro-unit arithmetic');
      return Object.freeze({ productId, quantityMicroUnits, unitPriceCentimes, lineTotalCentimes });
    });
    const total = items.reduce((sum, line) => sum + BigInt(line.lineTotalCentimes), 0n);
    const totalCentimes = safeInt(input.totalCentimes, 'totalCentimes', true);
    if (total !== BigInt(totalCentimes)) throw new Error('return total does not equal line totals');
    const debtReductionCentimes = safeInt(input.debtReductionCentimes, 'debtReductionCentimes', true);
    const cashRefundCentimes = safeInt(input.cashRefundCentimes, 'cashRefundCentimes', true);
    const supplierCreditCentimes = safeInt(input.supplierCreditCentimes ?? 0, 'supplierCreditCentimes', true);
    if (input.originalInvoiceType === 'sales_invoice' && supplierCreditCentimes !== 0)
      throw new Error('sales return cannot create supplier credit');
    const settled = BigInt(debtReductionCentimes) + BigInt(cashRefundCentimes) + BigInt(supplierCreditCentimes);
    if (settled > total) throw new Error('settlement exceeds return value');
    if (input.status === 'POSTED' && settled !== total) throw new Error('posted return settlement must equal return value');
    const stockMovementIds = Array.isArray(input.stockMovementIds) ? input.stockMovementIds.map(x => identifier(x, 'stockMovementId')) : [];
    const financialMovementIds = Array.isArray(input.financialMovementIds) ? input.financialMovementIds.map(x => identifier(x, 'financialMovementId')) : [];
    if (new Set(stockMovementIds).size !== stockMovementIds.length || new Set(financialMovementIds).size !== financialMovementIds.length)
      throw new Error('duplicate return movement reference');
    return Object.freeze({
      returnId: identifier(input.returnId, 'returnId'),
      originalInvoiceId: identifier(input.originalInvoiceId, 'originalInvoiceId'),
      originalInvoiceType: input.originalInvoiceType,
      returnType: input.returnType,
      items: Object.freeze(items),
      totalCentimes,
      debtReductionCentimes,
      cashRefundCentimes,
      supplierCreditCentimes,
      stockMovementIds: Object.freeze(stockMovementIds),
      financialMovementIds: Object.freeze(financialMovementIds),
      status: input.status,
      createdAt: identifier(input.createdAt, 'createdAt'),
      operatorId: identifier(input.operatorId, 'operatorId'),
      reason: identifier(input.reason, 'reason')
    });
  }
  function computeReturnableMicroUnits(originalMicroUnits, previouslyReturnedMicroUnits) {
    const original = asBigInt(originalMicroUnits, 'originalMicroUnits');
    const returned = asBigInt(previouslyReturnedMicroUnits, 'previouslyReturnedMicroUnits');
    if (original < 0n || returned < 0n || returned > original) throw new Error('invalid return quantity ceiling');
    return original - returned;
  }
  function getInvoices(state) {
    return [
      ...(Array.isArray(state.invoices) ? state.invoices.map(x => ({ row:x, type:'sales_invoice', partyId:String(x.customerId ?? x.customerObj?.id ?? '') })) : []),
      ...(Array.isArray(state.purchases) ? state.purchases.map(x => ({ row:x, type:'purchase_invoice', partyId:String(x.supplierId ?? x.supplier?.id ?? '') })) : [])
    ];
  }
  function getSourceMovement(state, allocation) {
    const id = String(allocation.sourceMovementId);
    let rows = [];
    if (allocation.partyType === 'customer' && allocation.sourceMovementType === 'customer_debt')
      rows = (state.cashMovements || []).filter(x => String(recordId(x)) === id && x.referenceType === 'customer_debt');
    else if (allocation.partyType === 'supplier' && allocation.sourceMovementType === 'supplier_payment')
      rows = (state.supplierMovements || []).filter(x => String(recordId(x)) === id && x.type === 'payment');
    else if (allocation.sourceMovementType === 'sales_invoice' || allocation.sourceMovementType === 'purchase_invoice')
      rows = (state.cashMovements || []).filter(x => String(recordId(x)) === id && x.referenceType === allocation.sourceMovementType);
    else throw new Error('unsupported allocation source movement type');
    if (rows.length !== 1) throw new Error('allocation source movement missing or ambiguous');
    return rows[0];
  }
  function sourceAmountCentimes(source) {
    if (Number.isSafeInteger(source.amountCentimes) && source.amountCentimes >= 0) return BigInt(source.amountCentimes);
    return currencyToCentimes(source.amount ?? source.amt, 'source movement amount');
  }
  function invoiceAmountCentimes(invoice, field, label) {
    if (Number.isSafeInteger(invoice[field + 'Centimes']) && invoice[field + 'Centimes'] >= 0)
      return BigInt(invoice[field + 'Centimes']);
    return currencyToCentimes(invoice[field], label);
  }
  function validateSettlementAllocations(state) {
    const data = ensureCollections(state);
    const invoices = getInvoices(data);
    const allocationIds = new Set();
    const invoiceTotals = new Map();
    const sourceTotals = new Map();
    const sourceRecords = new Map();
    for (const a of data.settlementAllocations) {
      if (!a || typeof a !== 'object' || a.ledgerVersion !== 2) throw new Error('invalid version-2 settlement allocation');
      const allocationId = identifier(a.allocationId, 'allocationId');
      if (allocationIds.has(allocationId)) throw new Error('duplicate allocationId');
      allocationIds.add(allocationId);
      if (!PARTY_TYPES.includes(a.partyType) || !['sales_invoice','purchase_invoice'].includes(a.invoiceType) ||
          ((a.partyType === 'customer') !== (a.invoiceType === 'sales_invoice')))
        throw new Error('settlement allocation party/invoice type mismatch');
      const matches = invoices.filter(x => String(x.row.id) === String(a.invoiceId) && x.type === a.invoiceType);
      if (matches.length !== 1) throw new Error('orphan or ambiguous settlement allocation invoice');
      const invoice = matches[0];
      if (!invoice.partyId || invoice.partyId !== String(a.partyId)) throw new Error('allocation party does not match invoice');
      const amount = BigInt(safeInt(a.amountCentimes, 'allocation amount', false));
      const invKey = a.invoiceType + ':' + a.invoiceId;
      invoiceTotals.set(invKey, (invoiceTotals.get(invKey) || 0n) + amount);
      const source = getSourceMovement(data, a);
      const sourceKey = a.partyType + ':' + a.sourceMovementType + ':' + a.sourceMovementId;
      sourceRecords.set(sourceKey, source);
      sourceTotals.set(sourceKey, (sourceTotals.get(sourceKey) || 0n) + amount);
    }
    for (const [key, total] of invoiceTotals) {
      const [type, ...rest] = key.split(':');
      const invoiceId = rest.join(':');
      const invoice = invoices.find(x => x.type === type && String(x.row.id) === invoiceId)?.row;
      if (!invoice || !own(invoice, 'paid')) throw new Error('allocated invoice has no verifiable paid amount');
      if (total > invoiceAmountCentimes(invoice, 'paid', 'invoice paid amount'))
        throw new Error('invoice allocations exceed paid centime amount');
    }
    for (const [key, total] of sourceTotals) {
      const source = sourceRecords.get(key);
      if (total > sourceAmountCentimes(source)) throw new Error('allocations exceed source movement amount');
    }
    return true;
  }
  function validateClientMovements(state) {
    const rows = state.clientMovements || [];
    const clients = state.customers || [];
    const seen = new Set();
    const totals = new Map();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || row.ledgerVersion !== 2) throw new Error('invalid version-2 client movement');
      const movementId = identifier(row.movementId, 'client movement ID');
      if (seen.has(movementId)) throw new Error('duplicate client movement ID');
      seen.add(movementId);
      const clientId = identifier(row.clientId, 'client ID');
      const clientMatches = clients.filter(x => String(x.id) === clientId);
      if (clientMatches.length !== 1) throw new Error('orphan or ambiguous client movement');
      if (!['debit','credit'].includes(row.direction)) throw new Error('invalid client movement direction');
      const amount = BigInt(safeInt(row.amountCentimes, 'client movement amount', false));
      const key = clientId;
      totals.set(key, (totals.get(key) || 0n) + (row.direction === 'debit' ? amount : -amount));
      identifier(row.referenceType, 'client movement reference type');
      identifier(row.referenceId, 'client movement reference ID');
      identifier(row.createdAt, 'client movement timestamp');
    }
    for (const [clientId, balance] of totals) {
      const client = clients.find(x => String(x.id) === clientId);
      if (client.ledgerVersion !== 2) throw new Error('client ledger movements exist without a version-2 opening reconciliation');
      if (balance < 0n || balance !== currencyToCentimes(client.debt ?? 0, 'customer debt'))
        throw new Error('client movement ledger does not match customer debt');
    }
    for (const client of clients) {
      if (client.ledgerVersion === 2 && !totals.has(String(client.id))) {
        if (currencyToCentimes(client.debt ?? 0, 'customer debt') !== 0n)
          throw new Error('version-2 customer debt has no client ledger movements');
      }
    }
    return true;
  }
  function invoiceItemProductId(item) {
    return String(item.productId ?? item.id ?? item.product?.id ?? '');
  }
  function originalInvoiceItems(invoice, invoiceType) {
    if (Array.isArray(invoice.items)) return invoice.items;
    if (invoiceType === 'purchase_invoice' && invoice.productId != null) {
      return [{
        productId: invoice.productId,
        qty: invoice.qty,
        price: invoice.cost ?? invoice.unitCost ?? invoice.buyPrice
      }];
    }
    return [];
  }
  function validateReturns(state) {
    const docs = (state.returns || []).filter(x => x && x.ledgerVersion === 2);
    const invoices = getInvoices(state);
    const ids = new Set();
    const postedQuantities = new Map();
    const stockRows = state.stockMovements || [];
    const cashRows = state.cashMovements || [];
    const clientRows = state.clientMovements || [];
    const supplierRows = state.supplierMovements || [];
    for (const doc of docs) {
      const returnId = identifier(doc.returnId, 'return ID');
      if (ids.has(returnId)) throw new Error('duplicate return ID');
      ids.add(returnId);
      if (!['DRAFT','POSTED','REJECTED'].includes(doc.status)) throw new Error('invalid return status');
      if (!['sales_invoice','purchase_invoice'].includes(doc.originalInvoiceType)) throw new Error('invalid original invoice type');
      const matches = invoices.filter(x => x.type === doc.originalInvoiceType && String(x.row.id) === String(doc.originalInvoiceId));
      if (matches.length !== 1) throw new Error('orphan or ambiguous return invoice');
      const invoice = matches[0].row;
      const expectedType = doc.returnType === 'SALE_RETURN' ? 'sales_invoice' :
        doc.returnType === 'PURCHASE_RETURN' ? 'purchase_invoice' : doc.originalInvoiceType;
      if (!RETURN_TYPES.includes(doc.returnType) || expectedType !== doc.originalInvoiceType)
        throw new Error('return type does not match original invoice');
      if (!Array.isArray(doc.items) || !doc.items.length) throw new Error('return items are missing');
      const seenProducts = new Set();
      let lineTotal = 0n;
      for (const item of doc.items) {
        const productId = identifier(item.productId, 'return product ID');
        if (seenProducts.has(productId)) throw new Error('duplicate return product line');
        seenProducts.add(productId);
        const qty = BigInt(safeInt(item.quantityMicroUnits, 'return quantity', false));
        const price = BigInt(safeInt(item.unitPriceCentimes, 'return unit price', true));
        const line = BigInt(safeInt(item.lineTotalCentimes, 'return line total', true));
        const product = qty * price;
        if (product % 1000000n !== 0n || product / 1000000n !== line)
          throw new Error('return line amount does not match exact quantity and price');
        lineTotal += line;
        if (doc.status === 'POSTED') {
          const originalItems = originalInvoiceItems(invoice, doc.originalInvoiceType);
          const originalMatches = originalItems.filter(x => invoiceItemProductId(x) === productId);
          if (originalMatches.length !== 1) throw new Error('return item is missing or ambiguous in original invoice');
          const originalQty = quantityToMicroUnits(originalMatches[0].qty ?? originalMatches[0].quantity, 'original invoice quantity');
          const originalPrice = currencyToCentimes(originalMatches[0].price ?? originalMatches[0].unitPrice, 'original invoice unit price');
          if (price > originalPrice) throw new Error('return unit price exceeds original invoice unit price');
          if (doc.returnType === 'INVOICE_CANCEL' && price !== originalPrice)
            throw new Error('invoice cancellation must reverse the original unit price');
          const key = doc.originalInvoiceType + ':' + doc.originalInvoiceId + ':' + productId;
          const before = postedQuantities.get(key) || 0n;
          const next = before + qty;
          if (next > originalQty) throw new Error('return exceeds remaining returnable micro-units');
          postedQuantities.set(key, next);
        }
      }
      if (lineTotal !== BigInt(safeInt(doc.totalCentimes, 'return total', true)))
        throw new Error('return total does not match item totals');
      const debt = BigInt(safeInt(doc.debtReductionCentimes, 'debt reduction', true));
      const cash = BigInt(safeInt(doc.cashRefundCentimes, 'cash refund', true));
      const supplierCredit = BigInt(safeInt(doc.supplierCreditCentimes ?? 0, 'supplier credit', true));
      if (doc.originalInvoiceType === 'sales_invoice' && supplierCredit !== 0n)
        throw new Error('sales return cannot create supplier credit');
      const settled = debt + cash + supplierCredit;
      if (settled > lineTotal) throw new Error('return settlement exceeds return value');
      if (doc.status === 'POSTED' && settled !== lineTotal)
        throw new Error('posted return settlement must equal return value');
      if (doc.status !== 'POSTED') continue;
      if (!Array.isArray(doc.stockMovementIds) || doc.stockMovementIds.length !== doc.items.length)
        throw new Error('posted return must reference one stock movement per item');
      const expectedRef = doc.returnType === 'INVOICE_CANCEL' ? 'invoice_cancel' :
        doc.returnType === 'SALE_RETURN' ? 'sales_return' : 'purchase_return';
      for (let i = 0; i < doc.stockMovementIds.length; i++) {
        const matchesStock = stockRows.filter(x => String(recordId(x)) === String(doc.stockMovementIds[i]));
        if (matchesStock.length !== 1 || matchesStock[0].referenceType !== expectedRef ||
            String(matchesStock[0].referenceId) !== returnId ||
            String(matchesStock[0].productId) !== String(doc.items[i].productId))
          throw new Error('posted return stock movement is missing or mismatched');
        const rawQty = matchesStock[0].qty ?? matchesStock[0].quantity;
        const numericQty = Number(rawQty);
        const expectedSign = doc.originalInvoiceType === 'sales_invoice' ? 1 : -1;
        if (!Number.isFinite(numericQty) || numericQty === 0 || Math.sign(numericQty) !== expectedSign)
          throw new Error('posted return stock movement has an invalid direction');
        const movementQty = quantityToMicroUnits(String(Math.abs(numericQty)), 'return stock movement quantity');
        if (movementQty !== BigInt(doc.items[i].quantityMicroUnits))
          throw new Error('posted return stock quantity does not match return document');
      }
      const financialIds = Array.isArray(doc.financialMovementIds) ? doc.financialMovementIds : [];
      if (settled > 0n && !financialIds.length) throw new Error('posted return is missing financial movements');
      if (new Set(financialIds.map(String)).size !== financialIds.length)
        throw new Error('posted return has duplicate financial movement references');
      const financialRows = [...cashRows, ...clientRows, ...supplierRows];
      let financialTotal = 0n;
      for (const movementId of financialIds) {
        const matchesMovement = financialRows.filter(x => String(recordId(x)) === String(movementId));
        if (matchesMovement.length !== 1 || matchesMovement[0].referenceType !== expectedRef ||
            String(matchesMovement[0].referenceId) !== returnId)
          throw new Error('posted return financial movement is missing or mismatched');
        financialTotal += sourceAmountCentimes(matchesMovement[0]);
      }
      if (financialTotal !== settled)
        throw new Error('posted return financial movements do not equal its settlement split');
      if (doc.returnType === 'INVOICE_CANCEL') {
        if (docs.some(other => other !== doc && other.status === 'POSTED' &&
            other.originalInvoiceType === doc.originalInvoiceType && String(other.originalInvoiceId) === String(doc.originalInvoiceId)))
          throw new Error('invoice cancellation cannot follow a prior posted return');
        const originalItems = originalInvoiceItems(invoice, doc.originalInvoiceType);
        if (!originalItems.length || doc.items.length !== originalItems.length) throw new Error('invoice cancellation must reverse every invoice line');
        for (const original of originalItems) {
          const line = doc.items.find(x => x.productId === invoiceItemProductId(original));
          if (!line || BigInt(line.quantityMicroUnits) !== quantityToMicroUnits(original.qty ?? original.quantity, 'original invoice quantity'))
            throw new Error('invoice cancellation must reverse the full original quantity');
        }
      }
    }
    return true;
  }
  function validateReverseLedgerParity(state) {
    const data = ensureCollections(state);
    validateClientMovements(data);
    validateSettlementAllocations(data);
    validateReturns(data);
    return true;
  }
  function sealVersion2Record(state, collectionName, record) {
    const data = ensureCollections(state);
    if (!['clientMovements','settlementAllocations','returns'].includes(collectionName))
      throw new Error('unsupported version-2 ledger collection');
    const candidateRecord = { ...record, ledgerVersion: 2 };
    const candidate = {
      ...data,
      [collectionName]: [...data[collectionName], candidateRecord]
    };
    validateReverseLedgerParity(candidate);
    return Object.freeze(candidateRecord);
  }
  function sealClientMovement(state, input) {
    return sealVersion2Record(state, 'clientMovements', makeClientMovement(input));
  }
  function sealSettlementAllocation(state, input) {
    return sealVersion2Record(state, 'settlementAllocations', makeSettlementAllocation(input));
  }
  function sealReturnDocument(state, input) {
    return sealVersion2Record(state, 'returns', makeReturnDocument(input));
  }
  function appendUnique(list, record, key) {
    if (!Array.isArray(list)) throw new Error('target ledger must be an array');
    if (list.some(x => String(x && x[key]) === String(record[key]))) throw new Error('duplicate ' + key);
    return [...list, clone(record)];
  }
  return Object.freeze({
    ensureCollections, makeClientMovement, makeSettlementAllocation, makeReturnDocument,
    sealClientMovement, sealSettlementAllocation, sealReturnDocument,
    computeReturnableMicroUnits, validateSettlementAllocations, validateClientMovements,
    validateReturns, validateReverseLedgerParity, appendUnique, RETURN_TYPES, PARTY_TYPES
  });
});
