import {createFleetState,openTrip,loadTrip,recordTruckSale,recordCustomerReturn,returnToMainWarehouse,recordDamagedGoods,recordOldDebtPayment,recordFieldExpense,calculateTripInventory,settleTrip,fromQuantityUnits,fromMoneyMinor,toQuantityUnits,restoreFleetAppData} from "./truck-settlement-engine.mjs";
import {MUTATION_KEYS} from "../sync/mutation_keys.mjs";
const W=window,TAG="__anasFleetBigInt";
const encode=v=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==="bigint"?{[TAG]:x.toString()}:x));
const decode=v=>{if(Array.isArray(v))return v.map(decode);if(v&&typeof v==="object"){const k=Object.keys(v);if(k.length===1&&k[0]===TAG&&/^-?(0|[1-9]\d*)$/.test(v[TAG]))return BigInt(v[TAG]);return Object.fromEntries(k.map(x=>[x,decode(v[x])]));}return v;};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const minor=v=>{const m=/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(v??"0").trim());if(!m)throw Error("مبلغ غير صالح");return BigInt(m[1])*100n+BigInt((m[2]||"").padEnd(2,"0")||"0");};
function data(){return typeof W.__ANAS_GET_APP_DATA__==="function"?W.__ANAS_GET_APP_DATA__():(W.AppData||null);}
function actor(){const u=data()?.currentUser||{},r=String(u.role||"").toLowerCase();return{id:String(u.id||"unknown"),canOverrideMinimumPrice:["admin","مدير","مدير عام","superadmin"].includes(r),canApproveVariance:["admin","مدير","مدير عام","superadmin"].includes(r)};}
function state(){const d=data();if(!d||!Array.isArray(d.products))throw Error("بيانات المنتجات غير جاهزة");const saved=d.anasFleetState?decode(d.anasFleetState):null;const products=d.products.map(p=>({id:String(p.id),name:p.name||p.title||String(p.id),mainStockUnits:toQuantityUnits(p.stock??0)}));if(!saved)return createFleetState({products,trucks:[]});return createFleetState({...saved,products:saved.products.map(p=>{const current=products.find(x=>x.id===String(p.id));return current?{...p,mainStockUnits:current.mainStockUnits}:p;})});}
function active(s=state()){return s.trips.find(t=>t.status==="ACTIVE"||t.status==="OPEN")||null;}
function tripWarehouse(t){return String(t?.warehouseName||"شاحنة "+String(t?.truckPlate||t?.truckId||""));}
function syncCurrentUserWarehouse(d,s){const uid=String(d.currentUser?.id??"");if(!uid)return;const own=[...s.trips].reverse().find(t=>String(t.driverId)===uid);if(!own)return;if(own.status==="ACTIVE"||own.status==="OPEN")d.currentUser.secondaryWarehouse=tripWarehouse(own);else if(own.status==="CLOSED"||own.status==="CANCELLED")d.currentUser.secondaryWarehouse=String(own.previousUserWarehouse||"");}
function message(s,bad=false){const n=document.getElementById("anasFleetMessage");if(n){n.textContent=s;n.style.color=bad?"#b91c1c":"#166534";}}
function mirror(d,s){for(const fp of s.products){const p=d.products.find(x=>String(x.id)===String(fp.id));if(!p)throw Error("المنتج غير موجود: "+fp.id);p.stock=fromQuantityUnits(fp.mainStockUnits);if(!p.warehouseStock||typeof p.warehouseStock!=="object"||Array.isArray(p.warehouseStock))p.warehouseStock={};for(const t of s.trucks)if(t.warehouseName)p.warehouseStock[t.warehouseName]=fromQuantityUnits(t.stockUnits[fp.id]||0n);}}
async function persist(s){
 const d=data();
 if(!d||typeof d!=="object")throw Error("بيانات التطبيق غير جاهزة للحفظ");
 const before=structuredClone(d);
 try{
  mirror(d,s);
  d.anasFleetState=encode(s);
  if(typeof W.saveDB!=="function"||W.saveDB()!==true)throw Error("تعذر تجهيز سجل الشاحنة للمزامنة");
  if(typeof W.saveDBDurably!=="function"||await W.saveDBDurably()!==true)throw Error("لم يؤكد التخزين الدائم");
  render();
  return s;
 }catch(error){
  restoreFleetAppData(d,before);
  try{render();}catch(_){}
  throw error;
 }
}
const uuid=()=>W.crypto.randomUUID(),key=p=>p+"-"+uuid();
let panel=null,draft=[],lastPayment=null,lastInvoice=null;
function setup(){
 if(panel||!document.getElementById("view-trucks"))return;
 panel=document.createElement("section");panel.id="anasFleetEnginePanel";
 panel.style.cssText="margin:12px;padding:14px;border:1px solid var(--mp-border,#cbd5e1);border-radius:16px;background:var(--mp-card-bg,#fff);color:var(--mp-text-dark,inherit)";
 panel.innerHTML="<h3>🚚 محرك الشاحنات والجولات — ANAS ERP</h3><p style='font-size:12px'>عهدة مستقلة، تحميل ذري، بيع ميداني من POS، مرتجعات وجرد وتسوية يومية.</p><p id='anasFleetMessage' role='status'>جاهز.</p><div style='display:grid;grid-template-columns:1fr 1fr;gap:8px'><label>لوحة الشاحنة<input id='fleetPlate' class='field-input'></label><label>السائق<input id='fleetDriver' class='field-input'></label></div><button data-fleet='open' class='btn-full-submit'>فتح جولة</button><div id='fleetActive'></div><div id='fleetActions' style='display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px'><label>المنتج<select id='fleetProduct' class='field-input'></select></label><label>كمية التحميل<input id='fleetQty' class='field-input' type='number' min='0.001' step='0.001' value='1'></label><button data-fleet='add' class='btn-pos-hasib'>إضافة للتحميل</button><button data-fleet='load' class='btn-full-submit'>اعتماد التحميل</button><div id='fleetDraft'></div><label>منتج الحركة<select id='fleetReturnProduct' class='field-input'></select></label><label>الكمية<input id='fleetReturnQty' class='field-input' type='number' min='0.001' step='0.001' value='1'></label><label>رقم فاتورة المرتجع<input id='fleetInvoice' class='field-input'></label><label>السبب<input id='fleetReason' class='field-input'></label><button data-fleet='customer-return' class='btn-pos-hasib'>مرتجع زبون</button><button data-fleet='return-main' class='btn-pos-hasib'>إرجاع للمستودع</button><button data-fleet='damage' class='btn-pos-hasib'>تالف موثق</button><label>مبلغ المصروف<input id='fleetExpense' class='field-input' type='number' min='0.01' step='0.01'></label><label>نوع المصروف<input id='fleetExpenseCategory' class='field-input'></label><label>مرجع الإيصال<input id='fleetExpenseRef' class='field-input'></label><button data-fleet='expense' class='btn-pos-hasib'>تسجيل مصروف</button></div><div style='display:flex;gap:8px;flex-wrap:wrap;margin-top:10px'><button data-fleet='pos' class='btn-full-submit'>فتح POS من مخزن الشاحنة</button><button data-fleet='manifest' class='btn-pos-hasib'>طباعة ورقة التحميل</button><button data-fleet='settlement-print' class='btn-pos-hasib'>طباعة التسوية</button><button data-fleet='payment-print' class='btn-pos-hasib'>طباعة آخر دفعة</button></div><div id='fleetSettlement'></div><details style='margin-top:12px'><summary>إعدادات الطابعة الحرارية العربية</summary><div style='display:grid;grid-template-columns:1fr 1fr;gap:8px'><label>الورق<select id='fleetPaper' class='field-input'><option value='58mm'>58mm — 384px</option><option value='80mm'>80mm — 576px</option></select></label><label>المسار<select id='fleetTransport' class='field-input'><option value='auto'>تلقائي</option><option value='bluetooth'>Bluetooth</option><option value='android'>Android</option><option value='rawbt'>RawBT</option></select></label><label>Service UUID<input id='fleetService' class='field-input'></label><label>Characteristic UUID<input id='fleetCharacteristic' class='field-input'></label></div><label><input type='checkbox' id='fleetRawbt'> السماح بتحويل RawBT عند تعذر الاتصال</label><button data-fleet='printer-save' class='btn-pos-hasib'>حفظ إعدادات الطابعة</button><button data-fleet='print-retry' class='btn-pos-hasib'>إعادة محاولة الطباعة</button><button data-fleet='invoice-share' class='btn-pos-hasib'>مشاركة آخر فاتورة صورة</button></details><div id='fleetConflict'></div>";
 document.getElementById("view-trucks").insertBefore(panel,document.getElementById("view-trucks").firstChild);
 panel.addEventListener("click",e=>{const b=e.target.closest("[data-fleet]");if(b)action(b.dataset.fleet).catch(x=>message(String(x.message||x),true));});
 const saved=W.ANASArabicEscPos?.getSettings?.()||{};panel.querySelector("#fleetPaper").value=saved.paper||"58mm";panel.querySelector("#fleetTransport").value=saved.transport||"auto";panel.querySelector("#fleetService").value=saved.serviceUuid||"";panel.querySelector("#fleetCharacteristic").value=saved.characteristicUuid||"";panel.querySelector("#fleetRawbt").checked=saved.allowRawBTFallback!==false;
 render();setupConflictCenter();
}
function render(){
 if(!panel)return;const d=data();if(!d)return;const s=state();syncCurrentUserWarehouse(d,s);const t=active(s),p1=panel.querySelector("#fleetProduct"),p2=panel.querySelector("#fleetReturnProduct");
 for(const select of [p1,p2]){const old=select.value;select.innerHTML="";for(const p of d.products){const o=document.createElement("option");o.value=String(p.id);o.textContent=(p.name||p.id)+" — "+String(p.stock??0);select.appendChild(o);}if(old)select.value=old;}
 panel.querySelector("#fleetActions").hidden=!t;
 panel.querySelector("#fleetActive").textContent=t?"الجولة: "+t.id+" · الشاحنة: "+(t.warehouseName||t.truckId)+" · السائق: "+t.driverName:"لا توجد جولة مفتوحة.";
 panel.querySelector("#fleetDraft").textContent=draft.map(x=>x.productId+" × "+x.quantity).join(" · ");
 const box=panel.querySelector("#fleetSettlement");box.innerHTML="";
 if(t&&t.status==="ACTIVE"){const inv=calculateTripInventory(t);const title=document.createElement("h4");title.textContent="جرد وإغلاق الجولة";box.appendChild(title);for(const [id,q] of Object.entries(inv)){const label=document.createElement("label");label.textContent=(d.products.find(p=>String(p.id)===id)?.name||id)+" — المتوقع "+q;const input=document.createElement("input");input.className="field-input";input.type="number";input.min="0";input.step="0.001";input.value=q;input.dataset.countProduct=id;label.appendChild(input);box.appendChild(label);}box.insertAdjacentHTML("beforeend","<label>النقد الفعلي (د.ج)<input id='fleetActualCash' class='field-input' type='number' min='0' step='0.01' value='"+fromMoneyMinor(t.cashSalesMinor+t.oldDebtPaymentsMinor-t.fieldExpensesMinor)+"'></label><label>ملاحظة الفروقات<input id='fleetVarianceNote' class='field-input'></label><label>اعتماد المدير<input id='fleetApprover' class='field-input' value='"+esc(actor().id)+"'></label><button data-fleet='close' class='btn-full-submit'>إغلاق الجولة واعتماد التسوية</button>");}
 else if(t?.status==="CLOSED")box.textContent="الجولة مغلقة.";
}
function requireTrip(s){const t=active(s);if(!t||t.status!=="ACTIVE")throw Error("يجب فتح الجولة واعتماد التحميل أولاً");return t;}
async function action(name){
 const d=data(),s=state(),t=active(s),a=actor();
 if(name==="settlement-print"){const closed=[...s.trips].reverse().find(x=>x.status==="CLOSED"&&x.settlement);if(!closed)throw Error("لا توجد تسوية نهائية للطباعة");await printSettlement(closed);return;}
 if(name==="manifest"){const selected=t||[...s.trips].reverse().find(x=>x.status==="CLOSED");if(!selected)throw Error("لا توجد ورقة تحميل للطباعة");await printManifest(selected,s);return;}
 if(name==="payment-print"){if(!lastPayment)throw Error("لا توجد دفعة دين حديثة");await printPayment(lastPayment);return;}
 if(name==="printer-save"){W.ANASArabicEscPos.saveSettings({paper:panel.querySelector("#fleetPaper").value,transport:panel.querySelector("#fleetTransport").value,serviceUuid:panel.querySelector("#fleetService").value.trim(),characteristicUuid:panel.querySelector("#fleetCharacteristic").value.trim(),allowRawBTFallback:panel.querySelector("#fleetRawbt").checked});message("تم حفظ إعدادات الطابعة.");return;}
 if(name==="invoice-share"){if(!lastInvoice)throw Error("لا توجد فاتورة حديثة");await shareInvoice(lastInvoice);return;}
 if(name==="print-retry"){const e=W.ANASArabicEscPos,storage=W.ANASResilientStorage;if(!e||!storage)throw Error("التخزين أو محرك الطباعة غير جاهز");const settings=e.getSettings(),q=e.createPrintQueue({storage,send:(bytes,meta)=>e.sendPreferred(bytes,{...settings,...meta})}),jobs=await q.list(),pending=jobs.filter(x=>x.status==="PENDING");let done=0;for(const job of pending){await q.retry(job.id);done++;}message("اكتملت إعادة محاولة "+done+" مهمة طباعة.");return;}
 if(name==="open"){
  if(t)throw Error("أغلق الجولة المفتوحة قبل فتح جولة جديدة");
const plate=panel.querySelector("#fleetPlate").value.trim(),driver=panel.querySelector("#fleetDriver").value.trim();if(!plate||!driver)throw Error("أدخل لوحة الشاحنة واسم السائق");const id="TRUCK-"+plate.normalize("NFC").replace(/[^\p{L}\p{N}-]+/gu,"-").toUpperCase(),warehouse="شاحنة "+plate;let truck=s.trucks.find(x=>x.id===id);if(!truck){truck={id,plate,warehouseName:warehouse,stockUnits:{}};s.trucks.push(truck);}else{if(Object.values(truck.stockUnits||{}).some(x=>BigInt(x)!==0n))throw Error("الشاحنة تحمل عهدة سابقة غير مسوّاة");truck.warehouseName=warehouse;}const result=openTrip(s,{tripId:"TRIP-"+uuid(),truckId:id,driverId:a.id,driverName:driver,openedAt:new Date().toISOString()},key("TRIP-OPEN"));const trip=result.state.trips.find(x=>x.id===result.result.tripId);trip.warehouseName=warehouse;trip.truckPlate=plate;trip.previousUserWarehouse=String(d.currentUser?.secondaryWarehouse||d.currentUser?.warehouseName||"");const previousAppData=structuredClone(d);try{d.currentUser.secondaryWarehouse=warehouse;const existingWarehouse=(d.warehouses||[]).find(w=>String(typeof w==="string"?w:w?.name||"").trim()===warehouse);if(existingWarehouse&&typeof existingWarehouse==="object"&&existingWarehouse.assigned_user_id!=null&&String(existingWarehouse.assigned_user_id)!==String(a.id))throw Error("اسم مخزن الشاحنة مستخدم ومُسند إلى مستخدم آخر");if(typeof W.wtEnsureMobileWarehouse==="function"&&!W.wtEnsureMobileWarehouse(warehouse))throw Error("تعذر إنشاء مخزن الشاحنة؛ راجع قائمة المخازن");if(typeof W.wtEnsureUserWarehouse==="function"&&!W.wtEnsureUserWarehouse(d.currentUser))throw Error("تعذر إسناد مخزن الشاحنة إلى السائق");await persist(result.state);}catch(error){restoreFleetAppData(d,previousAppData);try{render();}catch(_){}throw error;}message("تم فتح الجولة وإنشاء مخزن شاحنة فعلي وربطه بمستخدم السائق. أضف الحمولة واعتمدها قبل البيع.");return;}
 if(!t)throw Error("افتح جولة شاحنة أولاً");
 if(name==="add"){const id=p1Value(),q=panel.querySelector("#fleetQty").value;if(!id)throw Error("اختر منتجاً");const units=toQuantityUnits(q);if(units<=0n)throw Error("الكمية يجب أن تكون موجبة");const old=draft.find(x=>x.productId===id);if(old)old.quantity=fromQuantityUnits(toQuantityUnits(old.quantity)+units);else draft.push({productId:id,quantity:fromQuantityUnits(units)});render();return;}
 if(name==="load"){if(!draft.length)throw Error("أضف صنفاً للتحميل");const next=loadTrip(s,t.id,draft,key("TRUCK-LOAD"),a).state;await persist(next);draft=[];message("تم تحويل الحمولة من المستودع إلى مخزن الشاحنة.");return;}
 if(name==="pos"){if(t.status!=="ACTIVE")throw Error("اعتمد تحميل الشاحنة قبل البيع الميداني");const previousAppData=structuredClone(d);try{d.currentUser.secondaryWarehouse=t.warehouseName||("شاحنة "+t.truckId);if(W.saveDB()!==true||await W.saveDBDurably()!==true)throw Error("تعذر حفظ مخزن البيع الميداني");}catch(error){restoreFleetAppData(d,previousAppData);try{render();}catch(_){}throw error;}W.openView?.("pos");return;}
 if(name==="customer-return"){const next=recordCustomerReturn(s,t.id,{productId:p2Value(),quantity:panel.querySelector("#fleetReturnQty").value,invoiceId:panel.querySelector("#fleetInvoice").value.trim(),reason:panel.querySelector("#fleetReason").value.trim()},key("TRUCK-RETURN"),a).state;await persist(next);message("تم اعتماد مرتجع الزبون في عهدة الشاحنة.");return;}
 if(name==="return-main"){const next=returnToMainWarehouse(s,t.id,p2Value(),panel.querySelector("#fleetReturnQty").value,key("TRUCK-RETURN-MAIN"),a).state;await persist(next);message("تم إرجاع الكمية إلى المستودع الرئيسي.");return;}
 if(name==="damage"){const next=recordDamagedGoods(s,t.id,p2Value(),panel.querySelector("#fleetReturnQty").value,panel.querySelector("#fleetReason").value,key("TRUCK-DAMAGE"),a).state;await persist(next);message("تم توثيق التالف وخصمه من العهدة.");return;}
 if(name==="expense"){const next=recordFieldExpense(s,t.id,{amount:panel.querySelector("#fleetExpense").value,category:panel.querySelector("#fleetExpenseCategory").value,receiptReference:panel.querySelector("#fleetExpenseRef").value},key("TRUCK-EXPENSE"),a).state;await persist(next);message("تم تسجيل المصروف الميداني.");return;}
 if(name==="close"){const counts=Object.fromEntries(Array.from(panel.querySelectorAll("[data-count-product]")).map(x=>[x.dataset.countProduct,x.value]));const next=settleTrip(s,t.id,{actualCounts:counts,actualCash:panel.querySelector("#fleetActualCash").value,varianceNote:panel.querySelector("#fleetVarianceNote").value,varianceApprovedBy:panel.querySelector("#fleetApprover").value},key("TRUCK-CLOSE"),a).state;const closed=next.trips.find(x=>x.id===t.id);const previousAppData=structuredClone(d);try{d.currentUser.secondaryWarehouse=closed.previousUserWarehouse||"";const releasedWarehouse=(d.warehouses||[]).find(w=>String(typeof w==="string"?w:w?.name||"")===String(closed.warehouseName||""));if(releasedWarehouse&&typeof releasedWarehouse==="object"&&String(releasedWarehouse.assigned_user_id??"")===String(a.id))releasedWarehouse.assigned_user_id=null;await persist(next);}catch(error){restoreFleetAppData(d,previousAppData);try{render();}catch(_){}throw error;}message("تم إغلاق الجولة وتسوية العهدة مع تسجيل الفروقات.");return;}
 if(name==="payment-print"){if(!lastPayment)throw Error("لا توجد دفعة دين حديثة");await printPayment(lastPayment);return;}
 if(name==="printer-save"){W.ANASArabicEscPos.saveSettings({paper:panel.querySelector("#fleetPaper").value,transport:panel.querySelector("#fleetTransport").value,serviceUuid:panel.querySelector("#fleetService").value.trim(),characteristicUuid:panel.querySelector("#fleetCharacteristic").value.trim(),allowRawBTFallback:panel.querySelector("#fleetRawbt").checked});message("تم حفظ إعدادات الطابعة.");return;}
 if(name==="invoice-share"){if(!lastInvoice)throw Error("لا توجد فاتورة حديثة");await shareInvoice(lastInvoice);return;}
 if(name==="print-retry"){const e=W.ANASArabicEscPos,storage=W.ANASResilientStorage;if(!e||!storage)throw Error("التخزين أو محرك الطباعة غير جاهز");const settings=e.getSettings(),q=e.createPrintQueue({storage,send:(bytes,meta)=>e.sendPreferred(bytes,{...settings,...meta})}),jobs=await q.list(),pending=jobs.filter(x=>x.status==="PENDING");let done=0;for(const job of pending){await q.retry(job.id);done++;}message("اكتملت إعادة محاولة "+done+" مهمة طباعة.");return;}
}
function p1Value(){return panel.querySelector("#fleetProduct").value;}function p2Value(){return panel.querySelector("#fleetReturnProduct").value;}
async function printDoc(doc,id){const e=W.ANASArabicEscPos;if(!e)throw Error("محرك الطباعة غير جاهز");const r=await e.printDocument(doc,{printer:e.getSettings(),idempotencyKey:id});message(r.status==="QUEUED_FOR_RETRY"?"تعذر الاتصال بالطابعة؛ حُفظ الوصل لإعادة المحاولة.":"تم إرسال الوصل للطابعة.");return r;}
function invoiceDoc(inv){const e=W.ANASArabicEscPos,items=(inv.items||[]).map(x=>({name:x.name||x.id,quantity:x.qty,unitPriceMinor:minor(x.price||0),totalMinor:minor(x.total??(Number(x.qty||0)*Number(x.price||0)))}));return e.buildInvoiceReceipt({businessName:"ANAS ERP",invoiceNumber:inv.id,date:inv.date,customerName:inv.customer,items,oldDebtMinor:minor(inv.oldDebt||0),invoiceTotalMinor:minor(inv.total||0),paidMinor:minor(inv.paid||0)});}
async function printInvoice(inv){lastInvoice=inv;await printDoc(invoiceDoc(inv),"INVOICE-"+inv.id);}
async function shareInvoice(inv){const e=W.ANASArabicEscPos,c=e.renderReceiptCanvas(invoiceDoc(inv),{paper:e.getSettings().paper||"58mm"});await e.shareImage(c,"ANAS_ERP_receipt.png");}
async function printPayment(p){const doc=W.ANASArabicEscPos.buildPaymentReceipt({businessName:"ANAS ERP",receiptNumber:p.id,date:p.date,customerName:p.customerName,debtBeforeMinor:p.beforeMinor,amountMinor:p.amountMinor,method:"نقداً"});await printDoc(doc,"PAYMENT-"+p.id);}
async function printManifest(t,s){const items=Object.entries(t.loadedUnits||{}).map(([id,q])=>({productName:s.products.find(p=>p.id===id)?.name||id,quantity:fromQuantityUnits(q)}));const doc=W.ANASArabicEscPos.buildLoadManifest({businessName:"ANAS ERP",tripId:t.id,truckPlate:t.truckPlate,driverName:t.driverName,items,receiverName:"توقيع المستلم"});await printDoc(doc,"MANIFEST-"+t.id);}
async function printSettlement(t){const s=t.settlement,inventory=Object.entries(s.inventory||{}).map(([id,x])=>({productName:data().products.find(p=>String(p.id)===id)?.name||id,productId:id,expected:fromQuantityUnits(x.expectedUnits),actual:fromQuantityUnits(x.actualUnits),variance:fromQuantityUnits(x.varianceUnits)}));const doc=W.ANASArabicEscPos.buildTripSettlement({businessName:"ANAS ERP",tripId:t.id,driverName:t.driverName,truckPlate:t.truckPlate,inventory,cashSalesMinor:s.cashSalesMinor,oldDebtPaymentsMinor:s.oldDebtPaymentsMinor,fieldExpensesMinor:s.fieldExpensesMinor,netDueMinor:s.expectedCashMinor,actualCashMinor:s.actualCashMinor,cashVarianceMinor:s.cashVarianceMinor,varianceNote:s.varianceNote});await printDoc(doc,"SETTLEMENT-"+t.id);}
function prepareInvoiceCommit(inv){
 const d=data();if(!inv?.id||!d)return null;
 const before=structuredClone(d),previousLastInvoice=lastInvoice;
 try{
  let s=state(),t=s.trips.find(x=>x.status==="ACTIVE"&&String(x.warehouseName||"")===String(inv.warehouse||inv.warehouseName||""));
  if(!t)return null;
  let paid=minor(inv.paid||0),changed=false;
  for(let i=0;i<(inv.items||[]).length;i++){
   const row=inv.items[i],id=String(row.id??row.productId??"");if(!id)continue;
   const saleId=String(inv.id)+":"+i;if(t.sales.some(x=>String(x.id)===saleId))continue;
   const product=d.products.find(x=>String(x.id)===id);if(!product)throw Error("المنتج غير موجود في فاتورة الشاحنة");
   const qty=String(row.qty??row.quantity??0),price=String(row.price??0),line=minor(row.total??(Number(qty)*Number(price))),cash=paid>0n?(paid<line?paid:line):0n;paid-=cash;
   const next=recordTruckSale(s,t.id,{productId:id,quantity:qty,catalogPrice:String(product.price1??price),salePrice:price,minimumPrice:String(product.minimumPrice??product.minSalePrice??0),cashPaid:fromMoneyMinor(cash),invoiceId:String(inv.id),saleId},key("TRUCK-POS-"+inv.id+"-"+i),actor());
   s=next.state;t=s.trips.find(x=>x.id===t.id);changed=true;
  }
  if(!changed){lastInvoice=inv;return null;}
  // POS already posted the cash/customer ledgers and deducted warehouse stock.
  // Mirror only the matching fleet state; do not touch those ledgers or caisseBalance.
  mirror(d,s);d.anasFleetState=encode(s);lastInvoice=inv;
  return ()=>{restoreFleetAppData(d,before);lastInvoice=previousLastInvoice;try{render();}catch(_){}};
 }catch(error){
  restoreFleetAppData(d,before);lastInvoice=previousLastInvoice;throw error;
 }
}
function recordInvoice(inv){
 // Prepare only in memory. The caller owns the single durable save so the
 // invoice, POS ledgers, stock and fleet linkage enter one mutation envelope.
 return prepareInvoiceCommit(inv);
}
async function recoverInvoices(){
 const d=data();if(!d?.anasFleetState)return;const t=active();if(!t)return;
 for(const inv of (d.invoices||[]).filter(x=>String(x.warehouse||x.warehouseName||"")===String(t.warehouseName))){
  const rollback=recordInvoice(inv);if(typeof rollback!=="function")continue;
  try{
   if(typeof W.saveDB!=="function"||W.saveDB()!==true)throw Error("تعذر تجهيز استعادة ربط فاتورة الشاحنة");
   if(typeof W.saveDBDurably!=="function"||await W.saveDBDurably()!==true)throw Error("لم يؤكد التخزين الدائم لاستعادة ربط فاتورة الشاحنة");
   render();message("رُبطت فاتورة POS بعهدة الشاحنة وسجل السعر الفعلي.");
  }catch(error){rollback();throw error;}
 }
}
async function recoverDebtMovements(){const d=data();if(!d?.anasFleetState)return;const s=state(),t=active(s);if(!t)return;const known=new Set((t.debtPayments||[]).map(x=>String(x.referenceId)));for(const m of (d.cashMovements||[]).filter(x=>x?.type==="add"&&x?.referenceType==="customer_debt"&&!known.has(String(x.id))&&(!x.date||new Date(x.date).getTime()>=new Date(t.openedAt).getTime()))){const c=(d.customers||[]).find(x=>String(x.id)===String(m.referenceId));const before=minor(c?.debt||0)+minor(m.amount||0);await recordDebt(m,before);}}
async function recordDebt(m,before){if(m?.referenceType!=="customer_debt")return;const customer=data()?.customers?.find(x=>String(x.id)===String(m.referenceId));lastPayment={id:m.id,date:m.date,customerName:customer?.name||"عميل",beforeMinor:before,amountMinor:minor(m.amount)};const s=state(),t=active(s);if(!t||t.status!=="ACTIVE"||t.debtPayments?.some(x=>String(x.referenceId)===String(m.id)))return;const next=recordOldDebtPayment(s,t.id,{customerId:String(m.referenceId),referenceId:String(m.id),amount:String(m.amount)},key("TRUCK-DEBT-"+m.id),actor());await persist(next.state);}
let posCommitInFlight=null;
let pendingTruckInvoiceRollback=null;
let pendingFleetDurableAck=null;
async function awaitPendingV42DurableSaveAck(){
 if(pendingFleetDurableAck)await pendingFleetDurableAck;
 const storage=W.ANASResilientStorage;
 if(!storage||typeof storage.getItem!=="function")throw Error("V42 durable-save journal is unavailable before POS commit");
 const queue=storage.getItem(MUTATION_KEYS.pending)||[];
 if(!Array.isArray(queue))throw Error("V42 durable-save journal is malformed before POS commit");
 const prepared=queue.filter(item=>item?.status==="PREPARED");
 if(prepared.length>1)throw Error("Multiple PREPARED V42 operations exist; POS commit is blocked for ledger safety");
 if(prepared.length===1){
  const prior=prepared[0];
  W.__ANAS_FLEET_LAST_DURABLE_BARRIER__={type:String(prior.type||"unknown"),opId:String(prior.opId||""),status:"awaiting-prior-ack"};
  if(typeof W.saveDBDurably!=="function"||await W.saveDBDurably()!==true)
   throw Error("Previous V42 mutation did not receive a durable save acknowledgement");
  W.__ANAS_FLEET_LAST_DURABLE_BARRIER__={type:String(prior.type||"unknown"),opId:String(prior.opId||""),status:"acknowledged-before-pos"};
 }
 return true;
}
W.__ANAS_FLEET_AWAIT_PENDING_DURABLE_SAVE__=awaitPendingV42DurableSaveAck;
function hookPosCartDurability(){
 const originalSaveDB=W.saveDB,originalSaveDBDurably=W.saveDBDurably;
 if(typeof originalSaveDB==="function"&&!originalSaveDB.__anasFleetInvoiceBundled){
  const wrappedSaveDB=function(){
   if(pendingTruckInvoiceRollback)throw Error("TRUCK_POS_DURABLE_SAVE_ALREADY_PENDING");
   const d=data(),t=active();
   const latest=(d?.invoices||[]).slice().reverse().find(inv=>
    t&&String(inv?.warehouse||inv?.warehouseName||"")===String(t.warehouseName)
   );
   const rollback=latest?recordInvoice(latest):null;
   try{
    const result=originalSaveDB.apply(this,arguments);
    if(result!==true){if(typeof rollback==="function")rollback();return result;}
    if(typeof rollback==="function")pendingTruckInvoiceRollback=rollback;
    return result;
   }catch(error){if(typeof rollback==="function")rollback();throw error;}
  };
  wrappedSaveDB.__anasFleetInvoiceBundled=true;
  W.saveDB=wrappedSaveDB;
 }
 if(typeof originalSaveDBDurably==="function"&&!originalSaveDBDurably.__anasFleetInvoiceBundled){
  const wrappedDurable=async function(){
   const rollback=pendingTruckInvoiceRollback;
   const acknowledgement=Promise.resolve(originalSaveDBDurably.apply(this,arguments));
   pendingFleetDurableAck=acknowledgement;
   try{
    const result=await acknowledgement;
    if(rollback){
     pendingTruckInvoiceRollback=null;
     if(result!==true)rollback();
    }
    return result;
   }catch(error){
    if(rollback){pendingTruckInvoiceRollback=null;rollback();}
    throw error;
   }finally{
    if(pendingFleetDurableAck===acknowledgement)pendingFleetDurableAck=null;
   }
  };
  wrappedDurable.__anasFleetInvoiceBundled=true;
  W.saveDBDurably=wrappedDurable;
 }
 const originalConfirm=W.confirmHasibPaymentDurable;
 if(typeof originalConfirm==="function"&&!originalConfirm.__anasFleetDurableWrapped){
  const wrappedConfirm=async function(){
   if(posCommitInFlight)return posCommitInFlight;
   const receiver=this,args=arguments;
   const acknowledgement=(async()=>{
    try{
     await awaitPendingV42DurableSaveAck();
     const result=await originalConfirm.apply(receiver,args);
     if(pendingTruckInvoiceRollback){
      const rollback=pendingTruckInvoiceRollback;pendingTruckInvoiceRollback=null;rollback();
      throw Error("TRUCK_POS_CONFIRM_DID_NOT_COMPLETE_DURABLE_SAVE");
     }
     return result;
    }catch(error){
     if(pendingTruckInvoiceRollback){const rollback=pendingTruckInvoiceRollback;pendingTruckInvoiceRollback=null;rollback();}
     throw error;
    }
   })();
   posCommitInFlight=acknowledgement;
   W.__ANAS_POS_CART_DURABLE_SAVE__=acknowledgement;
   try{return await acknowledgement;}
   finally{if(posCommitInFlight===acknowledgement)posCommitInFlight=null;}
  };
  wrappedConfirm.__anasFleetDurableWrapped=true;
  W.confirmHasibPaymentDurable=wrappedConfirm;
 }
}
function hookDebt(){const original=W.collectCustDebt;if(typeof original!=="function"||original.__anasFleetWrapped)return;const wrapped=async function(id){
 if(posCommitInFlight){try{await posCommitInFlight;}catch(error){message("توقف قبض الدين حتى تُحسم عملية POS السابقة: "+String(error?.message||error),true);return false;}}
 const d=data(),c=d?.customers?.find(x=>String(x.id)===String(id)),before=minor(c?.debt||0),ids=new Set((d?.cashMovements||[]).map(x=>String(x.id)));
 const result=await original.apply(this,arguments);
 const m=(data()?.cashMovements||[]).find(x=>!ids.has(String(x.id))&&x?.type==="add"&&x?.referenceType==="customer_debt");
 if(m)try{await recordDebt(m,before);}catch(e){message("تم حفظ قبض العميل لكن ربطه بالجولة يحتاج مراجعة: "+String(e.message||e),true);}
 return result;
};wrapped.__anasFleetWrapped=true;W.collectCustDebt=wrapped;}
function hookInvoicePrint(){const observer=new MutationObserver(()=>{const dialog=document.getElementById("anasInvoicePostSaveDialog");if(!dialog||dialog.querySelector("[data-anas-fleet-print]"))return;const b=document.createElement("button");b.type="button";b.dataset.anasFleetPrint="1";b.className="btn-pos-hasib";b.textContent="🖨️ طباعة حرارية عربية";b.addEventListener("click",()=>{const inv=(data()?.invoices||[]).find(x=>String(x.id)===String(lastInvoice?.id))||lastInvoice;if(inv)printInvoice(inv).catch(e=>message(String(e.message||e),true));});dialog.querySelector("div")?.appendChild(b);});observer.observe(document.body,{childList:true,subtree:true});}
function setupConflictCenter(){const truckReview=x=>String(x?.reason||"").startsWith("TRUCK_FLEET_");W.addEventListener("anas:v42-sync-quarantine",e=>(e.detail||[]).filter(truckReview).forEach(showConflict));const rows=W.ANASResilientStorage?.getItem?.(MUTATION_KEYS.quarantined)||[];rows.filter(truckReview).forEach(showConflict);}
function showConflict(item){const root=panel?.querySelector("#fleetConflict");if(!root)return;const isCas=item.reason==="TRUCK_FLEET_STATE_CONFLICT";const cloud=item.cloudState??item.cloudWarehouse??null,local=item.localState??item.operation?.payload?.nextState??item.localWarehouse??null;root.innerHTML="<div style='border:1px solid #d97706;padding:10px;border-radius:10px'><strong>"+(isCas?"تعارض شاحنة HTTP 409":"مراجعة عملية شاحنة")+"</strong><p>السبب: "+esc(item.reason)+"</p><p>نسخة الخادم ونسخة الجهاز محفوظتان؛ لا توجد كتابة صامتة.</p><pre style='white-space:pre-wrap;max-height:100px;overflow:auto'>"+esc(JSON.stringify(cloud,null,2))+"</pre><pre style='white-space:pre-wrap;max-height:100px;overflow:auto'>"+esc(JSON.stringify(local,null,2))+"</pre>"+(isCas?"<button data-choice='cloud'>الاحتفاظ بنسخة الخادم</button><button data-choice='local'>إعادة تطبيق نسخة الجهاز</button>":"")+"</div>";root.querySelectorAll("[data-choice]").forEach(b=>b.addEventListener("click",()=>resolveConflict(item,b.dataset.choice).catch(e=>message(String(e.message||e),true))));}
async function resolveConflict(item,choice){const d=data(),op=item.operation;if(choice==="local"&&!actor().canApproveVariance)throw Error("إعادة تطبيق نسخة الجهاز تتطلب اعتماد مدير مخوّل");if(choice==="local"){d.anasFleetState=item.localState||op.payload.nextState;if(W.saveDB()!==true||await W.saveDBDurably()!==true)throw Error("تعذر حفظ نسخة الجهاز فوق أساس الخادم");}else if(item.cloudState==null)delete d.anasFleetState;else d.anasFleetState=item.cloudState;const storage=W.ANASResilientStorage,rows=storage.getItem(MUTATION_KEYS.quarantined)||[];await storage.setItem(MUTATION_KEYS.quarantined,rows.filter(x=>String(x.opId)!==String(op.opId)));await storage.flushDurableItems?.();render();message(choice==="local"?"أُنشئت عملية جديدة فوق نسخة الخادم؛ نفّذ المزامنة.":"تم الاحتفاظ بنسخة الخادم وإزالة التعارض.");}
function wrapSyncRefresh(name){const original=W[name];if(typeof original!=="function"||original.__anasFleetWrapped)return;const wrapped=async function(){const result=await original.apply(this,arguments);try{const d=data();if(d)syncCurrentUserWarehouse(d,state());render();}catch(e){message("تعذر تحديث إسناد مخزن الشاحنة بعد المزامنة: "+String(e.message||e),true);}return result;};wrapped.__anasFleetWrapped=true;W[name]=wrapped;}
function install(){if(!data()||!document.getElementById("view-trucks"))return false;setup();W.addEventListener("anas:fleet-error",e=>message(String(e.detail||"تعذر ربط العملية بعهدة الشاحنة"),true));hookDebt();hookPosCartDurability();hookInvoicePrint();wrapSyncRefresh("anasFirebaseSyncPush");wrapSyncRefresh("anasFirebaseSyncPull");W.ANASFleetPOS=Object.freeze({onInvoiceCommitted:recordInvoice,printInvoice,printPayment});recoverInvoices().catch(e=>message("استعادة فواتير الشاحنة: "+String(e.message||e),true));recoverDebtMovements().catch(e=>message("استعادة دفعات ديون الشاحنة: "+String(e.message||e),true));return true;}
function boot(attempt=0){const storage=W.ANASResilientStorage;if(!data()||!storage?.ready?.()||!W.ANASMutationSync||!W.ANASArabicEscPos){if(attempt<200){setTimeout(()=>boot(attempt+1),100);return;}console.warn("[ANAS Fleet] staging runtime deferred: storage/sync bootstrap not ready");return;}install();}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>boot(),{once:true});else boot();
