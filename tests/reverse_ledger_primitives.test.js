'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../reverse-ledger/reverse-ledger.js');

test('initializes new collections without rewriting legacy records', () => {
 const invoice={id:'S-1',total:100,paid:20}; const state={invoices:[invoice],customers:[{id:'C-1',debt:80}]};
 const next=R.ensureCollections(state);
 assert.deepEqual(next.clientMovements,[]); assert.deepEqual(next.settlementAllocations,[]); assert.deepEqual(next.returns,[]);
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
 const d=R.makeReturnDocument({returnId:'R-1',originalInvoiceId:'S-1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',items:[{productId:'P-1',quantityMicroUnits:3000000,unitPriceCentimes:10,lineTotalCentimes:30}],totalCentimes:30,debtReductionCentimes:20,cashRefundCentimes:10,status:'DRAFT',createdAt:'2026-10-30T12:00:00Z',operatorId:'U-1',reason:'damaged'});
 assert.equal(d.totalCentimes,30); assert.equal(Object.prototype.hasOwnProperty.call(d,'ledgerVersion'),false);
 const sealed=R.sealReturnDocument({customers:[],suppliers:[],invoices:[{id:'S-1',customerObj:{id:'C-1'},items:[{id:'P-1',qty:3,price:0.1}]}],purchases:[],returns:[]},{
  ...d, originalInvoiceType:'sales_invoice'
 });
 assert.equal(sealed.ledgerVersion,2);
 assert.throws(()=>R.makeReturnDocument({...d,totalCentimes:31}),/return total does not equal line totals/);
 assert.throws(()=>R.makeReturnDocument({...d,cashRefundCentimes:11}),/settlement exceeds return value/);
 assert.throws(()=>R.makeReturnDocument({...d,items:[{productId:'P-1',quantityMicroUnits:500000,unitPriceCentimes:1,lineTotalCentimes:0}],totalCentimes:0,debtReductionCentimes:0,cashRefundCentimes:0}),/fractional centime/);
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
 assert.throws(()=>R.validateReverseLedgerParity({...state,customers:[{id:'C-1',debt:7.24,ledgerVersion:2}]}),/does not match customer debt/);
});
test('posted returns reject a one-micro-unit over-return without mutating the source state', () => {
 const state={
  customers:[],suppliers:[],
  invoices:[{id:'S-1',customerObj:{id:'C-1'},items:[{id:'P-1',qty:2,price:1000000}]}],
  purchases:[],clientMovements:[],settlementAllocations:[],cashMovements:[],supplierMovements:[],stockMovements:[],
  returns:[{returnId:'R-1',ledgerVersion:2,originalInvoiceId:'S-1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'POSTED',
   items:[{productId:'P-1',quantityMicroUnits:2000001,unitPriceCentimes:1000000,lineTotalCentimes:2000001}],
   totalCentimes:2000001,debtReductionCentimes:0,cashRefundCentimes:0,stockMovementIds:[],financialMovementIds:[]}]
 };
 const before=JSON.stringify(state);
 assert.throws(()=>R.validateReverseLedgerParity(state),/return exceeds remaining returnable micro-units/);
 assert.equal(JSON.stringify(state),before,'rejected validation must not mutate incoming data');
 const draftState={...state,returns:[]};
 assert.throws(()=>R.sealReturnDocument(draftState,{
  returnId:'R-DRAFT-OVER',originalInvoiceId:'S-1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'DRAFT',
  items:[{productId:'P-1',quantityMicroUnits:2000001,unitPriceCentimes:1000000,lineTotalCentimes:2000001}],
  totalCentimes:2000001,debtReductionCentimes:0,cashRefundCentimes:0,createdAt:'2026-10-30T12:00:00Z',operatorId:'U-1',reason:'over ceiling'
 }),/return exceeds remaining returnable micro-units/);
});
test('posted return requires matching invoice-linked stock movements', () => {
 const state={
  customers:[],suppliers:[],
  invoices:[{id:'S-1',customerObj:{id:'C-1'},items:[{id:'P-1',qty:2,price:10}]}],
  purchases:[],clientMovements:[],settlementAllocations:[],
  cashMovements:[{id:'CM-1',amount:10,referenceType:'sales_return',referenceId:'R-1'}],supplierMovements:[],
  stockMovements:[{id:'SM-1',productId:'P-1',qty:1,referenceType:'sales_return',referenceId:'R-1'}],
  returns:[{returnId:'R-1',ledgerVersion:2,originalInvoiceId:'S-1',originalInvoiceType:'sales_invoice',returnType:'SALE_RETURN',status:'POSTED',
   items:[{productId:'P-1',quantityMicroUnits:1000000,unitPriceCentimes:1000,lineTotalCentimes:1000}],
   totalCentimes:1000,debtReductionCentimes:0,cashRefundCentimes:1000,supplierCreditCentimes:0,stockMovementIds:['SM-1'],financialMovementIds:['CM-1']}]
 };
 assert.equal(R.validateReverseLedgerParity(state),true);
 assert.throws(()=>R.validateReverseLedgerParity({...state,stockMovements:[]}),/posted return stock movement is missing or mismatched/);
});

test('posted purchase return reconciles the legacy single-line purchase schema', () => {
 const state={
  customers:[],suppliers:[{id:'SUP-1',balance:0}],
  invoices:[],purchases:[{id:'PUR-1',supplierId:'SUP-1',productId:'P-1',qty:2,cost:10,total:20,paid:20}],
  clientMovements:[],settlementAllocations:[],
  cashMovements:[{id:'CM-PUR-RET',amount:10,referenceType:'purchase_return',referenceId:'R-PUR-1'}],
  supplierMovements:[],
  stockMovements:[{id:'SM-PUR-RET',productId:'P-1',qty:-1,referenceType:'purchase_return',referenceId:'R-PUR-1'}],
  returns:[{returnId:'R-PUR-1',ledgerVersion:2,originalInvoiceId:'PUR-1',originalInvoiceType:'purchase_invoice',returnType:'PURCHASE_RETURN',status:'POSTED',
   items:[{productId:'P-1',quantityMicroUnits:1000000,unitPriceCentimes:1000,lineTotalCentimes:1000}],
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
