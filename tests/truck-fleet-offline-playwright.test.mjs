import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {buildStagingHosting} from "../scripts/build-staging-hosting.mjs";
import {chromium} from "playwright";
import {MUTATION_KEYS} from "../sync/mutation_keys.mjs";

const HOST="anas-erp-staging-a25e1.web.app";
const DB_KEY=MUTATION_KEYS.appData;
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
function staticServer(root){return http.createServer((req,res)=>{let target=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\\/+/, "")||"index.html");if(!path.extname(target))target=path.join(target,"index.html");if(!target.startsWith(root+path.sep)&&target!==path.join(root,"index.html")){res.writeHead(403).end();return;}fs.readFile(target,(err,bytes)=>{if(err){res.writeHead(404).end("not found");return;}const ext=path.extname(target);const type=ext===".html"?"text/html; charset=utf-8":ext===".js"||ext===".mjs"?"text/javascript; charset=utf-8":ext===".css"?"text/css":ext===".json"||ext===".webmanifest"?"application/json":"application/octet-stream";res.writeHead(200,{"Content-Type":type,"Cache-Control":"no-store"});res.end(bytes);});});}
test("Staging fleet + POS + debt collection survive airplane hard reload, replay once, and expose 409 fleet conflict",async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),"anas-truck-offline-"));
 const out=path.join(temp,"site"),keyPath=path.join(temp,"key.pem"),certPath=path.join(temp,"cert.pem");
 let server,browser;
 try{
  await buildStagingHosting({rootDir:process.cwd(),outDir:out,env:{FIREBASE_STAGING_WEB_API_KEY:"STAGING_PUBLIC_API_KEY",FIREBASE_STAGING_WEB_APP_ID:"1:123456:web:staging",GITHUB_SHA:"truck-offline-test",ANAS_BUILD_SHA:"truck-offline-test"}});
  execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",keyPath,"-out",certPath,"-subj","/CN="+HOST,"-days","1"],{stdio:"ignore"});
  server=https.createServer({key:await fs.readFile(keyPath),cert:await fs.readFile(certPath)},staticServer(out));
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const port=server.address().port;
  browser=await chromium.launch({headless:true,args:["--host-resolver-rules=MAP "+HOST+" 127.0.0.1"]});
  const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:"allow",viewport:{width:1365,height:900},locale:"fr-DZ"});
  await context.addInitScript(({key,data})=>{if(localStorage.getItem(key)===null)localStorage.setItem(key,JSON.stringify(data));window.anasGetFirebaseIdToken=async()=>"offline-test-token";},{key:DB_KEY,data:fixture()});
  const page=await context.newPage(),errors=[];
  page.on("pageerror",e=>errors.push(e.stack||e.message));
  let promptNumber=0;
  page.on("dialog",async dialog=>{if(dialog.type()==="prompt"){promptNumber++;await dialog.accept(promptNumber===1?"10.00":JSON.stringify([{invoiceId:"OLD-DEBT-INV",amount:"10.00"}]));}else await dialog.accept();});
  let serverSnapshot=JSON.stringify(fixture()),revision="rev-1",conflictBudget=0,postCount=0;
  const cors={"Access-Control-Allow-Origin":"https://"+HOST+":"+port,"Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Allow-Methods":"GET, POST, OPTIONS"};
  await page.route("https://anas-erp-firebase-snapshot-staging.amin545677.workers.dev/snapshot**",async route=>{
   const req=route.request();
   if(req.method()==="OPTIONS"){await route.fulfill({status:204,headers:cors});return;}
   if(req.method()==="GET"){await route.fulfill({status:200,headers:{...cors,"Content-Type":"application/json"},body:JSON.stringify({exists:true,data:serverSnapshot,revision})});return;}
   postCount++;
   if(conflictBudget>0){conflictBudget--;await route.fulfill({status:409,headers:{...cors,"Content-Type":"application/json"},body:JSON.stringify({error:"CAS_CONFLICT"})});return;}
   const body=req.postDataJSON();serverSnapshot=body.data;revision="rev-"+(postCount+1);await route.fulfill({status:200,headers:{...cors,"Content-Type":"application/json"},body:JSON.stringify({saved:true,revision})});
  });
  await page.goto("https://"+HOST+":"+port+"/erp/",{waitUntil:"domcontentloaded"});
  const runtimeReady=()=>window.ANASResilientStorage?.ready()===true&&window.ANASMutationSync?.status==="installed"&&document.getElementById("anasFleetEnginePanel");
  await page.waitForFunction(runtimeReady,null,{timeout:30000});
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  if(!(await page.evaluate(()=>!!navigator.serviceWorker?.controller)))await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>!!navigator.serviceWorker?.controller&&window.ANASResilientStorage?.ready()===true&&window.ANASMutationSync?.status==="installed"&&document.getElementById("anasFleetEnginePanel"),null,{timeout:30000});
  await page.evaluate(()=>{window.__ANAS_SET_APP_DATA__(window.__ANAS_GET_APP_DATA__());});
  if(postCount===0)serverSnapshot=await page.evaluate(()=>JSON.stringify(AppData));
  await page.evaluate(()=>openView("trucks"));
  await page.locator("#fleetPlate").fill("12345-31");
  await page.locator("#fleetDriver").fill("سائق الاختبار");
  await page.locator("[data-fleet='open']").click();
  await page.locator("#fleetProduct").selectOption("TRUCK-P1");
  await page.locator("#fleetQty").fill("100");
  await page.locator("[data-fleet='add']").click();
  await page.locator("[data-fleet='load']").click();
  await page.waitForFunction(()=>AppData.products[0].stock=== "100.000"||Number(AppData.products[0].stock)===100);
  await page.locator("[data-fleet='pos']").click();
  await page.locator("#posSearchField").fill("شاي اختبار الشاحنة");
  const result=page.locator("#posSearchResults .pos-search-result").filter({hasText:"شاي اختبار الشاحنة"});
  await result.waitFor({state:"visible",timeout:10000});
  await result.click();
  const tier=page.locator("#anasPosPriceTierModal");
  if(await tier.count()){await tier.waitFor({state:"visible"});await tier.locator("button").filter({hasText:"سعر التجزئة (الدفعة)"}).click();}
  await page.locator("#anasPosFloatingCart [data-mini-action='checkout']").click();
  await page.locator("#hasibModal.active").waitFor({state:"visible"});
  await page.locator("#hasibPaidAmount").fill("10.00");
  await page.locator("#hasibModal button[onclick='confirmHasibPaymentDurable()']").click();
  await page.waitForFunction(()=>AppData.invoices.some(x=>String(x.warehouse)==="شاحنة 12345-31"),null,{timeout:15000});
  await page.waitForFunction(()=>AppData.anasFleetState?.trips?.some(t=>t.sales?.some(s=>s.invoiceId)),null,{timeout:15000});
  await page.evaluate(async()=>{await collectCustDebt("C1");});
  await page.waitForFunction(()=>AppData.cashMovements.some(x=>x.referenceType==="customer_debt"),null,{timeout:15000});
  await page.waitForFunction(()=>AppData.anasFleetState.trips.some(t=>t.debtPayments?.length),null,{timeout:15000});
  await context.setOffline(true);
  await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.ANASResilientStorage?.ready()===true&&window.ANASMutationSync?.status==="installed"&&document.getElementById("anasFleetEnginePanel"),null,{timeout:30000});
  const localProof=await page.evaluate(({pendingKey})=>{const storage=window.ANASResilientStorage,s=storage.getCommittedSnapshot(),q=storage.getItem(pendingKey)||[];return{invoiceCount:s.invoices.filter(x=>String(x.warehouse||"").startsWith("شاحنة ")).length,truckSales:s.anasFleetState.trips.reduce((n,t)=>n+(t.sales||[]).length,0),debtPayments:s.anasFleetState.trips.reduce((n,t)=>n+(t.debtPayments||[]).length,0),cashReceipts:s.cashMovements.filter(x=>x.referenceType==="customer_debt").length,pendingTypes:q.map(x=>x.type),revision:storage.status().revision,db:storage.status().database,sequence:s.anasLocalMutationSequence};},{pendingKey:MUTATION_KEYS.pending});
  assert.equal(localProof.invoiceCount,1,"truck POS invoice must survive a complete offline reload");
  assert.equal(localProof.truckSales,1,"truck sale event must survive offline reload exactly once");
  assert.equal(localProof.debtPayments,1,"old-debt collection linked to the active truck trip must survive offline reload");
  assert.equal(localProof.cashReceipts,1,"the actual debt receipt must survive offline reload alongside the fleet allocation");
  assert.ok(localProof.pendingTypes.includes("TRUCK_FLEET_OPERATION"),"fleet operations must be durably queued");
  assert.ok(localProof.pendingTypes.includes("SALE_INVOICE"),"POS invoice must be durably queued");
  assert.ok(localProof.pendingTypes.includes("DEBT_COLLECTION"),"customer debt payment must be durably queued");
  assert.ok(Number(localProof.sequence)>=6,"local mutation sequence must persist across all truck, invoice and debt operations");
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
  assert.equal(cloud.anasFleetState.trips.reduce((n,t)=>n+(t.sales||[]).length,0),1);
  assert.equal(cloud.anasFleetState.trips.reduce((n,t)=>n+(t.debtPayments||[]).length,0),1);
  assert.equal(cloud.products[0].stock,"100.000","main warehouse stock must reflect the atomic 100-unit truck load");
  assert.equal(cloud.products[0].warehouseStock["شاحنة 12345-31"],"99.000","POS sale must deduct from the truck warehouse only");
  assert.equal(cloud.currentUser.secondaryWarehouse,"شاحنة 12345-31","active truck warehouse assignment must survive CAS replay");
  assert.equal(cloud.warehouses.find(w=>w.name==="شاحنة 12345-31").assigned_user_id,"DRIVER-1");
  assert.ok(Number(cloud.anasLocalMutationSequence)>=Number(localProof.sequence),"CAS reconciliation must retain the durable local sequence watermark");
  assert.ok(Number(cloud.anasLocalMutationSequence)>=Number(localProof.sequence),"CAS reconciliation must retain the durable local sequence watermark");
  const repeat=await page.evaluate(()=>window.anasFirebaseSyncPush());
  assert.ok(["pushed","synced","empty"].includes(repeat.status));
  const cloudAgain=JSON.parse(serverSnapshot);
  assert.equal(cloudAgain.invoices.filter(x=>String(x.warehouse||"").startsWith("شاحنة ")).length,1,"repeated sync must not duplicate truck invoices");
  assert.equal(cloudAgain.cashMovements.filter(x=>x.referenceType==="customer_debt").length,1,"repeated sync must not duplicate debt receipts");
  await page.evaluate(()=>openView("trucks"));
  await page.locator("#fleetExpense").fill("1.00");
  await page.locator("#fleetExpenseCategory").fill("وقود");
  await page.locator("#fleetExpenseRef").fill("FUEL-001");
  await page.locator("[data-fleet='expense']").click();
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
 }finally{
  if(browser)await browser.close();
  if(server)await new Promise(resolve=>server.close(resolve));
  await fs.rm(temp,{recursive:true,force:true});
 }
});
