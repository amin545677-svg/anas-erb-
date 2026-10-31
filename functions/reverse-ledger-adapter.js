'use strict';

const { authorizeReverseOperation, PERMISSIONS } = require('../reverse-ledger/authorization.js');

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function requiredText(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(label + ' is invalid');
  }
  return value.trim();
}

function decimalUnits(value, scale, label, maxPlaces) {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === null) {
    throw new Error(label + ' must be a decimal string or number');
  }
  const raw = String(value).trim();
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(raw);
  if (!match || ((match[2] || '').length > maxPlaces)) {
    throw new Error(label + ' has invalid decimal precision');
  }
  const places = maxPlaces;
  const fraction = (match[2] || '').padEnd(places, '0');
  return BigInt(match[1]) * BigInt(scale) + BigInt(fraction || '0');
}

function toCentimes(value, label) {
  const units = decimalUnits(value, 100n, label, 2);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(label + ' exceeds the safe range');
  return Number(units);
}

function toMicroUnits(value, label) {
  const units = decimalUnits(value, 1000000n, label, 6);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(label + ' exceeds the safe range');
  return Number(units);
}

function normalizeReverseRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('reverse operation request must be an object');
  }
  const operationId = requiredText(input.operationId, 'operationId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(operationId)) {
    throw new Error('operationId format is invalid');
  }
  const periodId = requiredText(input.periodId, 'periodId', 128);
  const invoiceId = requiredText(input.invoiceId, 'invoiceId');
  const originalInvoiceType = input.originalInvoiceType;
  const returnType = input.returnType;
  if (!['sales_invoice', 'purchase_invoice'].includes(originalInvoiceType)) {
    throw new Error('originalInvoiceType is invalid');
  }
  if (!['SALE_RETURN', 'PURCHASE_RETURN', 'INVOICE_CANCEL'].includes(returnType)) {
    throw new Error('returnType is invalid');
  }
  if ((returnType === 'SALE_RETURN' && originalInvoiceType !== 'sales_invoice') ||
      (returnType === 'PURCHASE_RETURN' && originalInvoiceType !== 'purchase_invoice')) {
    throw new Error('returnType does not match originalInvoiceType');
  }
  const reason = requiredText(input.reason, 'reason', 500);
  if (reason.length < 3) throw new Error('reason must contain at least 3 characters');
  const settlementMode = input.settlementMode;
  if (!['cash', 'credit'].includes(settlementMode)) {
    throw new Error('settlementMode must be cash or credit');
  }
  let items = [];
  if (returnType !== 'INVOICE_CANCEL') {
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 200) {
      throw new Error('return items must contain between 1 and 200 lines');
    }
    const seen = new Set();
    items = input.items.map((line, index) => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) {
        throw new Error('return item ' + index + ' is invalid');
      }
      const productId = requiredText(String(line.productId ?? ''), 'productId', 160);
      if (seen.has(productId)) throw new Error('duplicate return product line');
      seen.add(productId);
      const quantityMicroUnits = toMicroUnits(line.quantity ?? line.qty, 'return quantity');
      if (quantityMicroUnits <= 0) throw new Error('return quantity must be positive');
      return Object.freeze({ productId, quantity: String(line.quantity ?? line.qty) });
    });
  }
  return Object.freeze({
    operationId, periodId, invoiceId, originalInvoiceType, returnType,
    items: Object.freeze(items), settlementMode, reason
  });
}

function buildAuthorizationOperation(request, invoice, postedDocument, state) {
  if (!invoice || invoice.ledgerVersion !== 2) {
    throw new Error('invoice is not sealed in the version-2 ledger; reconcile it before reverse posting');
  }
  const cashAvailableCentimes = toCentimes(state.caisseBalance ?? 0, 'cash balance');
  const creditIssueCentimes = Number(postedDocument.customerCreditCentimes || 0) +
    Number(postedDocument.supplierCreditCentimes || 0);
  if (!Number.isSafeInteger(creditIssueCentimes) || creditIssueCentimes < 0) {
    throw new Error('reverse credit amount is invalid');
  }
  const purchaseReturnQuantityMicroUnits = request.returnType === 'PURCHASE_RETURN'
    ? postedDocument.items.reduce((sum, item) => sum + item.quantityMicroUnits, 0)
    : 0;
  if (!Number.isSafeInteger(purchaseReturnQuantityMicroUnits)) {
    throw new Error('purchase return quantity exceeds the safe range');
  }
  return {
    type: request.returnType,
    operationId: request.operationId,
    invoiceLedgerVersion: invoice.ledgerVersion,
    allocationsReconciled: true,
    legacyRecordsPresent: false,
    settlementMode: request.settlementMode,
    cashRefundCentimes: request.originalInvoiceType === 'sales_invoice'
      ? postedDocument.cashRefundCentimes : 0,
    cashDirection: request.originalInvoiceType === 'sales_invoice' ? 'outflow' : 'inflow',
    creditIssueCentimes,
    purchaseReturnQuantityMicroUnits
  };
}

function authorizePreparedReverseOperation({ projectId, uid, token, grant, period, request, postedDocument, state, reservation, nowEpochMs }) {
  const operation = buildAuthorizationOperation(
    request,
    (request.originalInvoiceType === 'sales_invoice' ? state.invoices : state.purchases)
      .find(row => row && String(row.id) === request.invoiceId),
    postedDocument,
    state
  );
  const stockAvailableMicroUnits = request.returnType === 'PURCHASE_RETURN'
    ? postedDocument.items.reduce((sum, item) => {
        const product = state.products.find(row => row && String(row.id) === item.productId);
        if (!product) throw new Error('purchase return product is missing');
        const warehouse = String(
          request.originalInvoiceType === 'sales_invoice' ? 'المخزن الرئيسي' : 'المخزن الرئيسي'
        );
        const current = warehouse === 'المخزن الرئيسي'
          ? product.stock ?? 0 : product.warehouseStock?.[warehouse] ?? 0;
        return sum + toMicroUnits(current, 'available warehouse stock');
      }, 0)
    : 0;
  return authorizeReverseOperation({
    projectId,
    auth: {
      verified: true,
      uid,
      disabled: false,
      audience: token.aud,
      issuer: token.iss,
      authTimeSeconds: token.auth_time,
      issuedAtSeconds: token.iat,
      expiresAtSeconds: token.exp
    },
    grant,
    operation,
    period,
    liquidity: { cashAvailableCentimes: toCentimes(state.caisseBalance ?? 0, 'cash balance') },
    stock: { availableMicroUnits: stockAvailableMicroUnits },
    reservation,
    nowEpochMs
  });
}

module.exports = Object.freeze({
  PERMISSIONS,
  normalizeReverseRequest,
  toCentimes,
  toMicroUnits,
  buildAuthorizationOperation,
  authorizePreparedReverseOperation
});
