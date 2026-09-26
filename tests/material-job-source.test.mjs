import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createStore} from '../src/store.mjs';
import {createMaterialInbox} from '../src/materials.mjs';
import {createMaterialProcessing} from '../src/material-processing.mjs';
import {createCandidateRepository,materialSourceRevision} from '../src/material-candidates.mjs';
import {createMaterialJobSource} from '../src/material-job-source.mjs';
import {createModels} from '../src/models.mjs';
import {createMaterialJobs,validateMaterialJobs} from '../src/material-jobs.mjs';
import {inspectProcessingSnapshot,readProcessingBytes,createMaterialJobSnapshotInspector} from '../src/processing-backup.mjs';
import {authoredOcrPdf} from './helpers/ocr-fixture.mjs';

const root=path.resolve('test-results/material-job-source');
const pack={schemaVersion:1,title:'Self-authored job source',version:'1.0.0',groups:[1,2].map(i=>({id:`g${i}`,section:'reading',taskKind:'read_daily',title:`Task ${i}`,passage:`The gate for task ${i} opens at nine. The whole shared passage remains intact.`,questions:[{id:`q${i}`,type:'single_choice',prompt:`When does gate ${i} open?`,options:[{id:'A',text:'At nine.'},{id:'B',text:'At ten.'}],answer:'A',explanation:'',source:`Question ${i}`}]}))};
async function fixture(t,sourcePack=pack){await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'run-'));t.after(async()=>{assert.ok(path.resolve(dataDir).startsWith(root+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});const store=await createStore({dataDir});t.after(()=>store.close());const inbox=createMaterialInbox({store}),repository=createCandidateRepository({store});const material=await inbox.receive({title:'Source',files:[{name:'practice-pack.json',data:Buffer.from(JSON.stringify(sourcePack)).toString('base64')}]});const processing=createMaterialProcessing({inbox,models:{},registerDraft:()=>{},candidateRepository:repository,getWorkspaceEpoch:()=>store.captureEpoch()});return {dataDir,store,inbox,repository,material,source:createMaterialJobSource({store,inbox,repository,materialProcessing:processing})};}
function proposals(payload){return {proposals:payload.questions.map(q=>{const scoped=payload.blocks.filter(block=>q.sourceBlockIds.includes(block.id)),named=part=>scoped.find(block=>block.label.endsWith(`:${part}`)),prompt=named('prompt'),answer=named('answer'),a=named('option:0'),b=named('option:1');return {sourceId:q.sourceId,taskKind:q.taskKind,answerType:q.answerType,fields:{prompt:prompt.text,options:[{id:'A',text:a.text},{id:'B',text:b.text}],answer:answer.text,explanation:null,transcript:null},evidence:[['prompt',prompt],['options',a],['options',b],['answer',answer]].map(([field,block])=>({field,blockId:block.id,quote:block.text}))};})};}

test('actual native material indexing produces complete per-group chunks and atomic repository checkpoints',async t=>{
  const f=await fixture(t),epoch=f.store.captureEpoch(),plan=await f.source.sourceProvider({materialId:f.material.id,expectedEpoch:epoch});assert.equal(plan.chunks.length,2);assert.equal(plan.chunks[0].sharedText,pack.groups[0].passage);assert.equal(plan.chunks[1].sharedText,pack.groups[1].passage);
  const before=f.inbox.get(f.material.id),payload=plan.chunks[0],request=await f.source.prepareChunk({payload});assert.ok(request.messages[1].content.includes(pack.groups[0].passage));assert.equal(request.messages[1].content.includes(pack.groups[1].passage),false);
  const result=await f.source.applyChunk({job:{materialId:f.material.id,sourceRevision:plan.sourceRevision},payload,output:proposals(payload),expectedSetRevision:0});assert.equal(f.store.read().candidateSets[f.material.id],undefined);
  await f.store.transact(state=>f.repository.commitPrepared(state,result.prepared,{expectedEpoch:epoch}));const loaded=await f.repository.load(f.material.id);assert.equal(loaded.candidates.length,1);assert.equal(loaded.candidates[0].readiness.canScore,false);assert.equal(loaded.candidates[0].fields.answer,'A');assert.equal(loaded.candidates[0].fieldEvidence.find(e=>e.path==='answer').method,'model-proposal');assert.deepEqual(f.inbox.get(f.material.id).files,before.files);assert.equal(materialSourceRevision(f.inbox.get(f.material.id)),plan.sourceRevision);
  const next=await f.source.applyChunk({job:{materialId:f.material.id,sourceRevision:plan.sourceRevision},payload:plan.chunks[1],output:proposals(plan.chunks[1]),expectedSetRevision:1});await f.store.transact(state=>f.repository.commitPrepared(state,next.prepared,{expectedEpoch:epoch}));assert.equal((await f.repository.load(f.material.id)).candidates.length,2);
});

test('OCR source preparation binds bounded page selections without inventing document dimensions',async t=>{
  const f=await fixture(t),pdf=await f.inbox.receive({files:[{name:'authored-scan.pdf',data:authoredOcrPdf('scan').toString('base64')}]}),expectedEpoch=f.store.captureEpoch();
  const localTool={toolId:'document.ocr',inputAssetIds:[pdf.files[0].id],parameters:{language:'eng',pages:[{page:1,region:{x:0,y:0,width:1,height:1}}]}};
  const plan=await f.source.sourceProvider({materialId:pdf.id,expectedEpoch,localTool});
  assert.deepEqual(plan.scope.regions[pdf.files[0].id],{pageLimit:1,rangeBasis:'explicit_page_selection_worker_dimensions'});assert.deepEqual(plan.chunks[0].localTool.parameters,localTool.parameters);assert.equal(plan.chunks[0].localTool.budget.maxPixels,4000000);assert.equal(plan.chunks[0].localTool.budget.maxMemoryBytes,768*1024*1024);
  const bad=structuredClone(localTool);bad.parameters.pages[0].page=201;await assert.rejects(f.source.sourceProvider({materialId:pdf.id,expectedEpoch,localTool:bad}));
  await assert.rejects(f.source.sourceProvider({materialId:pdf.id,expectedEpoch,localTool:{...localTool,parameters:{...localTool.parameters,path:'C:/private'}}}));
  assert.equal(f.store.read().candidateSets[pdf.id],undefined,'preparation never manufactures OCR candidates');
});

test('a cancelled job source inspection stops before loading original files',async t=>{
  const f=await fixture(t),original=f.inbox.loadFiles;let loads=0;f.inbox.loadFiles=async(...args)=>{loads++;return original(...args);};
  await assert.rejects(f.source.sourceProvider({materialId:f.material.id,expectedEpoch:f.store.captureEpoch(),signal:AbortSignal.abort()}),error=>error.name==='AbortError');
  assert.equal(loads,0);assert.equal(f.store.read().candidateSets[f.material.id],undefined);
});

test('model-invented fields/identities and cross-block citations never become candidates',async t=>{
  const f=await fixture(t),plan=await f.source.sourceProvider({materialId:f.material.id,expectedEpoch:f.store.captureEpoch()}),payload=plan.chunks[0],job={materialId:f.material.id,sourceRevision:plan.sourceRevision};
  const invented=proposals(payload);invented.proposals[0].fields.prompt='A fabricated question';await assert.rejects(f.source.applyChunk({job,payload,output:invented,expectedSetRevision:0}),/来源|原文/);
  const identity=proposals(payload);identity.proposals[0].candidateId='model-owned-id';await assert.rejects(f.source.applyChunk({job,payload,output:identity,expectedSetRevision:0}),/schema/);
  const cross=proposals(payload);cross.proposals[0].evidence[0].blockId=plan.chunks[1].blocks[0].id;await assert.rejects(f.source.applyChunk({job,payload,output:cross,expectedSetRevision:0}));assert.equal(f.store.read().candidateSets[f.material.id],undefined);
});

test('unconfirmed question boundaries cannot become smaller model chunks',async t=>{
  const f=await fixture(t);
  const payload={sourceScope:'unconfirmed-group',sourceIds:['unconfirmed-1','unconfirmed-2'],questions:[{sourceId:'unconfirmed-1',sourceBlockIds:[]},{sourceId:'unconfirmed-2',sourceBlockIds:[]}],blocks:[{id:'paragraph',text:'Two numbers do not prove two complete question boundaries.'}],sharedBlockIds:['paragraph'],sharedText:'',dependencyRefs:[],boundaryState:'explicit_group_unconfirmed_questions'};
  assert.equal(await f.source.splitChunk({payload}),null);
});

test('omitting a source question cannot silently complete its chunk without a pending candidate',async t=>{
  const f=await fixture(t),plan=await f.source.sourceProvider({materialId:f.material.id,expectedEpoch:f.store.captureEpoch()}),payload=plan.chunks[0];
  await assert.rejects(f.source.applyChunk({job:{materialId:f.material.id,sourceRevision:plan.sourceRevision},payload,output:{proposals:[]},expectedSetRevision:0}),/schema/);
  assert.equal(f.store.read().candidateSets[f.material.id],undefined);
});

test('real source splitting saves only leaf candidates and all job evidence has a resolvable CAS closure',async t=>{
  const sourcePack={...pack,groups:[{...pack.groups[0],questions:Array.from({length:4},(_,index)=>({...pack.groups[0].questions[0],id:`q${index+1}`,prompt:`When does numbered gate ${index+1} open?`}))}]};
  const f=await fixture(t,sourcePack),wires=[];let calls=0;
  const models=createModels({dataDir:f.dataDir,fetchImpl:async(_url,options)=>{
    calls++;wires.push(options.body);
    if(calls===1)return new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"proposals":['}}],usage:{prompt_tokens:300,completion_tokens:700}}));
    const job=Object.values(f.store.read().materialJobs)[0],chunk=job.chunks.find(chunk=>chunk.state==='running'),payload=await f.repository.readArtifact(chunk.scopeRef);
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(proposals(payload))}}],usage:{prompt_tokens:300,completion_tokens:300}}));
  }});
  await models.updateSettings({provider:'compatible',baseUrl:'https://self-authored.invalid/v1',model:'protocol-double',structuredOutput:'json_object',maxOutputTokens:700});
  const jobs=createMaterialJobs({store:f.store,models,repository:f.repository,...f.source});t.after(()=>jobs.stop());
  const expectedEpoch=f.store.captureEpoch(),expectedBinding=models.binding(),preview=await jobs.prepare({materialId:f.material.id,expectedEpoch,expectedBinding});
  const started=await jobs.start({...preview,expectedEpoch,expectedBinding,consent:true});await jobs.awaitIdle();
  const job=f.store.read().materialJobs[started.jobId],loaded=await f.repository.load(f.material.id);
  assert.equal(calls,3);assert.equal(job.state,'completed');assert.equal(job.chunks[0].state,'superseded');assert.equal(job.chunks[0].checkpointRef,null);
  assert.equal(job.chunks.filter(chunk=>chunk.state==='completed').length,2);assert.equal(loaded.candidates.length,4);assert.equal(new Set(loaded.candidates.map(candidate=>candidate.sourceQuestionId)).size,4);
  assert.ok(wires.every(wire=>wire.includes(sourcePack.groups[0].passage)));assert.equal(job.budget.requestCount,3);
  const closure=await inspectProcessingSnapshot(f.store.read(),{readBytes:ref=>readProcessingBytes(f.dataDir,ref),inspectJobs:createMaterialJobSnapshotInspector({validateJobs:validateMaterialJobs})}),seen=new Set(closure.files.keys());
  for(const chunk of job.chunks){const payload=await f.repository.readArtifact(chunk.scopeRef);for(const ref of [payload.sourceRef,payload.groupRef,payload.artifactIndexRef,...chunk.dependencyRefs])assert.ok(seen.has(ref),`missing job closure reference ${ref}`);}
  assert.ok(seen.has(job.requests[0].diagnosticRef));
});
