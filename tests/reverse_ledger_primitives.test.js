'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../reverse-ledger/reverse-ledger.js');

test('initializes new collections without rewriting legacy records', () => {
 const invoice={id:'S-1',total:100,paid:20}; const state={invoices:[invoice],customers:[{id:'C-1',debt:80}]};
 const next=R.ensureCollections(state);
 assert.deepEqual(next.clientMovements,[]); assert.deepEqual(next.settlementAllocations,[]); assert.deepEqual(next.returns,[]); assert.deepEqual(next.customerCreditMovements,[]);
 assert.equal(state.clientMovements,undefined); assert.equal(next.invoices[0],invoice);
});
test('fails closed on malformed collection shapes', () => assert.throws(()=>R.ensureCollections({returns:{}}),/returns must be an array/));
test('client movement uses positive safe integer centimes', () => {
 const m=R.makeClientMovement({movementId:'CM-1',clientId:'C-1',type:'receipt',amountCentimes:725,direction:'credit',referenceType:'customer_debt',referenceId:'C-1',createdAt:'2026-10-30T12:00:00Z'});
 assert.equal(m.amountCentimes,725); assert.equal(Object.prototype.hasOwnProperty.call(m,'ledgerVersion'),false); assert.ok(Object.isFrozen(m));
 assert.throws(()=>R.makeClientMovement({...m,amountCentimes:0}),/positive safe integer/);
 assert.throws(()=>R.makeClientMovement({...m,amountCentimes:9007199254740992}),/positive safe integer/);
});
test('allocation requires matching party and invoice domains', () => {
 const base={allocationId:'A-1',partyType:'customer',partyId:'C-1',invoiceType:'sales_invoice',invoiceId:'S-1',sourceMovementId:'M-1',sourceMovementType:'customer_debt',amountCentimes:500,createdAt:'2026-10-30T12:00:00Z'};
 const draft=R.makeSettlementAllocation(base);
 assert.equal(Object.prototype.hasOwnProperty.call(draft,'ledgerVersion'),false);
 const state={customers:[],suppliers:[],invoices:[{id:'S-1',customerId:'C-1',paid:5}],purchases:[],cashMovements:[{id:'M-1',amountCentimes:1000,referenceType:'customer_debt',referenceId:'C-1'}]};
 assert.equal(R.sealSettlementAllocation(state,base).ledgerVersion,2);
 assert.throws(()=>R.makeSettlementAllocation({...base,partyType:'supplier'}),/party and invoice types do not match/);
});
test('return document validates exact BigInt micro-unit line totals', () => {
 const d=R.makeReturnDocument({returnId:'R-1',originalInvoiceId:'S-1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',items:[{productId:'P-1',quantityMicroUnits:3000000,unitPriceCentimes:10,lineTotalCentimes:30,originalLineTotalCentimes:30,originalQuantityMicroUnits:3000000,previouslyReturnedMicroUnits:0}],totalCentimes:30,debtReductionCentimes:20,cashRefundCentimes:10,status:'DRAFT',createdAt:'2026-10-30T12:00:00Z',operatorId:'U-1',reason:'damaged'});
 assert.equal(d.totalCentimes,30); assert.equal(Object.prototype.hasOwnProperty.call(d,'ledgerVersion'),false);
 const sealed=R.sealReturnDocument({customers:[],suppliers:[],invoices:[{id:'S-1',customerObj:{id:'C-1'},items:[{id:'P-1',qty:3,price:0.1}]}],purchases:[],returns:[]},{
  ...d, originalInvoiceType:'sales_invoice'
 });
 assert.equal(sealed.ledgerVersion,2);
 assert.throws(()=>R.makeReturnDocument({...d,totalCentimes:31}),/return total does not equal line totals/);
 assert.throws(()=>R.makeReturnDocument({...d,cashRefundCentimes:11}),/settlement exceeds return value/);
 const fractional=R.makeReturnDocument({...d,items:[{productId:'P-1',quantityMicroUnits:500000,unitPriceCentimes:1,lineTotalCentimes:5,originalLineTotalCentimes:30,originalQuantityMicroUnits:3000000,previouslyReturnedMicroUnits:0}],totalCentimes:5,debtReductionCentimes:5,cashRefundCentimes:0});
 assert.equal(fractional.items[0].lineTotalCentimes,5);
});
test('returnable quantity ceiling is exact and rejects over-return', () => {
 assert.equal(R.computeReturnableMicroUnits(9007199254740990n,3000000n),9007199251740990n);
 assert.throws(()=>R.computeReturnableMicroUnits(3,4),/invalid return quantity ceiling/);
});
test('allocation validator rejects orphan, mismatch and over-allocation', () => {
 const invoice={id:'S-1',customerId:'C-1',paid:20}, movement={id:'M-1',amountCentimes:1000,referenceType:'customer_debt',referenceId:'C-1'};
 const a={ledgerVersion:2,allocationId:'A-1',partyType:'customer',partyId:'C-1',invoiceType:'sales_invoice',invoiceId:'S-1',sourceMovementId:'M-1',sourceMovementType:'customer_debt',amountCentimes:700};
 const state={invoices:[invoice],cashMovements:[movement],settlementAllocations:[a]};
 assert.equal(R.validateSettlementAllocations(state),true);
 assert.throws(()=>R.validateSettlementAllocations({...state,invoices:[]}),/orphan or ambiguous settlement allocation invoice/);
 assert.throws(()=>R.validateSettlementAllocations({...state,invoices:[{...invoice,customerId:'C-2'}]}),/allocation party does not match invoice/);
 assert.throws(()=>R.validateSettlementAllocations({...state,settlementAllocations:[a,{...a,allocationId:'A-2',amountCentimes:400}]}),/allocations exceed source movement amount/);
});
test('appendUnique rejects replay without mutating original list', () => {
 const original=[{returnId:'R-1'}], next=R.appendUnique(original,{returnId:'R-2'},'returnId');
 assert.equal(original.length,1); assert.equal(next.length,2);
 assert.throws(()=>R.appendUnique(next,{returnId:'R-2'},'returnId'),/duplicate returnId/);
});

test('client movement validator rejects unknown persisted movement types', () => {
 const state={
  customers:[{id:'C-1',debt:1,ledgerVersion:2}],
  clientMovements:[{ledgerVersion:2,movementId:'CM-UNKNOWN',clientId:'C-1',type:'unsupported_credit',amountCentimes:100,direction:'debit',referenceType:'anything',referenceId:'anything',createdAt:'2026-10-30T12:00:00Z'}],
  invoices:[],purchases:[],returns:[]
 };
 assert.throws(()=>R.validateClientMovements(state),/unsupported client movement type/);
});
test('legacy V42 state passes without synthetic allocation or movement records', () => {
 const state={customers:[{id:'C-1',debt:125.5}],suppliers:[],invoices:[],purchases:[],returns:[]};
 const before=JSON.stringify(state);
 assert.equal(R.validateReverseLedgerParity(state),true);
 assert.equal(JSON.stringify(state),before);
 assert.equal(state.clientMovements,undefined);
});
test('version-2 client movement ledger must reconcile exactly to customer debt', () => {
 const input={movementId:'CM-1',clientId:'C-1',type:'opening_balance',amountCentimes:725,direction:'debit',referenceType:'opening_balance',referenceId:'C-1',createdAt:'2026-10-30T12:00:00Z'};
 const state={customers:[{id:'C-1',debt:7.25,ledgerVersion:2}],clientMovements:[],invoices:[],purchases:[],returns:[]};
 const movement=R.sealClientMovement(state,input);
 state.clientMovements.push(movement);
 assert.equal(R.validateReverseLedgerParity(state),true);
 assert.throws(()=>R.sealClientMovement(state,{...input,movementId:'CM-BAD',direction:'credit'}),/direction does not match movement type/);
 assert.throws(()=>R.validateReverseLedgerParity({...state,customers:[{id:'C-1',debt:7.24,ledgerVersion:2}]}),/does not match customer debt/);
});
test('posted returns reject a one-micro-unit over-return without mutating the source state', () => {
 const state={
  customers:[],suppliers:[],
  invoices:[{id:'S-1',customerObj:{id:'C-1'},items:[{id:'P-1',qty:2,price:1000000}]}],
  purchases:[],clientMovements:[],settlementAllocations:[],cashMovements:[],supplierMovements:[],stockMovements:[],
  returns:[{returnId:'R-1',ledgerVersion:2,originalInvoiceId:'S-1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'POSTED',
   items:[{productId:'P-1',quantityMicroUnits:2000001,unitPriceCentimes:1000000,lineTotalCentimes:2000001,originalLineTotalCentimes:2000000,originalQuantityMicroUnits:2000000,previouslyReturnedMicroUnits:0}],
   totalCentimes:2000001,debtReductionCentimes:0,cashRefundCentimes:0,stockMovementIds:[],financialMovementIds:[]}]
 };
 const before=JSON.stringify(state);
 assert.throws(()=>R.validateReverseLedgerParity(state),/return exceeds remaining returnable micro-units/);
 assert.equal(JSON.stringify(state),before,'rejected validation must not mutate incoming data');
 const draftState={...state,returns:[]};
 assert.throws(()=>R.sealReturnDocument(draftState,{
  returnId:'R-DRAFT-OVER',originalInvoiceId:'S-1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'DRAFT',
  items:[{productId:'P-1',quantityMicroUnits:2000001,unitPriceCentimes:1000000,lineTotalCentimes:2000001,originalLineTotalCentimes:200000000,originalQuantityMicroUnits:2000000,previouslyReturnedMicroUnits:0}],
  totalCentimes:2000001,debtReductionCentimes:0,cashRefundCentimes:0,createdAt:'2026-10-30T12:00:00Z',operatorId:'U-1',reason:'over ceiling'
 }),/return quantity exceeds remaining original quantity/);
});
test('posted return requires matching invoice-linked stock movements', () => {
 const state={
  customers:[],suppliers:[],
  invoices:[{id:'S-1',customerObj:{id:'C-1'},items:[{id:'P-1',qty:2,price:10}]}],
  purchases:[],clientMovements:[],settlementAllocations:[],
  cashMovements:[{id:'CM-1',type:'subtract',amount:10,referenceType:'sales_return',referenceId:'R-1'}],supplierMovements:[],
  stockMovements:[
   {id:'SALE-ORIGINAL',productId:'P-1',qty:-2,type:'SALE_OUT',referenceType:'sales_invoice',referenceId:'S-1',originalSaleQuantityMicroUnits:2000000,originalSaleCostCentimes:500},
   {id:'SM-1',productId:'P-1',qty:1,type:'RETURN_IN',referenceType:'sales_return',referenceId:'R-1',restoredInventoryCostCentimes:250}
  ],
  returns:[{returnId:'R-1',ledgerVersion:2,originalInvoiceId:'S-1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'POSTED',
   items:[{productId:'P-1',quantityMicroUnits:1000000,unitPriceCentimes:1000,lineTotalCentimes:1000,originalLineTotalCentimes:2000,originalQuantityMicroUnits:2000000,previouslyReturnedMicroUnits:0,restoredInventoryCostCentimes:250,inventoryBookValueCentimes:0,valuationVarianceCentimes:0}],
   totalCentimes:1000,debtReductionCentimes:0,cashRefundCentimes:1000,supplierCreditCentimes:0,stockMovementIds:['SM-1'],financialMovementIds:['CM-1']}]
 };
 assert.equal(R.validateReverseLedgerParity(state),true);
 assert.throws(()=>R.validateReverseLedgerParity({...state,stockMovements:[]}),/posted return stock movement is missing or mismatched/);
 const orphanFinancial={...state,cashMovements:[...state.cashMovements,{id:'CM-ORPHAN',amount:1,referenceType:'sales_return',referenceId:'R-1'}]};
 assert.throws(()=>R.validateReverseLedgerParity(orphanFinancial),/unreferenced or ambiguous financial movements/);
});

test('posted purchase return reconciles the legacy single-line purchase schema', () => {
 const state={
  customers:[],suppliers:[{id:'SUP-1',balance:0}],
  invoices:[],purchases:[{id:'PUR-1',supplierId:'SUP-1',productId:'P-1',qty:2,cost:10,total:20,paid:20}],
  clientMovements:[],settlementAllocations:[],
  cashMovements:[{id:'CM-PUR-RET',type:'add',amount:10,referenceType:'purchase_return',referenceId:'R-PUR-1'}],
  supplierMovements:[],
  stockMovements:[{id:'SM-PUR-RET',productId:'P-1',qty:-1,type:'RETURN_OUT',referenceType:'purchase_return',referenceId:'R-PUR-1',inventoryBookValueCentimes:1000,valuationVarianceCentimes:0}],
  returns:[{returnId:'R-PUR-1',ledgerVersion:2,originalInvoiceId:'PUR-1',originalInvoiceType:'purchase_invoice',returnType:'PURCHASE_RETURN',status:'POSTED',
   items:[{productId:'P-1',quantityMicroUnits:1000000,unitPriceCentimes:1000,lineTotalCentimes:1000,originalLineTotalCentimes:2000,originalQuantityMicroUnits:2000000,previouslyReturnedMicroUnits:0,restoredInventoryCostCentimes:0,inventoryBookValueCentimes:1000,valuationVarianceCentimes:0}],
   totalCentimes:1000,debtReductionCentimes:0,cashRefundCentimes:1000,supplierCreditCentimes:0,
   stockMovementIds:['SM-PUR-RET'],financialMovementIds:['CM-PUR-RET']}]
 };
 assert.equal(R.validateReverseLedgerParity(state),true);
 assert.throws(()=>R.validateReverseLedgerParity({...state,stockMovements:[{...state.stockMovements[0],qty:1}]}),/invalid direction/);
});

test('supplier settlement allocations bind to the supplier payment ledger and exact supplier', () => {
 const invoice={id:'PUR-1',supplierId:'SUP-1',paid:10};
 const initialPayment={id:'SP-1',supplierId:'SUP-1',type:'payment',referenceType:'purchase_invoice',referenceId:'PUR-1',amount:5};
 const laterPayment={id:'SP-2',supplierId:'SUP-1',type:'payment',referenceType:'supplier_payment',referenceId:'SP-2',amount:5};
 const state={customers:[],suppliers:[{id:'SUP-1'}],invoices:[],purchases:[invoice],supplierMovements:[initialPayment,laterPayment]};
 const first=R.sealSettlementAllocation(state,{allocationId:'SA-1',partyType:'supplier',partyId:'SUP-1',invoiceType:'purchase_invoice',invoiceId:'PUR-1',sourceMovementId:'SP-1',sourceMovementType:'purchase_invoice',amountCentimes:500,createdAt:'2026-10-30T12:00:00Z'});
 const second=R.sealSettlementAllocation({...state,settlementAllocations:[first]},{allocationId:'SA-2',partyType:'supplier',partyId:'SUP-1',invoiceType:'purchase_invoice',invoiceId:'PUR-1',sourceMovementId:'SP-2',sourceMovementType:'supplier_payment',amountCentimes:500,createdAt:'2026-10-30T12:01:00Z'});
 assert.equal(first.ledgerVersion,2);
 assert.equal(second.ledgerVersion,2);
 assert.throws(()=>R.sealSettlementAllocation(state,{allocationId:'SA-3',partyType:'supplier',partyId:'SUP-OTHER',invoiceType:'purchase_invoice',invoiceId:'PUR-1',sourceMovementId:'SP-1',sourceMovementType:'purchase_invoice',amountCentimes:500,createdAt:'2026-10-30T12:02:00Z'}),/allocation party does not match invoice/);
});

test('draft return ceiling accounts for all previously posted returns', () => {
 const state={
  customers:[],suppliers:[],
  invoices:[{id:'S-CEILING',customerObj:{id:'C-1'},items:[{id:'P-1',qty:2,price:10000}]}],
  purchases:[],clientMovements:[],settlementAllocations:[],
  cashMovements:[{id:'CM-POSTED',type:'subtract',amount:10000,referenceType:'sales_return',referenceId:'R-POSTED'}],
  supplierMovements:[],
  stockMovements:[
   {id:'SALE-ORIGINAL-CEILING',productId:'P-1',qty:-2,type:'SALE_OUT',referenceType:'sales_invoice',referenceId:'S-CEILING',originalSaleQuantityMicroUnits:2000000,originalSaleCostCentimes:0},
   {id:'SM-POSTED',productId:'P-1',qty:1,type:'RETURN_IN',referenceType:'sales_return',referenceId:'R-POSTED',restoredInventoryCostCentimes:0}
  ],
  returns:[{returnId:'R-POSTED',ledgerVersion:2,originalInvoiceId:'S-CEILING',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'POSTED',
   items:[{productId:'P-1',quantityMicroUnits:1000000,unitPriceCentimes:1000000,lineTotalCentimes:1000000,originalLineTotalCentimes:2000000,originalQuantityMicroUnits:2000000,previouslyReturnedMicroUnits:0,restoredInventoryCostCentimes:0,inventoryBookValueCentimes:0,valuationVarianceCentimes:0}],
   totalCentimes:1000000,debtReductionCentimes:0,cashRefundCentimes:1000000,supplierCreditCentimes:0,
   stockMovementIds:['SM-POSTED'],financialMovementIds:['CM-POSTED']}]
 };
 const before=JSON.stringify(state);
 assert.throws(()=>R.sealReturnDocument(state,{
  returnId:'R-DRAFT',originalInvoiceId:'S-CEILING',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'DRAFT',
  items:[{productId:'P-1',quantityMicroUnits:1000001,unitPriceCentimes:1000000,lineTotalCentimes:1000001,originalLineTotalCentimes:2000000,originalQuantityMicroUnits:2000000,previouslyReturnedMicroUnits:1000000}],
  totalCentimes:1000001,debtReductionCentimes:0,cashRefundCentimes:0,createdAt:'2026-10-30T12:03:00Z',operatorId:'U-1',reason:'remaining ceiling'
 }),/return quantity exceeds remaining original quantity/);
 assert.equal(JSON.stringify(state),before,'failed draft sealing must not mutate existing posted return state');
});


test('customer v2 ledger reconciles opening debt, new invoice debit and explicitly allocated receipts', () => {
 const customer={id:'C-CYCLE',debt:10000,ledgerVersion:2};
 const invoice={id:'S-CYCLE',customerId:'C-CYCLE',total:0.30,paid:0.10,remaining:0.20};
 const state={
  customers:[customer],invoices:[invoice],purchases:[],returns:[],
  clientMovements:[],settlementAllocations:[],
  cashMovements:[
   {id:'CM-SALE-CYCLE',type:'add',amount:0.10,referenceType:'sales_invoice',referenceId:'S-CYCLE'},
   {id:'CM-RECEIPT-CYCLE',type:'add',amount:0.15,referenceType:'customer_debt',referenceId:'C-CYCLE'}
  ]
 };
 const opening=R.sealClientMovement(state,{movementId:'CL-OPEN-CYCLE',clientId:'C-CYCLE',type:'opening_balance',amountCentimes:1000000,direction:'debit',referenceType:'opening_balance',referenceId:'C-CYCLE',createdAt:'2026-10-30T12:00:00Z'});
 state.clientMovements.push(opening);
 customer.debt=10000.20;
 const debit=R.sealClientMovement(state,{movementId:'CL-INVOICE-CYCLE',clientId:'C-CYCLE',type:'invoice_debit',amountCentimes:20,direction:'debit',referenceType:'sales_invoice',referenceId:'S-CYCLE',createdAt:'2026-10-30T12:01:00Z'});
 state.clientMovements.push(debit);
 customer.debt=10000.05;
 const receipt=R.sealClientMovement(state,{movementId:'CL-RECEIPT-CYCLE',clientId:'C-CYCLE',type:'receipt',amountCentimes:15,direction:'credit',referenceType:'customer_debt',referenceId:'C-CYCLE',createdAt:'2026-10-30T12:02:00Z'});
 state.clientMovements.push(receipt);
 const immediate=R.sealSettlementAllocation(state,{allocationId:'ALLOC-IMMEDIATE',partyType:'customer',partyId:'C-CYCLE',invoiceType:'sales_invoice',invoiceId:'S-CYCLE',sourceMovementId:'CM-SALE-CYCLE',sourceMovementType:'sales_invoice',amountCentimes:10,createdAt:'2026-10-30T12:03:00Z'});
 state.settlementAllocations.push(immediate);
 const later=R.sealSettlementAllocation(state,{allocationId:'ALLOC-LATER',partyType:'customer',partyId:'C-CYCLE',invoiceType:'sales_invoice',invoiceId:'S-CYCLE',sourceMovementId:'CM-RECEIPT-CYCLE',sourceMovementType:'customer_debt',amountCentimes:15,createdAt:'2026-10-30T12:04:00Z'});
 state.settlementAllocations.push(later);
 assert.equal(R.validateReverseLedgerParity(state),true);
 assert.equal(state.clientMovements.reduce((sum,row)=>sum+(row.direction==='debit'?row.amountCentimes:-row.amountCentimes),0),1000005);
 assert.equal(state.settlementAllocations.reduce((sum,row)=>sum+row.amountCentimes,0),25);
 assert.equal(invoice.paid,0.10,'posted invoice paid amount must remain immutable');
 assert.equal(invoice.remaining,0.20,'posted invoice remaining field must remain immutable');
 assert.equal(Math.round(invoice.total*100)-Math.round(invoice.paid*100)-state.settlementAllocations.filter(x=>x.sourceMovementType==='customer_debt').reduce((sum,x)=>sum+x.amountCentimes,0),5,'current outstanding is derived from later allocations');
});

test('client receipt ledger cannot be sealed when customer debt does not include the receipt', () => {
 const state={customers:[{id:'C-RECEIPT',debt:9.98,ledgerVersion:2}],invoices:[],purchases:[],returns:[],
  clientMovements:[{ledgerVersion:2,movementId:'OPEN-R',clientId:'C-RECEIPT',type:'opening_balance',amountCentimes:1000,direction:'debit',referenceType:'opening_balance',referenceId:'C-RECEIPT',createdAt:'2026-10-30T12:00:00Z'}]};
 assert.throws(()=>R.sealClientMovement(state,{movementId:'RECEIPT-R',clientId:'C-RECEIPT',type:'receipt',amountCentimes:1,direction:'credit',referenceType:'customer_debt',referenceId:'C-RECEIPT',createdAt:'2026-10-30T12:01:00Z'}),/does not match customer debt/);
});


function saleReturnState() {
 const customer={id:'C-RET',name:'Customer',debt:0.20};
 const invoice={id:'INV-RET',customerId:'C-RET',customerObj:customer,total:0.30,paid:0.10,remaining:0.20,
  items:[{id:'P-RET',qty:3,price:0.10}],warehouse:'المخزن الرئيسي'};
 const product={id:'P-RET',name:'Tea',stock:0,buyPrice:0.05};
 return {customers:[customer],suppliers:[],invoices:[invoice],purchases:[],products:[product],
  cashMovements:[{id:'SALE-CASH-RET',type:'add',amount:0.10,referenceType:'sales_invoice',referenceId:'INV-RET'}],
  stockMovements:[{id:'SALE-STOCK-RET',productId:'P-RET',qty:-3,type:'SALE_OUT',referenceType:'sales_invoice',referenceId:'INV-RET',originalSaleQuantityMicroUnits:3000000,originalSaleCostCentimes:15}],
  clientMovements:[],supplierMovements:[],settlementAllocations:[],returns:[],customerCreditMovements:[],
  caisseBalance:1,currentUser:{id:'U-RET'}};
}
function purchaseReturnState(stock=3) {
 const supplier={id:'SUP-RET',name:'Supplier',balance:0.20};
 const invoice={id:'PUR-RET',supplierId:'SUP-RET',total:0.30,paid:0.10,remaining:0.20,
  productId:'P-RET',qty:3,cost:0.10,warehouse:'المخزن الرئيسي'};
 const product={id:'P-RET',name:'Tea',stock,buyPrice:0.10};
 return {customers:[],suppliers:[supplier],invoices:[],purchases:[invoice],products:[product],
  cashMovements:[{id:'PUR-CASH-RET',type:'subtract',amount:0.10,referenceType:'purchase_invoice',referenceId:'PUR-RET'}],
  stockMovements:[{id:'PUR-STOCK-RET',productId:'P-RET',qty:3,type:'PURCHASE_IN',referenceType:'purchase_invoice',referenceId:'PUR-RET'}],
  clientMovements:[],supplierMovements:[{id:'SUP-PUR-RET',supplierId:'SUP-RET',type:'purchase',amount:0.30,referenceType:'purchase_invoice',referenceId:'PUR-RET'}],
  settlementAllocations:[],returns:[],customerCreditMovements:[],caisseBalance:1,currentUser:{id:'U-RET'}};
}

test('atomic sale return reduces invoice debt first and returns stock with exact micro-units', () => {
 const state=saleReturnState();
 const doc=R.executeReturnTransaction(state,{originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',invoiceId:'INV-RET',
  items:[{productId:'P-RET',quantity:'1'}],settlementMode:'cash',reason:'damaged'},
  {createId:()=> 'RET-SALE-1',persist:()=>true});
 assert.equal(doc.totalCentimes,10);
 assert.equal(doc.debtReductionCentimes,10);
 assert.equal(doc.cashRefundCentimes,0);
 assert.equal(state.customers[0].debt,0.10);
 assert.equal(state.products[0].stock,1);
 assert.equal(state.products[0].buyPrice,0.05);
 assert.equal(state.stockMovements[0].restoredInventoryCostCentimes,5);
 assert.equal(state.stockMovements[0].type,'RETURN_IN');
 assert.equal(state.stockMovements[0].qty,1);
 assert.equal(state.invoices[0].paid,0.10);
 assert.equal(state.invoices[0].remaining,0.20);
 assert.equal(R.validateReverseLedgerParity(state),true);
 assert.throws(()=>R.executeReturnTransaction(state,{originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',invoiceId:'INV-RET',
  items:[{productId:'P-RET',quantity:'3'}],settlementMode:'cash',reason:'over return'},{createId:()=> 'RET-SALE-OVER',persist:()=>true}),/return exceeds remaining returnable micro-units/);
});

test('sale return routes excess to documented customer credit or cash refund', () => {
 const creditState=saleReturnState();
 const creditDoc=R.executeReturnTransaction(creditState,{originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',invoiceId:'INV-RET',
  items:[{productId:'P-RET',quantity:'3'}],settlementMode:'credit',reason:'full line return'},
  {createId:()=> 'RET-SALE-CREDIT',persist:()=>true});
 assert.equal(creditDoc.debtReductionCentimes,20);
 assert.equal(creditDoc.customerCreditCentimes,10);
 assert.equal(creditState.customers[0].debt,0);
 assert.equal(creditState.customers[0].creditBalanceCentimes,10);
 assert.equal(creditState.customerCreditMovements[0].amountCentimes,10);
 assert.equal(creditState.caisseBalance,1);
 assert.equal(R.validateReverseLedgerParity(creditState),true);

 const cashState=saleReturnState();
 const cashDoc=R.executeReturnTransaction(cashState,{originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',invoiceId:'INV-RET',
  items:[{productId:'P-RET',quantity:'3'}],settlementMode:'cash',reason:'full line return'},
  {createId:()=> 'RET-SALE-CASH',persist:()=>true});
 assert.equal(cashDoc.cashRefundCentimes,10);
 assert.equal(cashState.caisseBalance,0.90);
 assert.equal(cashState.cashMovements[0].type,'subtract');
 assert.equal(cashState.customers[0].debt,0);
 assert.equal(R.validateReverseLedgerParity(cashState),true);

 const lowCash=saleReturnState();
 lowCash.caisseBalance=0.05;
 const beforeLowCash=JSON.stringify(lowCash);
 assert.throws(()=>R.executeReturnTransaction(lowCash,{originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',invoiceId:'INV-RET',
  items:[{productId:'P-RET',quantity:'3'}],settlementMode:'cash',reason:'cash short'},
  {createId:()=> 'RET-SALE-LOW-CASH',persist:()=>true}),/cash balance is insufficient/);
 assert.equal(JSON.stringify(lowCash),beforeLowCash);
});

test('purchase return checks current stock and records debt reduction plus supplier credit or cash', () => {
 const creditState=purchaseReturnState();
 const creditDoc=R.executeReturnTransaction(creditState,{originalInvoiceType:'purchase_invoice',returnType:'PURCHASE_RETURN',invoiceId:'PUR-RET',
  items:[{productId:'P-RET',quantity:'3'}],settlementMode:'credit',reason:'supplier defect'},
  {createId:()=> 'RET-PUR-CREDIT',persist:()=>true});
 assert.equal(creditDoc.debtReductionCentimes,20);
 assert.equal(creditDoc.supplierCreditCentimes,10);
 assert.equal(creditState.suppliers[0].balance,0);
 assert.equal(creditState.suppliers[0].creditBalanceCentimes,10);
 assert.equal(creditState.supplierMovements[0].type,'return_credit');
 assert.equal(creditState.supplierMovements[0].amount,0.30);
 assert.equal(creditState.products[0].stock,0);
 assert.equal(creditState.stockMovements[0].type,'RETURN_OUT');
 assert.equal(R.validateReverseLedgerParity(creditState),true);

 const cashState=purchaseReturnState();
 const cashDoc=R.executeReturnTransaction(cashState,{originalInvoiceType:'purchase_invoice',returnType:'PURCHASE_RETURN',invoiceId:'PUR-RET',
  items:[{productId:'P-RET',quantity:'3'}],settlementMode:'cash',reason:'supplier refund'},
  {createId:()=> 'RET-PUR-CASH',persist:()=>true});
 assert.equal(cashDoc.cashRefundCentimes,10);
 assert.equal(cashState.caisseBalance,1.10);
 assert.equal(cashState.cashMovements[0].type,'add');
 assert.equal(cashState.suppliers[0].balance,0);
 assert.equal(R.validateReverseLedgerParity(cashState),true);

 const insufficient=purchaseReturnState(2);
 const before=JSON.stringify(insufficient);
 assert.throws(()=>R.executeReturnTransaction(insufficient,{originalInvoiceType:'purchase_invoice',returnType:'PURCHASE_RETURN',invoiceId:'PUR-RET',
  items:[{productId:'P-RET',quantity:'3'}],settlementMode:'cash',reason:'not enough stock'},
  {createId:()=> 'RET-PUR-LOW',persist:()=>true}),/not available in current warehouse stock/);
 assert.equal(JSON.stringify(insufficient),before);
});

test('invoice cancellation reverses full stock, debt and cash and refuses prior partial returns', () => {
 const sale=saleReturnState();
 const cancelled=R.executeReturnTransaction(sale,{originalInvoiceType:'sales_invoice',returnType:'INVOICE_CANCEL',invoiceId:'INV-RET',reason:'duplicate invoice'},
  {createId:()=> 'RET-CANCEL-SALE',persist:()=>true});
 assert.equal(cancelled.totalCentimes,30);
 assert.equal(cancelled.debtReductionCentimes,20);
 assert.equal(cancelled.cashRefundCentimes,10);
 assert.equal(sale.invoices[0].status,'CANCELLED');
 assert.equal(sale.customers[0].debt,0);
 assert.equal(sale.caisseBalance,0.90);
 assert.equal(sale.products[0].stock,3);
 assert.equal(R.validateReverseLedgerParity(sale),true);

 const purchase=purchaseReturnState();
 R.executeReturnTransaction(purchase,{originalInvoiceType:'purchase_invoice',returnType:'INVOICE_CANCEL',invoiceId:'PUR-RET',reason:'duplicate purchase'},
  {createId:()=> 'RET-CANCEL-PUR',persist:()=>true});
 assert.equal(purchase.purchases[0].status,'CANCELLED');
 assert.equal(purchase.suppliers[0].balance,0);
 assert.equal(purchase.caisseBalance,1.10);
 assert.equal(purchase.products[0].stock,0);
 assert.equal(R.validateReverseLedgerParity(purchase),true);

 const partial=saleReturnState();
 R.executeReturnTransaction(partial,{originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',invoiceId:'INV-RET',
  items:[{productId:'P-RET',quantity:'1'}],reason:'partial',settlementMode:'cash'},
  {createId:()=> 'RET-BEFORE-CANCEL',persist:()=>true});
 const before=JSON.stringify(partial);
 assert.throws(()=>R.executeReturnTransaction(partial,{originalInvoiceType:'sales_invoice',returnType:'INVOICE_CANCEL',invoiceId:'INV-RET',reason:'must block'},
  {createId:()=> 'RET-CANCEL-BLOCK',persist:()=>true}),/blocked after any posted partial return/);
 assert.equal(JSON.stringify(partial),before);
});

test('legacy unallocated settlements and failed persistence are rejected atomically', () => {
 const legacySale=saleReturnState();
 legacySale.cashMovements.push({id:'LEGACY-RECEIPT',type:'add',amount:0.10,referenceType:'customer_debt',referenceId:'C-RET'});
 const legacyBefore=JSON.stringify(legacySale);
 assert.throws(()=>R.executeReturnTransaction(legacySale,{originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',invoiceId:'INV-RET',
  items:[{productId:'P-RET',quantity:'1'}],reason:'legacy gate',settlementMode:'cash'},
  {createId:()=> 'RET-LEGACY',persist:()=>true}),/unallocated subsequent settlements/);
 assert.equal(JSON.stringify(legacySale),legacyBefore);

 const legacySupplier=purchaseReturnState();
 legacySupplier.supplierMovements.push({id:'LEGACY-SUP-PAY',supplierId:'SUP-RET',type:'payment',amount:0.10,
  referenceType:'supplier_payment',referenceId:'LEGACY-SUP-PAY'});
 const legacySupplierBefore=JSON.stringify(legacySupplier);
 assert.throws(()=>R.executeReturnTransaction(legacySupplier,{originalInvoiceType:'purchase_invoice',returnType:'PURCHASE_RETURN',invoiceId:'PUR-RET',
  items:[{productId:'P-RET',quantity:'1'}],reason:'legacy supplier gate',settlementMode:'cash'},
  {createId:()=> 'RET-LEGACY-SUP',persist:()=>true}),/unallocated subsequent settlements/);
 assert.equal(JSON.stringify(legacySupplier),legacySupplierBefore);

 const state=saleReturnState();
 const refs={app:state,customer:state.customers[0],product:state.products[0],cash:state.cashMovements,stock:state.stockMovements,
  clients:state.clientMovements,returns:state.returns,credits:state.customerCreditMovements};
 const before=JSON.stringify(state);
 assert.throws(()=>R.executeReturnTransaction(state,{originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',invoiceId:'INV-RET',
  items:[{productId:'P-RET',quantity:'1'}],reason:'save fail',settlementMode:'cash'},
  {createId:()=> 'RET-SAVE-FAIL',persist:()=>false}),/persistence failed/);
 assert.equal(JSON.stringify(state),before);
 assert.equal(state,refs.app);
 assert.equal(state.customers[0],refs.customer);
 assert.equal(state.products[0],refs.product);
 assert.equal(state.cashMovements,refs.cash);
 assert.equal(state.stockMovements,refs.stock);
 assert.equal(state.clientMovements,refs.clients);
 assert.equal(state.returns,refs.returns);
 assert.equal(state.customerCreditMovements,refs.credits);
});
