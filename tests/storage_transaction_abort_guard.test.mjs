import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('storage/android-resilient-storage.js','utf8');
const start=source.indexOf('function abortTransactionSafely(tx) {');
const end=source.indexOf('\n  async function writeIDB',start);
assert.ok(start>=0&&end>start,'safe abort helper must exist before IndexedDB write transaction');
const helper=source.slice(start,end);
test('settled IndexedDB transactions do not throw during rollback guard',()=>{
  const inactive={abort(){const error=new Error('transaction is inactive');error.name='InvalidStateError';throw error;}};
  const active={calls:0,abort(){this.calls++;}};
  const context={tx:inactive};vm.createContext(context);vm.runInContext(helper+'; this.result=abortTransactionSafely(tx);',context);
  assert.equal(context.result,false);
  const activeContext={tx:active};vm.createContext(activeContext);vm.runInContext(helper+'; this.result=abortTransactionSafely(tx);',activeContext);
  assert.equal(activeContext.result,true);assert.equal(active.calls,1);
});
test('IndexedDB completion rejects a previously observed revision conflict',()=>{
  assert.match(source,/tx\.oncomplete\s*=\s*\(\)\s*=>\s*conflictError\s*\?\s*reject\(conflictError\)\s*:\s*resolve\(\)/);
});