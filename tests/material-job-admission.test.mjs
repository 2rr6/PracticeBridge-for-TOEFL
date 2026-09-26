import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createStore,atomicWrite} from '../src/store.mjs';
import {createMaterialJobs} from '../src/material-jobs.mjs';
import {createModels} from '../src/models.mjs';

const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const tick=()=>new Promise(done=>setImmediate(done));
const base=path.resolve('test-results/material-job-admission');
for(const phase of ['prepare','start','continue','start-commit','continue-commit'])test(`restore drain owns ${phase} before its first asynchronous boundary`,async t=>{
  await fs.mkdir(base,{recursive:true});const dataDir=await fs.mkdtemp(path.join(base,phase+'-')),held=defer(),entered=defer();let armed=false,calls=0;
  const hold=async()=>{armed=false;entered.resolve();await held.promise;};
  const store=await createStore({dataDir,atomicWriter:async(file,bytes)=>{if(phase.endsWith('-commit')&&armed&&file.endsWith('state.json')&&Object.values(JSON.parse(bytes).materialJobs||{}).some(job=>job.state==='queued'))await hold();return atomicWrite(file,bytes);}});
  const epoch=store.captureEpoch(),materialId='authored-admission',sourceRevision='a'.repeat(64);
  await store.transact(state=>state.materials.push({id:materialId,files:[],text:'Self-authored admission fixture'}));
  const artifacts=new Map(),repository={async writeArtifact(value){if(phase==='start'&&armed)await hold();const ref=crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');artifacts.set(ref,structuredClone(value));return ref;},async readArtifact(ref){return structuredClone(artifacts.get(ref));},commitPrepared(){throw Error('The fixture never returns a successful model reply');}};
  const models=createModels({dataDir,fetchImpl:async()=>{calls++;return new Response('',{status:401});}});
  await models.updateSettings({provider:'compatible',baseUrl:'https://fixture.invalid/v1',model:'admission',structuredOutput:'json_object',maxOutputTokens:200});
  const plan={materialId,sourceRevision,sourceIndex:{groups:['g']},scope:{assetIds:[],allowedToolIds:[],allowLocalAsr:false},chunks:[{sourceScope:'g',dependencyRefs:[],sourceIds:['q'],text:'A complete self-authored source.'}]};
  const originalTransact=store.transact;store.transact=async(...args)=>{if(phase==='continue'&&armed)await hold();return originalTransact(...args);};
  const jobs=createMaterialJobs({store,models,repository,sourceRevisionOf:()=>sourceRevision,sourceProvider:async()=>{if(phase==='prepare'&&armed)await hold();return structuredClone(plan);},prepareChunk:async()=>({messages:[{role:'user',content:'Only this authored source'}],schema:{name:'probe',schema:{type:'object',additionalProperties:false,properties:{ok:{type:'boolean'}},required:['ok']}}}),applyChunk:async()=>{throw Error('The fixture never returns a successful reply');}});
  t.after(async()=>{held.resolve();await jobs.stop();await store.close();assert.equal(path.dirname(path.resolve(dataDir)),base);await fs.rm(dataDir,{recursive:true,force:true});});
  await jobs.ready;const scope={materialId,expectedEpoch:epoch,expectedBinding:models.binding()};let operation,initialCalls=0;
  if(phase==='prepare'){armed=true;operation=jobs.prepare(scope);}
  else {const preview=await jobs.prepare(scope);if(phase.startsWith('start')){armed=true;operation=jobs.start({...scope,...preview,consent:true});}
    else {const job=await jobs.start({...scope,...preview,consent:true});await jobs.awaitIdle();initialCalls=calls;armed=true;operation=jobs.continue({...scope,jobId:job.jobId,expectedGeneration:jobs.view(job.jobId).generation,consent:true});}}
  operation=operation.then(value=>({ok:true,value}),error=>({ok:false,error}));
  await entered.promise;let pauseResolved=false;const pausing=jobs.pause().then(()=>{pauseResolved=true;});await tick();await tick();
  const prematurePause=pauseResolved;held.resolve();const outcome=await operation;await pausing;await jobs.awaitIdle();
  assert.equal(prematurePause,false,'pause must wait for an already admitted operation');
  assert.equal(outcome.ok,false,'an admitted operation that crossed the pause boundary cannot publish a usable preview or enqueue');
  assert.equal(calls,initialCalls,'no model execution may begin after the drain gate closed');
  assert.ok(jobs.list().every(job=>!['queued','running'].includes(job.state)),'a late committed job must be interrupted even when enqueue was refused');
  jobs.resume();await tick();assert.equal(calls,initialCalls,'resuming after an unsuccessful restore never automatically starts drained work');
});
