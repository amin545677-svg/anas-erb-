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
