import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import fc from 'fast-check';
import {createStore,atomicWrite} from '../src/store.mjs';
import {createModels} from '../src/models.mjs';
import {createMaterialJobs,materialJobReferences,rebaseMaterialJobs,validateMaterialJobs} from '../src/material-jobs.mjs';
import {extractProcessingEdges} from '../src/processing-edges.mjs';

const root=path.resolve('test-results/material-jobs-v05');
const proposalSchema={type:'object',required:['sourceId','text'],additionalProperties:false,properties:{sourceId:{type:'string'},text:{type:'string'}}};
const schema={name:'scoped_proposals',schema:{type:'object',required:['proposals'],additionalProperties:false,properties:{proposals:{type:'array',items:proposalSchema}}}};
const remote=(proposals,usage={prompt_tokens:250,completion_tokens:50})=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({proposals})}}],usage}),{status:200,headers:{'Content-Type':'application/json'}});
async function fixture(t,{fetchImpl,groups=4,atomicWriter,splitChunk,decorate}={}){
  await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'run-'));t.after(async()=>{assert.ok(path.resolve(dataDir).startsWith(root+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});
  const store=await createStore({dataDir,atomicWriter:atomicWriter||atomicWrite});t.after(()=>store.close());
  const materialId='material-self-authored',sourceRevision='a'.repeat(64);await store.transact(s=>{s.materials.push({id:materialId,files:[],text:'Original immutable source'});});
  const artifacts=new Map();
  const repository={async writeArtifact(value){const bytes=JSON.stringify(value),ref=crypto.createHash('sha256').update(bytes).digest('hex');artifacts.set(ref,structuredClone(value));await fs.mkdir(path.join(dataDir,'processing-artifacts'),{recursive:true});await fs.writeFile(path.join(dataDir,'processing-artifacts',ref),bytes);return ref;},async readArtifact(ref){return JSON.parse(await fs.readFile(path.join(dataDir,'processing-artifacts',ref),'utf8'));},commitPrepared(state,p,{expectedEpoch}){assert.equal(state.workspaceEpoch,expectedEpoch);const current=state.candidateSets[materialId]||{revision:0,candidates:[]};if(current.revision!==p.expectedSetRevision)throw Object.assign(new Error('user revision conflict'),{status:409});state.candidateSets[materialId]={revision:current.revision+1,candidates:[...current.candidates,...p.proposals.map(proposal=>({...proposal,candidateId:proposal.sourceId,revision:1}))]};}};
  let calls=0;const models=createModels({dataDir,fetchImpl:fetchImpl?async(...args)=>fetchImpl(++calls,...args):async()=>remote([{sourceId:`group-${++calls}`,text:`Question ${calls}`}])});await models.updateSettings({provider:'compatible',baseUrl:'https://example.test/v1',model:'fixture',structuredOutput:'json_object',maxOutputTokens:700});
  const plan={materialId,sourceRevision,sourceIndex:{groups:Array.from({length:groups},(_,i)=>`group-${i+1}`)},scope:{assetIds:[],allowedToolIds:[],allowLocalAsr:false},chunks:Array.from({length:groups},(_,i)=>({sourceScope:`group-${i+1}`,dependencyRefs:[],sourceIds:[`group-${i+1}`],text:`Question ${i+1}`,sharedText:'Full shared passage repeated with every request.'}))};
  decorate?.(plan);const sourceProvider=async()=>structuredClone(plan);
  const prepareChunk=async({payload})=>({messages:[{role:'system',content:'Copy only located source proposals.'},{role:'user',content:JSON.stringify(payload)}],schema});
  const applyChunk=async({output,payload,expectedSetRevision})=>{assert.ok(Array.isArray(output.proposals));if(output.proposals.some(p=>!payload.sourceIds.includes(p.sourceId)))throw new Error('unlocated source');return {prepared:{expectedSetRevision,proposals:output.proposals},candidateCount:output.proposals.length,pendingCount:0};};
  const make=()=>createMaterialJobs({store,models,repository,sourceProvider,sourceRevisionOf:()=>sourceRevision,prepareChunk,applyChunk,splitChunk,sleep:async()=>{}});
  const jobs=make();await jobs.ready;t.after(()=>jobs.stop());
  async function start(limits){const expectedEpoch=store.captureEpoch(),expectedBinding=models.binding();const preview=await jobs.prepare({materialId,expectedEpoch,expectedBinding,limits});return jobs.start({previewId:preview.previewId,scopeDigest:preview.scopeDigest,expectedEpoch,expectedBinding,consent:true});}
  return {dataDir,store,models,repository,jobs,make,start,plan,calls:()=>calls,materialId};
}

test('request intent is durable before send and fourth-block failure preserves first three checkpoints',async t=>{
  let f;f=await fixture(t,{fetchImpl:async(n)=>{const state=f.store.read(),job=Object.values(state.materialJobs)[0],request=job.requests.at(-1);assert.ok(['reserved','in_flight'].includes(request.state));assert.ok(request.reservation.input>Buffer.byteLength(f.plan.chunks[n-1].text));assert.equal(request.reservation.output,700);if(n===4)return new Response('',{status:401});return remote([{sourceId:`group-${n}`,text:`Question ${n}`}]);}});
  const started=await f.start();await f.jobs.awaitIdle();const view=f.jobs.view(started.jobId);
  assert.equal(view.completedBlocks,3);assert.equal(view.state,'failed');assert.equal(view.lastError.httpStatus,401);assert.equal(f.calls(),4);
  assert.equal(f.store.read().candidateSets[f.materialId].candidates.length,3);
  assert.equal(view.budget.requestCount,4);assert.ok(view.budget.unknownInput>0);
});

test('unknown remote outcome survives restart, never autosends, and Continue requires explicit acknowledgement',async t=>{
  const f=await fixture(t,{groups:1,fetchImpl:async()=>{throw new Error('synthetic response lost');}});const started=await f.start();await f.jobs.awaitIdle();
  assert.equal(f.jobs.view(started.jobId).state,'request_outcome_unknown');const before=f.jobs.view(started.jobId).budget;
  const restarted=f.make();await restarted.ready;assert.equal(f.calls(),1);
  await assert.rejects(restarted.continue({jobId:started.jobId,expectedEpoch:f.store.captureEpoch(),expectedBinding:f.models.binding(),consent:true}),/未知|确认/);
  assert.deepEqual(restarted.view(started.jobId).budget,before);
  await restarted.continue({jobId:started.jobId,expectedEpoch:f.store.captureEpoch(),expectedBinding:f.models.binding(),consent:true,acknowledgeUnknown:true});await restarted.awaitIdle();assert.equal(f.calls(),2);assert.equal(restarted.view(started.jobId).budget.requestCount,2);await restarted.stop();
});

test('a reserved in-flight request found after process loss is marked unknown without network work',async t=>{
  const f=await fixture(t,{groups:1});const preview=await f.jobs.prepare({materialId:f.materialId,expectedEpoch:f.store.captureEpoch(),expectedBinding:f.models.binding()});
  let release,prepared;const held=new Promise(r=>{release=r;}),intentReserved=new Promise(r=>{prepared=r;});const originalSend=f.models.sendPrepared;f.models.sendPrepared=async(...args)=>{prepared();await held;return originalSend(...args);};
  const started=await f.jobs.start({previewId:preview.previewId,scopeDigest:preview.scopeDigest,expectedEpoch:f.store.captureEpoch(),expectedBinding:f.models.binding(),consent:true});
  await intentReserved;
  const old=f.store.read().materialJobs[started.jobId];assert.equal(old.requests.length,1);
  const restarted=f.make();await restarted.ready;assert.equal(restarted.view(started.jobId).state,'request_outcome_unknown');assert.equal(f.calls(),0);
  await f.jobs.cancel({jobId:started.jobId,expectedEpoch:f.store.captureEpoch()});release();await f.jobs.awaitIdle();assert.equal(f.store.read().candidateSets[f.materialId],undefined);await restarted.stop();
});

test('reservation counts complete repeated wire inputs across bounded 429 retry and one JSON repair',async t=>{
  const wires=[];const f=await fixture(t,{groups:1,fetchImpl:async(n,u,o)=>{wires.push(o.body);if(n===1)return new Response('',{status:429});if(n===2)return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{incomplete'}}]}),{status:200});return remote([{sourceId:'group-1',text:'Question 1'}]);}});
  const started=await f.start();await f.jobs.awaitIdle();const job=f.store.read().materialJobs[started.jobId];assert.equal(f.calls(),3);assert.equal(job.chunks[0].formatRepairCount,1);assert.equal(job.chunks[0].retryCount,1);
  assert.ok(wires.every(w=>w.includes('Full shared passage repeated')));assert.ok(job.requests.every((r,i)=>r.reservation.input>=Buffer.byteLength(wires[i])));assert.equal(f.jobs.view(started.jobId).completedBlocks,1);
});

test('input/output caps fail before send; continuation cannot reset accumulated budget',async t=>{
  const f=await fixture(t,{groups:2});const started=await f.start({maxRequests:1});await f.jobs.awaitIdle();let job=f.jobs.view(started.jobId);assert.equal(job.completedBlocks,1);assert.equal(job.state,'budget_exhausted');assert.equal(f.calls(),1);
  await assert.rejects(f.jobs.continue({jobId:started.jobId,expectedEpoch:f.store.captureEpoch(),expectedBinding:f.models.binding(),consent:true}),/预算/);assert.equal(f.jobs.view(started.jobId).budget.requestCount,1);
  // A block larger than the per-request cap is that block's problem, not spent job budget.
  const g=await fixture(t,{groups:1});const tooSmall=await g.start({maxInputPerRequest:300});await g.jobs.awaitIdle();assert.equal(g.calls(),0);
  const small=g.jobs.view(tooSmall.jobId);assert.equal(small.state,'needs_information');assert.equal(small.chunks[0].lastError.code,'input_context_budget_exceeded');
});

test('manual revision conflict and cancel/restore guards prevent late candidate publication',async t=>{
  let resolve;const f=await fixture(t,{groups:1,fetchImpl:()=>new Promise(r=>{resolve=r;})});const started=await f.start();for(let i=0;i<20&&!resolve;i++)await new Promise(r=>setTimeout(r,5));
  await f.store.transact(s=>{s.candidateSets[f.materialId]={revision:1,candidates:[{sourceId:'manual',text:'User text'}]};});resolve(remote([{sourceId:'group-1',text:'Question 1'}]));await f.jobs.awaitIdle();assert.equal(f.jobs.view(started.jobId).state,'needs_review');assert.deepEqual(f.store.read().candidateSets[f.materialId].candidates,[{sourceId:'manual',text:'User text'}]);
  let done;const g=await fixture(t,{groups:1,fetchImpl:()=>new Promise(r=>{done=r;})});const second=await g.start();for(let i=0;i<20&&!done;i++)await new Promise(r=>setTimeout(r,5));await g.jobs.cancel({jobId:second.jobId,expectedEpoch:g.store.captureEpoch()});done(remote([{sourceId:'group-1',text:'late'}]));await g.jobs.awaitIdle();assert.equal(g.jobs.view(second.jobId).state,'cancelled');assert.equal(g.store.read().candidateSets[g.materialId],undefined);
  const barrier=await g.store.beginRestore(g.store.captureEpoch());try{await barrier.publish(barrier.snapshot);}finally{barrier.release();}
  await assert.rejects(g.jobs.continue({jobId:second.jobId,expectedEpoch:g.store.captureEpoch(),expectedBinding:g.models.binding(),consent:true,acknowledgeUnknown:true}),/工作区|恢复/);
});

test('a failed checkpoint publication retains unknown request outcome and never half-commits candidates or settlement',async t=>{
  let failed=false;const f=await fixture(t,{groups:1,atomicWriter:async(file,bytes)=>{if(!failed&&file.endsWith('state.json')&&JSON.parse(bytes).candidateSets?.['material-self-authored']?.candidates.length){failed=true;throw new Error('synthetic checkpoint disk failure');}return atomicWrite(file,bytes);}});
  const started=await f.start();await f.jobs.awaitIdle();const job=f.jobs.view(started.jobId);
  assert.equal(failed,true);assert.equal(f.store.read().candidateSets[f.materialId],undefined);assert.equal(job.state,'request_outcome_unknown');assert.equal(job.unknownRequests,1);assert.ok(job.budget.unknownInput>0);assert.equal(job.budget.knownInput,0);
});

test('starting the identical source/scope/binding again returns its existing job and cannot reset its budget',async t=>{
  const f=await fixture(t,{groups:2});const first=await f.start({maxRequests:1});await f.jobs.awaitIdle();assert.equal(f.calls(),1);
  const again=await f.start({maxRequests:1});await f.jobs.awaitIdle();assert.equal(again.jobId,first.jobId);assert.equal(f.calls(),1);assert.equal(Object.keys(f.store.read().materialJobs).length,1);
});

test('job tool authority requires explicit source, generation and candidate revision guards',async t=>{
  const f=await fixture(t,{groups:1});const started=await f.start();await f.jobs.awaitIdle();const job=f.jobs.view(started.jobId);
  assert.throws(()=>f.jobs.assertCurrent({jobId:job.jobId,expectedEpoch:job.workspaceEpoch}),/版本|guard|保护/);
  assert.throws(()=>f.jobs.assertCurrent({jobId:job.jobId,expectedEpoch:job.workspaceEpoch,generation:job.generation,sourceRevision:'b'.repeat(64),expectedSetRevision:1}),/来源|版本/);
});

test('job CAS enumeration includes nested tool references and restore rebasing preserves checkpoints and unknown costs',async t=>{
  const f=await fixture(t,{groups:2,fetchImpl:async n=>{if(n===2)throw new Error('lost');return remote([{sourceId:'group-1',text:'Question 1'}]);}});const started=await f.start();await f.jobs.awaitIdle();
  const mediaRef=await f.repository.writeArtifact({kind:'media-derivative',value:{blob:{id:'f'.repeat(64),mime:'audio/mpeg',size:42}},dependencyRefs:[]});
  const checkpoint=await f.repository.writeArtifact({kind:'local-tool-checkpoint',toolId:'media.probe',result:{artifactRefs:[mediaRef]}});
  await f.store.transact(state=>{state.materialJobs[started.jobId].chunks[0].checkpointRef=checkpoint;});const before=f.store.read();
  const roots=materialJobReferences(before);assert.ok(roots.includes(checkpoint));const child=extractProcessingEdges(await f.repository.readArtifact(checkpoint),{role:'job-checkpoint'});assert.deepEqual(child.references,[{ref:mediaRef,role:'tool-json'}]);assert.deepEqual(extractProcessingEdges(await f.repository.readArtifact(mediaRef),{role:'media-artifact'}).blobs,[{id:'f'.repeat(64),mime:'audio/mpeg',size:42}]);
  const restored=structuredClone(before),newEpoch=crypto.randomUUID();rebaseMaterialJobs(restored,newEpoch);validateMaterialJobs(restored);const old=before.materialJobs[started.jobId],job=restored.materialJobs[started.jobId];assert.equal(job.workspaceEpoch,newEpoch);assert.equal(job.generation,old.generation+1);assert.equal(job.chunks[0].checkpointRef,checkpoint);assert.equal(job.chunks[0].state,'completed');assert.deepEqual(job.budget,old.budget);assert.equal(job.state,'request_outcome_unknown');assert.equal(f.calls(),2);
  restored.materialJobs[started.jobId].budget.limits.maxRequests=1000;assert.throws(()=>validateMaterialJobs(restored));
});

test('pause finishes promptly even if remote fetch ignores abort; resume never autosends',async t=>{
  const f=await fixture(t,{groups:1,fetchImpl:()=>new Promise(()=>{})});const started=await f.start();for(let i=0;i<30&&!f.calls();i++)await new Promise(r=>setTimeout(r,5));const time=Date.now();await f.jobs.pause();assert.ok(Date.now()-time<1000);assert.equal(f.jobs.view(started.jobId).state,'interrupted');assert.equal(f.jobs.view(started.jobId).unknownRequests,1);f.jobs.resume();await new Promise(r=>setTimeout(r,10));assert.equal(f.calls(),1);
});

test('restored job counters and request identity cannot understate unknown budget reservations',async t=>{
  const f=await fixture(t,{groups:1,fetchImpl:async()=>{throw new Error('response lost');}});
  const started=await f.start();await f.jobs.awaitIdle();const saved=f.store.read();
  const understated=structuredClone(saved),job=understated.materialJobs[started.jobId];
  job.budget.unknownInput=0;job.budget.unknownOutput=0;job.budget.chargedInput=0;job.budget.chargedOutput=0;
  assert.throws(()=>validateMaterialJobs(understated),error=>error.code==='invalid_material_jobs');
  const duplicated=structuredClone(saved),duplicate=duplicated.materialJobs[started.jobId];
  duplicate.requests.push(structuredClone(duplicate.requests[0]));duplicate.budget.requestCount++;
  for(const key of ['unknownInput','unknownOutput','chargedInput','chargedOutput'])duplicate.budget[key]*=2;
  assert.throws(()=>validateMaterialJobs(duplicated),error=>error.code==='invalid_material_jobs');
  const inconsistent=structuredClone(saved);inconsistent.materialJobs[started.jobId].requests[0].usageKnown=true;
  assert.throws(()=>validateMaterialJobs(inconsistent),error=>error.code==='invalid_material_jobs');
  assert.doesNotThrow(()=>validateMaterialJobs(saved));
});

test('oversized shared dependencies stop before transport preparation can bypass the scope-specific error',async t=>{
  const f=await fixture(t,{groups:1});f.plan.chunks[0].sharedText='shared original '.repeat(40000);
  const started=await f.start();await f.jobs.awaitIdle();const job=f.jobs.view(started.jobId);
  assert.equal(f.calls(),0);assert.equal(job.state,'needs_information');
  assert.equal(job.chunks[0].lastError.code,'CONTEXT_DEPENDENCY_TOO_LARGE');assert.equal(job.lastError.code,'blocks_unfinished');assert.equal(job.budget.requestCount,0);
});

test('generated provider-failure sequences preserve successful groups and never exceed approved attempts',async t=>{
  const behavior=fc.array(fc.constantFrom('completed','rate_limit','invalid','empty','length','refusal','lost'),{minLength:1,maxLength:8});
  await fc.assert(fc.asyncProperty(behavior,fc.integer({min:1,max:5}),async(sequence,maxRequests)=>{
    const f=await fixture(t,{fetchImpl:async(n,_url,options)=>{
      const kind=sequence[n-1]||'completed';
      if(kind==='rate_limit')return new Response('',{status:429});
      if(kind==='lost')throw new Error('synthetic lost reply');
      if(kind==='invalid'||kind==='empty')return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:kind==='invalid'?'{unfinished':''}}]}));
      if(kind==='length')return new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{unfinished'}}]}));
      if(kind==='refusal')return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{refusal:'synthetic refusal'}}]}));
      const body=JSON.parse(options.body),payload=JSON.parse(body.messages.find(message=>message.role==='user').content);
      return remote([{sourceId:payload.sourceIds[0],text:payload.text}]);
    }});
    // Model: a block-specific failure (unusable JSON after one repair, length
    // without a split, refusal) marks that block and moves on; three sent
    // blocks failing in a row, exhausted 429 retries, an unknown outcome or
    // spent budget stop the job.
    let expectedCalls=0,block=1,retries=0,repairs=0,streak=0,expectedState;const completed=[],unfinished=[];
    while(block<=4){
      if(expectedCalls>=maxRequests){expectedState='budget_exhausted';break;}
      const kind=sequence[expectedCalls++]||'completed';
      if(kind==='completed'){completed.push(block++);retries=0;repairs=0;streak=0;continue;}
      if(kind==='rate_limit'){if(retries++<2)continue;expectedState='failed';break;}
      if(kind==='lost'){expectedState='request_outcome_unknown';break;}
      if(['invalid','empty'].includes(kind)&&repairs++<1)continue;
      unfinished.push(kind==='length'?'needs_information':'failed');block++;retries=0;repairs=0;
      if(++streak>=3){expectedState='failed';break;}
    }
    expectedState??=!unfinished.length?'completed':unfinished.every(state=>state==='needs_information')?'needs_information':'failed';
    const started=await f.start({maxRequests});await f.jobs.awaitIdle();const job=f.jobs.view(started.jobId);
    assert.equal(f.calls(),expectedCalls);assert.equal(job.budget.requestCount,expectedCalls);
    assert.equal(job.completedBlocks,completed.length);assert.equal(job.state,expectedState);
    assert.deepEqual((f.store.read().candidateSets[f.materialId]?.candidates||[]).map(candidate=>candidate.sourceId),completed.map(index=>`group-${index}`));
    assert.ok(job.budget.requestCount<=maxRequests);validateMaterialJobs(f.store.read());
  }),{seed:20260913,numRuns:32});
});

// Replies echo the block's first source id so any block order can be checked.
const echo=(options)=>{const body=JSON.parse(options.body),payload=JSON.parse(body.messages.find(message=>message.role==='user').content);return remote(payload.sourceIds.map(sourceId=>({sourceId,text:'copied'})));};
const refusal=()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{refusal:'synthetic refusal'}}]}));

test('default approval scales with the planned blocks, so a 22-block paper can finish',async t=>{
  const f=await fixture(t,{groups:22,fetchImpl:async(n,_url,options)=>echo(options)});
  const preview=await f.jobs.prepare({materialId:f.materialId,expectedEpoch:f.store.captureEpoch(),expectedBinding:f.models.binding()});
  assert.equal(preview.limits.maxRequests,48);assert.equal(preview.limits.maxOutputTokens,48*700);
  const started=await f.start();await f.jobs.awaitIdle();const job=f.jobs.view(started.jobId);
  assert.equal(job.state,'completed');assert.equal(job.completedBlocks,22);assert.equal(f.calls(),22);
});

test('a block whose reply would not fit the output limit is split before any request is paid for',async t=>{
  const long='Original stem text that is long enough to need its own reply. '.repeat(40);
  const f=await fixture(t,{groups:1,fetchImpl:async(n,_url,options)=>echo(options),
    decorate:plan=>{const chunk=plan.chunks[0];chunk.sourceIds=['q-1','q-2'];chunk.sharedBlockIds=[];chunk.questions=[{sourceId:'q-1'},{sourceId:'q-2'}];chunk.blocks=[{id:'b-1',text:long},{id:'b-2',text:long}];},
    splitChunk:async({payload})=>payload.questions.length<2?null:payload.questions.map((question,index)=>({...structuredClone(payload),sourceScope:`${payload.sourceScope}/part-${index+1}`,sourceIds:[question.sourceId],questions:[question],blocks:[payload.blocks[index]]}))});
  const started=await f.start();await f.jobs.awaitIdle();const job=f.jobs.view(started.jobId),stored=f.store.read().materialJobs[started.jobId];
  assert.equal(job.state,'completed');assert.equal(f.calls(),2);
  assert.deepEqual(job.chunks.map(chunk=>chunk.state),['superseded','completed','completed']);
  assert.ok(stored.requests.every(request=>request.finishReason!=='length'));
});

test('one refused block is marked and skipped; Continue re-sends only that block',async t=>{
  let refuseSecond=true;
  const f=await fixture(t,{groups:3,fetchImpl:async(n,_url,options)=>{const payload=JSON.parse(JSON.parse(options.body).messages.find(m=>m.role==='user').content);if(refuseSecond&&payload.sourceIds[0]==='group-2')return refusal();return echo(options);}});
  const started=await f.start();await f.jobs.awaitIdle();let job=f.jobs.view(started.jobId);
  assert.equal(job.state,'failed');assert.equal(job.lastError.code,'blocks_unfinished');assert.equal(f.calls(),3);
  assert.deepEqual(job.chunks.map(chunk=>[chunk.state,chunk.lastError?.code??null]),[['completed',null],['failed','model_refusal'],['completed',null]]);
  refuseSecond=false;
  await f.jobs.continue({jobId:started.jobId,expectedEpoch:f.store.captureEpoch(),expectedBinding:f.models.binding(),consent:true});await f.jobs.awaitIdle();job=f.jobs.view(started.jobId);
  assert.equal(job.state,'completed');assert.equal(f.calls(),4);assert.equal(job.completedBlocks,3);
});

test('three sent blocks failing in a row stop the job instead of spending on every block',async t=>{
  const f=await fixture(t,{groups:6,fetchImpl:async()=>refusal()});
  const started=await f.start();await f.jobs.awaitIdle();const job=f.jobs.view(started.jobId);
  assert.equal(f.calls(),3);assert.equal(job.state,'failed');assert.equal(job.lastError.code,'repeated_block_failures');
  assert.equal(job.chunks.filter(chunk=>chunk.state==='pending').length,3);
});
