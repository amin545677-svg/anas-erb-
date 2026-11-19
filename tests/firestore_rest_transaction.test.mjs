import test from "node:test";
import assert from "node:assert/strict";
import { runFirestoreRestTransaction } from "../cloudflare/firestore_rest_transaction.mjs";

function fixture({aborts=0,readFailure=null,workFailure=null}={}) {
  const calls={begin:0,read:0,commit:0,rollback:0,work:0};
  const adapter={
    async beginTransaction(){calls.begin++;return "tx-"+calls.begin;},
    async readDocument(path,transaction){
      calls.read++;
      assert.equal(transaction,"tx-"+calls.begin);
      if(readFailure) { const e=new Error("read denied");e.code=readFailure;throw e; }
      return {path,attempt:calls.begin};
    },
    async commitTransaction(transaction,writes){
      calls.commit++;
      assert.equal(transaction,"tx-"+calls.begin);
      assert.ok(Array.isArray(writes));
      if(calls.commit<=aborts) return {response:{ok:false,status:409},data:{error:{status:"ABORTED",message:"transaction contention"}}};
      return {response:{ok:true,status:200},data:{}};
    },
    async rollbackTransaction(transaction){calls.rollback++;assert.equal(transaction,"tx-"+calls.begin);}
  };
  const work=async ({attempt,get})=>{
    calls.work++;
    const doc=await get("accounts/a");
    assert.equal(doc.attempt,attempt,"each retry must read in its new transaction");
    if(workFailure){const e=new Error("validation rejected");e.code=workFailure;throw e;}
    return {writes:[{update:{name:"accounts/a"}}],result:{attempt,readAttempt:doc.attempt}};
  };
  return {adapter,work,calls};
}

test("commits successfully on the first attempt",async()=>{
  const f=fixture();
  const result=await runFirestoreRestTransaction(f.adapter,f.work);
  assert.deepEqual(result,{attempt:1,readAttempt:1});
  assert.deepEqual(f.calls,{begin:1,read:1,commit:1,rollback:0,work:1});
});

test("retries ABORTED and reruns the complete read/validation callback until attempt three",async()=>{
  const f=fixture({aborts:2});
  const result=await runFirestoreRestTransaction(f.adapter,f.work);
  assert.deepEqual(result,{attempt:3,readAttempt:3});
  assert.deepEqual(f.calls,{begin:3,read:3,commit:3,rollback:2,work:3});
});

test("fails explicitly after five ABORTED attempts",async()=>{
  const f=fixture({aborts:5});
  await assert.rejects(()=>runFirestoreRestTransaction(f.adapter,f.work),
    error=>error.code==="ABORTED"&&error.attempts===5&&/after 5 attempts/.test(error.message));
  assert.deepEqual(f.calls,{begin:5,read:5,commit:5,rollback:5,work:5});
});

test("rolls back a transaction when validation fails before commit and does not retry",async()=>{
  const f=fixture({workFailure:"FAILED_PRECONDITION"});
  await assert.rejects(()=>runFirestoreRestTransaction(f.adapter,f.work),{code:"FAILED_PRECONDITION"});
  assert.deepEqual(f.calls,{begin:1,read:1,commit:0,rollback:1,work:1});
});

for (const code of ["403","400"]) {
  test(`does not retry non-ABORTED read error ${code}`,async()=>{
    const f=fixture({readFailure:code});
    await assert.rejects(()=>runFirestoreRestTransaction(f.adapter,f.work),{code});
    assert.deepEqual(f.calls,{begin:1,read:1,commit:0,rollback:1,work:1});
  });
  test(`does not retry non-ABORTED commit error ${code}`,async()=>{
    const f=fixture();
    f.adapter.commitTransaction=async()=>{f.calls.commit++;return {response:{ok:false,status:Number(code)},data:{error:{status:code,message:"rejected"}}};};
    await assert.rejects(()=>runFirestoreRestTransaction(f.adapter,f.work),{code});
    assert.deepEqual(f.calls,{begin:1,read:1,commit:1,rollback:1,work:1});
  });
}
