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
 assert.equal(m.amountCentimes,725); assert.equal(m.ledgerVersion,2);
 assert.throws(()=>R.makeClientMovement({...m,amountCentimes:0}),/positive safe integer/);
 assert.throws(()=>R.makeClientMovement({...m,amountCentimes:9007199254740992}),/positive safe integer/);
});
test('allocation requires matching party and invoice domains', () => {
 const base={allocationId:'A-1',partyType:'customer',partyId:'C-1',invoiceType:'sales_invoice',invoiceId:'S-1',sourceMovementId:'M-1',sourceMovementType:'customer_debt',amountCentimes:500,createdAt:'2026-10-30T12:00:00Z'};
 assert.equal(R.makeSettlementAllocation(base).ledgerVersion,2);
 assert.throws(()=>R.makeSettlementAllocation({...base,partyType:'supplier'}),/party and invoice types do not match/);
});
test('return document validates exact BigInt micro-unit line totals', () => {
 const d=R.makeReturnDocument({returnId:'R-1',originalInvoiceId:'S-1',returnType:'SALE_RETURN',items:[{productId:'P-1',quantityMicroUnits:3000000,unitPriceCentimes:10,lineTotalCentimes:30}],totalCentimes:30,debtReductionCentimes:20,cashRefundCentimes:10,status:'DRAFT',createdAt:'2026-10-30T12:00:00Z',operatorId:'U-1',reason:'damaged'});
 assert.equal(d.totalCentimes,30); assert.equal(d.ledgerVersion,2);
 assert.throws(()=>R.makeReturnDocument({...d,totalCentimes:31}),/return total does not equal line totals/);
 assert.throws(()=>R.makeReturnDocument({...d,cashRefundCentimes:11}),/settlement exceeds return value/);
});
test('returnable quantity ceiling is exact and rejects over-return', () => {
 assert.equal(R.computeReturnableMicroUnits(9007199254740990n,3000000n),9007199251740990n);
 assert.throws(()=>R.computeReturnableMicroUnits(3,4),/invalid return quantity ceiling/);
});
test('allocation validator rejects orphan, mismatch and over-allocation', () => {
 const invoice={id:'S-1',customerId:'C-1'}, movement={id:'M-1',amountCentimes:1000};
 const a={allocationId:'A-1',partyType:'customer',partyId:'C-1',invoiceType:'sales_invoice',invoiceId:'S-1',sourceMovementId:'M-1',amountCentimes:700};
 const state={invoices:[invoice],cashMovements:[movement],settlementAllocations:[a]};
 assert.equal(R.validateSettlementAllocations(state),true);
 assert.throws(()=>R.validateSettlementAllocations({...state,invoices:[]}),/orphan settlement allocation/);
 assert.throws(()=>R.validateSettlementAllocations({...state,invoices:[{...invoice,customerId:'C-2'}]}),/allocation party does not match invoice/);
 assert.throws(()=>R.validateSettlementAllocations({...state,settlementAllocations:[a,{...a,allocationId:'A-2',amountCentimes:400}]}),/allocations exceed source movement amount/);
});
test('appendUnique rejects replay without mutating original list', () => {
 const original=[{returnId:'R-1'}], next=R.appendUnique(original,{returnId:'R-2'},'returnId');
 assert.equal(original.length,1); assert.equal(next.length,2);
 assert.throws(()=>R.appendUnique(next,{returnId:'R-2'},'returnId'),/duplicate returnId/);
});
