import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {buildStagingHosting} from "../scripts/build-staging-hosting.mjs";
import {chromium} from "playwright";
import {MUTATION_KEYS} from "../sync/mutation_keys.mjs";

const DB_KEY=MUTATION_KEYS.appData;
function safeJson(value){try{return JSON.stringify(value);}catch(error){return JSON.stringify({serializationError:String(error?.stack||error)});}}
function fixture(){const customer={id:"C1",name:"زبون قديم",phone:"0000000000",debt:20,credit_limit:100};return{
 appName:"ANAS ERP Truck Offline Acceptance",
 storeConfig:{name:"ANAS ERP",footer:"Offline staging acceptance"},
 currentUser:{id:"DRIVER-1",name:"سائق الاختبار",role:"مدير عام",warehouse:"المخزن الرئيسي",secondaryWarehouse:""},
 activePosScreenTab:1,activePriceTier:1,posScreensCarts:{1:[],2:[],3:[],4:[],quote:[]},
 caisseBalance:100,
 products:[{id:"TRUCK-P1",name:"شاي اختبار الشاحنة",stock:200,buyPrice:2,lastPurchaseCost:2,price1:10,price2:9,price3:8,unit:"قطعة",barcode:"TRUCKP1",warehouseStock:{}}],
 customers:[customer],suppliers:[],supplierMovements:[],purchases:[],purchaseInvoices:[],expenses:[],
 invoices:[{id:"OLD-DEBT-INV",date:"2026-11-20",customer:customer.name,customerObj:customer,customerId:"C1",items:[{id:"TRUCK-P1",name:"شاي اختبار الشاحنة",qty:2,price:10,total:20}],subtotal:20,discount:0,total:20,paid:0,remaining:20,warehouse:"المخزن الرئيسي",warehouseName:"المخزن الرئيسي",invoiceLedgerVersion:2}],
 cashMovements:[],stockMovements:[],clientMovements:[],settlementAllocations:[],auditTrail:[],
 users:[],alerts:[],warehouseTransfers:[],warehouses:[],truckTrips:[],trucks:[],returns:[],stocktakeRecords:[],syncUrl:""
};}
function staticServer(root){
 root=path.resolve(root);
 return async(req,res)=>{
  try{
   let cleanPath;
   try{cleanPath=decodeURIComponent(new URL(req.url,"http://127.0.0.1").pathname);}catch{res.writeHead(400);res.end("bad request");return;}
   const relative=cleanPath.startsWith("/")?cleanPath.slice(1):cleanPath;
   let target=path.resolve(root,relative||"index.html");
   if(!path.extname(target))target=path.join(target,"index.html");
   if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403);res.end("forbidden");return;}
   let bytes;
   try{bytes=await fs.readFile(target);}catch{res.writeHead(404);res.end("not found");return;}
   const ext=path.extname(target);
   const contentTypes={
    ".html":"text/html; charset=utf-8",
    ".js":"application/javascript; charset=utf-8",
    ".mjs":"application/javascript; charset=utf-8",
    ".css":"text/css; charset=utf-8",
    ".json":"application/json; charset=utf-8",
    ".webmanifest":"application/manifest+json; charset=utf-8"
   };
   const type=contentTypes[ext]||"application/octet-stream";
   res.writeHead(200,{"Content-Type":type,"Cache-Control":"no-store"});
   res.end(bytes);
  }catch{
   if(!res.headersSent)res.writeHead(500);
   if(!res.writableEnded)res.end("internal server error");
  }finally{
   if(!res.writableEnded&&!res.destroyed)res.end();
  }
 };
}
test("Staging fleet + POS + debt collection survive airplane hard reload, replay once, and expose 409 fleet conflict",async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),"anas-truck-offline-"));
 const out=path.join(temp,"site");
 let server,browser,context,page;
 const errors=[],consoleErrors=[],dialogMessages=[],local404s=[],externalScripts=[];
 try{
  await buildStagingHosting({rootDir:process.cwd(),outDir:out,env:{FIREBASE_STAGING_WEB_API_KEY:"STAGING_PUBLIC_API_KEY",FIREBASE_STAGING_WEB_APP_ID:"1:123456:web:staging",GITHUB_SHA:"truck-offline-test",ANAS_BUILD_SHA:"truck-offline-test"}});
  server=http.createServer(staticServer(out));
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const port=server.address().port;
  browser=await chromium.launch({headless:true,args:["--no-proxy-server","--proxy-bypass-list=*"]});
  context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:"allow",viewport:{width:1365,height:900},locale:"fr-DZ"});
  await context.addInitScript(({key,data})=>{if(localStorage.getItem(key)===null)localStorage.setItem(key,JSON.stringify(data));window.__ANAS_ALLOW_V42_RUNTIME_ON_LOCALHOST__=true;window.anasGetFirebaseIdToken=async()=>"offline-test-token";},{key:DB_KEY,data:fixture()});
  page=await context.newPage();
  const localOrigin="http://127.0.0.1:"+port;
  page.on("pageerror",e=>errors.push(e.stack||e.message));
  page.on("console",msg=>{if(msg.type()==="error")consoleErrors.push(msg.text());});
  page.on("response",response=>{
   if(response.status()===404&&response.url().startsWith(localOrigin+"/"))local404s.push(response.url());
  });
  let promptNumber=0;
  page.on("dialog",async dialog=>{dialogMessages.push({type:dialog.type(),message:dialog.message()});if(dialog.type()==="prompt"){promptNumber++;await dialog.accept(promptNumber===1?"10.00":JSON.stringify([{invoiceId:"OLD-DEBT-INV",amount:"10.00"}]));}else await dialog.accept();});
  let serverSnapshot=JSON.stringify(fixture()),revision="rev-1",conflictBudget=0,postCount=0;
  const cors={"Access-Control-Allow-Origin":"http://127.0.0.1:"+port,"Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Allow-Methods":"GET, POST, OPTIONS"};
  await page.route("**/*",async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.protocol==="http:"&&url.hostname==="127.0.0.1"&&Number(url.port)===port){await route.continue();return;}
   // All application-critical SDKs and runtimes are bundled under /erp/.
   // External script tags are optional integrations; answer deterministically
   // instead of turning their absence into a page bootstrap network failure.
   if(request.resourceType()==="script"){
    externalScripts.push(request.url());
    await route.fulfill({status:200,contentType:"application/javascript; charset=utf-8",body:"/* optional external script disabled in offline acceptance */"});
    return;
   }
   await route.abort();
  });
  await page.route("https://anas-erp-firebase-snapshot-staging.amin545677.workers.dev/snapshot**",async route=>{
   const req=route.request();
   if(req.method()==="OPTIONS"){await route.fulfill({status:204,headers:cors});return;}
   if(req.method()==="GET"){await route.fulfill({status:200,headers:{...cors,"Content-Type":"application/json"},body:JSON.stringify({exists:true,data:serverSnapshot,revision})});return;}
   postCount++;
   if(conflictBudget>0){conflictBudget--;await route.fulfill({status:409,headers:{...cors,"Content-Type":"application/json"},body:JSON.stringify({error:"CAS_CONFLICT"})});return;}
   const body=req.postDataJSON();serverSnapshot=body.data;revision="rev-"+(postCount+1);await route.fulfill({status:200,headers:{...cors,"Content-Type":"application/json"},body:JSON.stringify({saved:true,revision})});
  });
  await page.goto("http://127.0.0.1:"+port+"/erp/",{waitUntil:"domcontentloaded",timeout:30000});
  const runtimeReady=()=>window.ANASResilientStorage?.ready()===true&&window.ANASMutationSync?.status==="installed"&&document.getElementById("anasFleetEnginePanel");
  try{
   await page.waitForFunction(runtimeReady,null,{timeout:30000});
   await page.evaluate(()=>{
    const original=window.saveDBDurably,originalSaveDB=window.saveDB;
    const stats={calls:0,completed:0,rejected:0,saveDBCalls:0,lastState:"not-called",lastError:null};
    window.__ANAS_DURABLE_SAVE_DIAGNOSTICS__=stats;
    window.saveDB=function(...args){stats.saveDBCalls++;return originalSaveDB.apply(this,args);};
    window.saveDBDurably=async function(...args){
     stats.calls++;stats.lastState="pending";stats.lastError=null;
     try{const result=await original.apply(this,args);stats.completed++;stats.lastState="completed";return result;}
     catch(error){stats.rejected++;stats.lastState="rejected";stats.lastError=String(error?.stack||error);throw error;}
    };
   });
  }catch(error){
   const conditionState=await page.evaluate(()=>({
    storageReady:window.ANASResilientStorage?.ready?.()===true,
    mutationSyncInstalled:window.ANASMutationSync?.status==="installed",
    fleetPanelPresent:!!document.getElementById("anasFleetEnginePanel")
   }));
   console.error("[truck-offline] runtimeReady bootstrap failed:",error?.stack||error);
   console.error("[truck-offline] runtime condition state:",JSON.stringify(conditionState));
   console.error("[truck-offline] page errors:",JSON.stringify(errors));
   console.error("[truck-offline] console errors:",JSON.stringify(consoleErrors));
   console.error("[truck-offline] local 404 responses:",JSON.stringify(local404s));
   console.error("[truck-offline] optional external scripts stubbed:",JSON.stringify(externalScripts));
   throw error;
  }
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  if(!(await page.evaluate(()=>!!navigator.serviceWorker?.controller)))await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>!!navigator.serviceWorker?.controller&&window.ANASResilientStorage?.ready()===true&&window.ANASMutationSync?.status==="installed"&&document.getElementById("anasFleetEnginePanel"),null,{timeout:30000});
  await page.evaluate(()=>{window.__ANAS_SET_APP_DATA__(window.__ANAS_GET_APP_DATA__());});
  if(postCount===0)serverSnapshot=await page.evaluate(()=>JSON.stringify(AppData));
  await page.evaluate(()=>openView("trucks"));
  await page.locator("#fleetPlate").fill("12345-31");
  await page.locator("#fleetDriver").fill("سائق الاختبار");
  await page.locator("[data-fleet='open']").click();
  // Wait for the async open-trip action to finish durable persistence before continuing.
  await page.waitForFunction(()=>document.getElementById("anasFleetMessage")?.textContent?.trim().startsWith("تم فتح الجولة وإنشاء مخزن شاحنة فعلي"));
  await page.locator("#fleetProduct").selectOption("TRUCK-P1");
  await page.locator("#fleetQty").fill("100");
  await page.locator("[data-fleet='add']").click();
  await page.locator("[data-fleet='load']").click();
  // Stock is mirrored synchronously before durable storage acknowledges the load.
  // Wait for the completion message before starting another fleet action.
  await page.waitForFunction(()=>
    (AppData.products[0].stock=== "100.000"||Number(AppData.products[0].stock)===100) &&
    document.getElementById("anasFleetMessage")?.textContent?.trim()==="تم تحويل الحمولة من المستودع إلى مخزن الشاحنة."
  ,null,{timeout:15000});
  await page.locator("[data-fleet='pos']").click();
  // Diagnose application state only if the POS navigation wait fails.
  try {
    await page.locator("#view-pos.page-view.active").waitFor({state:"visible",timeout:15000});
  } catch(error) {
    const navigationState=await page.evaluate(()=>{
      const pos=document.getElementById("view-pos");
      const active=document.querySelector(".page-view.active");
      const notices=Array.from(document.querySelectorAll('[role="alert"],[role="status"],.toast,.toast-message,.notification'))
        .map(node=>(node.textContent||"").trim()).filter(Boolean);
      return {activeView:active?.id||null,posClassName:pos?.className||null,
        posDisplay:pos?getComputedStyle(pos).display:null,
        fleetMessage:document.getElementById("anasFleetMessage")?.textContent?.trim()||null,
        notices};
    });
    console.error("[truck-offline] POS navigation diagnostics:",JSON.stringify({
      ...navigationState,pageErrors:errors,consoleErrors
    }));
    throw error;
  }
  await page.locator("#posSearchField").waitFor({state:"visible",timeout:15000});
  assert.equal(await page.locator("#posSearchField").isVisible(),true,
    "truck POS action must finish navigation and expose the cashier search field");
  await page.locator("#posSearchField").fill("شاي اختبار الشاحنة");
  const result=page.locator("#posSearchResults .pos-search-result").filter({hasText:"شاي اختبار الشاحنة"});
  await result.waitFor({state:"visible",timeout:10000});
  await result.click();
  const tier=page.locator("#anasPosPriceTierModal");
  if(await tier.count()){await tier.waitFor({state:"visible"});await tier.locator("button").filter({hasText:"سعر التجزئة (الدفعة)"}).click();}
  await page.locator("#anasPosFloatingCart [data-mini-action='checkout']").click();
  await page.locator("#hasibModal.active").waitFor({state:"visible"});
  await page.locator("#hasibPaidAmount").fill("10.00");
  await page.evaluate(async()=>{
   if(typeof window.__ANAS_FLEET_AWAIT_PENDING_DURABLE_SAVE__!=="function")
    throw new Error("fleet POS must expose the prior V42 durable-ACK barrier");
   await window.__ANAS_FLEET_AWAIT_PENDING_DURABLE_SAVE__();
  });
  const priorDurableBarrier=await page.evaluate(()=>window.__ANAS_FLEET_LAST_DURABLE_BARRIER__||null);
  console.log("[truck-offline] prior V42 durable barrier:",JSON.stringify(priorDurableBarrier));
  const posSaveCountsBefore=await page.evaluate(()=>({saveDB:window.__ANAS_DURABLE_SAVE_DIAGNOSTICS__.saveDBCalls,durable:window.__ANAS_DURABLE_SAVE_DIAGNOSTICS__.calls}));
  await page.locator("#hasibModal button[onclick='confirmHasibPaymentDurable()']").click();
  await page.evaluate(async()=>{
    const acknowledgement=window.__ANAS_POS_CART_DURABLE_SAVE__;
    if(!acknowledgement||typeof acknowledgement.then!=="function")throw new Error("POS confirmation did not expose its full durable acknowledgement");
    await acknowledgement;
  });
  const posSaveCountsAfter=await page.evaluate(()=>({saveDB:window.__ANAS_DURABLE_SAVE_DIAGNOSTICS__.saveDBCalls,durable:window.__ANAS_DURABLE_SAVE_DIAGNOSTICS__.calls}));
  assert.equal(posSaveCountsAfter.saveDB-posSaveCountsBefore.saveDB,1,"truck POS invoice must call saveDB exactly once");
  assert.equal(posSaveCountsAfter.durable-posSaveCountsBefore.durable,1,"truck POS invoice must perform exactly one durable save");
  const committedSale=await page.evaluate(()=>{
    const snapshot=window.ANASResilientStorage.getCommittedSnapshot();
    return {
      invoiceCount:snapshot.invoices.filter(x=>String(x.warehouse)==="شاحنة 12345-31").length,
      truckSales:snapshot.anasFleetState.trips.reduce((n,t)=>n+(t.sales||[]).length,0)
    };
  });
  assert.equal(committedSale.invoiceCount,1,"POS ACK must include the durable invoice");
  assert.equal(committedSale.truckSales,1,"POS ACK must include the durable truck-invoice linkage");
  await page.waitForFunction(()=>AppData.invoices.some(x=>String(x.warehouse)==="شاحنة 12345-31"),null,{timeout:15000});
  await page.waitForFunction(()=>AppData.anasFleetState?.trips?.some(t=>t.sales?.some(s=>s.invoiceId)),null,{timeout:15000});
  await page.evaluate(async()=>{await collectCustDebt("C1");});
  await page.waitForFunction(()=>AppData.cashMovements.some(x=>x.referenceType==="customer_debt"),null,{timeout:15000});
  await page.waitForFunction(()=>AppData.anasFleetState.trips.some(t=>t.debtPayments?.length),null,{timeout:15000});
  await context.setOffline(true);
  await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.ANASResilientStorage?.ready()===true&&window.ANASMutationSync?.status==="installed"&&document.getElementById("anasFleetEnginePanel"),null,{timeout:30000});
  const localProof=await page.evaluate(({pendingKey})=>{
   const storage=window.ANASResilientStorage,s=storage.getCommittedSnapshot(),q=storage.getItem(pendingKey)||[];
   const invoice=s.invoices.find(x=>String(x.warehouse||"").startsWith("شاحنة "));
   const addedRows=(delta,field="id")=>{
    const before=new Set((delta?.before||[]).map(row=>String(row?.[field]??"")));
    return (delta?.after||[]).filter(row=>row&&!before.has(String(row?.[field]??"")));
   };
   const changedRows=(delta,field="id")=>{
    const before=new Map((delta?.before||[]).map(row=>[
     String(row?.[field]??""),JSON.stringify(row)
    ]));
    return (delta?.after||[]).filter(row=>row&&(
     !before.has(String(row?.[field]??""))||
     JSON.stringify(row)!==before.get(String(row?.[field]??""))
    ));
   };
   const fleetSalesAdded=(operation,invoiceId)=>{
    const baseTrips=operation?.payload?.baseState?.trips||[];
    const prior=new Map(baseTrips.map(trip=>[String(trip.id),new Set((trip.sales||[]).map(row=>String(row.id)))]));
    return (operation?.payload?.nextState?.trips||[]).flatMap(trip=>(trip.sales||[]).filter(row=>
     !(prior.get(String(trip.id))||new Set()).has(String(row.id))&&String(row.invoiceId)===String(invoiceId)
    ));
   };
   const bundle=Array.isArray(q)?q.find(item=>{
    if(item?.type!=="TRUCK_FLEET_OPERATION"||item?.status!=="PENDING")return false;
    const deltas=item.payload?.collectionDeltas||{};
    const invoiceId=String(invoice?.id??"");
    const addedInvoices=addedRows(deltas.invoices);
    const addedCash=addedRows(deltas.cashMovements);
    const addedStock=addedRows(deltas.stockMovements);
    const changedCustomers=changedRows(deltas.customers);
    return addedInvoices.some(row=>String(row.id)===invoiceId)&&
     addedCash.some(row=>row.referenceType==="sales_invoice"&&String(row.referenceId)===invoiceId)&&
     addedStock.some(row=>row.referenceType==="sales_invoice"&&String(row.referenceId)===invoiceId)&&
     changedCustomers.some(row=>String(row.id)==="C1")&&
     fleetSalesAdded(item,invoiceId).length>0;
   }):null;
   const deltas=bundle?.payload?.collectionDeltas||{},invoiceId=String(invoice?.id??"");
   const saleOps=(Array.isArray(q)?q:[]).filter(item=>item?.type==="SALE_INVOICE"&&String(item.payload?.invoice?.id??"")===invoiceId);
   return{
    invoiceCount:s.invoices.filter(x=>String(x.warehouse||"").startsWith("شاحنة ")).length,
    truckSales:s.anasFleetState.trips.reduce((n,t)=>n+(t.sales||[]).length,0),
    debtPayments:s.anasFleetState.trips.reduce((n,t)=>n+(t.debtPayments||[]).length,0),
    cashReceipts:s.cashMovements.filter(x=>x.referenceType==="customer_debt").length,
    saleCashReceipts:s.cashMovements.filter(x=>x.referenceType==="sales_invoice").length,
    saleStockMovements:s.stockMovements.filter(x=>x.referenceType==="sales_invoice").length,
    customerDebt:Number(s.customers.find(x=>String(x.id)==="C1")?.debt),cashBalance:Number(s.caisseBalance),
    truckWarehouseStock:Number(s.products.find(x=>String(x.id)==="TRUCK-P1")?.warehouseStock?.["شاحنة 12345-31"]),
    pendingTypes:q.map(x=>x.type),
    posBundle:bundle?{
     type:bundle.type,status:bundle.status,
     invoiceIds:addedRows(deltas.invoices).filter(row=>String(row.id)===invoiceId).map(row=>row.id),
     cashMovementIds:addedRows(deltas.cashMovements).filter(row=>row.referenceType==="sales_invoice"&&String(row.referenceId)===invoiceId).map(row=>row.id),
     stockMovementIds:addedRows(deltas.stockMovements).filter(row=>row.referenceType==="sales_invoice"&&String(row.referenceId)===invoiceId).map(row=>row.id),
     fleetSaleIds:fleetSalesAdded(bundle,invoiceId).map(row=>row.id),
     auditIds:addedRows(deltas.auditTrail).filter(row=>String(row.referenceId)===invoiceId).map(row=>row.id),
     separateSaleOps:saleOps.length
    }:null,
    revision:storage.status().revision,db:storage.status().database,sequence:s.anasLocalMutationSequence
   };
  },{pendingKey:MUTATION_KEYS.pending});
  assert.equal(localProof.invoiceCount,1,"truck POS invoice must survive a complete offline reload");
  assert.equal(localProof.truckSales,1,"truck sale event must survive offline reload exactly once");
  assert.equal(localProof.debtPayments,1,"old-debt collection linked to the active truck trip must survive offline reload");
  assert.equal(localProof.cashReceipts,1,"the actual debt receipt must survive offline reload alongside the fleet allocation");
  assert.equal(localProof.saleCashReceipts,1,"the POS cash receipt must survive offline reload with the linked invoice");
  assert.equal(localProof.saleStockMovements,1,"the POS stock movement must survive offline reload with the linked invoice");
  assert.ok(localProof.pendingTypes.includes("TRUCK_FLEET_OPERATION"),"fleet operations must be durably queued");
  assert.ok(localProof.posBundle,"POS invoice must be durably queued inside its atomic TRUCK_FLEET_OPERATION");
  assert.equal(localProof.posBundle.invoiceIds.length,1,"the durable fleet operation must contain the complete POS invoice");
  assert.equal(localProof.posBundle.cashMovementIds.length,1,"the same durable fleet operation must contain the POS cash ledger row");
  assert.equal(localProof.posBundle.stockMovementIds.length,1,"the same durable fleet operation must contain the POS stock ledger row");
  assert.equal(localProof.posBundle.fleetSaleIds.length,1,"the durable fleet operation must contain the linked truck sale");
  assert.equal(localProof.posBundle.auditIds.length,1,"the durable fleet operation must contain the invoice audit row");
  assert.equal(localProof.posBundle.separateSaleOps,0,"the invoice must not be split into a second SALE_INVOICE queue operation");
  assert.equal(localProof.cashBalance,120,"local POS cash and debt receipt must update the cashbox exactly once");
  assert.equal(localProof.customerDebt,20,"local invoice debt and later receipt must net to the correct customer balance");
  assert.equal(localProof.truckWarehouseStock,99,"local POS must deduct truck warehouse stock exactly once");
  assert.ok(localProof.pendingTypes.includes("DEBT_COLLECTION"),"customer debt payment must be durably queued");
  assert.ok(Number(localProof.sequence)>=6,"local mutation sequence must persist across all truck, invoice and debt operations");
  assert.match(localProof.db,/anas_erp_v42_resilient_db/i);
  assert.deepEqual(errors,[],"offline hard reload must not produce uncaught browser exceptions");
  await context.setOffline(false);
  conflictBudget=1;
  const sync=await page.evaluate(()=>window.anasFirebaseSyncPush());
  assert.ok(["synced","pushed"].includes(sync.status),"offline operations must reconcile after the simulated 409 CAS response");
  const cloud=JSON.parse(serverSnapshot);
  assert.equal(cloud.invoices.filter(x=>String(x.warehouse||"").startsWith("شاحنة ")).length,1);
  assert.equal(cloud.cashMovements.filter(x=>x.referenceType==="customer_debt").length,1);
  assert.equal(cloud.cashMovements.filter(x=>x.referenceType==="sales_invoice").length,1);
  assert.equal(cloud.stockMovements.filter(x=>x.referenceType==="sales_invoice").length,1);
  assert.equal(cloud.caisseBalance,120,"the POS sale and debt receipt must update the cashbox exactly once");
  assert.equal(Number(cloud.customers.find(x=>String(x.id)==="C1")?.debt),20,"replay must apply invoice debt and debt receipt exactly once");
  assert.equal(cloud.anasFleetState.trips.reduce((n,t)=>n+(t.sales||[]).length,0),1);
  assert.equal(cloud.anasFleetState.trips.reduce((n,t)=>n+(t.debtPayments||[]).length,0),1);
  assert.equal(cloud.products[0].stock,"100.000","main warehouse stock must reflect the atomic 100-unit truck load");
  assert.equal(cloud.products[0].warehouseStock["شاحنة 12345-31"],"99.000","POS sale must deduct from the truck warehouse only");
  assert.equal(cloud.currentUser.secondaryWarehouse,"شاحنة 12345-31","active truck warehouse assignment must survive CAS replay");
  assert.equal(cloud.warehouses.find(w=>w.name==="شاحنة 12345-31").assigned_user_id,"DRIVER-1");
  assert.ok(Number(cloud.anasLocalMutationSequence)>=Number(localProof.sequence),"CAS reconciliation must retain the durable local sequence watermark");
  const repeat=await page.evaluate(()=>window.anasFirebaseSyncPush());
  assert.ok(["pushed","synced","empty"].includes(repeat.status));
  const cloudAgain=JSON.parse(serverSnapshot);
  assert.equal(cloudAgain.invoices.filter(x=>String(x.warehouse||"").startsWith("شاحنة ")).length,1,"repeated sync must not duplicate truck invoices");
  assert.equal(cloudAgain.cashMovements.filter(x=>x.referenceType==="customer_debt").length,1,"repeated sync must not duplicate debt receipts");
  assert.equal(cloudAgain.cashMovements.filter(x=>x.referenceType==="sales_invoice").length,1,"repeated sync must not duplicate POS cash receipts");
  assert.equal(cloudAgain.stockMovements.filter(x=>x.referenceType==="sales_invoice").length,1,"repeated sync must not duplicate POS stock movements");
  assert.equal(cloudAgain.anasFleetState.trips.reduce((n,t)=>n+(t.sales||[]).length,0),1,"repeated sync must not duplicate linked truck sales");
  assert.equal(cloudAgain.caisseBalance,120,"repeated sync must not double-count the cashbox");
  assert.equal(Number(cloudAgain.customers.find(x=>String(x.id)==="C1")?.debt),20,"repeated sync must not double-count customer debt");
  assert.equal(cloudAgain.products[0].warehouseStock["شاحنة 12345-31"],"99.000","repeated sync must not double-count truck inventory");
  await page.evaluate(()=>openView("trucks"));
  await page.locator("#view-trucks.page-view.active").waitFor({state:"visible",timeout:10000});
  await page.locator("#fleetExpense").waitFor({state:"visible",timeout:10000});
  await page.locator("#fleetExpense").fill("1.00");
  await page.locator("#fleetExpenseCategory").fill("وقود");
  await page.locator("#fleetExpenseRef").fill("FUEL-001");
  await page.locator("[data-fleet='expense']").click();
  await page.waitForFunction(()=>AppData.anasFleetState.trips.some(t=>(t.expenses||[]).some(e=>e.receiptReference==="FUEL-001")),null,{timeout:15000});
  const remote=JSON.parse(serverSnapshot);
  remote.anasFleetState.remoteDeviceMarker="remote-device-change";
  serverSnapshot=JSON.stringify(remote);
  conflictBudget=1;
  await page.evaluate(()=>window.anasFirebaseSyncPush());
  await page.locator("#fleetConflict").getByText("تعارض شاحنة HTTP 409").waitFor({state:"visible",timeout:15000});
  assert.equal(await page.locator("#fleetConflict [data-choice='cloud']").count(),1);
  assert.equal(await page.locator("#fleetConflict [data-choice='local']").count(),1);
  assert.deepEqual(errors,[],"fleet conflict review must not produce uncaught browser exceptions");
  await context.close();
 }catch(error){
  if(page){
   try{
    const diagnostics=await page.evaluate(({pendingKey})=>{
     const safe=(read,fallback=null)=>{try{return read();}catch(error){return fallback;}};
     const d=safe(()=>window.AppData||{},{});
     const storage=safe(()=>window.ANASResilientStorage,null);
     const pending=safe(()=>storage?.getItem?.(pendingKey)||[],[]);
     const trips=safe(()=>d.anasFleetState?.trips||[],[]);
     const trucks=safe(()=>d.anasFleetState?.trucks||[],[]);
     const fleetMessage=safe(()=>document.getElementById("anasFleetMessage")?.textContent??null,null);
     const stockValue=safe(()=>window.AppData.products[0].stock,null);
     const stockExact=safe(()=>window.AppData.products[0].stock=== "100.000",false);
     const stockNumeric=safe(()=>Number(window.AppData.products[0].stock)===100,false);
     const expectedMessage="تم تحويل الحمولة من المستودع إلى مخزن الشاحنة.";
     const messageExact=safe(()=>document.getElementById("anasFleetMessage")?.textContent?.trim()===expectedMessage,false);
     const loadCondition=safe(()=>(
      (window.AppData.products[0].stock=== "100.000"||Number(window.AppData.products[0].stock)===100) &&
      document.getElementById("anasFleetMessage")?.textContent?.trim()==="تم تحويل الحمولة من المستودع إلى مخزن الشاحنة."
     ),false);
     const notices=safe(()=>Array.from(document.querySelectorAll('[role="alert"],[role="status"],.toast,.toast-message,.notification,[aria-live]'))
      .map(node=>(node.textContent||"").trim()).filter(Boolean),[]);
     const stock=safe(()=>(d.products||[]).map(p=>({id:p.id,stock:p.stock,warehouseStock:p.warehouseStock||{}})),[]);
     const durable=safe(()=>window.__ANAS_DURABLE_SAVE_DIAGNOSTICS__||{state:"instrumentation-not-installed"},{state:"diagnostics-unavailable"});
     const storageStatus=safe(()=>storage?.status?.()||null,null);
     return{
      fleetMessage,expectedFleetMessage:expectedMessage,notices,stock,stockValue,
      loadCompletionCondition:{
       expression:'(AppData.products[0].stock=== "100.000"||Number(AppData.products[0].stock)===100) && document.getElementById("anasFleetMessage")?.textContent?.trim()==="تم تحويل الحمولة من المستودع إلى مخزن الشاحنة."',
       stockExact,stockNumeric,messageExact,result:loadCondition
      },
      trucks,trips:trips.map(t=>({id:t.id,truckId:t.truckId,status:t.status,loadedUnits:t.loadedUnits})),
      durableSave:{started:durable.calls||0,completed:durable.completed||0,rejected:durable.rejected||0,lastState:durable.lastState||durable.state||"unknown",lastError:durable.lastError||null},
      syncQueueCount:Array.isArray(pending)?pending.length:(pending&&typeof pending==="object"?Object.keys(pending).length:0),
      storageStatus
     };
    },{pendingKey:MUTATION_KEYS.pending});
    const diagnosticPayload={
     error:error?.stack||String(error),...diagnostics,pageErrors:errors,consoleErrors,dialogs:dialogMessages,
     local404s,externalScripts
    };
    console.error("[truck-offline] GLOBAL FAILURE DIAGNOSTICS:",safeJson(diagnosticPayload));
   }catch(diagnosticError){
    console.error("[truck-offline] GLOBAL DIAGNOSTICS COLLECTION FAILED:",diagnosticError?.stack||diagnosticError);
   }
  }
  console.error("[truck-offline] captured page errors:",JSON.stringify(errors));
  console.error("[truck-offline] captured console errors:",JSON.stringify(consoleErrors));
  console.error("[truck-offline] captured dialogs:",JSON.stringify(dialogMessages));
  throw error;
 }finally{
  if(browser)await browser.close();
  if(server)await new Promise(resolve=>server.close(resolve));
  await fs.rm(temp,{recursive:true,force:true});
 }
});
