import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workerSource = await readFile(resolve("cloudflare/worker_reverse_ledger.js"),"utf8");
const workerUrl = "data:text/javascript;base64,"+Buffer.from(workerSource).toString("base64");
const { default: worker } = await import(workerUrl);
const origin = "https://anas-erp-staging-a25e1.web.app";
const env = { FIREBASE_API_KEY:"test-key", FIREBASE_PROJECT_ID:"anas-erp-staging-a25e1",
  FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({client_email:"worker@test.iam.gserviceaccount.com",
    private_key:"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD\\n-----END PRIVATE KEY-----"}),
  ALLOWED_ORIGINS:origin };
function request(path,{method="GET",body,auth=true,requestOrigin=origin}={}) {
  const headers=new Headers({Origin:requestOrigin});
  if(auth) headers.set("Authorization","Bearer firebase-token");
  if(body!==undefined) headers.set("Content-Type","application/json");
  return new Request("https://reverse-ledger.test"+path,{method,headers,
    body:body===undefined?undefined:JSON.stringify(body)});
}
test("health is explicit that reservation service cannot post accounting",async()=>{
  const r=await worker.fetch(request("/health"),env);
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{ok:true,service:"anas-erp-reverse-ledger-reservation",configured:true,postingEnabled:false});
});
test("unknown origins are rejected without permissive CORS",async()=>{
  const r=await worker.fetch(request("/health",{requestOrigin:"https://evil.example"}),env);
  assert.equal(r.status,403);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"),null);
});
test("reservation endpoint requires Firebase bearer token",async()=>{
  const r=await worker.fetch(request("/reserve",{method:"POST",body:{}}),env);
  assert.equal(r.status,401);
});
test("reservation endpoint rejects malformed JSON and non-object payloads",async()=>{
  const noAuth=request("/reserve",{method:"POST",auth:false});
  const r=await worker.fetch(new Request(noAuth.url,{method:"POST",headers:noAuth.headers,body:"{"}),env);
  assert.equal(r.status,400);
});
test("browser cannot call a local or direct posting route",async()=>{
  const r=await worker.fetch(request("/post",{method:"POST",body:{}}),env);
  assert.equal(r.status,404);
});
test("Firestore control-plane rules deny every browser client",async()=>{
  const rules=await readFile(resolve("firebase/firestore.reverse-ledger.rules"),"utf8");
  assert.match(rules,/match \/reverseLedgerGrants\/{uid}\s*\{\s*allow read, write: if false;/);
  assert.match(rules,/match \/financialPeriods\/{periodId}\s*\{\s*allow read, write: if false;/);
  assert.match(rules,/match \/reverseLedgerOperations\/{operationId}\s*\{\s*allow read, write: if false;/);
});
test("staging Worker config uses isolated Firebase project and dedicated service credentials",async()=>{
  const config=await readFile(resolve("cloudflare/wrangler-reverse-ledger-staging.toml"),"utf8");
  assert.match(config,/name = "anas-erp-reverse-ledger-staging"/);
  assert.match(config,/FIREBASE_PROJECT_ID = "anas-erp-staging-a25e1"/);
  assert.match(config,/required = \["FIREBASE_API_KEY", "FIREBASE_SERVICE_ACCOUNT_JSON"\]/);
  assert.doesNotMatch(config,/anas-erb|amin545677-svg\.github\.io/);
});

function value(x) {
  if (typeof x === "string") return { stringValue:x };
  if (typeof x === "boolean") return { booleanValue:x };
  if (typeof x === "number") return { integerValue:String(x) };
  if (Array.isArray(x)) return { arrayValue:{values:x.map(value)} };
  return { mapValue:{fields:Object.fromEntries(Object.entries(x).map(([k,v])=>[k,value(v)]))} };
}
function firestoreDoc(data) {
  return { fields:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,value(v)])) };
}
const signingKeys = await crypto.subtle.generateKey(
  {name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},
  true,["sign","verify"]);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8",signingKeys.privateKey)).toString("base64");
const realEnv = {...env,FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({
  client_email:"reverse-ledger@test-project.iam.gserviceaccount.com",
  private_key:"-----BEGIN PRIVATE KEY-----\\n"+pkcs8+"\\n-----END PRIVATE KEY-----"
})};
const validBody = {operationId:"RET-OP-20261031-0001",type:"SALE_RETURN",invoiceId:"INV-1001",periodId:"FY-2026-10"};

test("verified grant and open period produce a durable create-only reservation, never a posting",async()=>{
  const oldFetch=globalThis.fetch;
  let reservationUrl="", patchCount=0, duplicate=false;
  globalThis.fetch=async(url,init={})=>{
    const target=String(url);
    if(target.includes("identitytoolkit.googleapis.com"))
      return new Response(JSON.stringify({users:[{localId:"trusted-user-1",disabled:false}]}),{status:200});
    if(target.includes("oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({access_token:"service-access-token",expires_in:3600}),{status:200});
    if(target.includes("firestore.googleapis.com")){
      assert.equal(new Headers(init.headers).get("Authorization"),"Bearer service-access-token");
      if(init.method==="PATCH"){
        patchCount++; reservationUrl=target;
        assert.match(target,/currentDocument\\.exists=false/);
        if(duplicate) return new Response(JSON.stringify({error:{status:"FAILED_PRECONDITION",message:"Document already exists"}}),{status:400});
        return new Response(JSON.stringify({updateTime:"2026-10-31T00:00:00.000000Z"}),{status:200});
      }
      if(target.endsWith("/reverseLedgerGrants/trusted-user-1"))
        return new Response(JSON.stringify(firestoreDoc({uid:"trusted-user-1",active:true,schemaVersion:1,permissions:["reverse_sale_return"]})),{status:200});
      if(target.endsWith("/financialPeriods/FY-2026-10"))
        return new Response(JSON.stringify(firestoreDoc({periodId:"FY-2026-10",status:"OPEN"})),{status:200});
    }
    throw new Error("Unexpected network request: "+target);
  };
  try {
    const first=await worker.fetch(request("/reserve",{method:"POST",body:validBody}),realEnv);
    assert.equal(first.status,201);
    const result=await first.json();
    assert.equal(result.reserved,true);
    assert.equal(result.posted,false);
    assert.equal(result.postingEnabled,false);
    assert.equal(result.reservation.ownerUid,"trusted-user-1");
    assert.equal(result.reservation.status,"RESERVED");
    assert.match(reservationUrl,/currentDocument\\.exists=false/);
    assert.equal(patchCount,1);

    duplicate=true;
    const second=await worker.fetch(request("/reserve",{method:"POST",body:validBody}),realEnv);
    assert.equal(second.status,409);
    assert.match((await second.json()).error,/already reserved/i);
    assert.equal(patchCount,2);
  } finally { globalThis.fetch=oldFetch; }
});

test("a grant without the exact operation permission cannot reserve an operation",async()=>{
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{
    const target=String(url);
    if(target.includes("identitytoolkit.googleapis.com"))
      return new Response(JSON.stringify({users:[{localId:"trusted-user-1"}]}),{status:200});
    if(target.includes("oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({access_token:"service-access-token",expires_in:3600}),{status:200});
    if(target.endsWith("/reverseLedgerGrants/trusted-user-1"))
      return new Response(JSON.stringify(firestoreDoc({uid:"trusted-user-1",active:true,schemaVersion:1,permissions:[]})),{status:200});
    if(target.endsWith("/financialPeriods/FY-2026-10"))
      return new Response(JSON.stringify(firestoreDoc({periodId:"FY-2026-10",status:"OPEN"})),{status:200});
    throw new Error("No reservation write is permitted for a grant without permission");
  };
  try {
    const response=await worker.fetch(request("/reserve",{method:"POST",body:validBody}),realEnv);
    assert.equal(response.status,403);
    assert.match((await response.json()).error,/missing required permission/i);
  } finally { globalThis.fetch=oldFetch; }
});
