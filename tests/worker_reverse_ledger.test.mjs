import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workerSource = await readFile(resolve("cloudflare/worker_reverse_ledger.js"),"utf8");
const workerUrl = "data:text/javascript;base64,"+Buffer.from(workerSource).toString("base64");
const { default: worker } = await import(workerUrl);
const origin = "https://anas-erp-staging-a25e1.web.app";
const nowSeconds = Math.floor(Date.now()/1000);
const firebaseClaims = { sub:"trusted-user-1", user_id:"trusted-user-1",
  aud:"anas-erp-staging-a25e1", iss:"https://securetoken.google.com/anas-erp-staging-a25e1",
  auth_time:nowSeconds-30, iat:nowSeconds-20, exp:nowSeconds+3600 };
const mockFirebaseIdToken = "header."+Buffer.from(JSON.stringify(firebaseClaims)).toString("base64url")+".signature";
const env = { FIREBASE_API_KEY:"test-key", FIREBASE_PROJECT_ID:"anas-erp-staging-a25e1",
  FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({client_email:"worker@test.iam.gserviceaccount.com",
    private_key:"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD\\n-----END PRIVATE KEY-----"}),
  ALLOWED_ORIGINS:origin };
function request(path,{method="GET",body,auth=true,requestOrigin=origin}={}) {
  const headers=new Headers({Origin:requestOrigin});
  if(auth) headers.set("Authorization","Bearer "+mockFirebaseIdToken);
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
  const r=await worker.fetch(request("/reserve",{method:"POST",body:{},auth:false}),env);
  assert.equal(r.status,401);
});
test("reservation endpoint rejects malformed JSON and non-object payloads",async()=>{
  const malformed=request("/reserve",{method:"POST",body:{}});
  const r=await worker.fetch(new Request(malformed.url,{method:"POST",headers:malformed.headers,body:"{"}),env);
  assert.equal(r.status,400);
});
test("browser cannot call a local or direct posting route",async()=>{
  const r=await worker.fetch(request("/post",{method:"POST",body:{}}),env);
  assert.equal(r.status,404);
});
test("Firestore control-plane rules deny every browser client",async()=>{
  const rules=await readFile(resolve("firebase/firestore.rules"),"utf8");
  assert.match(rules,/match \/reverseLedgerGrants\/{uid}\s*\{\s*allow read, write: if false;/);
  assert.match(rules,/match \/financialPeriods\/{periodId}\s*\{\s*allow read, write: if false;/);
  assert.match(rules,/match \/reverseLedgerOperations\/{operationId}\s*\{\s*allow read, write: if false;/);
});
test("deployed and Staging Firestore rules both deny client access to the reverse-ledger control plane",async()=>{
  const rules=await readFile(resolve("firebase/firestore.rules"),"utf8");
  const stagingRules=await readFile(resolve("firebase/firestore.staging.rules"),"utf8");
  for(const source of [rules,stagingRules]){
    assert.match(source,/match \/reverseLedgerGrants\/{uid}\s*\{\s*allow read, write: if false;/);
    assert.match(source,/match \/financialPeriods\/{periodId}\s*\{\s*allow read, write: if false;/);
    assert.match(source,/match \/reverseLedgerOperations\/{operationId}\s*\{\s*allow read, write: if false;/);
  }
  const firebaseConfig=JSON.parse(await readFile(resolve("firebase.staging.json"),"utf8"));
  assert.equal(firebaseConfig.firestore.rules,"firebase/firestore.staging.rules");
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

test("verified grant and open period produce a durable transactional create-only reservation, never a posting",async()=>{
  const oldFetch=globalThis.fetch;
  let commitCount=0,rollbackCount=0,existing=false,readCount=0;
  globalThis.fetch=async(url,init={})=>{
    const target=String(url),method=init.method||"GET";
    if(target.includes("identitytoolkit.googleapis.com"))
      return new Response(JSON.stringify({users:[{localId:"trusted-user-1",disabled:false}]}),{status:200});
    if(target.includes("oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({access_token:"service-access-token",expires_in:3600}),{status:200});
    if(target.includes("firestore.googleapis.com")){
      assert.equal(new Headers(init.headers).get("Authorization"),"Bearer service-access-token");
      if(target.endsWith("/documents:beginTransaction"))
        return new Response(JSON.stringify({transaction:"tx-1"}),{status:200});
      if(target.includes("/reverseLedgerGrants/trusted-user-1?transaction=")){
        readCount++;
        return new Response(JSON.stringify(firestoreDoc({uid:"trusted-user-1",active:true,schemaVersion:1,permissions:["reverse_sale_return"]})),{status:200});
      }
      if(target.includes("/financialPeriods/FY-2026-10?transaction=")){
        readCount++;
        return new Response(JSON.stringify(firestoreDoc({periodId:"FY-2026-10",status:"OPEN"})),{status:200});
      }
      if(target.includes("/reverseLedgerOperations/RET-OP-20261031-0001?transaction=")){
        readCount++;
        if(existing) return new Response(JSON.stringify(firestoreDoc({status:"RESERVED"})),{status:200});
        return new Response(JSON.stringify({error:{status:"NOT_FOUND"}}),{status:404});
      }
      if(target.endsWith("/documents:commit")){
        commitCount++;
        const payload=JSON.parse(init.body);
        assert.equal(payload.transaction,"tx-1");
        assert.equal(payload.writes.length,1);
        assert.equal(payload.writes[0].currentDocument.exists,false);
        assert.match(payload.writes[0].update.name,/reverseLedgerOperations\/RET-OP-20261031-0001$/);
        assert.equal(payload.writes[0].update.fields.status.stringValue,"RESERVED");
        return new Response(JSON.stringify({writeResults:[{updateTime:"2026-10-31T00:00:00.000000Z"}]}),{status:200});
      }
      if(target.endsWith("/documents:rollback")){
        rollbackCount++;
        return new Response("{}",{status:200});
      }
    }
    throw new Error("Unexpected network request: "+target);
  };
  try {
    const first=await worker.fetch(request("/reserve",{method:"POST",body:validBody}),realEnv);
    assert.equal(first.status,201,JSON.stringify(await first.clone().json()));
    const result=await first.json();
    assert.equal(result.reserved,true);
    assert.equal(result.posted,false);
    assert.equal(result.postingEnabled,false);
    assert.equal(result.reservation.ownerUid,"trusted-user-1");
    assert.equal(result.reservation.status,"RESERVED");
    assert.equal(commitCount,1);
    assert.equal(rollbackCount,0);
    assert.equal(readCount,3);

    existing=true;
    const second=await worker.fetch(request("/reserve",{method:"POST",body:validBody}),realEnv);
    assert.equal(second.status,409);
    assert.match((await second.json()).error,/already reserved/i);
    assert.equal(commitCount,1,"duplicate operation must not create a second reservation");
    assert.equal(rollbackCount,1,"duplicate read transaction must be rolled back");
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
    if(target.endsWith("/documents:beginTransaction"))
      return new Response(JSON.stringify({transaction:"tx-no-permission"}),{status:200});
    if(target.includes("/reverseLedgerGrants/trusted-user-1?transaction="))
      return new Response(JSON.stringify(firestoreDoc({uid:"trusted-user-1",active:true,schemaVersion:1,permissions:[]})),{status:200});
    if(target.includes("/financialPeriods/FY-2026-10?transaction="))
      return new Response(JSON.stringify(firestoreDoc({periodId:"FY-2026-10",status:"OPEN"})),{status:200});
    if(target.includes("/reverseLedgerOperations/RET-OP-20261031-0001?transaction="))
      return new Response(JSON.stringify({error:{status:"NOT_FOUND"}}),{status:404});
    if(target.endsWith("/documents:rollback"))
      return new Response("{}",{status:200});
    throw new Error("No reservation write is permitted for a grant without permission");
  };
  try {
    const response=await worker.fetch(request("/reserve",{method:"POST",body:validBody}),realEnv);
    assert.equal(response.status,403);
    assert.match((await response.json()).error,/missing required permission/i);
  } finally { globalThis.fetch=oldFetch; }
});

test("client-supplied financial amounts are rejected before privileged Firestore access",async()=>{
  const oldFetch=globalThis.fetch;
  let privilegedCalls=0;
  globalThis.fetch=async url=>{
    if(String(url).includes("identitytoolkit.googleapis.com"))
      return new Response(JSON.stringify({users:[{localId:"trusted-user-1"}]}),{status:200});
    privilegedCalls++;
    throw new Error("client financial fields must be rejected before service-account access");
  };
  try {
    const response=await worker.fetch(request("/reserve",{method:"POST",body:{...validBody,refundCentimes:1,cashAvailableCentimes:100000}}),realEnv);
    assert.equal(response.status,400);
    assert.match((await response.json()).error,/client-supplied financial fields/i);
    assert.equal(privilegedCalls,0);
  } finally { globalThis.fetch=oldFetch; }
});

test("closed financial periods roll back and cannot create a reservation",async()=>{
  const oldFetch=globalThis.fetch;
  let commitCount=0,rollbackCount=0;
  globalThis.fetch=async(url,init={})=>{
    const target=String(url);
    if(target.includes("identitytoolkit.googleapis.com"))
      return new Response(JSON.stringify({users:[{localId:"trusted-user-1"}]}),{status:200});
    if(target.includes("oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({access_token:"service-access-token",expires_in:3600}),{status:200});
    if(target.endsWith("/documents:beginTransaction"))
      return new Response(JSON.stringify({transaction:"tx-closed-period"}),{status:200});
    if(target.includes("/reverseLedgerGrants/trusted-user-1?transaction="))
      return new Response(JSON.stringify(firestoreDoc({uid:"trusted-user-1",active:true,schemaVersion:1,permissions:["reverse_sale_return"]})),{status:200});
    if(target.includes("/financialPeriods/FY-2026-10?transaction="))
      return new Response(JSON.stringify(firestoreDoc({periodId:"FY-2026-10",status:"CLOSED"})),{status:200});
    if(target.includes("/reverseLedgerOperations/RET-OP-20261031-0001?transaction="))
      return new Response(JSON.stringify({error:{status:"NOT_FOUND"}}),{status:404});
    if(target.endsWith("/documents:commit")){commitCount++;return new Response("{}",{status:200});}
    if(target.endsWith("/documents:rollback")){rollbackCount++;return new Response("{}",{status:200});}
    throw new Error("Unexpected network request: "+target);
  };
  try {
    const response=await worker.fetch(request("/reserve",{method:"POST",body:validBody}),realEnv);
    assert.equal(response.status,403);
    assert.match((await response.json()).error,/not OPEN/i);
    assert.equal(commitCount,0);
    assert.equal(rollbackCount,1);
  } finally { globalThis.fetch=oldFetch; }
});
