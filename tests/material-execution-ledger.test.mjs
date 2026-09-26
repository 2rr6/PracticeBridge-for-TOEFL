import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStore,emptyState,atomicWrite} from '../src/store.mjs';
import {synchronizeExecutionLedger,executionBudget,unacknowledgedExecutions,acknowledgeExecutions,validateExecutionLedger} from '../src/material-execution-ledger.mjs';

const limits={maxRequests:20,maxInputPerRequest:24000,maxInputTokens:240000,maxOutputTokens:60000,maxFormatRepairs:1,maxToolTextBytes:16384,maxDurationMs:900000,maxRetriesPerChunk:2};
const request=(index,state='settled',usage={inputTokens:100,outputTokens:20})=>({requestId:`request-${index}`,requestDigest:index.toString(16).padStart(64,'0'),reservation:{input:200,output:80},state,usage,usageKnown:usage!==null,outcomeUnknown:state==='outcome_unknown'});
function stateWithRequests(count=2){
  const state=emptyState(),jobId=randomUUID();
  state.materialJobs={[jobId]:{jobId,jobKey:'a'.repeat(64),sourceRevision:'b'.repeat(64),workspaceEpoch:state.workspaceEpoch,state:'interrupted',requests:Array.from({length:count},(_,i)=>request(i+1)),budget:{limits:{...limits},elapsedMs:count*10}}};
  synchronizeExecutionLedger(state);return {state,jobId};
}
async function fixture(t,options={}){
  const base=path.resolve('test-results/material-execution-ledger');await fs.mkdir(base,{recursive:true});const dataDir=await fs.mkdtemp(path.join(base,'run-'));
  const store=await createStore({dataDir,...options});
  t.after(async()=>{await store.close();assert.ok(dataDir.startsWith(base+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});
  return {store,dataDir};
}
async function restore(store,state){const permit=await store.beginRestore(store.captureEpoch());try{return await permit.publish(state);}finally{permit.release();}}

test('actual store restore keeps ten charges when restoring an earlier two-charge backup, including an intervening backup without the job',async t=>{
  const {store}=await fixture(t),{state,jobId}=stateWithRequests();
  await store.transact(next=>Object.assign(next,{materialJobs:state.materialJobs}));const older=store.read();
  await store.transact(next=>{next.materialJobs[jobId].requests.push(...Array.from({length:8},(_,i)=>request(i+3)));next.materialJobs[jobId].budget.elapsedMs=100;});
  assert.equal(store.read().materialJobs[jobId].budget.requestCount,10);
  await restore(store,older);let current=store.read();
  assert.equal(current.materialJobs[jobId].requests.length,2);assert.equal(current.materialJobs[jobId].budget.requestCount,10);assert.equal(current.materialJobs[jobId].budget.knownInput,1000);assert.equal(current.materialJobs[jobId].budget.elapsedMs,100);
  assert.equal(Object.keys(current.materialExecutionLedger.grants[jobId].requests).length,10);
  await restore(store,emptyState());assert.equal(store.read().materialJobs,undefined);assert.equal(Object.keys(store.read().materialExecutionLedger.grants[jobId].requests).length,10);
  await restore(store,older);assert.equal(store.read().materialJobs[jobId].budget.requestCount,10);
});

test('unknown charges absent from restored chunks remain reserved and require explicit renewed acknowledgement',async t=>{
  const {store}=await fixture(t),{state,jobId}=stateWithRequests(1);await store.transact(next=>{next.materialJobs=state.materialJobs;});const older=store.read();
  await store.transact(next=>{next.materialJobs[jobId].requests.push(request(2,'reserved',null));});
  await restore(store,older);let current=store.read();assert.equal(current.materialJobs[jobId].budget.requestCount,2);assert.equal(current.materialJobs[jobId].budget.unknownInput,200);assert.equal(unacknowledgedExecutions(current,jobId),1);
  await store.transact(next=>acknowledgeExecutions(next,jobId,123));assert.equal(unacknowledgedExecutions(store.read(),jobId),0);
  await restore(store,older);current=store.read();assert.equal(unacknowledgedExecutions(current,jobId),1);assert.equal(current.materialJobs[jobId].budget.unknownOutput,80);
});

test('settlement is deduplicated by execution identity and known usage survives restoration of an earlier unknown record',()=>{
  const {state,jobId}=stateWithRequests(0);state.materialJobs[jobId].requests=[request(1,'outcome_unknown',null)];synchronizeExecutionLedger(state);const unknown=structuredClone(state);
  state.materialJobs[jobId].requests=[request(1)];synchronizeExecutionLedger(state);
  synchronizeExecutionLedger(unknown,{previous:state,restoring:true});const budget=executionBudget(unknown.materialJobs[jobId],unknown.materialExecutionLedger);
  assert.equal(budget.requestCount,1);assert.equal(budget.knownInput,100);assert.equal(budget.unknownInput,0);assert.equal(unacknowledgedExecutions(unknown,jobId),0);
});

test('restore removes obsolete acknowledgement from both live requests and the retained ledger',async t=>{
  const {store}=await fixture(t),{state,jobId}=stateWithRequests(0);state.materialJobs[jobId].requests=[request(1,'outcome_unknown',null)];
  await store.transact(next=>{next.materialJobs=state.materialJobs;});await store.transact(next=>acknowledgeExecutions(next,jobId,123));const acknowledged=store.read();assert.equal(unacknowledgedExecutions(acknowledged,jobId),0);
  await restore(store,acknowledged);const current=store.read();assert.equal(unacknowledgedExecutions(current,jobId),1);assert.equal(current.materialJobs[jobId].requests[0].acknowledgedAt,undefined);
});

test('a local transport finalization can confirm not_sent, and restoring an older provisional row does not undo that local fact',async t=>{
  const {store}=await fixture(t),{state,jobId}=stateWithRequests(0);state.materialJobs[jobId].requests=[request(1,'outcome_unknown',null)];
  await store.transact(next=>{next.materialJobs=state.materialJobs;});const older=store.read();assert.equal(older.materialJobs[jobId].budget.requestCount,1);
  await store.transact(next=>{Object.assign(next.materialJobs[jobId].requests[0],{state:'not_sent',outcomeUnknown:false});});
  assert.equal(store.read().materialJobs[jobId].budget.requestCount,0);await restore(store,older);
  const restored=store.read();assert.equal(restored.materialJobs[jobId].budget.requestCount,0);assert.equal(restored.materialJobs[jobId].requests[0].state,'not_sent');assert.equal(unacknowledgedExecutions(restored,jobId),0);
});

test('same execution ID with different immutable input or settlement fails without publishing old-state damage',async t=>{
  const {store,dataDir}=await fixture(t),{state,jobId}=stateWithRequests(1);await store.transact(next=>{next.materialJobs=state.materialJobs;});
  const before=await fs.readFile(path.join(dataDir,'state.json'));
  for(const patch of [{requestDigest:'f'.repeat(64)},{usage:{inputTokens:101,outputTokens:20}}]){
    const forged=store.read();Object.assign(forged.materialJobs[jobId].requests[0],patch);
    await assert.rejects(restore(store,forged),error=>error.code==='EXECUTION_LEDGER_CONFLICT');assert.deepEqual(await fs.readFile(path.join(dataDir,'state.json')),before);
  }
});

test('failed atomic restore leaves both learning state and irreversible charge union unpublished',async t=>{
  let fail=false;const {store,dataDir}=await fixture(t,{atomicWriter:async(...args)=>{if(fail)throw Error('synthetic publish failure');return atomicWrite(...args);}}),{state,jobId}=stateWithRequests(1);
  await store.transact(next=>{next.materialJobs=state.materialJobs;});const before=await fs.readFile(path.join(dataDir,'state.json')),incoming=store.read();incoming.materialJobs[jobId].requests.push(request(2));synchronizeExecutionLedger(incoming);fail=true;
  await assert.rejects(restore(store,incoming),/synthetic publish failure/);assert.deepEqual(await fs.readFile(path.join(dataDir,'state.json')),before);assert.equal(store.read().materialJobs[jobId].budget.requestCount,1);
});

test('ledger contains only bounded charge identities and rejects extra fields, shared execution IDs, and credential or CAS payloads',()=>{
  const {state,jobId}=stateWithRequests(1);assert.equal(validateExecutionLedger(state.materialExecutionLedger),undefined);
  for(const [key,value] of [['apiKey','private-secret'],['inputRef','c'.repeat(64)],['baseUrl','http://localhost']]){
    const ledger=structuredClone(state.materialExecutionLedger);ledger.grants[jobId].requests['request-1'][key]=value;assert.throws(()=>validateExecutionLedger(ledger),error=>error.code==='INVALID_EXECUTION_LEDGER');
  }
  const duplicated=structuredClone(state.materialExecutionLedger);duplicated.grants[randomUUID()]=structuredClone(duplicated.grants[jobId]);assert.throws(()=>validateExecutionLedger(duplicated),error=>error.code==='EXECUTION_LEDGER_CONFLICT');
});
