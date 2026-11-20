/** Pure preparation coordinator: no I/O, clock, database, or platform side effects. */
import {normalizeRequest,authorizeFinancialScope,requestHashAsync,buildOperationRecord,resolveIdempotency} from "./shared-application-core.mjs";
export async function prepareFinancialMigration({input,normalize,context,authorize,sha256Hex,uid,operationId,operationType,previousOperation=null,legacyRequestHashes=[]}) {
 const normalized=normalizeRequest(input,normalize);
 authorizeFinancialScope(context,authorize);
 const digest=await requestHashAsync(normalized,sha256Hex);
 const replay=resolveIdempotency(previousOperation,{uid,requestHash:digest,legacyRequestHashes,operationType});
 if(replay.replay)return Object.freeze({state:"REPLAY",result:replay.result,requestHash:digest});
 const operation=buildOperationRecord({ownerUid:uid,operationId,operationType,requestHash:digest,status:"PREPARED"});
 return Object.freeze({state:"PREPARED",normalized,operation,requestHash:digest});
}
