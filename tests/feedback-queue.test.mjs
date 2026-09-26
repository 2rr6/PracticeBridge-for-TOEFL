import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createStore} from '../src/store.mjs';
import {createFeedbackQueue} from '../src/feedback-queue.mjs';

const root=path.resolve('test-results/feedback-queue'),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('restore pauses feedback promptly, quarantines late output and never automatically resends',async t=>{
  await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'run-')),store=await createStore({dataDir:dir});
  const held=deferred(),entered=deferred();let calls=0,receivedBinding;const binding={provider:'synthetic'};
  const queue=createFeedbackQueue({store,getBinding:()=>binding,request:async input=>{calls++;receivedBinding=input.expectedBinding;entered.resolve();return held.promise;},evaluate:value=>value,now:()=>new Date().toISOString()});
  t.after(async()=>{held.resolve({summary:'Late synthetic feedback'});await queue.pause();await store.close();assert.ok(dir.startsWith(root+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  await store.transact(s=>{s.attempts=[{id:'a',evaluations:[]}];s.jobs=[{id:'j',attemptId:'a',status:'queued',modelBinding:binding,request:{}}];});
  const running=queue.run();await entered.promise;assert.deepEqual(receivedBinding,binding,'dispatch must carry the exact binding authorized for this queued feedback');assert.notEqual(receivedBinding,binding);
  await Promise.race([queue.pause('workspace_restore'),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Pause waited for remote reply')),1500);timer.unref();})]);
  assert.equal(store.read().jobs[0].status,'interrupted');
  const permit=await store.beginRestore(store.getWorkspaceEpoch());try{await permit.publish(store.read());}finally{permit.release();}
  queue.resume();held.resolve({summary:'Late synthetic feedback'});await running;await new Promise(setImmediate);
  assert.equal(store.read().attempts[0].evaluations.length,0);assert.equal(calls,1);assert.equal(store.read().jobs[0].status,'interrupted');
  await store.transact(s=>s.jobs.push({id:'fresh',attemptId:'a',status:'queued',modelBinding:binding,request:{}}));await queue.run();
  assert.equal(calls,2);assert.equal(store.read().jobs[1].status,'completed');assert.equal(store.read().attempts[0].evaluations.length,1);
});
