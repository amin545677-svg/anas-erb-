'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../reverse-ledger/reverse-ledger.js');

function makeState() {
  const customer = { id:'C-ROLLBACK', debt:0.20, name:'Rollback customer' };
  const invoice = {
    id:'INV-ROLLBACK', customerId:'C-ROLLBACK', customerObj:customer,
    total:0.30, paid:0.10, remaining:0.20, warehouse:'Store A',
    items:[{ id:'P-ROLLBACK', qty:3, price:0.10 }]
  };
  const warehouseStock = { 'Store A':0, 'Store B':7 };
  const product = {
    id:'P-ROLLBACK', name:'Rollback product', stock:11,
    buyPrice:0.10, warehouseStock
  };
  const sourceSaleMovement = {
    id:'SALE-ROLLBACK', productId:'P-ROLLBACK', qty:-3, type:'SALE_OUT',
    referenceType:'sales_invoice', referenceId:'INV-ROLLBACK',
    originalSaleQuantityMicroUnits:3000000,
    originalSaleCostCentimes:15
  };
  const invoiceRows = [invoice];
  const customerRows = [customer];
  const productRows = [product];
  const stockRows = [sourceSaleMovement];
  const state = {
    invoices:invoiceRows, purchases:[], customers:customerRows, suppliers:[],
    products:productRows, stockMovements:stockRows,
    cashMovements:[], clientMovements:[], supplierMovements:[],
    customerCreditMovements:[], settlementAllocations:[], returns:[],
    caisseBalance:42.75, currentUser:{id:'U-ROLLBACK',name:'Tester'}
  };
  return {
    state, customer, invoice, product, warehouseStock,
    invoiceRows, customerRows, productRows, stockRows,
    cashRows:state.cashMovements, clientRows:state.clientMovements,
    supplierRows:state.supplierMovements, creditRows:state.customerCreditMovements,
    allocationRows:state.settlementAllocations, returnRows:state.returns
  };
}

test('save failure restores values, property presence, and every pre-existing object/array identity', () => {
  const f = makeState();
  const before = {
    customer:{...f.customer},
    invoice:{...f.invoice},
    product:{...f.product},
    warehouseStock:{...f.warehouseStock},
    stateFields:{caisseBalance:f.state.caisseBalance},
    ownKeys:{
      state:Object.keys(f.state).sort(),
      customer:Object.keys(f.customer).sort(),
      invoice:Object.keys(f.invoice).sort(),
      product:Object.keys(f.product).sort()
    },
    rows:{
      invoices:f.invoiceRows.slice(), customers:f.customerRows.slice(),
      products:f.productRows.slice(), stock:f.stockRows.slice(),
      cash:f.cashRows.slice(), client:f.clientRows.slice(),
      supplier:f.supplierRows.slice(), credit:f.creditRows.slice(),
      allocations:f.allocationRows.slice(), returns:f.returnRows.slice()
    }
  };

  assert.throws(() => R.executeReturnTransaction(f.state, {
    returnType:'SALE_RETURN',
    originalInvoiceType:'sales_invoice',
    invoiceId:'INV-ROLLBACK',
    items:[{productId:'P-ROLLBACK',quantity:'3'}],
    settlementMode:'credit',
    reason:'rollback identity proof'
  }, {
    createId:()=>'RET-ROLLBACK-IDENTITY',
    operatorId:'U-ROLLBACK',
    persist:()=>false
  }), /persistence failed/);

  // The same domain objects must survive; rollback must not replace them with clones.
  assert.strictEqual(f.state.invoices, f.invoiceRows);
  assert.strictEqual(f.state.customers, f.customerRows);
  assert.strictEqual(f.state.products, f.productRows);
  assert.strictEqual(f.state.stockMovements, f.stockRows);
  assert.strictEqual(f.state.cashMovements, f.cashRows);
  assert.strictEqual(f.state.clientMovements, f.clientRows);
  assert.strictEqual(f.state.supplierMovements, f.supplierRows);
  assert.strictEqual(f.state.customerCreditMovements, f.creditRows);
  assert.strictEqual(f.state.settlementAllocations, f.allocationRows);
  assert.strictEqual(f.state.returns, f.returnRows);
  assert.strictEqual(f.state.customers[0], f.customer);
  assert.strictEqual(f.state.invoices[0], f.invoice);
  assert.strictEqual(f.state.products[0], f.product);
  assert.strictEqual(f.state.stockMovements[0], before.rows.stock[0]);
  assert.strictEqual(f.product.warehouseStock, f.warehouseStock);

  // The original arrays are restored in place, including their original row identities.
  for (const [actual, expected] of [
    [f.invoiceRows,before.rows.invoices], [f.customerRows,before.rows.customers],
    [f.productRows,before.rows.products], [f.stockRows,before.rows.stock],
    [f.cashRows,before.rows.cash], [f.clientRows,before.rows.client],
    [f.supplierRows,before.rows.supplier], [f.creditRows,before.rows.credit],
    [f.allocationRows,before.rows.allocations], [f.returnRows,before.rows.returns]
  ]) {
    assert.equal(actual.length, expected.length);
    expected.forEach((row,index)=>assert.strictEqual(actual[index],row));
  }

  assert.deepEqual(f.customer,before.customer);
  assert.deepEqual(f.invoice,before.invoice);
  assert.deepEqual(f.product,{...before.product,warehouseStock:f.warehouseStock});
  assert.deepEqual(f.warehouseStock,before.warehouseStock);
  assert.equal(f.state.caisseBalance,before.stateFields.caisseBalance);
  assert.deepEqual(Object.keys(f.state).sort(),before.ownKeys.state);
  assert.deepEqual(Object.keys(f.customer).sort(),before.ownKeys.customer);
  assert.deepEqual(Object.keys(f.invoice).sort(),before.ownKeys.invoice);
  assert.deepEqual(Object.keys(f.product).sort(),before.ownKeys.product);
  assert.equal(f.state.returns.length,0);
  assert.equal(f.state.stockMovements.length,1);
  assert.equal(f.state.clientMovements.length,0);
  assert.equal(f.state.customerCreditMovements.length,0);
});
