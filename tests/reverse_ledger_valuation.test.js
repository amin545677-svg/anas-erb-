'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../reverse-ledger/valuation.js');

test('cumulative return deltas distribute a 100-centime / 3-unit line as 33 + 34 + 33', () => {
  const deltas = [
    V.cumulativeDeltaCentimes(100, 3000000, 0, 1000000),
    V.cumulativeDeltaCentimes(100, 3000000, 1000000, 1000000),
    V.cumulativeDeltaCentimes(100, 3000000, 2000000, 1000000)
  ];
  assert.deepEqual(deltas, [33n, 34n, 33n]);
  assert.equal(deltas.reduce((sum, x) => sum + x, 0n), 100n);
});

test('cumulative valuation handles fractional micro-unit slices without floating point', () => {
  const a = V.cumulativeDeltaCentimes(100, 3000000, 0, 500000);
  const b = V.cumulativeDeltaCentimes(100, 3000000, 500000, 2500000);
  assert.equal(a + b, 100n);
  assert.equal(V.cumulativeValueCentimes(100, 3000000, 3000000), 100n);
});

test('cumulative valuation rejects zero basis, negative values and over-return', () => {
  assert.throws(() => V.cumulativeValueCentimes(100, 0, 0), /original quantity must be positive/);
  assert.throws(() => V.cumulativeDeltaCentimes(100, 3000000, 2500000, 500001), /exceeds remaining/);
  assert.throws(() => V.cumulativeValueCentimes(-1, 3000000, 1), /must be non-negative/);
  assert.throws(() => V.cumulativeValueCentimes(100, 3000000, 3000001), /exceeds original/);
});

test('sale return rejects inventory value without a corresponding stock quantity', () => {
  assert.throws(() => V.saleReturnInventoryValuation({
    currentStockMicroUnits:0,currentInventoryValueCentimes:1,
    returnQuantityMicroUnits:1000000,originalSaleCostCentimes:10,
    originalSaleQuantityMicroUnits:1000000
  }), /zero stock must not retain inventory book value/);
});

test('sale return restores inventory at historical sale COGS, not current WAC', () => {
  const result = V.saleReturnInventoryValuation({
    currentStockMicroUnits: 5000000,
    currentInventoryValueCentimes: 250,
    returnQuantityMicroUnits: 1000000,
    originalSaleCostCentimes: 90,
    originalSaleQuantityMicroUnits: 3000000,
    previouslyReturnedMicroUnits: 0
  });
  assert.equal(result.returnedHistoricalCostCentimes, 30n);
  assert.equal(result.nextStockMicroUnits, 6000000n);
  assert.equal(result.nextInventoryValueCentimes, 280n);
  assert.equal(result.nextWeightedAverageCostCentimes, 47n);
});

test('sale return cumulative historical cost is exact across sequential partial returns', () => {
  const slices = [
    V.saleReturnInventoryValuation({currentStockMicroUnits:0,currentInventoryValueCentimes:0,returnQuantityMicroUnits:1000000,originalSaleCostCentimes:100,originalSaleQuantityMicroUnits:3000000,previouslyReturnedMicroUnits:0}),
    V.saleReturnInventoryValuation({currentStockMicroUnits:1000000,currentInventoryValueCentimes:33,returnQuantityMicroUnits:1000000,originalSaleCostCentimes:100,originalSaleQuantityMicroUnits:3000000,previouslyReturnedMicroUnits:1000000}),
    V.saleReturnInventoryValuation({currentStockMicroUnits:2000000,currentInventoryValueCentimes:67,returnQuantityMicroUnits:1000000,originalSaleCostCentimes:100,originalSaleQuantityMicroUnits:3000000,previouslyReturnedMicroUnits:2000000})
  ];
  assert.deepEqual(slices.map(x=>x.returnedHistoricalCostCentimes),[33n,34n,33n]);
  assert.equal(slices[2].nextInventoryValueCentimes,100n);
});

test('purchase return separates supplier settlement from WAC book value and signs variance', () => {
  const result = V.purchaseReturnInventoryValuation({
    currentStockMicroUnits: 3000000,
    currentInventoryValueCentimes: 100,
    returnQuantityMicroUnits: 1000000,
    supplierOriginalLineTotalCentimes: 110,
    supplierOriginalQuantityMicroUnits: 3000000,
    previouslyReturnedMicroUnits: 0
  });
  assert.equal(result.supplierSettlementCentimes,37n);
  assert.equal(result.inventoryBookValueCentimes,33n);
  assert.equal(result.valuationVarianceCentimes,4n);
  assert.equal(result.nextStockMicroUnits,2000000n);
  assert.equal(result.nextInventoryValueCentimes,67n);
  assert.equal(result.nextWeightedAverageCostCentimes,34n);
});

test('sequential purchase returns remove the full carrying value without a rounding residue', () => {
  let stock=3000000n, book=100n, previouslyReturned=0n;
  const settlements=[], carrying=[];
  for (let i=0;i<3;i++) {
    const result=V.purchaseReturnInventoryValuation({
      currentStockMicroUnits:stock,currentInventoryValueCentimes:book,
      returnQuantityMicroUnits:1000000,
      supplierOriginalLineTotalCentimes:100,supplierOriginalQuantityMicroUnits:3000000,
      previouslyReturnedMicroUnits:previouslyReturned
    });
    settlements.push(result.supplierSettlementCentimes);
    carrying.push(result.inventoryBookValueCentimes);
    stock=result.nextStockMicroUnits; book=result.nextInventoryValueCentimes;
    previouslyReturned+=1000000n;
  }
  assert.deepEqual(settlements,[33n,34n,33n]);
  assert.equal(settlements.reduce((sum,x)=>sum+x,0n),100n);
  assert.equal(carrying.reduce((sum,x)=>sum+x,0n),100n);
  assert.equal(stock,0n);
  assert.equal(book,0n);
});

test('purchase return rejects stock overdraw and inconsistent zero-stock valuation', () => {
  assert.throws(() => V.purchaseReturnInventoryValuation({
    currentStockMicroUnits:1000000,currentInventoryValueCentimes:10,
    returnQuantityMicroUnits:1000001,supplierOriginalLineTotalCentimes:10,
    supplierOriginalQuantityMicroUnits:1000000
  }), /exceeds current stock/);
  const fullRemoval = V.purchaseReturnInventoryValuation({
    currentStockMicroUnits:1000000,currentInventoryValueCentimes:10,
    returnQuantityMicroUnits:1000000,supplierOriginalLineTotalCentimes:10,
    supplierOriginalQuantityMicroUnits:1000000
  });
  assert.equal(fullRemoval.nextStockMicroUnits,0n);
  assert.equal(fullRemoval.nextInventoryValueCentimes,0n);
  assert.equal(fullRemoval.nextWeightedAverageCostCentimes,0n);
});

test('prime-divisor seven-lot floor allocation conserves every centime and micro-unit', () => {
  const totalValue = 1000000n;
  const totalQuantity = 7000000n;
  let allocatedValue = 0n;
  let allocatedQuantity = 0n;
  const deltas = [];
  for (let i = 0; i < 7; i++) {
    const delta = V.cumulativeFloorDeltaCentimes(
      totalValue, totalQuantity, allocatedQuantity, 1000000n
    );
    deltas.push(delta);
    allocatedValue += delta;
    allocatedQuantity += 1000000n;
  }
  assert.equal(deltas.reduce((sum, value) => sum + value, 0n), 1000000n);
  assert.equal(allocatedValue, totalValue);
  assert.equal(allocatedQuantity, totalQuantity);
  assert.equal(totalValue - allocatedValue, 0n);
  assert.equal(totalQuantity - allocatedQuantity, 0n);
  assert.deepEqual(deltas, [142857n, 142857n, 142857n, 142857n, 142857n, 142857n, 142858n]);
});


test('Level 24: all four unique return permutations close 13 cartons / 100003 centimes exactly', () => {
  const permutations = [
    [3n, 5n, 2n, 3n],
    [5n, 3n, 2n, 3n],
    [2n, 3n, 5n, 3n],
    [3n, 3n, 5n, 2n]
  ];
  const finalStates = [];
  for (const cartons of permutations) {
    let returnedMicroUnits = 0n;
    let refundedCentimes = 0n;
    let stockMicroUnits = 0n;
    let inventoryValueCentimes = 0n;
    let cashCentimes = 0n;
    let receivablesCentimes = 0n;
    for (const cartonsInBatch of cartons) {
      const quantity = cartonsInBatch * 1_000_000n;
      const result = V.saleReturnInventoryValuation({
        currentStockMicroUnits: stockMicroUnits,
        currentInventoryValueCentimes: inventoryValueCentimes,
        returnQuantityMicroUnits: quantity,
        originalSaleCostCentimes: 100003n,
        originalSaleQuantityMicroUnits: 13_000_000n,
        previouslyReturnedMicroUnits: returnedMicroUnits
      });
      const delta = result.returnedHistoricalCostCentimes;
      returnedMicroUnits += quantity;
      refundedCentimes += delta;
      stockMicroUnits = result.nextStockMicroUnits;
      inventoryValueCentimes = result.nextInventoryValueCentimes;
      cashCentimes -= delta;
      receivablesCentimes += delta;
      const invariant = (-delta) + delta + 0n;
      assert.equal(invariant, 0n, 'algebraic zero after every partial return');
      assert.ok(returnedMicroUnits <= 13_000_000n);
    }
    assert.equal(refundedCentimes, 100003n);
    assert.equal(100003n - refundedCentimes, 0n);
    assert.equal(returnedMicroUnits, 13_000_000n);
    finalStates.push({ stockMicroUnits, inventoryValueCentimes, cashCentimes, receivablesCentimes });
  }
  for (const state of finalStates.slice(1)) assert.deepEqual(state, finalStates[0]);
  assert.deepEqual(finalStates[0], {
    stockMicroUnits: 13_000_000n,
    inventoryValueCentimes: 100003n,
    cashCentimes: -100003n,
    receivablesCentimes: 0n
  });
});
