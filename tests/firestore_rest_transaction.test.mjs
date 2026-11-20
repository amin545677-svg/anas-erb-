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

test("retries ABORTED beginTransaction failures within the five-attempt ceiling", async () => {
  const calls = { begin: 0, read: 0, commit: 0, rollback: 0, work: 0 };
  const adapter = {
    async beginTransaction() {
      calls.begin++;
      if (calls.begin < 3) { const error = new Error("begin contention"); error.code = "ABORTED"; throw error; }
      return "tx-" + calls.begin;
    },
    async readDocument(_path, tx) { calls.read++; assert.equal(tx, "tx-3"); return { ok: true }; },
    async commitTransaction(tx, writes) { calls.commit++; assert.equal(tx, "tx-3"); assert.deepEqual(writes, []); return { response: { ok: true, status: 200 } }; },
    async rollbackTransaction() { calls.rollback++; }
  };
  const result = await runFirestoreRestTransaction(adapter, async () => {
    calls.work++;
    return { writes: [], result: "committed" };
  });
  assert.equal(result, "committed");
  assert.deepEqual(calls, { begin: 3, read: 0, commit: 1, rollback: 0, work: 1 });
});

test("retries ABORTED read failures using a fresh transaction and reruns validation", async () => {
  const calls = { begin: 0, read: 0, commit: 0, rollback: 0, work: 0 };
  const adapter = {
    async beginTransaction() { calls.begin++; return "tx-" + calls.begin; },
    async readDocument(_path, tx) {
      calls.read++;
      assert.equal(tx, "tx-" + calls.begin);
      if (calls.read === 1) { const error = new Error("read contention"); error.code = "ABORTED"; throw error; }
      return { transaction: tx };
    },
    async commitTransaction(tx, writes) {
      calls.commit++;
      assert.equal(tx, "tx-2");
      assert.deepEqual(writes, [{ update: { name: "accounts/a" } }]);
      return { response: { ok: true, status: 200 } };
    },
    async rollbackTransaction(tx) { calls.rollback++; assert.equal(tx, "tx-1"); }
  };
  const result = await runFirestoreRestTransaction(adapter, async ({ attempt, get }) => {
    calls.work++;
    const doc = await get("accounts/a");
    assert.equal(doc.transaction, "tx-" + attempt);
    return { writes: [{ update: { name: "accounts/a" } }], result: attempt };
  });
  assert.equal(result, 2);
  assert.deepEqual(calls, { begin: 2, read: 2, commit: 1, rollback: 1, work: 2 });
});

test("does not retry a non-ABORTED beginTransaction failure", async () => {
  let begins = 0;
  const adapter = {
    async beginTransaction() { begins++; const error = new Error("permission denied"); error.code = "PERMISSION_DENIED"; throw error; },
    async readDocument() { assert.fail("read must not run"); },
    async commitTransaction() { assert.fail("commit must not run"); },
    async rollbackTransaction() { assert.fail("rollback must not run without a transaction"); }
  };
  await assert.rejects(() => runFirestoreRestTransaction(adapter, async () => ({ writes: [] })),
    { code: "PERMISSION_DENIED" });
  assert.equal(begins, 1);
});

test("rollback failure never masks the original callback failure", async () => {
  const adapter = {
    async beginTransaction() { return "tx-rollback-failure"; },
    async readDocument() { return null; },
    async commitTransaction() { assert.fail("commit must not run"); },
    async rollbackTransaction() { throw new Error("rollback transport failed"); }
  };
  await assert.rejects(
    () => runFirestoreRestTransaction(adapter, async () => {
      const error = new Error("business validation failed");
      error.code = "FAILED_PRECONDITION";
      throw error;
    }),
    error => error.code === "FAILED_PRECONDITION" && error.message === "business validation failed"
  );
});

test("rejects invalid adapters, callbacks and retry bounds before opening a transaction", async () => {
  let begins = 0;
  const adapter = {
    async beginTransaction() { begins++; return "tx"; },
    async readDocument() { return null; },
    async commitTransaction() { return { response: { ok: true } }; },
    async rollbackTransaction() {}
  };
  await assert.rejects(() => runFirestoreRestTransaction({}, async () => ({ writes: [] })), TypeError);
  await assert.rejects(() => runFirestoreRestTransaction(adapter, null), TypeError);
  for (const maxAttempts of [0, 6, 1.5, "5", NaN]) {
    await assert.rejects(() => runFirestoreRestTransaction(adapter, async () => ({ writes: [] }), { maxAttempts }), RangeError);
  }
  assert.equal(begins, 0);
});

test("commit failures expose structured Firestore context and do not retry non-ABORTED errors", async () => {
  let begins = 0, commits = 0, rollbacks = 0;
  const adapter = {
    async beginTransaction() { begins++; return "tx-context"; },
    async readDocument() { return null; },
    async commitTransaction() {
      commits++;
      return { response: { ok: false, status: 503 }, data: { error: { status: "UNAVAILABLE", message: "Firestore unavailable" } } };
    },
    async rollbackTransaction() { rollbacks++; }
  };
  await assert.rejects(
    () => runFirestoreRestTransaction(adapter, async () => ({ writes: [], result: null })),
    error => error.code === "UNAVAILABLE" && error.httpStatus === 503 &&
      error.operation === "commit" && error.message === "Firestore unavailable"
  );
  assert.deepEqual({ begins, commits, rollbacks }, { begins: 1, commits: 1, rollbacks: 1 });
});

