import test from "node:test";
import assert from "node:assert/strict";
import {createFleetState,openTrip,loadTrip,recordTruckSale,recordCustomerReturn,returnToMainWarehouse,recordDamagedGoods,recordOldDebtPayment,recordFieldExpense,calculateTripInventory,settleTrip,assertFleetInvariants,toQuantityUnits,toMoneyMinor,fromQuantityUnits,fromMoneyMinor} from "../fleet/truck-settlement-engine.mjs";
const base=()=>createFleetState({products:[{id:"P1",name:"Tea",mainStock:"250.000"}],trucks:[{id:"T1",stockUnits:{}}]});
const opened=()=>openTrip(base(),{tripId:"TRIP-1",truckId:"T1",driverId:"D1"},"open").state;
test("BigInt decimal conversion is exact",()=>{assert.equal(toQuantityUnits("100.125"),100125n);assert.equal(toMoneyMinor("1234567.89"),123456789n);assert.equal(fromQuantityUnits(100125n),"100.125");assert.equal(fromMoneyMinor(123456789n),"1234567.89");assert.throws(()=>toQuantityUnits("0.0001"),/invalid decimal/);});
test("load 100, sell 60, return 10 leaves exactly 30 and duplicate actions are idempotent",()=>{let s=opened();s=loadTrip(s,"TRIP-1",[{productId:"P1",quantity:"100"}],"load").state;const dup=loadTrip(s,"TRIP-1",[{productId:"P1",quantity:"100"}],"load");assert.equal(dup.duplicate,true);s=recordTruckSale(s,"TRIP-1",{productId:"P1",quantity:"60",catalogPrice:"10",salePrice:"10",cashPaid:"600",invoiceId:"INV-1"},"sale",{id:"D1"}).state;assert.equal(recordTruckSale(s,"TRIP-1",{productId:"P1",quantity:"60",catalogPrice:"10",salePrice:"10",cashPaid:"600",invoiceId:"INV-1"},"sale",{id:"D1"}).duplicate,true);s=returnToMainWarehouse(s,"TRIP-1","P1","10","return").state;assert.equal(calculateTripInventory(s.trips[0]).P1,"30.000");const close=settleTrip(s,"TRIP-1",{actualCounts:{P1:"30"},actualCash:"600"},"close");assert.equal(close.result.status,"CLOSED");assert.equal(close.state.products[0].mainStockUnits,190000n);assert.equal(close.state.trucks[0].stockUnits.P1,0n);assert.equal(assertFleetInvariants(close.state).ok,true);});
test("customer return must link to sold invoice and restores truck stock",()=>{let s=opened();s=loadTrip(s,"TRIP-1",[{productId:"P1",quantity:"100"}],"load").state;s=recordTruckSale(s,"TRIP-1",{productId:"P1",quantity:"60",catalogPrice:"12",salePrice:"12",cashPaid:"720",invoiceId:"INV-1"},"sale",{id:"D1"}).state;assert.throws(()=>recordCustomerReturn(s,"TRIP-1",{productId:"P1",quantity:"61",invoiceId:"INV-1",reason:"return"},"bad"),/EXCEEDS_LINKED/);s=recordCustomerReturn(s,"TRIP-1",{productId:"P1",quantity:"5",invoiceId:"INV-1",reason:"عبوة سليمة"},"return",{id:"D1"}).state;assert.equal(calculateTripInventory(s.trips[0]).P1,"45.000");});
test("zero price, unauthorized below-minimum and overselling are blocked",()=>{let s=opened();s=loadTrip(s,"TRIP-1",[{productId:"P1",quantity:"10"}],"load").state;const baseSale={productId:"P1",quantity:"1",catalogPrice:"10",salePrice:"0"};assert.throws(()=>recordTruckSale(s,"TRIP-1",baseSale,"zero"),/ZERO_PRICE_BLOCKED/);assert.throws(()=>recordTruckSale(s,"TRIP-1",{...baseSale,salePrice:"8",minimumPrice:"9"},"low"),/MINIMUM_PRICE_PERMISSION_REQUIRED/);assert.throws(()=>recordTruckSale(s,"TRIP-1",{...baseSale,quantity:"11",salePrice:"10"},"over"),/INSUFFICIENT_TRUCK_STOCK/);assert.equal(s.trucks[0].stockUnits.P1,10000n);});
test("cash net is cash sales plus old debt receipts minus documented field expenses",()=>{let s=opened();s=loadTrip(s,"TRIP-1",[{productId:"P1",quantity:"10"}],"load").state;s=recordTruckSale(s,"TRIP-1",{productId:"P1",quantity:"2",catalogPrice:"10",salePrice:"10",cashPaid:"15"},"sale",{id:"D1"}).state;s=recordOldDebtPayment(s,"TRIP-1",{customerId:"C1",referenceId:"OLD-1",amount:"25"},"debt",{id:"D1"}).state;s=recordFieldExpense(s,"TRIP-1",{amount:"5",category:"وقود",receiptReference:"R-1"},"expense",{id:"D1"}).state;const r=settleTrip(s,"TRIP-1",{actualCounts:{P1:"8"},actualCash:"35"},"close");assert.equal(r.result.expectedCashMinor,3500n);assert.equal(r.result.cashVarianceMinor,0n);});
test("stock or cash variance requires manager authorization, note and audit trail",()=>{let s=opened();s=loadTrip(s,"TRIP-1",[{productId:"P1",quantity:"10"}],"load").state;const data={actualCounts:{P1:"9"},actualCash:"0",varianceNote:"نقص موثق",varianceApprovedBy:"M1"};assert.throws(()=>settleTrip(s,"TRIP-1",data,"close",{id:"M1"}),/AUTHORIZED_MANAGER/);const r=settleTrip(s,"TRIP-1",data,"close",{id:"M1",canApproveVariance:true});assert.equal(r.result.hasVariance,true);assert.equal(r.state.trips[0].settlement.inventory.P1.varianceUnits,-1000n);});
test("damaged goods require reason and actor and reduce custody",()=>{let s=opened();s=loadTrip(s,"TRIP-1",[{productId:"P1",quantity:"10"}],"load").state;assert.throws(()=>recordDamagedGoods(s,"TRIP-1","P1","1","","bad"),/DAMAGE_REQUIRES/);s=recordDamagedGoods(s,"TRIP-1","P1","1","كسر","damage",{id:"D1"}).state;assert.equal(calculateTripInventory(s.trips[0]).P1,"9.000");});


test("fleet AppData rollback restores nested business data in place", async () => {
  const { restoreFleetAppData } = await import("../fleet/truck-settlement-engine.mjs");
  const live = {
    products: [{ id: "P1", stock: "0.000", warehouseStock: { Truck: "100.000" } }],
    anasFleetState: { trips: [{ id: "T1", status: "ACTIVE" }] },
    currentUser: { id: "U1", secondaryWarehouse: "Truck" }
  };
  const identity = live;
  const before = structuredClone(live);
  live.products[0].stock = "100.000";
  live.anasFleetState.trips[0].status = "CLOSED";
  live.currentUser.secondaryWarehouse = "";
  live.extraMutation = true;
  assert.equal(restoreFleetAppData(live, before), identity);
  assert.deepEqual(live, before);
  assert.equal(Object.prototype.hasOwnProperty.call(live, "extraMutation"), false);
});

import "./truck-warehouse-reconciliation.test.mjs";
