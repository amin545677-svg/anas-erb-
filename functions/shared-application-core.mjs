/** ESM runtime-neutral financial application primitives shared by Node and Cloudflare Workers. */
export function normalizeRequest(input, normalizer) { if(typeof normalizer!=="function") throw new TypeError("request normalizer is required"); return normalizer(input); }
export function authorizeFinancialScope(context, authorize) {
 if(typeof authorize!=="function") throw new TypeError("financial scope authorizer is required");
 const grant=context&&context.grant;
 if(!grant||typeof grant.tenantId!=="string"||!grant.tenantId.trim()||!Array.isArray(grant.storeIds)||!grant.storeIds.length||grant.storeIds.some(id=>typeof id!=="string"||!id.trim())) { const e=new Error("Trusted tenantId and storeIds scope is required.");e.code="permission-denied";throw e; }
 return authorize(context);
}
export function canonicalSerialize(value) {
 if(value===null||typeof value!=="object")return JSON.stringify(value);
 if(Array.isArray(value))return "["+value.map(item=>{const s=canonicalSerialize(item);return s===undefined?"null":s;}).join(",")+"]";
 return "{"+Object.keys(value).sort().flatMap(key=>{const s=canonicalSerialize(value[key]);return s===undefined?[]:[JSON.stringify(key)+":"+s];}).join(",")+"}";
}
export function legacyCanonicalSerialize(value) {
 if(Array.isArray(value))return "["+value.map(legacyCanonicalSerialize).join(",")+"]";
 if(value&&typeof value==="object")return "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+legacyCanonicalSerialize(value[key])).join(",")+"}";
 return JSON.stringify(value);
}
export function requestHash(value,sha256Hex) {
 if(typeof sha256Hex!=="function")throw new TypeError("sha256Hex dependency is required");
 const digest=sha256Hex(canonicalSerialize(value));
 if(typeof digest!=="string"||!/^[a-f0-9]{64}$/i.test(digest))throw new TypeError("sha256Hex must return a 64-character hexadecimal digest");
 return digest.toLowerCase();
}
export async function requestHashAsync(value,sha256Hex) {
 if(typeof sha256Hex!=="function")throw new TypeError("sha256Hex dependency is required");
 const digest=await sha256Hex(canonicalSerialize(value));
 if(typeof digest!=="string"||!/^[a-f0-9]{64}$/i.test(digest))throw new TypeError("sha256Hex must resolve to a 64-character hexadecimal digest");
 return digest.toLowerCase();
}
export function buildOperationRecord(fields) {
 if(!fields||typeof fields!=="object"||Array.isArray(fields))throw new TypeError("operation record fields are required");
 for(const key of ["ownerUid","operationId","operationType","requestHash","status"])if(typeof fields[key]!=="string"||!fields[key])throw new TypeError("operation record "+key+" is required");
 if(!/^[a-f0-9]{64}$/i.test(fields.requestHash))throw new TypeError("operation record requestHash is invalid");
 return Object.freeze({...fields});
}
export function resolveIdempotency(previous,{uid,requestHash:expectedHash,legacyRequestHashes=[],operationType}) {
 if(!previous)return Object.freeze({replay:false});
 if(previous.ownerUid!==uid){const e=new Error("operationId belongs to another Firebase user.");e.code="already-exists";throw e;}
 if(previous.status==="POSTED"){
  if(![expectedHash,...legacyRequestHashes].includes(previous.requestHash)||(operationType&&previous.operationType!==operationType)||!previous.result){const e=new Error("IDEMPOTENCY_PAYLOAD_MISMATCH: operationId was already used for a different financial operation.");e.code="already-exists";e.details={code:"IDEMPOTENCY_PAYLOAD_MISMATCH"};throw e;}
  return Object.freeze({replay:true,result:previous.result});
 }
 return Object.freeze({replay:false,previous});
}
