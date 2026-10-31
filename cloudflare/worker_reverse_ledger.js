/**
 * ANAS ERP reverse-ledger reservation Worker.
 *
 * This service establishes the trusted identity/grant/period boundary and
 * atomically reserves operation IDs in Firestore. It DOES NOT post accounting,
 * inventory, cash, or invoice mutations. Posting remains disabled until a
 * separate server-side transaction implementation is completed and audited.
 */
const MAX_BODY_BYTES = 16 * 1024;
const PERMISSIONS = Object.freeze({
  SALE_RETURN: "reverse_sale_return",
  PURCHASE_RETURN: "reverse_purchase_return",
  INVOICE_CANCEL: "reverse_invoice_cancel"
});
const ALLOWED_ORIGINS = env => (env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
const json = (data, status, origin) => {
  const headers = { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store",
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS", "Access-Control-Allow-Headers":"Authorization,Content-Type",
    "Vary":"Origin" };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return new Response(JSON.stringify(data), { status, headers });
};
const record = x => !!x && typeof x === "object" && !Array.isArray(x);
const required = (x, label, max=160) => {
  if (typeof x !== "string" || !x.trim() || x.length > max) throw new Error(label + " is invalid");
  return x.trim();
};
const b64url = bytes => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replaceAll("=","").replaceAll("+","-").replaceAll("/","_");
};
const enc = value => b64url(new TextEncoder().encode(value));
let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

async function serviceAccessToken(env) {
  if (cachedAccessToken && cachedAccessTokenExpiry > Date.now() + 60000) return cachedAccessToken;
  let account;
  try { account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || ""); }
  catch { throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing or malformed"); }
  const email = required(account.client_email, "service account email", 256);
  const privateKey = required(account.private_key, "service account private key", 8192).replace(/\\n/g,"\n");
  const now = Math.floor(Date.now()/1000);
  const head = enc(JSON.stringify({ alg:"RS256", typ:"JWT" }));
  const claims = enc(JSON.stringify({ iss:email, aud:"https://oauth2.googleapis.com/token",
    scope:"https://www.googleapis.com/auth/datastore", iat:now, exp:now+3600 }));
  const unsigned = head + "." + claims;
  const pem = privateKey.replaceAll("-----BEGIN PRIVATE KEY-----","").replaceAll("-----END PRIVATE KEY-----","").replaceAll("\n","").replaceAll("\r","").replaceAll("\t","").replaceAll(" ","");
  const binary = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", binary,
    { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + "." + b64url(signature);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body:new URLSearchParams({ grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok || typeof data.access_token !== "string") throw new Error("Firebase service authorization failed");
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiry = Date.now() + Math.max(60, Number(data.expires_in)||3600)*1000;
  return cachedAccessToken;
}

function decodeJwtPayload(token) {
  const parts=String(token).split(".");
  if(parts.length!==3) throw new Error("Firebase ID token format is invalid");
  const normalized=parts[1].replace(/-/g,"+").replace(/_/g,"/");
  const padded=normalized+"=".repeat((4-normalized.length%4)%4);
  try { return JSON.parse(atob(padded)); }
  catch { throw new Error("Firebase ID token claims are malformed"); }
}
async function verifiedUid(token, env) {
  if (!env.FIREBASE_API_KEY || !env.FIREBASE_PROJECT_ID) throw new Error("Firebase identity configuration is incomplete");
  const response = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" +
    encodeURIComponent(env.FIREBASE_API_KEY), {
      method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ idToken:token })
    });
  const data = await response.json().catch(()=>({}));
  const user = data.users?.[0];
  if (!response.ok || !user?.localId || user.disabled === true) throw new Error("Firebase identity is invalid, expired, or disabled");
  const uid=required(user.localId,"Firebase UID",128);
  const claims=decodeJwtPayload(token);
  const now=Math.floor(Date.now()/1000);
  if(claims.sub!==uid || claims.user_id!==uid ||
     claims.aud!==env.FIREBASE_PROJECT_ID ||
     claims.iss!=="https://securetoken.google.com/"+env.FIREBASE_PROJECT_ID)
    throw new Error("Firebase token identity or project claims do not match");
  if(!Number.isSafeInteger(claims.auth_time) || !Number.isSafeInteger(claims.iat) ||
     !Number.isSafeInteger(claims.exp) || claims.auth_time<=0 ||
     claims.iat<claims.auth_time || claims.exp<=claims.iat)
    throw new Error("Firebase token time claims are invalid");
  if(claims.auth_time>now || claims.iat>now)
    throw new Error("Firebase token time claims are in the future");
  if(claims.exp<=now) throw new Error("Firebase identity token is expired");
  return uid;
}
function documentUrl(env, path) {
  return "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(env.FIREBASE_PROJECT_ID) +
    "/databases/(default)/documents/" + path;
}
function decodeValue(value) {
  if (!record(value)) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields || {});
  return undefined;
}
function decodeFields(fields) {
  const out = {};
  for (const [key,value] of Object.entries(fields || {})) out[key] = decodeValue(value);
  return out;
}
async function firestoreRequest(env, path, init={}) {
  const token = await serviceAccessToken(env);
  const response = await fetch(documentUrl(env,path), {
    ...init, headers:{ Authorization:"Bearer "+token, "Content-Type":"application/json", ...(init.headers||{}) }
  });
  const data = await response.json().catch(()=>({}));
  return { response, data };
}
async function readDocument(env,path,transaction) {
  const suffix=transaction ? "?transaction="+encodeURIComponent(transaction) : "";
  const {response,data} = await firestoreRequest(env,path+suffix);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Trusted Firestore read failed");
  return { fields:decodeFields(data.fields || {}), name:data.name, updateTime:data.updateTime || null };
}
async function firestoreAction(env,action,init={}) {
  const token=await serviceAccessToken(env);
  const base=documentUrl(env,"").slice(0,-1);
  const response=await fetch(base+":"+action,{
    ...init,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json",...(init.headers||{})}
  });
  const data=await response.json().catch(()=>({}));
  return {response,data};
}
async function beginTransaction(env) {
  const {response,data}=await firestoreAction(env,"beginTransaction",{
    method:"POST",body:JSON.stringify({options:{readWrite:{}}})
  });
  if(!response.ok || !data.transaction) throw new Error("Trusted Firestore transaction could not begin");
  return data.transaction;
}
async function commitTransaction(env,transaction,writes) {
  return firestoreAction(env,"commit",{method:"POST",body:JSON.stringify({transaction,writes})});
}
async function rollbackTransaction(env,transaction) {
  if(!transaction)return;
  try{await firestoreAction(env,"rollback",{method:"POST",body:JSON.stringify({transaction})});}catch{}
}
function firestoreFields(value) {
  if (typeof value === "string") return { stringValue:value };
  if (typeof value === "boolean") return { booleanValue:value };
  if (typeof value === "number" && Number.isSafeInteger(value)) return { integerValue:String(value) };
  if (Array.isArray(value)) return { arrayValue:{ values:value.map(firestoreFields) } };
  if (record(value)) {
    const fields={}; for (const [k,v] of Object.entries(value)) fields[k]=firestoreFields(v);
    return { mapValue:{ fields } };
  }
  return { nullValue:null };
}
async function reserveOperation(env, uid, requestData) {
  if (!record(requestData)) throw new Error("Request body must be an object");
  const allowed = new Set(["operationId", "type", "invoiceId", "periodId"]);
  const unknown = Object.keys(requestData).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error("Unsupported or client-supplied financial fields: " + unknown.join(", "));
  const operationId = required(requestData.operationId,"operationId",160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(operationId)) throw new Error("operationId format is invalid");
  const type = required(requestData.type,"operation type",40);
  const permission = PERMISSIONS[type];
  if (!permission) throw new Error("Unsupported reverse operation type");
  const invoiceId = required(requestData.invoiceId,"invoice ID",160);
  const periodId = required(requestData.periodId,"financial period ID",128);
  const transaction = await beginTransaction(env);
  try {
    const [grantDoc,periodDoc,existingOperation] = await Promise.all([
      readDocument(env,"reverseLedgerGrants/"+encodeURIComponent(uid),transaction),
      readDocument(env,"financialPeriods/"+encodeURIComponent(periodId),transaction),
      readDocument(env,"reverseLedgerOperations/"+encodeURIComponent(operationId),transaction)
    ]);
    if(existingOperation) throw new Error("Operation ID is already reserved; duplicate posting is blocked");
    const grant=grantDoc?.fields;
    const period=periodDoc?.fields;
    if (!grant || grant.uid !== uid || grant.active !== true || grant.schemaVersion !== 1 ||
        !Array.isArray(grant.permissions) || grant.permissions.some(p=>typeof p!=="string"))
      throw new Error("Active trusted authorization grant is missing or invalid");
    if (!grant.permissions.includes(permission)) throw new Error("Missing required permission: "+permission);
    if (!period || period.periodId !== periodId || period.status !== "OPEN")
      throw new Error("Financial period is not OPEN");
    const reservation = {
      operationId, ownerUid:uid, operationType:type, invoiceId, periodId,
      status:"RESERVED", schemaVersion:1, createdAt:new Date().toISOString()
    };
    const name=documentUrl(env,"reverseLedgerOperations/"+encodeURIComponent(operationId));
    const write={
      update:{name,fields:Object.fromEntries(Object.entries(reservation).map(([k,v])=>[k,firestoreFields(v)]))},
      currentDocument:{exists:false}
    };
    const committed=await commitTransaction(env,transaction,[write]);
    if(!committed.response.ok) {
      const code=String(committed.data.error?.status||"");
      if(code==="ALREADY_EXISTS"||code==="ABORTED"||code==="FAILED_PRECONDITION")
        throw new Error("Operation ID is already reserved or a trusted grant/period changed; retry with a new verified operation");
      throw new Error("Atomic Firestore operation reservation failed");
    }
    return reservation;
  } catch(error) {
    await rollbackTransaction(env,transaction);
    throw error;
  }
}
async function readLimited(request) {
  const reader=request.body?.getReader(); if(!reader) return "";
  const chunks=[]; let total=0;
  while(true){ const {done,value}=await reader.read(); if(done)break; total+=value.byteLength;
    if(total>MAX_BODY_BYTES){await reader.cancel();return null;} chunks.push(value); }
  const bytes=new Uint8Array(total); let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(bytes);
}
async function handle(request,env) {
  const origin=request.headers.get("Origin")||"";
  const allowed=ALLOWED_ORIGINS(env);
  const accepted=allowed.includes(origin)?origin:"";
  if(request.method==="OPTIONS") return accepted
    ? new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":accepted,"Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Authorization,Content-Type","Vary":"Origin"}})
    : json({error:"Origin is not allowed"},403,"");
  if(origin && !accepted) return json({error:"Origin is not allowed"},403,"");
  const url=new URL(request.url);
  if(request.method==="GET" && url.pathname==="/health") return json({
    ok:true,service:"anas-erp-reverse-ledger-reservation",
    configured:!!(env.FIREBASE_API_KEY&&env.FIREBASE_PROJECT_ID&&env.FIREBASE_SERVICE_ACCOUNT_JSON),
    postingEnabled:false
  },200,accepted);
  if(request.method!=="POST" || url.pathname!=="/reserve") return json({error:"Not found"},404,accepted);
  const auth=request.headers.get("Authorization")||"";
  const match=auth.match(/^Bearer +(.+)$/i);
  if(!match) return json({error:"Missing Firebase bearer token"},401,accepted);
  let raw;
  try { raw=await readLimited(request); } catch { return json({error:"Request body could not be read"},400,accepted); }
  if(raw===null) return json({error:"Request body exceeds size limit"},413,accepted);
  let body;
  try { body=JSON.parse(raw); } catch { return json({error:"Request body must be valid JSON"},400,accepted); }
  if(!record(body)) return json({error:"Request body must be an object"},400,accepted);
  try {
    const uid=await verifiedUid(match[1],env);
    const reservation=await reserveOperation(env,uid,body);
    return json({ok:true,reserved:true,posted:false,postingEnabled:false,reservation},201,accepted);
  } catch(error) {
    const message=String(error?.message||"Authorization failed");
    const status=/already reserved|duplicate posting/i.test(message)?409:
      /permission|not OPEN|grant|Unsupported|invalid|format/i.test(message)?403:503;
    return json({error:message,posted:false},status,accepted);
  }
}
export default { fetch:handle };
