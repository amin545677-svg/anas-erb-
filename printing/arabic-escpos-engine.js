/* ANAS ERP Arabic ESC/POS — Arabic Canvas raster, GS v 0, printer adapters and durable retry queue. */
(function(root){"use strict";
const QUEUE="ANAS_THERMAL_PRINT_QUEUE_V1",SETTINGS="ANAS_THERMAL_PRINTER_SETTINGS_V1",WIDTHS={"58mm":384,"80mm":576};
function minor(v,label){if(typeof v==="bigint")return v;if(typeof v==="number"&&Number.isSafeInteger(v))return BigInt(v);if(typeof v==="string"&&/^-?\d+$/.test(v))return BigInt(v);throw new TypeError(label+" must be integer minor units");}
function money(v){const n=minor(v,"money"),neg=n<0n,a=neg?-n:n;return(neg?"-":"")+(a/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,",")+"."+String(a%100n).padStart(2,"0");}function latinDigits(value){return String(value??"").replace(/[٠-٩۰-۹]/g,ch=>String("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹".indexOf(ch)%10)).replace(/[٫]/g,".").replace(/[٬]/g,",");}
function invoice(d){const old=minor(d.oldDebtMinor||0n,"old debt"),total=minor(d.invoiceTotalMinor,"invoice total"),paid=minor(d.paidMinor||0n,"paid"),balance=old+total-paid;if(balance<0n)throw Error("PAID_EXCEEDS_BALANCE");return{template:"invoice",business:d.businessName||"ANAS ERP",title:"وصل فاتورة بيع",fields:[["رقم الفاتورة",d.invoiceNumber||"—"],["التاريخ",d.date||"—"],["العميل",d.customerName||"—"]],rows:(d.items||[]).map(x=>[x.name||"",String(x.quantity??""),money(x.unitPriceMinor),money(x.totalMinor)]),totals:[["الدين السابق",money(old)],["الفاتورة الحالية",money(total)],["المدفوع",money(paid)],["الرصيد الجديد",money(balance)],["المعادلة",money(old)+" + "+money(total)+" - "+money(paid)+" = "+money(balance)]],footer:d.footer||"شكراً لثقتكم"};}
function payment(d){const before=minor(d.debtBeforeMinor,"debt before"),amount=minor(d.amountMinor,"payment");if(amount<=0n||amount>before)throw Error("INVALID_DEBT_PAYMENT");return{template:"payment",business:d.businessName||"ANAS ERP",title:"وصل استلام دفعة مالية",fields:[["رقم السند",d.receiptNumber||"—"],["التاريخ",d.date||"—"],["العميل",d.customerName||"—"],["طريقة الدفع",d.method||"نقداً"]],totals:[["الدين السابق",money(before)],["المبلغ المستلم",money(amount)],["الرصيد المتبقي",money(before-amount)],["المعادلة",money(before)+" - "+money(amount)+" = "+money(before-amount)]],footer:d.footer||"تم استلام المبلغ بنجاح"};}
function manifest(d){return{template:"manifest",business:d.businessName||"ANAS ERP",title:"ورقة تحميل شاحنة",fields:[["رقم الجولة",d.tripId||"—"],["الشاحنة",d.truckPlate||"—"],["السائق",d.driverName||"—"],["المستودع",d.warehouseName||"—"],["التاريخ",d.date||"—"]],rows:(d.items||[]).map(x=>[x.productName||x.name||"",String(x.quantity??""),x.unit||""]),signature:d.receiverName||"توقيع المستلم",footer:d.footer||"تُراجع الكميات عند الاستلام"};}
function statement(d){const opening=minor(d.openingBalanceMinor||0n,"opening balance"),invoices=minor(d.invoiceTotalMinor||0n,"invoice total"),paid=minor(d.paidMinor||0n,"paid"),returns=minor(d.returnCreditMinor||0n,"return credits"),adjustmentDebit=minor(d.adjustmentDebitMinor||0n,"adjustment debit"),adjustmentCredit=minor(d.adjustmentCreditMinor||0n,"adjustment credit"),balance=opening+invoices+adjustmentDebit-paid-returns-adjustmentCredit;if(d.closingBalanceMinor!==undefined&&minor(d.closingBalanceMinor,"closing balance")!==balance)throw Error("STATEMENT_BALANCE_MISMATCH");return{template:"statement",business:d.businessName||"ANAS ERP",title:"كشف حساب عميل",fields:[["العميل",d.customerName||"—"],["الفترة",(d.periodFrom||"البداية")+" — "+(d.periodTo||"حتى اليوم")]],rows:(d.rows||[]).map(x=>[x.date||"—",x.description||"حركة",x.reference||"—",money(x.debitMinor||0n),money(x.creditMinor||0n),money(x.balanceMinor||0n)]),totals:[["الرصيد السابق",money(opening)],["الفواتير",money(invoices)],["المقبوض",money(paid)],["المرتجعات",money(returns)],["تسويات مدينة",money(adjustmentDebit)],["تسويات دائنة",money(adjustmentCredit)],["الرصيد المتبقي",money(balance)],["المعادلة",money(opening)+" + "+money(invoices)+" + "+money(adjustmentDebit)+" - "+money(paid)+" - "+money(returns)+" - "+money(adjustmentCredit)+" = "+money(balance)]],footer:d.footer||"ANAS ERP"};}
function settlement(d){return{template:"settlement",business:d.businessName||"ANAS ERP",title:"تسوية وجرد جولة الشاحنة",fields:[["رقم الجولة",d.tripId||"—"],["السائق",d.driverName||"—"],["الشاحنة",d.truckPlate||"—"]],rows:(d.inventory||[]).map(x=>[x.productName||x.productId,String(x.expected??""),String(x.actual??""),String(x.variance??"0")]),totals:[["تحصيل المبيعات",money(d.cashSalesMinor||0n)],["دفعات الديون القديمة",money(d.oldDebtPaymentsMinor||0n)],["المصاريف الميدانية",money(d.fieldExpensesMinor||0n)],["الصافي الواجب تسليمه",money(d.netDueMinor||0n)],["النقد الفعلي",money(d.actualCashMinor||0n)],["فرق الصندوق",money(d.cashVarianceMinor||0n)]],footer:d.varianceNote||"تم توثيق نتيجة الجرد والتسوية"};}
function wrap(ctx,text,max){const words=latinDigits(text).split(/\s+/),out=[];let line="";for(const word of words){const next=line?line+" "+word:word;if(ctx.measureText(next).width<=max){line=next;continue;}if(line){out.push(line);line="";}if(ctx.measureText(word).width<=max){line=word;continue;}let chunk="";for(const ch of Array.from(word)){if(chunk&&ctx.measureText(chunk+ch).width>max){out.push(chunk);chunk=ch;}else chunk+=ch;}line=chunk;}if(line)out.push(line);return out.length?out:[""];}
function render(doc,opts={}){
 const paper=opts.paper||"58mm",width=opts.widthDots||WIDTHS[paper];if(width!==384&&width!==576)throw Error("PAPER_WIDTH_MUST_BE_384_OR_576");
 const factory=opts.canvasFactory||(root.document&&(()=>root.document.createElement("canvas")));if(!factory)throw Error("CANVAS_UNAVAILABLE");
 const scale=opts.dpiScale||2,fontSize=opts.fontSize||18,lineH=Math.ceil(fontSize*1.55),content=width-28;
 const high=factory(),measure=high.getContext("2d");if(!measure)throw Error("CANVAS_2D_UNAVAILABLE");
 const blocks=[],fontFamily=opts.fontFamily||"Tahoma, Arial, sans-serif";
 const push=(txt,style={})=>{const f=style.font||((style.bold?"700 ":"400 ")+fontSize+"px "+fontFamily);measure.font=f;for(const line of wrap(measure,txt,content))blocks.push({text:line,font:f,align:style.align||"right",gap:style.gap||0});};
 push(doc.business||"ANAS ERP",{bold:true,align:"center",gap:5});push(doc.title||"",{bold:true,align:"center",gap:5});
 for(const f of doc.fields||[])push(String(f[0])+": "+String(f[1]));
 if(doc.rows&&doc.rows.length){push("--------------------------------",{align:"center"});for(const row of doc.rows)push(row.map(String).join(" | "));}
 for(const t of doc.totals||[])push(String(t[0])+": "+String(t[1]),{bold:t[0]==="الرصيد الجديد"||t[0]==="الصافي الواجب تسليمه"});
 if(doc.signature){push("--------------------------------",{align:"center"});push(doc.signature,{align:"center",gap:6});}if(doc.footer)push(doc.footer,{align:"center",gap:6});
 const height=Math.max(120,26+blocks.reduce((a,b)=>a+lineH+b.gap,0));
 high.width=width*scale;high.height=height*scale;const hctx=high.getContext("2d");hctx.scale(scale,scale);hctx.fillStyle="#fff";hctx.fillRect(0,0,width,height);hctx.fillStyle="#000";hctx.textBaseline="top";if("direction"in hctx)hctx.direction="rtl";
 let y=12;for(const b of blocks){hctx.font=b.font;hctx.textAlign=b.align;hctx.fillText(b.text,b.align==="center"?width/2:width-14,y,content);y+=lineH+b.gap;}
 const output=factory();output.width=width;output.height=height;const octx=output.getContext("2d");octx.fillStyle="#fff";octx.fillRect(0,0,width,height);octx.drawImage(high,0,0,width,height);return output;
}
function mono(imageData,width,height,threshold=175){
 if(!imageData?.data||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||imageData.data.length<width*height*4)throw TypeError("INVALID_RGBA_IMAGE_DATA");
 const bpr=Math.ceil(width/8),bitmap=new Uint8Array(bpr*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,a=imageData.data[i+3]/255,lum=(.299*imageData.data[i]+.587*imageData.data[i+1]+.114*imageData.data[i+2])*a+255*(1-a);if(lum<threshold)bitmap[y*bpr+(x>>3)]|=0x80>>(x&7);}
 return{bitmap,bytesPerRow:bpr,width,height};
}
function gsv0(r){if(!Number.isInteger(r.bytesPerRow)||r.bytesPerRow<1||!Number.isInteger(r.height)||r.height<1||!(r.bitmap instanceof Uint8Array)||r.bitmap.length!==r.bytesPerRow*r.height)throw TypeError("INVALID_RASTER_BITMAP");const cmd=new Uint8Array(8+r.bitmap.length);cmd.set([0x1d,0x76,0x30,0,r.bytesPerRow&255,(r.bytesPerRow>>8)&255,r.height&255,(r.height>>8)&255]);cmd.set(r.bitmap,8);return cmd;}
function raster(canvas,opts={}){const ctx=canvas.getContext("2d"),r=mono(ctx.getImageData(0,0,canvas.width,canvas.height),canvas.width,canvas.height,opts.threshold||175),img=gsv0(r),out=new Uint8Array(2+img.length+2);out.set([0x1b,0x40]);out.set(img,2);out.set([0x0a,0x0a],2+img.length);return{payload:out,width:r.width,height:r.height,bytesPerRow:r.bytesPerRow};}
function b64(bytes){let s="";for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+32768));return root.btoa?root.btoa(s):Buffer.from(bytes).toString("base64");}
function un64(s){if(root.atob){const b=root.atob(s);return Uint8Array.from(b,c=>c.charCodeAt(0));}return Uint8Array.from(Buffer.from(s,"base64"));}
async function saveQueue(storage,q){if(!storage||typeof storage.setItem!=="function")throw Error("INDEXEDDB_BACKED_STORAGE_REQUIRED");await storage.setItem(QUEUE,q);if(storage.flushDurableItems)await storage.flushDurableItems();}
const activePrintJobs=new Map();
function createQueue({storage,send,now=()=>new Date().toISOString()}={}){
 if(!storage||typeof send!=="function")throw Error("STORAGE_AND_SEND_REQUIRED");
 const read=async()=>{const value=await storage.getItem(QUEUE);return Array.isArray(value)?value:[];};
 return Object.freeze({
  async enqueue(bytes,meta={}){
   const q=await read(),id=String(meta.idempotencyKey||("print-"+Date.now()+"-"+q.length));
   const existing=q.find(item=>item.id===id);
   if(existing)return{id,duplicate:true,status:existing.status};
   q.push({id,payloadBase64:b64(bytes),metadata:meta,status:"PENDING",createdAt:now(),attempts:0});
   await saveQueue(storage,q);return{id,duplicate:false,status:"PENDING"};
  },
  async retry(id){
   const key=String(id);
   if(activePrintJobs.has(key))return activePrintJobs.get(key);
   const task=(async()=>{
    const q=await read(),item=q.find(value=>value.id===key);
    if(!item)throw Error("PRINT_JOB_NOT_FOUND");
    if(item.status==="PRINTED")return{id:item.id,status:"PRINTED",duplicate:true};
    item.attempts++;
    try{
     await send(un64(item.payloadBase64),item.metadata);
     item.status="PRINTED";item.printedAt=now();await saveQueue(storage,q);
     return{id:item.id,status:item.status};
    }catch(error){
     item.status="PENDING";item.lastError=String(error?.message||error);await saveQueue(storage,q);throw error;
    }
   })();
   activePrintJobs.set(key,task);
   try{return await task;}finally{if(activePrintJobs.get(key)===task)activePrintJobs.delete(key);}
  },
  async list(){return(await read()).map(item=>({id:item.id,status:item.status,attempts:item.attempts,metadata:item.metadata,lastError:item.lastError||null}));}
 });
}
async function bluetooth(bytes,settings={}){const api=root.navigator?.bluetooth;if(!api)throw Error("WEB_BLUETOOTH_UNAVAILABLE");let device=null;if(settings.deviceId&&api.getDevices){const devices=await api.getDevices();device=devices.find(d=>d.id===settings.deviceId)||null;}if(!device){const opts=settings.filters?.length?{filters:settings.filters,optionalServices:settings.optionalServices||[]}:{acceptAllDevices:true,optionalServices:settings.optionalServices||[]};device=await api.requestDevice(opts);}const server=await device.gatt.connect(),service=await server.getPrimaryService(settings.serviceUuid),ch=await service.getCharacteristic(settings.characteristicUuid),size=settings.chunkSize||180;for(let i=0;i<bytes.length;i+=size){const part=bytes.slice(i,i+size);if(ch.writeValueWithoutResponse)await ch.writeValueWithoutResponse(part);else await ch.writeValue(part);}try{saveSettings({...getSettings(),...settings,deviceId:device.id,deviceName:device.name||"Bluetooth printer",transport:"auto"});}catch(_){}return{deviceId:device.id,deviceName:device.name||"Bluetooth printer",bytesSent:bytes.length};}
async function android(bytes){const bridge=root.Android||root.AnasPrinterBridge;if(!bridge||typeof bridge.printEscPosBase64!=="function")throw Error("ANDROID_RAW_PRINT_BRIDGE_UNAVAILABLE");return bridge.printEscPosBase64(b64(bytes));}
function rawbt(bytes){if(!root.location)throw Error("RAWBT_UNAVAILABLE");root.location.href="rawbt:base64,"+encodeURIComponent(b64(bytes));return{status:"RAWBT_HANDOFF_REQUESTED"};}
async function shareImage(canvas,name="ANAS_ERP_receipt.png"){const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error("IMAGE_EXPORT_FAILED")),"image/png"));const file=typeof File==="function"?new File([blob],name,{type:"image/png"}):null;if(root.navigator?.share&&file&&(!root.navigator.canShare||root.navigator.canShare({files:[file]}))){await root.navigator.share({files:[file],title:"ANAS ERP receipt"});return{status:"SHARED"};}throw Error("IMAGE_SHARE_UNAVAILABLE");}
async function sendPreferred(bytes,settings={}){if(settings.transport==="android")return android(bytes);if(settings.transport==="rawbt")return rawbt(bytes);if(settings.transport==="bluetooth")return bluetooth(bytes,settings);let lastError=null;if(root.navigator?.bluetooth){try{return await bluetooth(bytes,settings);}catch(e){lastError=e;}}const bridge=root.Android||root.AnasPrinterBridge;if(bridge&&typeof bridge.printEscPosBase64==="function"){try{return await android(bytes);}catch(e){lastError=e;}}if(settings.allowRawBTFallback!==false)return rawbt(bytes);if(lastError)throw lastError;throw Error("NO_SUPPORTED_PRINTER_TRANSPORT");}
async function printDocument(doc,options={}){const storage=root.ANASResilientStorage;if(!storage)throw Error("INDEXEDDB_STORAGE_NOT_READY");const settings={...getSettings(),...(options.printer||{})};const canvas=render(doc,{paper:settings.paper||"58mm",...options.render});const encoded=raster(canvas,options.raster);const queue=createQueue({storage,send:(bytes,meta)=>sendPreferred(bytes,{...settings,...meta})});const queued=await queue.enqueue(encoded.payload,{idempotencyKey:options.idempotencyKey,template:doc.template,paper:settings.paper||"58mm"});try{const result=await queue.retry(queued.id);return{...result,queuedId:queued.id,width:encoded.width,height:encoded.height};}catch(error){return{status:"QUEUED_FOR_RETRY",queuedId:queued.id,error:String(error?.message||error)};}}
function isPhysicalPrinterConnected(){
 const settings=getSettings();
 const bridge=root.Android||root.AnasPrinterBridge;
 if(settings.transport==="android"&&bridge&&typeof bridge.printEscPosBase64==="function")return true;
 const bluetoothApi=root.navigator&&root.navigator.bluetooth;
 if(!bluetoothApi||typeof bluetoothApi.getDevices!=="function"||!settings.deviceId)return false;
 return bluetoothApi.getDevices().then(devices=>{
  const device=(devices||[]).find(item=>item&&item.id===settings.deviceId);
  return !!(device&&device.gatt&&typeof device.gatt.connect==="function");
 }).catch(()=>false);
}
function saveSettings(s){if(!root.localStorage)throw Error("LOCAL_SETTINGS_UNAVAILABLE");if(!WIDTHS[s.paper||"58mm"])throw Error("INVALID_PAPER_SIZE");root.localStorage.setItem(SETTINGS,JSON.stringify({...s,paper:s.paper||"58mm",widthDots:WIDTHS[s.paper||"58mm"]}));}
function getSettings(){try{return root.localStorage?JSON.parse(root.localStorage.getItem(SETTINGS)||"{}"):{};}catch(_){return{};}}
const api=Object.freeze({PAPER_WIDTHS:WIDTHS,isPhysicalPrinterConnected,formatMinor:money,buildInvoiceReceipt:invoice,buildPaymentReceipt:payment,buildLoadManifest:manifest,buildTripSettlement:settlement,buildCustomerStatementReceipt:statement,renderReceiptCanvas:render,encodeMonoBitmap:mono,buildGSv0:gsv0,canvasToEscPos:raster,createPrintQueue:createQueue,sendViaBluetooth:bluetooth,sendViaAndroid:android,sendViaRawBT:rawbt,sendPreferred,printDocument,shareImage,saveSettings,getSettings});
root.ANASArabicEscPos=api;
if(typeof root.printLastConfirmedInvoice==="function"&&!root.__ANAS_THERMAL_PRINT_ROUTER_INSTALLED){
 const originalPrintLastConfirmedInvoice=root.printLastConfirmedInvoice;
 root.printLastConfirmedInvoice=function(type){
  if(type==="legalA4")return originalPrintLastConfirmedInvoice(type);
  const connected=api.isPhysicalPrinterConnected();
  const useTraditional=()=>{const active=root.ANASArabicEscPos;root.ANASArabicEscPos=null;try{return originalPrintLastConfirmedInvoice(type);}finally{root.ANASArabicEscPos=active;}};
  return connected&&typeof connected.then==="function"
   ?connected.then(isConnected=>isConnected?originalPrintLastConfirmedInvoice(type):useTraditional())
   :(connected?originalPrintLastConfirmedInvoice(type):useTraditional());
 };
 root.__ANAS_THERMAL_PRINT_ROUTER_INSTALLED=true;
}
if(typeof module!=="undefined"&&module.exports)module.exports=api;
})(typeof window!=="undefined"?window:globalThis);
