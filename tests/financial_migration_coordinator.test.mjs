import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {prepareFinancialMigration} from "../functions/financial-migration-coordinator.mjs";
const sha256Hex=async value=>createHash("sha256").update(value,"utf8").digest("hex");
const common={input:{amount:125,operationId:"OP-12345678"},normalize:value=>({amount:value.amount,operationId:value.operationId}),context:{grant:{tenantId:"tenant-1",storeIds:["store-1"]}},authorize:()=>true,sha256Hex,uid:"user-1",operationId:"OP-12345678",operationType:"SETTLEMENT_ALLOCATION"};
test("pure coordinator prepares deterministic immutable operation",async()=>{
 const first=await prepareFinancialMigration(common);
 const second=await prepareFinancialMigration({...common,input:{operationId:"OP-12345678",amount:125}});
 assert.equal(first.state,"PREPARED");assert.equal(first.requestHash,second.requestHash);assert.equal(Object.isFrozen(first),true);assert.equal(first.operation.status,"PREPARED");
});
test("pure coordinator replays only matching owner, operation type and hash",async()=>{
 const prepared=await prepareFinancialMigration(common);
 const replay=await prepareFinancialMigration({...common,previousOperation:{ownerUid:"user-1",operationType:"SETTLEMENT_ALLOCATION",requestHash:prepared.requestHash,status:"POSTED",result:{operationId:"OP-12345678"}}});
 assert.equal(replay.state,"REPLAY");assert.deepEqual(replay.result,{operationId:"OP-12345678"});
 await assert.rejects(()=>prepareFinancialMigration({...common,context:{grant:{tenantId:"tenant-1",storeIds:[]}}}),{code:"permission-denied"});
});
