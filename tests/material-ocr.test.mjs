import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createStore} from '../src/store.mjs';
import {createMaterialInbox} from '../src/materials.mjs';
import {createCandidateRepository,materialSourceRevision} from '../src/material-candidates.mjs';
import {createMaterialOcr,OCR_HUMAN_REVIEW_FIELDS} from '../src/material-ocr.mjs';
import {OCR_LIMITS,hash} from '../src/ocr-policy.mjs';
import {authoredScanPng} from './helpers/ocr-fixture.mjs';

const review=()=>Object.fromEntries(OCR_HUMAN_REVIEW_FIELDS.map(key=>[key,true]));
const proposal=()=>({title:'Authored notice',instructions:'Read the notice and choose one answer.',passage:'The red door is NOT open. The blue door is open.',prompt:'Which door is NOT open?',options:[{id:'A',text:'The red door.'},{id:'B',text:'The blue door.'}],sourceQuestionNumber:null,originalOrdinalInTask:null});

async function fixture(t,{paged=false,prepareHook=null}={}){
  const root=path.resolve('test-results/material-ocr-unit');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'run-'));
  const store=await createStore({dataDir:dir}),inbox=createMaterialInbox({store}),real=createCandidateRepository({store}),readRefs=[];
  const repository={...real,readArtifact:async ref=>{readRefs.push(ref);return real.readArtifact(ref);},prepareCandidates:async input=>{const result=await real.prepareCandidates(input);if(prepareHook)await prepareHook({store,repository:real,input});return result;}};
  const image=authoredScanPng(),imageRef=hash(image.bytes),material=await inbox.receive({files:[{name:'self-authored.png',data:image.bytes.toString('base64')}]}),sourceRevision=materialSourceRevision(material),expectedEpoch=store.captureEpoch();
  const artifactDir=path.join(dir,'processing-artifacts');await fs.mkdir(artifactDir,{recursive:true});await fs.writeFile(path.join(artifactDir,imageRef),image.bytes);
  const evidence={version:1,kind:'ocr-evidence',state:'needs_review',text:'Raw OCR may contain an answer: author view only.',words:[],confidence:null,source:{assetId:imageRef,sourceRevision,page:1,region:{x:0,y:0,width:1,height:1},imageRef,width:1200,height:1000},engine:{backend:'authored-protocol-fixture'},issues:[],answerVerified:false};
  const evidenceRef=await real.writeArtifact(evidence),result={state:'completed',artifactRefs:[{ref:imageRef,kind:'page-image',page:1,size:image.bytes.length},{ref:evidenceRef,kind:'ocr-evidence',page:1}],evidence:[{ref:evidenceRef,page:1,state:'needs_review',imageRef}],issues:[],actualDevice:'cpu'};
  const wrapperRef=paged?await real.writeArtifact({kind:'tool-result',toolId:'document.ocr',parentAssetIds:[imageRef],...result}):null;
  const checkpointRef=await real.writeArtifact({kind:'local-tool-checkpoint',toolId:'document.ocr',result:paged?{state:'completed',paged:true,artifactRefs:[wrapperRef]}:result,candidateCount:0,pendingCount:0});
  // This local-tool checkpoint made no model request, but still belongs to one
  // durable grant with an immutable identity and its original finite limits.
  const job={jobId:'owned-job',jobKey:hash(Buffer.from(`authored-ocr-grant:${material.id}:${sourceRevision}`)),materialId:material.id,workspaceEpoch:expectedEpoch,sourceRevision,generation:1,state:'completed',scope:{assetIds:[imageRef]},chunks:[{chunkId:'owned-chunk',state:'completed',checkpointRef}],requests:[],budget:{limits:{maxRequests:20,maxInputPerRequest:24000,maxInputTokens:240000,maxOutputTokens:60000,maxFormatRepairs:1,maxToolTextBytes:16384,maxDurationMs:900000,maxRetriesPerChunk:2},elapsedMs:0}};
  const empty=await real.prepareCandidates({materialId:material.id,sourceRevision,candidates:[],artifactIndex:{},expectedSetRevision:0});
  await store.transact(state=>{state.materialJobs={};state.materialJobs[job.jobId]=job;real.commitPrepared(state,empty,{expectedEpoch});});
  const authority=Object.freeze({authenticatedHuman:Symbol('server-private-human')});let enabled=true;
  const service={assetDir:path.join(dir,'optional','ocr'),artifactDir,status:async()=>({enabled})};
  const getJobs=()=>({list:({materialId})=>Object.values(store.read().materialJobs||{}).filter(j=>j.materialId===materialId)});
  const bridge=createMaterialOcr({store,repository,getJobs,ocrService:service,authorizeHuman:context=>context===authority});
  t.after(async()=>{await bridge.quiesce();await store.close();assert.ok(dir.startsWith(root+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  const base={materialId:material.id,expectedEpoch,sourceRevision,expectedSetRevision:1};
  return {dir,store,inbox,repository:real,bridge,authority,material,image,evidence,evidenceRef,imageRef,result,checkpointRef,job,base,readRefs,service,getJobs,setEnabled:value=>{enabled=value;}};
}

for(const paged of [false,true])test(`OCR summary and human reveal require the material's successful ${paged?'paged':'inline'} checkpoint`,async t=>{
  const f=await fixture(t,{paged});f.readRefs.length=0;
  const summary=await f.bridge.summary({materialId:f.material.id});assert.equal(summary.entries.length,1);assert.equal(summary.entries[0].evidenceRef,f.evidenceRef);
  assert.equal(JSON.stringify(summary).includes('Raw OCR'),false);assert.equal(f.readRefs.includes(f.evidenceRef),false,'default summary must not even read raw OCR JSON');
  const request={...f.base,evidenceRef:f.evidenceRef,author:true};
  await assert.rejects(f.bridge.openAuthor({...request,author:false},f.authority),e=>e.code==='OCR_AUTHOR_CONFIRMATION');
  await assert.rejects(f.bridge.openAuthor(request,{authenticatedHuman:'model-forged'}),e=>e.code==='OCR_HUMAN_REQUIRED');
  await assert.rejects(f.bridge.openAuthor({...request,evidenceRef:'f'.repeat(64)},f.authority),e=>e.code==='OCR_EVIDENCE_UNOWNED');
  const opened=await f.bridge.openAuthor(request,f.authority);assert.equal(opened.evidence.text,f.evidence.text);assert.ok(opened.reviewToken);
  assert.deepEqual((await f.bridge.readImage({materialId:f.material.id,reviewToken:opened.reviewToken},f.authority)).bytes,f.image.bytes);
  await f.bridge.closeAuthor({materialId:f.material.id,reviewToken:opened.reviewToken},f.authority);
  await assert.rejects(f.bridge.readImage({materialId:f.material.id,reviewToken:opened.reviewToken},f.authority),e=>e.code==='OCR_REVIEW_EXPIRED');
});

test('another material hash, stale source, failed job and changed successful checkpoint cannot authorize raw evidence',async t=>{
  const f=await fixture(t),other=await f.inbox.receive({files:[{name:'other-source.png',data:f.image.bytes.toString('base64')}]}),otherRevision=materialSourceRevision(other);
  const otherEvidenceRef=await f.repository.writeArtifact({...f.evidence,source:{...f.evidence.source,sourceRevision:otherRevision}});
  const poisoned={...f.result,evidence:[{...f.result.evidence[0],ref:otherEvidenceRef}],artifactRefs:f.result.artifactRefs.map(r=>r.kind==='ocr-evidence'?{...r,ref:otherEvidenceRef}:r)};
  const changedCheckpoint=await f.repository.writeArtifact({kind:'local-tool-checkpoint',toolId:'document.ocr',result:poisoned});
  await f.store.transact(state=>{state.materialJobs[f.job.jobId].chunks[0].checkpointRef=changedCheckpoint;});
  await assert.rejects(f.bridge.openAuthor({...f.base,evidenceRef:otherEvidenceRef,author:true},f.authority),e=>e.code==='OCR_EVIDENCE_UNOWNED');
  await f.store.transact(state=>{state.materialJobs[f.job.jobId].chunks[0].checkpointRef=f.checkpointRef;});
  const opened=await f.bridge.openAuthor({...f.base,evidenceRef:f.evidenceRef,author:true},f.authority);
  await f.store.transact(state=>{state.materialJobs[f.job.jobId].state='failed';});
  assert.equal((await f.bridge.summary({materialId:f.material.id})).entries.length,0);
  await assert.rejects(f.bridge.readImage({materialId:f.material.id,reviewToken:opened.reviewToken},f.authority),e=>e.code==='OCR_EVIDENCE_UNOWNED');
  await f.store.transact(state=>{state.materialJobs[f.job.jobId].state='completed';state.materials.find(m=>m.id===f.material.id).text='source changed';});
  await assert.rejects(f.bridge.openAuthor({...f.base,evidenceRef:f.evidenceRef,author:true},f.authority),e=>e.code==='OCR_STALE_SOURCE');
});

test('authenticated six-part human review commits a real candidate with null answer and unknown original ordinals',async t=>{
  const f=await fixture(t),opened=await f.bridge.openAuthor({...f.base,evidenceRef:f.evidenceRef,author:true},f.authority);
  const request={...f.base,reviewToken:opened.reviewToken,author:true,proposal:proposal(),review:review()};
  for(const field of OCR_HUMAN_REVIEW_FIELDS)await assert.rejects(f.bridge.review({...request,review:{...request.review,[field]:false}},f.authority),e=>e.code==='OCR_REVIEW_INCOMPLETE');
  await assert.rejects(f.bridge.review(request,{authenticatedHuman:'model-forged'}),e=>e.code==='OCR_HUMAN_REQUIRED');
  await assert.rejects(f.bridge.review({...request,proposal:{...request.proposal,answer:'A'}},f.authority),e=>e.code==='OCR_CANDIDATE_INCOMPLETE');
  const result=await f.bridge.review(request,f.authority),loaded=await f.repository.load(f.material.id),candidate=loaded.candidates[0];
  assert.equal(result.canCompile,true);assert.equal(result.expectedSetRevision,2);assert.equal(candidate.fields.answer,null);assert.equal(candidate.originalOrdinalInTask,null);assert.equal(candidate.sourceQuestionNumber,null);
  assert.deepEqual(candidate.readiness,{canDisplay:true,canAnswer:true,canScore:false,canSimulateOriginal:false});
  const source=Object.values(loaded.artifactIndex).find(e=>e.kind==='document');assert.deepEqual(source.value.review,review());assert.equal(source.value.documentLayout.blocks[0].text,f.evidence.text);
  await assert.rejects(f.bridge.review(request,f.authority),e=>['OCR_REVIEW_EXPIRED','OCR_REVIEW_CONFLICT'].includes(e.code));assert.equal((await f.repository.load(f.material.id)).candidates.length,1);
});

test('a candidate-set change during review preparation is rejected inside the final transaction',async t=>{
  let changed=false;
  const f=await fixture(t,{prepareHook:async({store,repository,input})=>{
    if(changed||!input.candidates.length)return;changed=true;
    const current=await repository.load(input.materialId),prepared=await repository.prepareCandidates({materialId:input.materialId,sourceRevision:input.sourceRevision,candidates:current.candidates,artifactIndex:current.artifactIndex,expectedSetRevision:current.revision});
    await store.transact(state=>repository.commitPrepared(state,prepared,{expectedEpoch:store.captureEpoch()}));
  }});
  const opened=await f.bridge.openAuthor({...f.base,evidenceRef:f.evidenceRef,author:true},f.authority);
  await assert.rejects(f.bridge.review({...f.base,reviewToken:opened.reviewToken,author:true,proposal:proposal(),review:review()},f.authority),e=>e.code==='OCR_REVIEW_CONFLICT');
  const loaded=await f.repository.load(f.material.id);assert.equal(loaded.revision,2);assert.equal(loaded.candidates.length,0,'concurrent candidate state is preserved');
});

for(const change of ['source','epoch','checkpoint'])test(`a ${change} change during review preparation cannot commit an old author decision`,async t=>{
  let changed=false;
  const f=await fixture(t,{prepareHook:async({store,input})=>{
    if(changed||!input.candidates.length)return;changed=true;
    await store.transact(state=>{
      if(change==='source')state.materials.find(m=>m.id===input.materialId).text='changed after author preparation';
      else if(change==='epoch')state.workspaceEpoch='99999999-9999-4999-8999-999999999999';
      else state.materialJobs['owned-job'].generation++;
    });
  }});
  const opened=await f.bridge.openAuthor({...f.base,evidenceRef:f.evidenceRef,author:true},f.authority);
  await assert.rejects(f.bridge.review({...f.base,reviewToken:opened.reviewToken,author:true,proposal:proposal(),review:review()},f.authority),e=>change==='source'?e.code==='OCR_STALE_SOURCE':change==='checkpoint'?e.code==='OCR_EVIDENCE_UNOWNED':e.status===409);
  assert.equal(f.store.read().candidateSets[f.material.id].revision,1);assert.equal(f.store.read().candidateSets[f.material.id].candidates.length,0);
});

test('quiesce invalidates already authorized image and review tokens before reset',async t=>{
  const f=await fixture(t),opened=await f.bridge.openAuthor({...f.base,evidenceRef:f.evidenceRef,author:true},f.authority);
  await f.bridge.quiesce();f.bridge.reset();
  await assert.rejects(f.bridge.readImage({materialId:f.material.id,reviewToken:opened.reviewToken},f.authority),e=>e.code==='OCR_REVIEW_EXPIRED');
  await assert.rejects(f.bridge.review({...f.base,reviewToken:opened.reviewToken,author:true,proposal:proposal(),review:review()},f.authority),e=>e.code==='OCR_REVIEW_EXPIRED');
});

test('adapter caps fixed budgets, respects disabled state and quiesce awaits actual worker settlement before reset',async t=>{
  const f=await fixture(t);let captured,release,started;const began=new Promise(resolve=>{started=resolve;});
  const bridge=createMaterialOcr({store:f.store,repository:f.repository,getJobs:f.getJobs,ocrService:f.service,authorizeHuman:context=>context===f.authority,workerFactory:options=>({runMaterialTool:async request=>{captured={options,request};await options.checkGuard(request);started();await new Promise(resolve=>{release=resolve;});return {state:'completed'};}})});
  t.after(()=>bridge.quiesce());
  const request={jobId:f.job.jobId,expectedEpoch:f.base.expectedEpoch,sourceRevision:f.base.sourceRevision,toolId:'document.ocr',inputAssetIds:[f.imageRef],parameters:{language:'eng',pages:[{page:1}]},budget:{timeoutMs:900000,maxPages:4,maxPixels:40000000,maxOutputBytes:32*1024*1024,maxMemoryBytes:8*1024**3}};
  const args={request,resolveAsset:async()=>({}),checkGuard:async()=>{}};
  f.setEnabled(false);await assert.rejects(bridge.adapter(args),e=>e.code==='OCR_DISABLED');assert.equal(captured,undefined);f.setEnabled(true);
  const running=bridge.adapter(args),rejected=assert.rejects(running,e=>e.code==='OCR_CANCELLED');await began;
  assert.equal(captured.request.budget.timeoutMs,OCR_LIMITS.timeoutMs);assert.equal(captured.request.budget.maxMemoryBytes,OCR_LIMITS.maxMemoryBytes);assert.equal(captured.options.assetDir,f.service.assetDir);assert.equal(captured.options.artifactDir,f.service.artifactDir);
  const stopping=bridge.quiesce();assert.equal(captured.request.cancelToken.aborted,true);assert.equal(bridge.busy(),true);assert.throws(()=>bridge.reset(),e=>e.code==='OCR_BUSY');
  release();await rejected;await stopping;assert.equal(bridge.busy(),false);bridge.reset();
});
