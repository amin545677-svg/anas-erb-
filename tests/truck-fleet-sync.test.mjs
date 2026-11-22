import test from "node:test";
import assert from "node:assert/strict";
import {createFleetState,openTrip,loadTrip,recordTruckSale,settleTrip} from "../fleet/truck-settlement-engine.mjs";
import {createMutationEnvelope} from "../sync/mutation_capture.mjs";
import {reconcilePendingMutations} from "../sync/mutation_reconciliation.mjs";

const encode=value=>JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==="bigint"?{__anasFleetBigInt:v.toString()}:v));
const initial=()=>createFleetState({products:[{id:"P1",name:"Tea",mainStock:"250.000"}],trucks:[{id:"T1",warehouseName:"شاحنة 123",stockUnits:{}}]});
const op=(base,next,id,actorId="driver-1",extraPayload={})=>{const latestTrip=[...next.trips].reverse().find(t=>String(t.driverId)===actorId);return createMutationEnvelope({type:"TRUCK_FLEET_OPERATION",payload:{baseState:base==null?null:encode(base),nextState:encode(next),warehouses:latestTrip?[{id:"wh-mobile-123",name:latestTrip.warehouseName,type:"mobile",status:"active",assigned_user_id:latestTrip.status==="CLOSED"||latestTrip.status==="CANCELLED"?null:actorId}]:[],actorId,...extraPayload},now:()=>new Date("2026-11-21T10:00:00.000Z"),uuid:()=>id});};
const cloud=()=>({products:[{id:"P1",stock:"250.000",warehouseStock:{}}],warehouses:[],invoices:[],anasFleetState:null,appliedOpIds:[]});

test("fleet open and load replay as ordered atomic snapshots, preserve zero stock shape and never duplicate",()=>{
 const opened=openTrip(initial(),{tripId:"TRIP-1",truckId:"T1",driverId:"driver-1",driverName:"Driver"},"open").state;
 const openOp=op(null,opened,"truck-open-1");
 const first=reconcilePendingMutations(cloud(),[{...openOp,status:"PENDING"}]);
 assert.equal(first.review.length,0);
 assert.equal(first.snapshot.products[0].stock,"250.000");
 assert.deepEqual(first.snapshot.anasFleetState.trucks[0].stockUnits,{});
 assert.equal(first.snapshot.warehouses[0].name,"شاحنة 123");
 assert.equal(first.snapshot.warehouses[0].type,"mobile");
 const loaded=loadTrip(opened,"TRIP-1",[{productId:"P1",quantity:"100"}],"load",{id:"driver-1"}).state;
 const loadOp=op(opened,loaded,"truck-load-1");
 const second=reconcilePendingMutations(first.snapshot,[{...loadOp,status:"PENDING"}]);
 assert.equal(second.review.length,0);
 assert.equal(second.appliedNow[0].outcome,"applied");
 assert.equal(second.snapshot.products[0].stock,"150.000");
 assert.equal(second.snapshot.products[0].warehouseStock["شاحنة 123"],"100.000");
 assert.equal(second.snapshot.anasFleetState.trucks[0].stockUnits.P1.__anasFleetBigInt,"100000");
 assert.equal(second.snapshot.warehouses.length,1,"replay must not duplicate the truck warehouse record");
 const duplicate=reconcilePendingMutations(second.snapshot,[{...loadOp,status:"PENDING"}]);
 assert.equal(duplicate.appliedNow[0].outcome,"folded-duplicate");
 assert.equal(duplicate.snapshot.products[0].stock,"150.000");
});

test("closing a trip releases its warehouse assignment and a second driver can claim it safely",()=>{
 const opened=openTrip(initial(),{tripId:"TRIP-1",truckId:"T1",driverId:"driver-1"},"open").state;
 const openedOp=op(null,opened,"open-1");
 const cloudOpen=reconcilePendingMutations(cloud(),[{...openedOp,status:"PENDING"}]).snapshot;
 const loaded=loadTrip(opened,"TRIP-1",[{productId:"P1",quantity:"100"}],"load").state;
 const loadOp=op(opened,loaded,"load-1");
 const cloudLoaded=reconcilePendingMutations(cloudOpen,[{...loadOp,status:"PENDING"}]).snapshot;
 const closed=settleTrip(loaded,"TRIP-1",{actualCounts:{P1:"100"},actualCash:"0"},"close",{id:"driver-1",canApproveVariance:true}).state;
 const closeOp=op(loaded,closed,"close-1");
 const cloudClosed=reconcilePendingMutations(cloudLoaded,[{...closeOp,status:"PENDING"}]);
 assert.equal(cloudClosed.review.length,0);
 assert.equal(cloudClosed.snapshot.products[0].stock,"250.000");
 assert.equal(cloudClosed.snapshot.products[0].warehouseStock["شاحنة 123"],"0.000");
 assert.equal(cloudClosed.snapshot.warehouses[0].assigned_user_id,null);
 const reopened=openTrip(closed,{tripId:"TRIP-2",truckId:"T1",driverId:"driver-2"},"reopen").state;
 const reopenOp=op(closed,reopened,"reopen-2","driver-2");
 const cloudReopened=reconcilePendingMutations(cloudClosed.snapshot,[{...reopenOp,status:"PENDING"}]);
 assert.equal(cloudReopened.review.length,0);
 assert.equal(cloudReopened.snapshot.warehouses[0].assigned_user_id,"driver-2");
});

test("POS sale invoice is not deducted twice when its linked fleet sale follows SALE_INVOICE",()=>{
 let state=initial();
 state=openTrip(state,{tripId:"TRIP-1",truckId:"T1",driverId:"driver-1"},"open").state;
 state=loadTrip(state,"TRIP-1",[{productId:"P1",quantity:"100"}],"load").state;
 const base=state;
 state=recordTruckSale(state,"TRIP-1",{productId:"P1",quantity:"60",catalogPrice:"10",salePrice:"10",cashPaid:"600",invoiceId:"INV-1",saleId:"INV-1:P1"},"sale",{id:"driver-1"}).state;
 const operation=op(base,state,"truck-sale-1");
 const snapshot={products:[{id:"P1",stock:"150.000",warehouseStock:{"شاحنة 123":"40.000"}}],warehouses:[],invoices:[{id:"INV-1",warehouse:"شاحنة 123"}],anasFleetState:encode(base),appliedOpIds:[]};
 const result=reconcilePendingMutations(snapshot,[{...operation,status:"PENDING"}]);
 assert.equal(result.review.length,0);
 assert.equal(result.snapshot.products[0].stock,"150.000");
 assert.equal(result.snapshot.products[0].warehouseStock["شاحنة 123"],"40.000");
 assert.equal(result.snapshot.anasFleetState.trucks[0].stockUnits.P1.__anasFleetBigInt,"40000");
 assert.equal(result.snapshot.warehouses.length,1);
});

test("concurrent fleet changes are quarantined with both cloud and local snapshots for 409 review",()=>{
 let local=initial();
 local=openTrip(local,{tripId:"LOCAL-TRIP",truckId:"T1",driverId:"driver-1"},"open-local").state;
 let remote=initial();
 remote=openTrip(remote,{tripId:"REMOTE-TRIP",truckId:"T1",driverId:"driver-2"},"open-remote").state;
 const next=loadTrip(local,"LOCAL-TRIP",[{productId:"P1",quantity:"1"}],"local-load").state;
 const operation=op(local,next,"truck-conflict");
 const snapshot={products:[{id:"P1",stock:"250.000",warehouseStock:{}}],warehouses:[],invoices:[],anasFleetState:encode(remote),appliedOpIds:[]};
 const result=reconcilePendingMutations(snapshot,[{...operation,status:"PENDING"}]);
 assert.equal(result.review.length,1);
 assert.equal(result.review[0].reason,"TRUCK_FLEET_STATE_CONFLICT");
 assert.ok(result.review[0].cloudState);
 assert.ok(result.review[0].localState);
 assert.equal(result.snapshot.anasFleetState.trips[0].id,"REMOTE-TRIP");
 assert.equal(result.snapshot.warehouses.length,0,"a quarantined local operation must not partially write its warehouse");
});

test("fleet sale waits for its linked POS invoice instead of silently double-posting stock",()=>{
 let state=initial();
 state=openTrip(state,{tripId:"TRIP-1",truckId:"T1",driverId:"driver-1"},"open").state;
 state=loadTrip(state,"TRIP-1",[{productId:"P1",quantity:"10"}],"load").state;
 const base=state;
 state=recordTruckSale(state,"TRIP-1",{productId:"P1",quantity:"2",catalogPrice:"10",salePrice:"10",cashPaid:"20",invoiceId:"INV-MISSING",saleId:"INV-MISSING:P1"},"sale").state;
 const operation=op(base,state,"truck-sale-missing");
 const snapshot={products:[{id:"P1",stock:"240.000",warehouseStock:{"شاحنة 123":"8.000"}}],warehouses:[],invoices:[],anasFleetState:encode(base),appliedOpIds:[]};
 const result=reconcilePendingMutations(snapshot,[{...operation,status:"PENDING"}]);
 assert.equal(result.review[0].reason,"TRUCK_FLEET_LINKED_INVOICE_NOT_SYNCED");
 assert.equal(result.snapshot.products[0].warehouseStock["شاحنة 123"],"8.000");
 assert.equal(result.snapshot.warehouses.length,0,"a rejected fleet sale must not partially create a warehouse record");
});


test("fleet POS bundle replays cash, stock and centime ledgers atomically after 409",()=>{
 let state=initial();
 state=openTrip(state,{tripId:"TRIP-POS",truckId:"T1",driverId:"driver-1"},"open-pos").state;
 state=loadTrip(state,"TRIP-POS",[{productId:"P1",quantity:"100"}],"load-pos").state;
 const base=state;
 state=recordTruckSale(state,"TRIP-POS",{productId:"P1",quantity:"1",catalogPrice:"20",salePrice:"20",cashPaid:"10",invoiceId:"INV-POS",saleId:"INV-POS:0"},"sale-pos",{id:"driver-1"}).state;
 const customer={id:"C1",name:"Customer",debt:0,ledgerVersion:2};
 const invoice={id:"INV-POS",customerId:"C1",total:20,paid:10,remaining:10,paymentMethod:"partial",paymentChannel:"cash",warehouse:"شاحنة 123",items:[{id:"P1",qty:1,price:20}]};
 const cash={id:"CASH-INV-POS",type:"add",amount:10,referenceType:"sales_invoice",referenceId:"INV-POS"};
 const stock={id:"STOCK-INV-POS",productId:"P1",qty:-1,type:"SALE_OUT",referenceType:"sales_invoice",referenceId:"INV-POS",warehouse:"شاحنة 123"};
 const client={movementId:"CLIENT-INV-POS",clientId:"C1",type:"invoice_debit",amountCentimes:1000,direction:"debit",referenceType:"sales_invoice",referenceId:"INV-POS"};
 const allocation={allocationId:"ALLOC-INV-POS",partyType:"customer",partyId:"C1",invoiceType:"sales_invoice",invoiceId:"INV-POS",sourceMovementId:"CASH-INV-POS",sourceMovementType:"sales_invoice",amountCentimes:1000};
 const audit={id:"AUD-INV-POS",opId:"fleet-pos-bundle",eventType:"SALE_COMMITTED",entityType:"sales_invoice",entityId:"INV-POS",referenceType:"sales_invoice",referenceId:"INV-POS",amountCentimes:2000,paidCentimes:1000,remainingCentimes:1000,createdAt:"2026-11-21T10:00:00.000Z"};
 const collectionDeltas={invoices:{before:[],after:[invoice]},customers:{before:[customer],after:[{...customer,debt:10}]},cashMovements:{before:[],after:[cash]},stockMovements:{before:[],after:[stock]},clientMovements:{before:[],after:[client]},settlementAllocations:{before:[],after:[allocation]},auditTrail:{before:[],after:[audit]}};
 const operation=op(base,state,"fleet-pos-bundle","driver-1",{collectionDeltas,caisseBalanceDelta:{before:0,after:10}});
 const snapshot={...cloud(),products:[{id:"P1",stock:"150.000",warehouseStock:{"شاحنة 123":"99.000"}}],customers:[customer],anasFleetState:encode(base),caisseBalance:0,cashMovements:[],stockMovements:[],clientMovements:[],settlementAllocations:[],auditTrail:[]};
 const result=reconcilePendingMutations(snapshot,[{...operation,status:"PENDING"}]);
 assert.deepEqual(result.review,[]);
 assert.equal(result.snapshot.invoices.length,1);
 assert.equal(result.snapshot.cashMovements.length,1);
 assert.equal(result.snapshot.stockMovements.length,1);
 assert.equal(result.snapshot.clientMovements.length,1);
 assert.equal(result.snapshot.settlementAllocations.length,1);
 assert.equal(result.snapshot.customers[0].debt,10);
 assert.equal(result.snapshot.caisseBalance,10);
 assert.equal(result.snapshot.products[0].warehouseStock["شاحنة 123"],"99.000");
 const invalid={...operation,payload:{...operation.payload,collectionDeltas:{...collectionDeltas,cashMovements:{before:[],after:[{...cash,amount:"10.001"}]}}}};
 const rejected=reconcilePendingMutations(snapshot,[{...invalid,status:"PENDING"}]);
 assert.equal(rejected.review[0]?.reason,"TRUCK_FLEET_COLLECTION_DELTA_NOT_APPEND_ONLY");
 assert.equal(rejected.snapshot.caisseBalance,0);
 assert.equal(rejected.snapshot.cashMovements.length,0);
});
test("atomic fleet POS bundle deducts truck warehouse stock once when invoice and stock ledger are new in the same operation",()=>{
 let state=initial();
 state=openTrip(state,{tripId:"TRIP-BUNDLED-POS",truckId:"T1",driverId:"driver-1"},"open-bundled-pos").state;
 state=loadTrip(state,"TRIP-BUNDLED-POS",[{productId:"P1",quantity:"100"}],"load-bundled-pos").state;
 const base=state;
 state=recordTruckSale(state,"TRIP-BUNDLED-POS",{productId:"P1",quantity:"1",catalogPrice:"10",salePrice:"10",cashPaid:"10",invoiceId:"INV-BUNDLED-POS",saleId:"INV-BUNDLED-POS:0"},"sale-bundled-pos",{id:"driver-1"}).state;
 const invoice={id:"INV-BUNDLED-POS",total:10,paid:10,remaining:0,paymentChannel:"cash",warehouse:"شاحنة 123",items:[{id:"P1",qty:1,price:10}]};
 const cash={id:"CASH-INV-BUNDLED-POS",type:"add",amount:10,referenceType:"sales_invoice",referenceId:"INV-BUNDLED-POS"};
 const stock={id:"STOCK-INV-BUNDLED-POS",productId:"P1",qty:-1,type:"SALE_OUT",referenceType:"sales_invoice",referenceId:"INV-BUNDLED-POS",warehouse:"شاحنة 123"};
 const collectionDeltas={invoices:{before:[],after:[invoice]},cashMovements:{before:[],after:[cash]},stockMovements:{before:[],after:[stock]}};
 const operation=op(base,state,"fleet-bundled-pos","driver-1",{collectionDeltas,caisseBalanceDelta:{before:0,after:10}});
 const snapshot={...cloud(),products:[{id:"P1",stock:"150.000",warehouseStock:{"شاحنة 123":"100.000"}}],warehouses:[],invoices:[],cashMovements:[],stockMovements:[],anasFleetState:encode(base),caisseBalance:0};
 const result=reconcilePendingMutations(snapshot,[{...operation,status:"PENDING",localSeq:1}]);
 assert.deepEqual(result.review,[]);
 assert.equal(result.snapshot.products[0].stock,"150.000");
 assert.equal(result.snapshot.products[0].warehouseStock["شاحنة 123"],"99.000");
 assert.equal(result.snapshot.anasFleetState.trucks[0].stockUnits.P1.__anasFleetBigInt,"99000");
 assert.equal(result.snapshot.anasFleetState.trips[0].sales.length,1);
 assert.equal(result.snapshot.invoices.length,1);
 assert.equal(result.snapshot.cashMovements.length,1);
 assert.equal(result.snapshot.stockMovements.length,1);
 assert.equal(result.snapshot.caisseBalance,10);
});

test("fleet POS bank settlement replays bank ledger without touching the cashbox",()=>{
 let state=initial();
 state=openTrip(state,{tripId:"TRIP-BANK",truckId:"T1",driverId:"driver-1"},"open-bank").state;
 state=loadTrip(state,"TRIP-BANK",[{productId:"P1",quantity:"100"}],"load-bank").state;
 const base=state;
 state=recordTruckSale(state,"TRIP-BANK",{productId:"P1",quantity:"1",catalogPrice:"10",salePrice:"10",cashPaid:"0",invoiceId:"INV-BANK",saleId:"INV-BANK:0"},"sale-bank",{id:"driver-1"}).state;
 const invoice={id:"INV-BANK",total:10,paid:10,remaining:0,paymentChannel:"transfer",warehouse:"شاحنة 123",items:[{id:"P1",qty:1,price:10}]};
 const bank={id:"BANK-INV-BANK",type:"add",amount:10,paymentChannel:"transfer",cashImpact:false,referenceType:"sales_invoice",referenceId:"INV-BANK"};
 const stock={id:"STOCK-INV-BANK",productId:"P1",qty:-1,type:"SALE_OUT",referenceType:"sales_invoice",referenceId:"INV-BANK",warehouse:"شاحنة 123"};
 const collectionDeltas={invoices:{before:[],after:[invoice]},bankMovements:{before:[],after:[bank]},stockMovements:{before:[],after:[stock]}};
 const operation=op(base,state,"fleet-bank-bundle","driver-1",{collectionDeltas});
 const snapshot={...cloud(),products:[{id:"P1",stock:"150.000",warehouseStock:{"شاحنة 123":"99.000"}}],anasFleetState:encode(base),caisseBalance:0,bankMovements:[],stockMovements:[]};
 const result=reconcilePendingMutations(snapshot,[{...operation,status:"PENDING"}]);
 assert.deepEqual(result.review,[]);
 assert.equal(result.snapshot.bankMovements.length,1);
 assert.equal(result.snapshot.caisseBalance,0);
});