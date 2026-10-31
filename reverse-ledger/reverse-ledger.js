'use strict';
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    const browserApi = { ...api };
    delete browserApi.executeReturnTransaction;
    root.ANASReverseLedger = Object.freeze(browserApi);
  }
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
    const names = ['clientMovements', 'settlementAllocations', 'returns', 'customerCreditMovements'];
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
    const customerCreditCentimes = safeInt(input.customerCreditCentimes ?? 0, 'customerCreditCentimes', true);
    if (input.originalInvoiceType === 'sales_invoice' && supplierCreditCentimes !== 0)
      throw new Error('sales return cannot create supplier credit');
    if (input.originalInvoiceType === 'purchase_invoice' && customerCreditCentimes !== 0)
      throw new Error('purchase return cannot create customer credit');
    const settled = BigInt(debtReductionCentimes) + BigInt(cashRefundCentimes) + BigInt(supplierCreditCentimes) + BigInt(customerCreditCentimes);
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
      customerCreditCentimes,
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
    if (allocation.partyType === 'customer' && allocation.sourceMovementType === 'customer_debt') {
      rows = (state.cashMovements || []).filter(x => String(recordId(x)) === id &&
        x.referenceType === 'customer_debt' && String(x.referenceId) === String(allocation.partyId));
    } else if (allocation.partyType === 'supplier' && allocation.sourceMovementType === 'supplier_payment') {
      rows = (state.supplierMovements || []).filter(x => String(recordId(x)) === id &&
        x.type === 'payment' && x.referenceType === 'supplier_payment' &&
        String(x.supplierId) === String(allocation.partyId) && String(x.referenceId) === id);
    } else if (allocation.partyType === 'customer' && allocation.sourceMovementType === 'sales_invoice') {
      rows = (state.cashMovements || []).filter(x => String(recordId(x)) === id &&
        x.referenceType === 'sales_invoice' && String(x.referenceId) === String(allocation.invoiceId));
    } else if (allocation.partyType === 'supplier' && allocation.sourceMovementType === 'purchase_invoice') {
      rows = (state.supplierMovements || []).filter(x => String(recordId(x)) === id &&
        x.type === 'payment' && x.referenceType === 'purchase_invoice' &&
        String(x.supplierId) === String(allocation.partyId) && String(x.referenceId) === String(allocation.invoiceId));
    } else {
      throw new Error('unsupported allocation source movement type');
    }
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
    const invoiceInitialPaymentTotals = new Map();
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
      const initialSourceType = a.invoiceType === 'sales_invoice' ? 'sales_invoice' : 'purchase_invoice';
      if (a.sourceMovementType === initialSourceType)
        invoiceInitialPaymentTotals.set(invKey, (invoiceInitialPaymentTotals.get(invKey) || 0n) + amount);
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
      const initialPaid = invoiceAmountCentimes(invoice, 'paid', 'invoice paid amount');
      const invoiceCeiling = own(invoice, 'total')
        ? invoiceAmountCentimes(invoice, 'total', 'invoice total amount') : initialPaid;
      const initialLinked = invoiceInitialPaymentTotals.get(key) || 0n;
      if (initialLinked > initialPaid)
        throw new Error('invoice-linked initial allocations exceed original paid centime amount');
      if (total > invoiceCeiling)
        throw new Error('invoice allocations exceed original invoice total centime amount');
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
      if (!['opening_balance', 'invoice_debit', 'receipt', 'return_credit', 'adjustment'].includes(row.type))
        throw new Error('unsupported client movement type');
      const movementId = identifier(row.movementId, 'client movement ID');
      if (seen.has(movementId)) throw new Error('duplicate client movement ID');
      seen.add(movementId);
      const clientId = identifier(row.clientId, 'client ID');
      const clientMatches = clients.filter(x => String(x.id) === clientId);
      if (clientMatches.length !== 1) throw new Error('orphan or ambiguous client movement');
      if (!['debit','credit'].includes(row.direction)) throw new Error('invalid client movement direction');
      const expectedDirection = row.type === 'opening_balance' || row.type === 'invoice_debit' ? 'debit' :
        row.type === 'receipt' || row.type === 'return_credit' ? 'credit' : null;
      if (expectedDirection && row.direction !== expectedDirection)
        throw new Error('client movement direction does not match movement type');
      const amount = BigInt(safeInt(row.amountCentimes, 'client movement amount', false));
      const key = clientId;
      totals.set(key, (totals.get(key) || 0n) + (row.direction === 'debit' ? amount : -amount));
      const referenceType = identifier(row.referenceType, 'client movement reference type');
      const referenceId = identifier(row.referenceId, 'client movement reference ID');
      identifier(row.createdAt, 'client movement timestamp');
      if (row.type === 'opening_balance' && (referenceType !== 'opening_balance' || referenceId !== clientId))
        throw new Error('client opening balance reference is invalid');
      if (row.type === 'receipt' && (referenceType !== 'customer_debt' || referenceId !== clientId))
        throw new Error('client receipt reference is invalid');
      if (row.type === 'invoice_debit') {
        const linked = (state.invoices || []).filter(x => String(x.id) === referenceId &&
          String(x.customerId ?? x.customerObj?.id ?? '') === clientId);
        if (referenceType !== 'sales_invoice' || linked.length !== 1)
          throw new Error('client invoice debit references a missing or mismatched invoice');
      }
      if (row.type === 'return_credit') {
        const linked = (state.returns || []).filter(x => x && x.ledgerVersion === 2 &&
          x.status === 'POSTED' && ['SALE_RETURN','INVOICE_CANCEL'].includes(x.returnType) &&
          x.originalInvoiceType === 'sales_invoice' && String(x.returnId) === referenceId);
        const expectedReference = linked.length === 1 && linked[0].returnType === 'INVOICE_CANCEL' ? 'invoice_cancel' : 'sales_return';
        if (referenceType !== expectedReference || linked.length !== 1)
          throw new Error('client return credit references a missing or mismatched return');
      }
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
    const customerCreditRows = state.customerCreditMovements || [];
    const customerCreditTotals = new Map();
    const supplierCreditTotals = new Map();
    const referencedCustomerCreditIds = new Set();
    const referencedStockMovementIds = new Set();
    const referencedFinancialMovementIds = new Set();
    for (const posted of docs) {
      if (posted.status !== 'POSTED' || !Array.isArray(posted.items)) continue;
      for (const item of posted.items) {
        const productId = identifier(item.productId, 'return product ID');
        const quantity = BigInt(safeInt(item.quantityMicroUnits, 'return quantity', false));
        const key = posted.originalInvoiceType + ':' + posted.originalInvoiceId + ':' + productId;
        postedQuantities.set(key, (postedQuantities.get(key) || 0n) + quantity);
      }
    }
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
        const originalItems = originalInvoiceItems(invoice, doc.originalInvoiceType);
        const originalMatches = originalItems.filter(x => invoiceItemProductId(x) === productId);
        if (originalMatches.length !== 1) throw new Error('return item is missing or ambiguous in original invoice');
        const originalQty = quantityToMicroUnits(originalMatches[0].qty ?? originalMatches[0].quantity, 'original invoice quantity');
        const originalPrice = currencyToCentimes(originalMatches[0].price ?? originalMatches[0].unitPrice, 'original invoice unit price');
        if (price > originalPrice) throw new Error('return unit price exceeds original invoice unit price');
        if (doc.returnType === 'INVOICE_CANCEL' && price !== originalPrice)
          throw new Error('invoice cancellation must reverse the original unit price');
        const key = doc.originalInvoiceType + ':' + doc.originalInvoiceId + ':' + productId;
        const postedTotal = postedQuantities.get(key) || 0n;
        if (postedTotal > originalQty || (doc.status !== 'POSTED' && postedTotal + qty > originalQty))
          throw new Error('return exceeds remaining returnable micro-units');
      }
      if (lineTotal !== BigInt(safeInt(doc.totalCentimes, 'return total', true)))
        throw new Error('return total does not match item totals');
      const debt = BigInt(safeInt(doc.debtReductionCentimes, 'debt reduction', true));
      const cash = BigInt(safeInt(doc.cashRefundCentimes, 'cash refund', true));
      const supplierCredit = BigInt(safeInt(doc.supplierCreditCentimes ?? 0, 'supplier credit', true));
      const customerCredit = BigInt(safeInt(doc.customerCreditCentimes ?? 0, 'customer credit', true));
      if (doc.originalInvoiceType === 'sales_invoice' && supplierCredit !== 0n)
        throw new Error('sales return cannot create supplier credit');
      if (doc.originalInvoiceType === 'purchase_invoice' && customerCredit !== 0n)
        throw new Error('purchase return cannot create customer credit');
      const settled = debt + cash + supplierCredit + customerCredit;
      if (settled > lineTotal) throw new Error('return settlement exceeds return value');
      if (doc.status === 'POSTED' && settled !== lineTotal)
        throw new Error('posted return settlement must equal return value');
      if (doc.returnType === 'INVOICE_CANCEL') {
        if (docs.some(other => other !== doc && other.status === 'POSTED' &&
            other.originalInvoiceType === doc.originalInvoiceType && String(other.originalInvoiceId) === String(doc.originalInvoiceId)))
          throw new Error('invoice cancellation cannot follow a prior posted return');
        const originalItems = originalInvoiceItems(invoice, doc.originalInvoiceType);
        if (!originalItems.length || doc.items.length !== originalItems.length)
          throw new Error('invoice cancellation must reverse every invoice line');
        for (const original of originalItems) {
          const line = doc.items.find(x => x.productId === invoiceItemProductId(original));
          if (!line || BigInt(line.quantityMicroUnits) !== quantityToMicroUnits(original.qty ?? original.quantity, 'original invoice quantity'))
            throw new Error('invoice cancellation must reverse the full original quantity');
        }
      }
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
        const expectedMovementType = expectedSign > 0 ? 'RETURN_IN' : 'RETURN_OUT';
        if (!Number.isFinite(numericQty) || numericQty === 0 || Math.sign(numericQty) !== expectedSign || matchesStock[0].type !== expectedMovementType)
          throw new Error('posted return stock movement has an invalid direction or movement type');
        const movementQty = quantityToMicroUnits(String(Math.abs(numericQty)), 'return stock movement quantity');
        if (movementQty !== BigInt(doc.items[i].quantityMicroUnits))
          throw new Error('posted return stock quantity does not match return document');
        referencedStockMovementIds.add(String(recordId(matchesStock[0])));
      }
      const financialIds = Array.isArray(doc.financialMovementIds) ? doc.financialMovementIds : [];
      if (settled > 0n && !financialIds.length) throw new Error('posted return is missing financial movements');
      if (new Set(financialIds.map(String)).size !== financialIds.length)
        throw new Error('posted return has duplicate financial movement references');
      const financialRows = doc.originalInvoiceType === 'sales_invoice'
        ? [...cashRows, ...clientRows, ...customerCreditRows] : [...cashRows, ...supplierRows];
      // Every movement posted under this return reference must be listed by the return document.
      // Otherwise a forged/unlinked ledger row could alter cash or party balances without parity failure.
      const linkedFinancialRows = financialRows.filter(x =>
        x && x.referenceType === expectedRef && String(x.referenceId) === returnId);
      const linkedFinancialIds = linkedFinancialRows.map(x => String(recordId(x)));
      if (linkedFinancialIds.some(id => !id || id === 'undefined' || id === 'null') ||
          new Set(linkedFinancialIds).size !== linkedFinancialIds.length ||
          linkedFinancialIds.length !== financialIds.length ||
          linkedFinancialIds.some(id => !financialIds.map(String).includes(id)))
        throw new Error('posted return has unreferenced or ambiguous financial movements');
      const invoicePartyId = matches[0].partyId;
      const linkedCash = cashRows.filter(x => x && x.referenceType === expectedRef && String(x.referenceId) === returnId);
      if ((cash > 0n && (linkedCash.length !== 1 || linkedCash[0].type !== (doc.originalInvoiceType === 'sales_invoice' ? 'subtract' : 'add') || sourceAmountCentimes(linkedCash[0]) !== cash)) ||
          (cash === 0n && linkedCash.length !== 0))
        throw new Error('posted return cash movement does not match its cash settlement');
      if (doc.originalInvoiceType === 'sales_invoice') {
        const linkedDebt = clientRows.filter(x => x && x.referenceType === expectedRef && String(x.referenceId) === returnId && x.type === 'return_credit');
        const linkedCredit = customerCreditRows.filter(x => x && x.referenceType === expectedRef && String(x.referenceId) === returnId);
        if ((debt > 0n && (linkedDebt.length !== 1 || linkedDebt[0].direction !== 'credit' || String(linkedDebt[0].clientId) !== invoicePartyId || BigInt(safeInt(linkedDebt[0].amountCentimes, 'return debt movement', false)) !== debt)) ||
            (debt === 0n && linkedDebt.length !== 0))
          throw new Error('posted sale return debt movement does not match its debt reduction');
        if ((customerCredit > 0n && (linkedCredit.length !== 1 || linkedCredit[0].type !== 'credit' || String(linkedCredit[0].customerId) !== invoicePartyId || BigInt(safeInt(linkedCredit[0].amountCentimes, 'customer credit movement', false)) !== customerCredit)) ||
            (customerCredit === 0n && linkedCredit.length !== 0))
          throw new Error('posted sale return customer credit movement does not match its credit balance');
        if (customerCredit > 0n) {
          if (!invoicePartyId) throw new Error('customer credit return requires a registered customer');
          customerCreditTotals.set(invoicePartyId, (customerCreditTotals.get(invoicePartyId) || 0n) + customerCredit);
          for (const row of linkedCredit) referencedCustomerCreditIds.add(String(recordId(row)));
        }
      } else {
        const linkedSupplier = supplierRows.filter(x => x && x.referenceType === expectedRef && String(x.referenceId) === returnId && x.type === 'return_credit');
        const supplierMovementTotal = debt + supplierCredit;
        if ((supplierMovementTotal > 0n && (linkedSupplier.length !== 1 || String(linkedSupplier[0].supplierId) !== invoicePartyId || sourceAmountCentimes(linkedSupplier[0]) !== supplierMovementTotal)) ||
            (supplierMovementTotal === 0n && linkedSupplier.length !== 0))
          throw new Error('posted purchase return supplier movement does not match debt and supplier credit');
        if (supplierCredit > 0n) {
          if (!invoicePartyId) throw new Error('supplier credit return requires a registered supplier');
          supplierCreditTotals.set(invoicePartyId, (supplierCreditTotals.get(invoicePartyId) || 0n) + supplierCredit);
        }
      }
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
      for (const id of financialIds) referencedFinancialMovementIds.add(String(id));

    }
    const returnReferenceTypes = new Set(['sales_return','purchase_return','invoice_cancel']);
    for (const movement of stockRows) {
      if (movement && returnReferenceTypes.has(String(movement.referenceType || '')) &&
          !referencedStockMovementIds.has(String(recordId(movement))))
        throw new Error('orphan stock movement references a missing return document');
    }
    for (const movement of [...cashRows,...supplierRows,...clientRows,...customerCreditRows]) {
      if (movement && returnReferenceTypes.has(String(movement.referenceType || '')) &&
          !referencedFinancialMovementIds.has(String(recordId(movement))))
        throw new Error('orphan financial movement references a missing return document');
    }
    const creditMovementIds = new Set();
    for (const movement of customerCreditRows) {
      const id = String(recordId(movement) ?? '');
      if (!id || id === 'undefined' || id === 'null' || creditMovementIds.has(id) || !referencedCustomerCreditIds.has(id) ||
          movement.type !== 'credit' || !Number.isSafeInteger(movement.amountCentimes) || movement.amountCentimes <= 0)
        throw new Error('orphan, duplicate or malformed customer credit movement');
      creditMovementIds.add(id);
    }
    if (creditMovementIds.size !== referencedCustomerCreditIds.size)
      throw new Error('customer credit movement references are incomplete');
    for (const invoice of invoices) {
      const cancellation = docs.filter(doc => doc.status === 'POSTED' && doc.returnType === 'INVOICE_CANCEL' &&
        doc.originalInvoiceType === invoice.type && String(doc.originalInvoiceId) === String(invoice.row.id));
      if (cancellation.length > 1 || (invoice.row.status === 'CANCELLED') !== (cancellation.length === 1))
        throw new Error('invoice cancellation status does not match its posted cancellation document');
    }
    for (const customer of (state.customers || [])) {
      const expected = customerCreditTotals.get(String(customer.id)) || 0n;
      const actual = BigInt(safeInt(customer.creditBalanceCentimes ?? 0, 'customer credit balance', true));
      if (actual !== expected) throw new Error('customer credit balance does not match posted return credits');
    }
    for (const supplier of (state.suppliers || [])) {
      const expected = supplierCreditTotals.get(String(supplier.id)) || 0n;
      const actual = BigInt(safeInt(supplier.creditBalanceCentimes ?? 0, 'supplier credit balance', true));
      if (actual !== expected) throw new Error('supplier credit balance does not match posted return credits');
    }
    return true;
  }
  function executeReturnTransaction(state, input, options = {}) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('state must be an object');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('return request is required');
    const originalInvoiceType = input.originalInvoiceType;
    const returnType = input.returnType;
    if (!['sales_invoice','purchase_invoice'].includes(originalInvoiceType) ||
        !['SALE_RETURN','PURCHASE_RETURN','INVOICE_CANCEL'].includes(returnType))
      throw new Error('return type and original invoice type are invalid');
    if ((returnType === 'SALE_RETURN' && originalInvoiceType !== 'sales_invoice') ||
        (returnType === 'PURCHASE_RETURN' && originalInvoiceType !== 'purchase_invoice'))
      throw new Error('return type does not match invoice type');
    if (!Array.isArray(state.invoices) || !Array.isArray(state.purchases) ||
        !Array.isArray(state.products) || !Array.isArray(state.customers) || !Array.isArray(state.suppliers))
      throw new Error('required invoice, product, customer or supplier collections are malformed');
    const invoiceRows = getInvoices(state).filter(x => x.type === originalInvoiceType && String(x.row.id) === String(input.invoiceId));
    if (invoiceRows.length !== 1) throw new Error('original invoice is missing or ambiguous');
    const invoice = invoiceRows[0].row;
    if (invoice.status === 'CANCELLED') throw new Error('invoice is already cancelled');
    validateReverseLedgerParity(state);

    const total = currencyToCentimes(invoice.total, 'original invoice total');
    const paid = currencyToCentimes(invoice.paid, 'original invoice paid amount');
    const originalRemaining = currencyToCentimes(invoice.remaining, 'original invoice remaining amount');
    if (total <= 0n || paid < 0n || originalRemaining < 0n || paid + originalRemaining !== total ||
        total > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('original invoice financial snapshot is invalid');
    const partyType = originalInvoiceType === 'sales_invoice' ? 'customer' : 'supplier';
    const partyId = invoiceRows[0].partyId;
    const partyRows = partyType === 'customer' ? state.customers : state.suppliers;
    const partyMatches = partyId ? partyRows.filter(x => String(x.id) === partyId) : [];
    if (partyId && partyMatches.length !== 1) throw new Error('invoice party is missing or ambiguous');
    const party = partyMatches[0] || null;
    const laterType = partyType === 'customer' ? 'customer_debt' : 'supplier_payment';
    const allocations = Array.isArray(state.settlementAllocations) ? state.settlementAllocations : [];
    const movements = partyType === 'customer' ? (state.cashMovements || []) : (state.supplierMovements || []);
    const laterMovements = movements.filter(row => partyType === 'customer'
      ? row && row.referenceType === 'customer_debt' && String(row.referenceId) === partyId
      : row && row.type === 'payment' && row.referenceType === 'supplier_payment' && String(row.supplierId) === partyId);
    for (const movement of laterMovements) {
      const sourceId = recordId(movement);
      if (sourceId == null || String(sourceId).trim() === '') throw new Error('unallocated subsequent settlement has no movement ID');
      const sourceAmount = currencyToCentimes(movement.amount ?? movement.amt, 'subsequent settlement amount');
      const allocated = allocations.filter(a => a && a.partyType === partyType &&
        String(a.partyId) === partyId && a.sourceMovementType === laterType &&
        String(a.sourceMovementId) === String(sourceId))
        .reduce((sum,a) => sum + BigInt(safeInt(a.amountCentimes, 'settlement allocation amount', false)), 0n);
      if (allocated !== sourceAmount) throw new Error('unallocated subsequent settlements block this return or cancellation');
    }
    if (partyType === 'customer' && party && party.ledgerVersion !== 2 &&
        (state.clientMovements || []).some(row => row && String(row.clientId) === partyId))
      throw new Error('legacy customer movement rows are not sealed; manual reconciliation is required before return');
    const laterAllocations = allocations.filter(a => a && a.partyType === partyType &&
      String(a.partyId) === partyId && a.invoiceType === originalInvoiceType &&
      String(a.invoiceId) === String(invoice.id) && a.sourceMovementType === laterType)
      .reduce((sum,a) => sum + BigInt(safeInt(a.amountCentimes, 'invoice settlement allocation', false)), 0n);
    const outstanding = total - paid - laterAllocations;
    if (outstanding < 0n) throw new Error('invoice settlement allocations exceed its original outstanding amount');

    const originalItems = originalInvoiceItems(invoice, originalInvoiceType);
    if (!originalItems.length) throw new Error('original invoice has no verifiable product lines');
    if (originalInvoiceType === 'sales_invoice' && currencyToCentimes(invoice.discount ?? 0, 'invoice discount') !== 0n)
      throw new Error('returns for discounted sales invoices require a verified discount-allocation policy');
    const previousReturns = (state.returns || []).filter(doc => doc && doc.ledgerVersion === 2 &&
      doc.status === 'POSTED' && doc.originalInvoiceType === originalInvoiceType &&
      String(doc.originalInvoiceId) === String(invoice.id));
    if (returnType === 'INVOICE_CANCEL' && previousReturns.length)
      throw new Error('invoice cancellation is blocked after any posted partial return');
    if (returnType !== 'INVOICE_CANCEL' && previousReturns.some(doc => doc.returnType === 'INVOICE_CANCEL'))
      throw new Error('invoice is already reversed by a cancellation document');

    const requestedLines = returnType === 'INVOICE_CANCEL'
      ? originalItems.map(row => ({ productId: invoiceItemProductId(row), quantity: row.qty ?? row.quantity }))
      : input.items;
    if (!Array.isArray(requestedLines) || !requestedLines.length) throw new Error('return item quantities are required');
    const seenProducts = new Set();
    const lines = [];
    let totalCentimes = 0n;
    for (const requestLine of requestedLines) {
      if (!requestLine || typeof requestLine !== 'object' || Array.isArray(requestLine))
        throw new Error('return line is invalid');
      const productId = identifier(requestLine.productId, 'return product ID');
      if (seenProducts.has(productId)) throw new Error('duplicate product line');
      seenProducts.add(productId);
      const matches = originalItems.filter(row => invoiceItemProductId(row) === productId);
      if (matches.length !== 1) throw new Error('return product is missing or ambiguous in original invoice');
      const originalLine = matches[0];
      const quantity = quantityToMicroUnits(requestLine.quantity ?? requestLine.qty, 'return quantity');
      if (quantity <= 0n || quantity > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('return quantity is invalid');
      const originalQuantity = quantityToMicroUnits(originalLine.qty ?? originalLine.quantity, 'original invoice quantity');
      const previousQuantity = previousReturns.reduce((sum,doc) => sum +
        doc.items.filter(item => String(item.productId) === productId)
          .reduce((subtotal,item) => subtotal + BigInt(safeInt(item.quantityMicroUnits, 'previous return quantity', false)),0n),0n);
      const returnable = computeReturnableMicroUnits(originalQuantity, previousQuantity);
      if (quantity > returnable) throw new Error('return exceeds remaining returnable micro-units');
      if (returnType === 'INVOICE_CANCEL' && quantity !== originalQuantity)
        throw new Error('invoice cancellation must reverse the full original quantity');
      const rawPrice = originalLine.price ?? originalLine.unitPrice ?? originalLine.cost ?? originalLine.buyPrice;
      const unitPrice = currencyToCentimes(rawPrice, 'original invoice unit price');
      const lineProduct = quantity * unitPrice;
      if (lineProduct % 1000000n !== 0n) throw new Error('return line creates a fractional centime; no mutation was performed');
      const lineTotal = lineProduct / 1000000n;
      if (lineTotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('return line exceeds the safe financial range');
      totalCentimes += lineTotal;
      if (totalCentimes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('return total exceeds the safe financial range');
      lines.push({ productId, quantityMicroUnits: Number(quantity), unitPriceCentimes: Number(unitPrice), lineTotalCentimes: Number(lineTotal) });
    }
    if (returnType === 'INVOICE_CANCEL') {
      if (lines.length !== originalItems.length) throw new Error('invoice cancellation must reverse every original invoice line');
      if (totalCentimes !== total) throw new Error('invoice line values do not reconcile to the original invoice total; cancellation is blocked');
    }

    const debtReduction = totalCentimes < outstanding ? totalCentimes : outstanding;
    const excess = totalCentimes - debtReduction;
    const settlementMode = input.settlementMode === 'credit' ? 'credit' : 'cash';
    let cashRefund = 0n, customerCredit = 0n, supplierCredit = 0n;
    if (returnType === 'INVOICE_CANCEL' || settlementMode === 'cash') cashRefund = excess;
    else if (partyType === 'customer') customerCredit = excess;
    else supplierCredit = excess;
    if ((customerCredit > 0n || debtReduction > 0n) && partyType === 'customer' && !party)
      throw new Error('registered customer is required for a debt reduction or customer credit');
    if ((supplierCredit > 0n || debtReduction > 0n) && partyType === 'supplier' && !party)
      throw new Error('registered supplier is required for a debt reduction or supplier credit');

    let partyDebt = 0n, partyCredit = 0n;
    if (party && debtReduction > 0n) {
      partyDebt = currencyToCentimes(partyType === 'customer' ? (party.debt ?? 0) : (party.balance ?? 0), partyType + ' balance');
      if (partyDebt < debtReduction) throw new Error('party balance is lower than the invoice debt reduction');
    }
    if (party && customerCredit > 0n) {
      partyCredit = BigInt(safeInt(party.creditBalanceCentimes ?? 0, 'customer credit balance', true));
      if (partyCredit + customerCredit > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('customer credit balance exceeds safe range');
    }
    if (party && supplierCredit > 0n) {
      partyCredit = BigInt(safeInt(party.creditBalanceCentimes ?? 0, 'supplier credit balance', true));
      if (partyCredit + supplierCredit > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('supplier credit balance exceeds safe range');
    }
    const cashBefore = currencyToCentimes(state.caisseBalance ?? 0, 'cash balance');
    const cashAfter = originalInvoiceType === 'sales_invoice' ? cashBefore - cashRefund : cashBefore + cashRefund;
    if (cashAfter < 0n || cashAfter > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error(originalInvoiceType === 'sales_invoice' ? 'cash balance is insufficient for the refund' : 'cash balance exceeds safe range after supplier refund');

    const warehouse = String(originalInvoiceType === 'sales_invoice'
      ? (invoice.warehouseName || invoice.warehouse || 'المخزن الرئيسي')
      : (invoice.warehouse || 'المخزن الرئيسي')).trim() || 'المخزن الرئيسي';
    const stockDeltas = [];
    for (const line of lines) {
      const products = state.products.filter(row => row && String(row.id) === line.productId);
      if (products.length !== 1) throw new Error('return product is missing or has duplicate product IDs');
      const product = products[0];
      if (Object.prototype.hasOwnProperty.call(product, 'warehouseStock') &&
          (!product.warehouseStock || typeof product.warehouseStock !== 'object' || Array.isArray(product.warehouseStock)))
        throw new Error('product warehouse stock map is malformed');
      const currentRaw = warehouse === 'المخزن الرئيسي' ? (product.stock ?? 0) : (product.warehouseStock?.[warehouse] ?? 0);
      const currentUnits = quantityToMicroUnits(currentRaw, 'current product stock');
      const delta = originalInvoiceType === 'sales_invoice' ? BigInt(line.quantityMicroUnits) : -BigInt(line.quantityMicroUnits);
      const nextUnits = currentUnits + delta;
      if (nextUnits < 0n || nextUnits > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error(originalInvoiceType === 'purchase_invoice' ? 'purchase return quantity is not available in current warehouse stock' : 'sale return produces an unsafe stock quantity');
      stockDeltas.push({ product, line, currentUnits, nextUnits, warehouse });
    }

    const returnId = String(options.createId ? options.createId() :
      'RET-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,8).toUpperCase());
    identifier(returnId, 'return ID');
    const createdAt = new Date().toISOString();
    const operatorId = String(options.operatorId ?? state.currentUser?.id ?? 'system');
    const reason = String(input.reason || '').trim();
    if (!reason) throw new Error('return reason is required');
    const referenceType = returnType === 'INVOICE_CANCEL' ? 'invoice_cancel' :
      returnType === 'SALE_RETURN' ? 'sales_return' : 'purchase_return';
    const stockMovementIds = [];
    const financialMovementIds = [];
    const usedIds = new Set();
    for (const key of ['returns','stockMovements','cashMovements','clientMovements','supplierMovements','customerCreditMovements']) {
      for (const row of (Array.isArray(state[key]) ? state[key] : [])) {
        const id = recordId(row);
        if (id != null) {
          if (usedIds.has(String(id))) throw new Error('duplicate movement ID exists in reverse-ledger collections');
          usedIds.add(String(id));
        }
      }
    }
    const movementId = suffix => {
      const id = 'RET-' + suffix + '-' + returnId;
      if (usedIds.has(id)) throw new Error('duplicate reverse posting movement ID');
      usedIds.add(id);
      return id;
    };

    const arrayNames = ['returns','stockMovements','cashMovements','clientMovements','supplierMovements','customerCreditMovements'];
    const arraySnapshots = Object.fromEntries(arrayNames.map(key => ({
      key, had: own(state,key), ref: Array.isArray(state[key]) ? state[key] : null,
      rows: Array.isArray(state[key]) ? state[key].slice() : null
    })).map(x => [x.key,x]));
    const stateFields = ['caisseBalance'];
    const stateSnapshot = Object.fromEntries(stateFields.map(key => [key,{had:own(state,key),value:state[key]}]));
    const partyFields = partyType === 'customer' ? ['debt','ledgerVersion','creditBalanceCentimes'] : ['balance','creditBalanceCentimes'];
    const partySnapshot = party ? Object.fromEntries(partyFields.map(key => [key,{had:own(party,key),value:party[key]}])) : null;
    const invoiceSnapshot = { had:own(invoice,'status'), value:invoice.status };
    const productSnapshots = stockDeltas.map(({product}) => ({
      product, stock:{had:own(product,'stock'),value:product.stock},
      warehouseStock:{had:own(product,'warehouseStock'),value:product.warehouseStock,
        ref: product.warehouseStock && typeof product.warehouseStock === 'object' && !Array.isArray(product.warehouseStock) ? product.warehouseStock : null,
        entries: product.warehouseStock && typeof product.warehouseStock === 'object' && !Array.isArray(product.warehouseStock) ? {...product.warehouseStock} : null}
    }));
    const restoreObjectField = (object,key,snapshot) => {
      if (!snapshot.had) { delete object[key]; return; }
      if (key === 'warehouseStock' && snapshot.ref && snapshot.entries) {
        for (const existing of Object.keys(snapshot.ref)) delete snapshot.ref[existing];
        Object.assign(snapshot.ref,snapshot.entries);
        object[key] = snapshot.ref;
      } else object[key] = snapshot.value;
    };
    const rollback = () => {
      for (const snap of productSnapshots) {
        restoreObjectField(snap.product,'stock',snap.stock);
        restoreObjectField(snap.product,'warehouseStock',snap.warehouseStock);
      }
      if (party && partySnapshot) for (const key of Object.keys(partySnapshot)) restoreObjectField(party,key,partySnapshot[key]);
      restoreObjectField(invoice,'status',invoiceSnapshot);
      for (const key of stateFields) restoreObjectField(state,key,stateSnapshot[key]);
      for (const key of arrayNames) {
        const snap = arraySnapshots[key];
        if (!snap.had) delete state[key];
        else if (snap.ref) { snap.ref.splice(0,snap.ref.length,...snap.rows); state[key]=snap.ref; }
        else state[key]=state[key];
      }
    };

    try {
      for (const key of arrayNames) {
        if (!Array.isArray(state[key])) {
          if (own(state,key)) throw new Error(key + ' collection is malformed');
          state[key] = [];
        }
      }
      for (const {product,line,nextUnits,warehouse} of stockDeltas) {
        const nextValue = Number(nextUnits) / 1000000;
        if (warehouse === 'المخزن الرئيسي') product.stock = nextValue;
        else {
          if (!product.warehouseStock) product.warehouseStock = {};
          product.warehouseStock[warehouse] = nextValue;
        }
        const stockId = movementId('STOCK');
        state.stockMovements.unshift({
          id:stockId, productId:line.productId, productName:product.name || product.title || line.productId,
          qty:(originalInvoiceType === 'sales_invoice' ? 1 : -1) * (Number(BigInt(line.quantityMicroUnits))/1000000),
          type:originalInvoiceType === 'sales_invoice' ? 'RETURN_IN' : 'RETURN_OUT',
          referenceType, referenceId:returnId, warehouse, date:createdAt,
          note:(returnType === 'INVOICE_CANCEL' ? 'عكس كامل للفاتورة ' : 'مرتجع مرتبط بالفاتورة ') + String(invoice.id)
        });
        stockMovementIds.push(stockId);
      }
      if (party && debtReduction > 0n) {
        if (partyType === 'customer') {
          const existingRows = state.clientMovements.filter(row => row && String(row.clientId) === partyId);
          if (party.ledgerVersion !== 2) {
            if (existingRows.length) throw new Error('customer has unsealed historical movements; manual reconciliation is required');
            party.ledgerVersion = 2;
            if (partyDebt > 0n) state.clientMovements.push({...makeClientMovement({
              movementId:movementId('CLIENT-OPEN'), clientId:partyId, type:'opening_balance',
              amountCentimes:Number(partyDebt), direction:'debit', referenceType:'opening_balance',
              referenceId:partyId, createdAt
            }),ledgerVersion:2});
          }
          party.debt = Number(partyDebt - debtReduction) / 100;
          const clientMovementId = movementId('CLIENT-RETURN');
          state.clientMovements.push({...makeClientMovement({
            movementId:clientMovementId, clientId:partyId, type:'return_credit',
            amountCentimes:Number(debtReduction), direction:'credit',
            referenceType, referenceId:returnId, createdAt
          }),ledgerVersion:2});
          financialMovementIds.push(clientMovementId);
        } else {
          party.balance = Number(partyDebt - debtReduction) / 100;
        }
      }
      if (party && customerCredit > 0n) {
        party.creditBalanceCentimes = Number(partyCredit + customerCredit);
        const creditId = movementId('CUSTOMER-CREDIT');
        state.customerCreditMovements.push({
          id:creditId, type:'credit', customerId:partyId, amountCentimes:Number(customerCredit),
          referenceType, referenceId:returnId, date:createdAt
        });
        financialMovementIds.push(creditId);
      }
      if (party && supplierCredit > 0n) party.creditBalanceCentimes = Number(partyCredit + supplierCredit);
      if (partyType === 'supplier' && party && (debtReduction > 0n || supplierCredit > 0n)) {
        const supplierMovementId = movementId('SUPPLIER-RETURN');
        const supplierAmount = debtReduction + supplierCredit;
        state.supplierMovements.unshift({
          id:supplierMovementId, supplierId:partyId, supplierName:String(party.name || ''),
          type:'return_credit', amount:Number(supplierAmount)/100, referenceType, referenceId:returnId,
          date:createdAt, note:'قيد دائن لمرتجع فاتورة شراء'
        });
        financialMovementIds.push(supplierMovementId);
      }
      if (cashRefund > 0n) {
        const cashMovementId = movementId('CASH');
        state.caisseBalance = Number(cashAfter) / 100;
        state.cashMovements.unshift({
          id:cashMovementId, type:originalInvoiceType === 'sales_invoice' ? 'subtract' : 'add',
          amount:Number(cashRefund)/100,
          description:(originalInvoiceType === 'sales_invoice' ? 'رد قيمة مرتجع مبيعات ' : 'استرداد مرتجع مشتريات ') + String(invoice.id),
          referenceType, referenceId:returnId, date:createdAt,
          userId:state.currentUser?.id != null ? String(state.currentUser.id) : null,
          userName:state.currentUser?.name || 'غير محدد'
        });
        financialMovementIds.push(cashMovementId);
      } else if (cashAfter !== cashBefore) state.caisseBalance = Number(cashAfter)/100;
      if (returnType === 'INVOICE_CANCEL') invoice.status = 'CANCELLED';
      const doc = makeReturnDocument({
        returnId, originalInvoiceId:String(invoice.id), originalInvoiceType, returnType,
        items:lines, totalCentimes:Number(totalCentimes),
        debtReductionCentimes:Number(debtReduction), cashRefundCentimes:Number(cashRefund),
        supplierCreditCentimes:Number(supplierCredit), customerCreditCentimes:Number(customerCredit),
        stockMovementIds, financialMovementIds, status:'POSTED', createdAt, operatorId, reason
      });
      state.returns.push({...doc,ledgerVersion:2});
      validateReverseLedgerParity(state);
      if (typeof options.validateSupplierParity === 'function') options.validateSupplierParity(state);
      if (typeof options.persist === 'function' && options.persist() !== true) throw new Error('return transaction persistence failed');
      return state.returns[state.returns.length - 1];
    } catch (error) {
      rollback();
      throw error;
    }
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
    validateReturns, validateReverseLedgerParity, executeReturnTransaction, originalInvoiceItems, appendUnique, RETURN_TYPES, PARTY_TYPES
  });
});
