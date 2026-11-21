/**
 * ANAS ERP fleet engine. Immutable transitions; quantities are milli-units and money is centimes.
 */
const QS=1000n, MS=100n;
function scaled(v,scale,digits,label){
  if(typeof v==="bigint"){if(v<0n)throw new RangeError(label+" must be non-negative");return v;}
  if(typeof v==="number"&&!Number.isFinite(v))throw new TypeError(label+" is not finite");
  if(typeof v!=="string"&&typeof v!=="number")throw new TypeError(label+" must be a decimal value");
  const m=/^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(String(v).trim());
  if(!m||(m[2]||"").length>digits)throw new TypeError(label+" has an invalid decimal representation");
  return BigInt(m[1])*scale+BigInt((m[2]||"").padEnd(digits,"0")||"0");
}
function fmt(v,scale,d){v=BigInt(v);const neg=v<0n;v=neg?-v:v;return(neg?"-":"")+(v/scale).toString()+"."+String(v%scale).padStart(d,"0");}
export const toQuantityUnits=v=>scaled(v,QS,3,"quantity");
export const toMoneyMinor=v=>scaled(v,MS,2,"money");
export const fromQuantityUnits=v=>fmt(v,QS,3);
export const fromMoneyMinor=v=>fmt(v,MS,2);
const cp=v=>structuredClone(v);
function arr(v,n){if(!Array.isArray(v))throw new TypeError(n+" must be an array");return v;}
function obj(v,n){if(!v||typeof v!=="object"||Array.isArray(v))throw new TypeError(n+" must be an object");}
function exact(items,id,label){const a=items.filter(x=>x&&String(x.id)===String(id));if(a.length!==1)throw new Error(a.length?label+"_ID_AMBIGUOUS:"+id:label+"_NOT_FOUND:"+id);return a[0];}
function mapBig(v){const o={};for(const [k,n] of Object.entries(v||{}))o[k]=BigInt(n);return o;}
function add(m,id,n){const k=String(id);m[k]=(m[k]||0n)+n;if(m[k]<0n)throw new Error("NEGATIVE_STOCK:"+k);}
function round(n,d){return(n+d/2n)/d;}
function expected(trip){
 const ids=new Set(["openingUnits","loadedUnits","customerReturnUnits","soldUnits","returnedToMainUnits","damagedUnits"].flatMap(k=>Object.keys(trip[k]||{})));
 const out={};for(const id of ids){out[id]=(trip.openingUnits[id]||0n)+(trip.loadedUnits[id]||0n)+(trip.customerReturnUnits[id]||0n)-(trip.soldUnits[id]||0n)-(trip.returnedToMainUnits[id]||0n)-(trip.damagedUnits[id]||0n);if(out[id]<0n)throw new Error("NEGATIVE_TRIP_EQUATION:"+id);}return out;
}
function live(state,trip){const truck=exact(state.trucks,trip.truckId,"TRUCK"),e=expected(trip),ids=new Set([...Object.keys(e),...Object.keys(truck.stockUnits||{})]);for(const id of ids)if((truck.stockUnits[id]||0n)!==(e[id]||0n))throw new Error("TRUCK_STOCK_EQUATION_MISMATCH:"+id);}
function once(state,key,fn){if(typeof key!=="string"||!key.trim())throw new Error("IDEMPOTENCY_KEY_REQUIRED");const old=state.appliedOperations.find(x=>x.key===key);if(old)return{state:cp(state),result:cp(old.result),duplicate:true};const next=cp(state),result=fn(next);next.appliedOperations.push({key,result:cp(result)});return{state:next,result,duplicate:false};}
function movement(s,x){s.movements.push({id:"FM-"+(s.movements.length+1),createdAt:new Date().toISOString(),...x});}
function tripOf(s,id){return exact(arr(s.trips,"trips"),id,"TRIP");}
function active(t){if(t.status!=="ACTIVE")throw new Error("TRIP_NOT_ACTIVE:"+t.status);}
export function createFleetState(input={}){
 obj(input,"state");
 return{schemaVersion:1,
  products:arr(input.products||[],"products").map(p=>({...cp(p),id:String(p.id),mainStockUnits:p.mainStockUnits==null?toQuantityUnits(p.mainStock??0):BigInt(p.mainStockUnits)})),
  trucks:arr(input.trucks||[],"trucks").map(t=>({...cp(t),id:String(t.id),stockUnits:mapBig(t.stockUnits)})),
  trips:cp(arr(input.trips||[],"trips")),movements:cp(arr(input.movements||[],"movements")),
  auditTrail:cp(arr(input.auditTrail||[],"auditTrail")),appliedOperations:cp(arr(input.appliedOperations||[],"appliedOperations"))
 };
}
export function openTrip(input,{tripId,truckId,driverId,driverName="",openedAt}={},key){
 const s=createFleetState(input);return once(s,key,n=>{
  if(!tripId||!truckId||!driverId)throw new Error("TRIP_TRUCK_DRIVER_REQUIRED");
  if(n.trips.some(t=>String(t.id)===String(tripId)))throw new Error("DUPLICATE_TRIP_ID");
  const truck=exact(n.trucks,truckId,"TRUCK");
  if(n.trips.some(t=>String(t.truckId)===String(truckId)&&!["CLOSED","CANCELLED"].includes(t.status)))throw new Error("TRUCK_ALREADY_HAS_OPEN_TRIP");
  const openingUnits=mapBig(truck.stockUnits);
  if(Object.values(openingUnits).some(x=>x!==0n))throw new Error("TRUCK_NOT_EMPTY_RECONCILE_PREVIOUS_CUSTODY");
  n.trips.push({id:String(tripId),truckId:String(truckId),driverId:String(driverId),driverName:String(driverName),status:"OPEN",openedAt:openedAt||new Date().toISOString(),openingUnits,loadedUnits:{},customerReturnUnits:{},soldUnits:{},returnedToMainUnits:{},damagedUnits:{},sales:[],customerReturns:[],cashSalesMinor:0n,oldDebtPaymentsMinor:0n,fieldExpensesMinor:0n,debtPayments:[],expenses:[]});
  n.auditTrail.push({type:"TRIP_OPENED",tripId:String(tripId),driverId:String(driverId),at:openedAt||new Date().toISOString()});
  return{tripId:String(tripId),status:"OPEN"};
 });
}
export function loadTrip(input,tripId,items,key,actor={}){
 const s=createFleetState(input);return once(s,key,n=>{
  const t=tripOf(n,tripId);if(!["OPEN","ACTIVE"].includes(t.status))throw new Error("TRIP_NOT_OPEN_FOR_LOAD");
  const truck=exact(n.trucks,t.truckId,"TRUCK"),rows=arr(items,"load items");if(!rows.length)throw new Error("LOAD_ITEMS_REQUIRED");
  const seen=new Set(),prepared=rows.map(r=>{const id=String(r.productId??"");if(!id||seen.has(id))throw new Error("LOAD_PRODUCT_IDS_MUST_BE_UNIQUE");seen.add(id);const q=toQuantityUnits(r.quantity);if(q<=0n)throw new Error("LOAD_QUANTITY_MUST_BE_POSITIVE");const p=exact(n.products,id,"PRODUCT");if(p.mainStockUnits<q)throw new Error("INSUFFICIENT_MAIN_STOCK:"+id);return{id,q,p};});
  for(const x of prepared){x.p.mainStockUnits-=x.q;add(truck.stockUnits,x.id,x.q);add(t.loadedUnits,x.id,x.q);movement(n,{type:"TRUCK_LOAD",tripId:t.id,truckId:truck.id,productId:x.id,quantityUnits:x.q,actorId:actor.id||null,idempotencyKey:key});}
  t.status="ACTIVE";t.updatedAt=new Date().toISOString();live(n,t);return{tripId:t.id,status:t.status,loadedItems:prepared.length};
 });
}
export function recordTruckSale(input,tripId,sale,key,actor={}){
 const s=createFleetState(input);return once(s,key,n=>{
  const t=tripOf(n,tripId);active(t);const truck=exact(n.trucks,t.truckId,"TRUCK"),id=String(sale?.productId??"");if(!id)throw new Error("SALE_PRODUCT_REQUIRED");
  const q=toQuantityUnits(sale.quantity),catalog=toMoneyMinor(sale.catalogPrice),price=toMoneyMinor(sale.salePrice),min=toMoneyMinor(sale.minimumPrice??0);
  if(q<=0n)throw new Error("SALE_QUANTITY_MUST_BE_POSITIVE");if(price===0n)throw new Error("ZERO_PRICE_BLOCKED");
  if(price<min&&(actor.canOverrideMinimumPrice!==true||!actor.id))throw new Error("MINIMUM_PRICE_PERMISSION_REQUIRED");
  const balance=truck.stockUnits[id]||0n;if(balance<q)throw new Error("INSUFFICIENT_TRUCK_STOCK:"+id);
  const total=round(q*price,QS),paid=toMoneyMinor(sale.cashPaid??0);if(paid>total)throw new Error("CASH_PAID_EXCEEDS_SALE");
  const p=exact(n.products,id,"PRODUCT");truck.stockUnits[id]=balance-q;add(t.soldUnits,id,q);t.cashSalesMinor+=paid;
  const row={id:String(sale.saleId||key),productId:id,productName:String(p.name||p.title||id),quantityUnits:q,catalogPriceMinor:catalog,salePriceMinor:price,totalMinor:total,cashPaidMinor:paid,customerId:sale.customerId==null?null:String(sale.customerId),invoiceId:sale.invoiceId==null?null:String(sale.invoiceId),actorId:actor.id||null,createdAt:new Date().toISOString()};
  t.sales.push(row);n.auditTrail.push({type:catalog===price?"TRUCK_SALE_PRICE_AUDIT":"TRUCK_PRICE_OVERRIDE_AUDIT",tripId:t.id,saleId:row.id,catalogPriceMinor:catalog,actualPriceMinor:price,actorId:actor.id||null});
  movement(n,{type:"TRUCK_SALE",tripId:t.id,truckId:truck.id,productId:id,quantityUnits:q,saleId:row.id,idempotencyKey:key});live(n,t);
  return{saleId:row.id,totalMinor:total,cashPaidMinor:paid,remainingUnits:truck.stockUnits[id]};
 });
}
export function recordCustomerReturn(input,tripId,row,key,actor={}){
 const s=createFleetState(input);return once(s,key,n=>{
  const t=tripOf(n,tripId);active(t);const id=String(row?.productId??""),invoiceId=String(row?.invoiceId??""),reason=String(row?.reason??"").trim(),q=toQuantityUnits(row.quantity);
  if(!id||!invoiceId||!reason||q<=0n)throw new Error("CUSTOMER_RETURN_DETAILS_REQUIRED");
  const sold=t.sales.filter(x=>x.invoiceId===invoiceId&&x.productId===id).reduce((a,x)=>a+x.quantityUnits,0n);
  const prior=t.customerReturns.filter(x=>x.invoiceId===invoiceId&&x.productId===id).reduce((a,x)=>a+x.quantityUnits,0n);
  if(sold===0n||prior+q>sold)throw new Error("CUSTOMER_RETURN_EXCEEDS_LINKED_INVOICE_QUANTITY");
  exact(n.products,id,"PRODUCT");const truck=exact(n.trucks,t.truckId,"TRUCK");add(truck.stockUnits,id,q);add(t.customerReturnUnits,id,q);
  t.customerReturns.push({productId:id,invoiceId,quantityUnits:q,reason,actorId:actor.id||null,createdAt:new Date().toISOString()});
  movement(n,{type:"TRUCK_CUSTOMER_RETURN",tripId:t.id,productId:id,quantityUnits:q,invoiceId,idempotencyKey:key});live(n,t);return{tripId:t.id,productId:id,returnedUnits:q};
 });
}
export function returnToMainWarehouse(input,tripId,productId,quantity,key,actor={}){
 const s=createFleetState(input);return once(s,key,n=>{
  const t=tripOf(n,tripId);active(t);const id=String(productId),q=toQuantityUnits(quantity),truck=exact(n.trucks,t.truckId,"TRUCK"),p=exact(n.products,id,"PRODUCT");
  if(q<=0n||(truck.stockUnits[id]||0n)<q)throw new Error("INVALID_OR_INSUFFICIENT_TRUCK_RETURN");
  truck.stockUnits[id]-=q;p.mainStockUnits+=q;add(t.returnedToMainUnits,id,q);movement(n,{type:"TRUCK_RETURN_TO_MAIN",tripId:t.id,productId:id,quantityUnits:q,actorId:actor.id||null,idempotencyKey:key});live(n,t);return{tripId:t.id,productId:id,returnedUnits:q};
 });
}
export function recordDamagedGoods(input,tripId,productId,quantity,reason,key,actor={}){
 const s=createFleetState(input);return once(s,key,n=>{
  const t=tripOf(n,tripId);active(t);const id=String(productId),q=toQuantityUnits(quantity),truck=exact(n.trucks,t.truckId,"TRUCK");
  if(q<=0n||!String(reason||"").trim()||!actor.id)throw new Error("DAMAGE_REQUIRES_QUANTITY_REASON_ACTOR");
  if((truck.stockUnits[id]||0n)<q)throw new Error("INSUFFICIENT_TRUCK_STOCK_FOR_DAMAGE");
  exact(n.products,id,"PRODUCT");truck.stockUnits[id]-=q;add(t.damagedUnits,id,q);movement(n,{type:"TRUCK_DAMAGED",tripId:t.id,productId:id,quantityUnits:q,reason:String(reason),actorId:actor.id,idempotencyKey:key});live(n,t);return{tripId:t.id,productId:id,damagedUnits:q};
 });
}
export function recordOldDebtPayment(input,tripId,payment,key,actor={}){
 const s=createFleetState(input);return once(s,key,n=>{
  const t=tripOf(n,tripId);active(t);const amount=toMoneyMinor(payment?.amount),customerId=String(payment?.customerId??""),ref=String(payment?.referenceId??"").trim();
  if(!customerId||!ref||amount<=0n)throw new Error("DEBT_PAYMENT_REQUIRES_CUSTOMER_REFERENCE_AMOUNT");
  t.oldDebtPaymentsMinor+=amount;t.debtPayments.push({customerId,referenceId:ref,amountMinor:amount,actorId:actor.id||null,createdAt:new Date().toISOString()});
  movement(n,{type:"TRUCK_OLD_DEBT_PAYMENT",tripId:t.id,customerId,amountMinor:amount,idempotencyKey:key});return{amountMinor:amount,totalOldDebtPaymentsMinor:t.oldDebtPaymentsMinor};
 });
}
export function recordFieldExpense(input,tripId,expense,key,actor={}){
 const s=createFleetState(input);return once(s,key,n=>{
  const t=tripOf(n,tripId);active(t);const amount=toMoneyMinor(expense?.amount),category=String(expense?.category??"").trim(),receipt=String(expense?.receiptReference??"").trim();
  if(amount<=0n||!category||!receipt||!actor.id)throw new Error("FIELD_EXPENSE_REQUIRES_AMOUNT_CATEGORY_RECEIPT_ACTOR");
  t.fieldExpensesMinor+=amount;t.expenses.push({amountMinor:amount,category,receiptReference:receipt,actorId:actor.id,createdAt:new Date().toISOString()});
  movement(n,{type:"TRUCK_FIELD_EXPENSE",tripId:t.id,amountMinor:amount,category,actorId:actor.id,idempotencyKey:key});return{amountMinor:amount,totalExpensesMinor:t.fieldExpensesMinor};
 });
}
export function calculateTripInventory(t){obj(t,"trip");return Object.fromEntries(Object.entries(expected(t)).map(([id,q])=>[id,fromQuantityUnits(q)]));}
export function settleTrip(input,tripId,{actualCounts,actualCash,varianceNote="",varianceApprovedBy="",settledAt}={},key,actor={}){
 const s=createFleetState(input);return once(s,key,n=>{
  const t=tripOf(n,tripId);active(t);const truck=exact(n.trucks,t.truckId,"TRUCK");obj(actualCounts,"actualCounts");
  const book=expected(t),ids=new Set([...Object.keys(book),...Object.keys(actualCounts)]),actual={};
  for(const id of ids){if(!Object.prototype.hasOwnProperty.call(actualCounts,id))throw new Error("ACTUAL_COUNT_MISSING:"+id);actual[id]=toQuantityUnits(actualCounts[id]);exact(n.products,id,"PRODUCT");}
  const due=t.cashSalesMinor+t.oldDebtPaymentsMinor-t.fieldExpensesMinor;if(due<0n)throw new Error("FIELD_EXPENSES_EXCEED_CASH");
  const cash=toMoneyMinor(actualCash),cashVariance=cash-due,variances=[];
  for(const id of ids){const b=book[id]||0n,a=actual[id]||0n;if(a!==b)variances.push({productId:id,expectedUnits:b,actualUnits:a,varianceUnits:a-b,type:a<b?"SHORTAGE":"SURPLUS"});}
  const hasVariance=variances.length>0||cashVariance!==0n;
  if(hasVariance&&(!String(varianceNote).trim()||!String(varianceApprovedBy).trim()||actor.canApproveVariance!==true||String(actor.id)!==String(varianceApprovedBy)))throw new Error("VARIANCE_REQUIRES_AUTHORIZED_MANAGER_NOTE");
  for(const id of ids){const p=exact(n.products,id,"PRODUCT"),count=actual[id]||0n;p.mainStockUnits+=count;truck.stockUnits[id]=0n;if(count!==(book[id]||0n))movement(n,{type:count<(book[id]||0n)?"TRUCK_INVENTORY_SHORTAGE":"TRUCK_INVENTORY_SURPLUS",tripId:t.id,productId:id,quantityUnits:count-(book[id]||0n),note:String(varianceNote),approvedBy:String(varianceApprovedBy),idempotencyKey:key});if(count>0n)movement(n,{type:"TRUCK_CLOSE_RETURN_TO_MAIN",tripId:t.id,productId:id,quantityUnits:count,idempotencyKey:key});}
  const settlement={id:"TRUCK-SETTLEMENT-"+t.id,tripId:t.id,settledAt:settledAt||new Date().toISOString(),inventory:Object.fromEntries([...ids].map(id=>[id,{expectedUnits:book[id]||0n,actualUnits:actual[id]||0n,varianceUnits:(actual[id]||0n)-(book[id]||0n)}])),expectedCashMinor:due,actualCashMinor:cash,cashVarianceMinor:cashVariance,cashSalesMinor:t.cashSalesMinor,oldDebtPaymentsMinor:t.oldDebtPaymentsMinor,fieldExpensesMinor:t.fieldExpensesMinor,varianceNote:String(varianceNote),varianceApprovedBy:String(varianceApprovedBy),actorId:actor.id||null};
  t.settlement=settlement;t.status="CLOSED";t.closedAt=settlement.settledAt;n.auditTrail.push({type:"TRIP_SETTLED",tripId:t.id,settlementId:settlement.id,hasVariance,idempotencyKey:key});
  return{settlementId:settlement.id,status:t.status,hasVariance,expectedCashMinor:due,actualCashMinor:cash,cashVarianceMinor:cashVariance,inventoryVarianceCount:variances.length};
 });
}
export function assertFleetInvariants(input){
 const s=createFleetState(input),errors=[];
 for(const t of s.trips){if(t.status==="ACTIVE"){try{live(s,t);}catch(e){errors.push(String(e.message||e));}}if(t.status==="CLOSED"){const truck=exact(s.trucks,t.truckId,"TRUCK");if(Object.values(truck.stockUnits).some(v=>BigInt(v)!==0n))errors.push("CLOSED_TRIP_HAS_TRUCK_STOCK:"+t.id);if(!t.settlement)errors.push("CLOSED_TRIP_WITHOUT_SETTLEMENT:"+t.id);}}
 return{ok:errors.length===0,errors};
}
export const FLEET_UNITS=Object.freeze({quantityScale:QS,moneyScale:MS});


/** Restore a failed fleet mutation without replacing the live AppData root object. */
export function restoreFleetAppData(target, snapshot) {
  if (!target || typeof target !== "object" || Array.isArray(target) ||
      !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("FLEET_APP_DATA_ROLLBACK_REQUIRES_OBJECTS");
  }
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete target[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    target[key] = structuredClone(value);
  }
  return target;
}
