import test from "node:test";
import assert from "node:assert/strict";
import {runFirestoreRestTransaction} from "../cloudflare/firestore_rest_transaction.mjs";
test("invoice, stock, customer debt and idempotency marker share one commit",async()=>{
 let attempt=0;const commits=[];
 const adapter={
  async beginTransaction(){return{id:++attempt};},
  async readDocument(path,tx){assert.equal(tx.id,attempt);if(path==="operations/op1")return{exists:false};if(path==="products/p1")return{stockMicroUnits:5000000};if(path==="customers/c1")return{debtCentimes:0};return null;},
  async commitTransaction(tx,writes){commits.push({tx,writes});return{response:{ok:true,status:200}};},
  async rollbackTransaction(){}
 };
 const result=await runFirestoreRestTransaction(adapter,async({transaction,get})=>{
  const [op,stock,customer]=await Promise.all([get("operations/op1"),get("products/p1"),get("customers/c1")]);
  assert.equal(op.exists,false);assert.equal(stock.stockMicroUnits,5000000);assert.equal(customer.debtCentimes,0);
  return{writes:[
   {update:{name:"invoices/i1",fields:{totalCentimes:1250,paidCentimes:250,debtCentimes:1000}}},
   {update:{name:"products/p1",fields:{stockMicroUnits:4000000}}},
   {update:{name:"customers/c1",fields:{debtCentimes:1000}}},
   {update:{name:"operations/op1",fields:{status:"COMMITTED",invoiceId:"i1"}}}
  ],result:{transactionId:transaction.id}};
 });
 assert.deepEqual(result,{transactionId:1});
 assert.equal(commits.length,1);
 assert.deepEqual(commits[0].writes.map(w=>w.update.name),["invoices/i1","products/p1","customers/c1","operations/op1"]);
});
test("ABORTED transaction rolls back and retries the entire write set",async()=>{
 let attempt=0;const committed=[],rolled=[];
 const adapter={
  async beginTransaction(){return{id:++attempt};},
  async readDocument(path,tx){return{readAttempt:tx.id};},
  async commitTransaction(tx,writes){if(tx.id===1)return{response:{ok:false,status:409},data:{error:{status:"ABORTED"}}};committed.push({tx,writes});return{response:{ok:true,status:200}};},
  async rollbackTransaction(tx){rolled.push(tx.id);}
 };
 const result=await runFirestoreRestTransaction(adapter,async({transaction,get})=>{
  const [s,d]=await Promise.all([get("products/p1"),get("customers/c1")]);
  return{writes:[
   {update:{name:"invoices/i2",fields:{attempt:transaction.id}}},
   {update:{name:"products/p1",fields:{readAttempt:s.readAttempt}}},
   {update:{name:"customers/c1",fields:{readAttempt:d.readAttempt}}},
   {update:{name:"operations/op2",fields:{attempt:transaction.id}}}
  ],result:{attempt:transaction.id}};
 });
 assert.deepEqual(result,{attempt:2});assert.deepEqual(rolled,[1]);assert.equal(committed.length,1);
 assert.ok(committed[0].writes.every(w=>w.update.fields.attempt===2||w.update.fields.readAttempt===2));
});
