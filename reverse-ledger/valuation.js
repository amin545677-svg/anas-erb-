'use strict';

/**
 * Pure integer valuation primitives for ANAS ERP reverse-ledger.
 * Currency values are integer centimes; quantities are integer micro-units.
 * This module is intentionally not wired into live posting until its callers
 * supply verified original invoice cost/value snapshots.
 */
const SCALE = 1000000n;

function integer(value, label) {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) throw new Error(label + ' must be a safe integer or BigInt');
  return BigInt(value);
}
function nonNegative(value, label) {
  const n = integer(value, label);
  if (n < 0n) throw new Error(label + ' must be non-negative');
  return n;
}
function positive(value, label) {
  const n = integer(value, label);
  if (n <= 0n) throw new Error(label + ' must be positive');
  return n;
}
function roundHalfUpRatio(numerator, denominator) {
  const n = nonNegative(numerator, 'numerator');
  const d = positive(denominator, 'denominator');
  return (n + d / 2n) / d;
}

/**
 * Value of the first cumulative quantity slice, rounded once to a centime.
 * This makes all sequential return deltas telescope exactly to original total.
 */
function cumulativeValueCentimes(originalLineTotalCentimes, originalQuantityMicroUnits, cumulativeQuantityMicroUnits) {
  const total = nonNegative(originalLineTotalCentimes, 'original line total');
  const originalQty = positive(originalQuantityMicroUnits, 'original quantity');
  const cumulativeQty = nonNegative(cumulativeQuantityMicroUnits, 'cumulative quantity');
  if (cumulativeQty > originalQty) throw new Error('cumulative quantity exceeds original quantity');
  return roundHalfUpRatio(total * cumulativeQty, originalQty);
}

function cumulativeDeltaCentimes(originalLineTotalCentimes, originalQuantityMicroUnits,
  previouslyReturnedMicroUnits, returnQuantityMicroUnits) {
  const originalQty = positive(originalQuantityMicroUnits, 'original quantity');
  const previous = nonNegative(previouslyReturnedMicroUnits, 'previously returned quantity');
  const quantity = positive(returnQuantityMicroUnits, 'return quantity');
  if (previous > originalQty || quantity > originalQty - previous)
    throw new Error('return quantity exceeds remaining original quantity');
  const before = cumulativeValueCentimes(originalLineTotalCentimes, originalQty, previous);
  const after = cumulativeValueCentimes(originalLineTotalCentimes, originalQty, previous + quantity);
  return after - before;
}

function saleReturnInventoryValuation(input) {
  if (!input || typeof input !== 'object') throw new Error('sale return valuation input is required');
  const stock = nonNegative(input.currentStockMicroUnits, 'current stock');
  const book = nonNegative(input.currentInventoryValueCentimes, 'current inventory value');
  if (stock === 0n && book !== 0n) throw new Error('zero stock must not retain inventory book value');
  const quantity = positive(input.returnQuantityMicroUnits, 'return quantity');
  const historicalCost = cumulativeDeltaCentimes(
    input.originalSaleCostCentimes,
    input.originalSaleQuantityMicroUnits,
    input.previouslyReturnedMicroUnits ?? 0,
    quantity
  );
  const nextStock = stock + quantity;
  const nextBook = book + historicalCost;
  const unitCost = nextStock === 0n ? 0n : roundHalfUpRatio(nextBook * SCALE, nextStock);
  return Object.freeze({
    returnedHistoricalCostCentimes: historicalCost,
    nextStockMicroUnits: nextStock,
    nextInventoryValueCentimes: nextBook,
    nextWeightedAverageCostCentimes: unitCost
  });
}

/**
 * Variance sign convention:
 *   positive => supplier settlement exceeds inventory book value removed;
 *   negative => supplier settlement is below inventory book value removed.
 */
function purchaseReturnInventoryValuation(input) {
  if (!input || typeof input !== 'object') throw new Error('purchase return valuation input is required');
  const stock = positive(input.currentStockMicroUnits, 'current stock');
  const book = nonNegative(input.currentInventoryValueCentimes, 'current inventory value');
  const quantity = positive(input.returnQuantityMicroUnits, 'return quantity');
  if (quantity > stock) throw new Error('purchase return exceeds current stock');
  const supplierSettlement = cumulativeDeltaCentimes(
    input.supplierOriginalLineTotalCentimes,
    input.supplierOriginalQuantityMicroUnits,
    input.previouslyReturnedMicroUnits ?? 0,
    quantity
  );
  const inventoryBookValue = cumulativeDeltaCentimes(book, stock, 0n, quantity);
  const nextStock = stock - quantity;
  const nextBook = book - inventoryBookValue;
  if (nextStock === 0n && nextBook !== 0n) throw new Error('zero stock must not retain inventory book value');
  const nextWeightedAverageCost = nextStock === 0n ? 0n : roundHalfUpRatio(nextBook * SCALE, nextStock);
  const variance = supplierSettlement - inventoryBookValue;
  return Object.freeze({
    supplierSettlementCentimes: supplierSettlement,
    inventoryBookValueCentimes: inventoryBookValue,
    valuationVarianceCentimes: variance,
    nextStockMicroUnits: nextStock,
    nextInventoryValueCentimes: nextBook,
    nextWeightedAverageCostCentimes: nextWeightedAverageCost
  });
}

module.exports = Object.freeze({
  SCALE,
  roundHalfUpRatio,
  cumulativeValueCentimes,
  cumulativeDeltaCentimes,
  saleReturnInventoryValuation,
  purchaseReturnInventoryValuation
});
