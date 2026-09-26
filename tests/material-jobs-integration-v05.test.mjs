import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createStore} from '../src/store.mjs';
import {createModels} from '../src/models.mjs';
import {createMaterialInbox,modelBindingValue} from '../src/materials.mjs';
import {createMaterialProcessing} from '../src/material-processing.mjs';
import {createCandidateRepository} from '../src/material-candidates.mjs';
import {createMaterialCompiler} from '../src/material-compiler.mjs';
import {createMaterialJobSource} from '../src/material-job-source.mjs';
import {createMaterialJobs} from '../src/material-jobs.mjs';
import {validateAsrRequest} from '../src/workers/asr.mjs';
import {startServer} from '../src/server.mjs';

const root=path.resolve('test-results/material-jobs-integration-v05');
const encode=(name,value)=>({name,data:Buffer.from(value).toString('base64')});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const settings={provider:'compatible',baseUrl:'https://self-authored-old.invalid/v1',model:'self-authored-model',structuredOutput:'json_schema',maxOutputTokens:700};
const remote=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:200,completion_tokens:100}}));
const native=()=>({schemaVersion:1,id:'self-authored-source',version:'1',title:'Original gate notices',groups:[{id:'gate-notices',section:'reading',taskKind:'read_daily',title:'Two separate gates',passage:'Gate 1 opens at nine. Gate 2 opens at ten.',transcript:'The gate opens at nine.',questions:[1,2].map(i=>({id:`q${i}`,type:'single_choice',prompt:`When does gate ${i} open?`,options:[{id:'A',text:i===1?'At nine.':'At ten.'},{id:'B',text:'At eleven.'}],answer:'A',explanation:'',transcript:'The gate opens at nine.',source:`Original question ${i}`}))}]});
function audio(mark=0){const bytes=Buffer.alloc(32044);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(32000,40);bytes.writeInt16LE(mark,44);return bytes;}
async function dataDirectory(t){await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'run-'));t.after(async()=>{const target=path.resolve(dataDir);assert.ok(target.startsWith(root+path.sep));await fs.rm(target,{recursive:true,force:true});});return dataDir;}
async function fixture(t,{pack=native(),extraFiles=[],fetchImpl=async()=>{throw new Error('Unexpected model request in local fixture');}}={}){
  const dataDir=await dataDirectory(t),store=await createStore({dataDir}),models=createModels({dataDir,fetchImpl});await models.updateSettings(settings);
  const inbox=createMaterialInbox({store}),repository=createCandidateRepository({store}),material=await inbox.receive({files:[encode('practice-pack.json',JSON.stringify(pack)),...extraFiles]});
  const processing=createMaterialProcessing({inbox,models,registerDraft:()=>{},candidateRepository:repository,getWorkspaceEpoch:()=>store.captureEpoch()});
  const f={dataDir,store,models,inbox,repository,material,processing,pack,source:createMaterialJobSource({store,inbox,repository,materialProcessing:processing}),compiler:createMaterialCompiler({store,repository})};
  t.after(async()=>{await f.jobs?.stop();await processing.stop();models.cancelRequests();await store.close();});return f;
}
function proposals(payload){return {proposals:payload.questions.map(question=>{const own=payload.blocks.filter(block=>question.sourceBlockIds.includes(block.id)),pick=part=>own.find(block=>block.label.endsWith(`:${part}`)),prompt=pick('prompt'),a=pick('option:0'),b=pick('option:1');return {sourceId:question.sourceId,taskKind:question.taskKind,answerType:question.answerType,fields:{prompt:prompt.text,options:[{id:'A',text:a.text},{id:'B',text:b.text}],answer:null,explanation:null,transcript:null},evidence:[['prompt',prompt],['options',a],['options',b]].map(([field,block])=>({field,blockId:block.id,quote:block.text}))};})};}
async function planFor(f,localTool){return f.source.sourceProvider({materialId:f.material.id,expectedEpoch:f.store.captureEpoch(),...(localTool?{localTool}:{})});}
async function publish(f,plan,output){const applied=await f.source.applyChunk({job:{materialId:f.material.id,sourceRevision:plan.sourceRevision},payload:plan.chunks[0],output,expectedSetRevision:0});await f.store.transact(state=>f.repository.commitPrepared(state,applied.prepared,{expectedEpoch:f.store.captureEpoch()}));return f.repository.load(f.material.id);}
async function compile(f,loaded){return f.compiler.compilePracticeSubset({materialId:f.material.id,sourceRevision:loaded.sourceRevision,candidateRevisions:Object.fromEntries(loaded.candidates.map(candidate=>[candidate.candidateId,candidate.revision])),selectedIds:loaded.candidates.map(candidate=>candidate.candidateId),importOperationId:crypto.randomUUID(),expectedEpoch:f.store.captureEpoch()});}
async function httpFixture(t){
  const dataDir=await dataDirectory(t),sent=[],models=createModels({dataDir,fetchImpl:async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return new Response('',{status:401});}});await models.updateSettings(settings);
  const instance=await startServer({dataDir,models});t.after(()=>instance.close());
  const bootstrap=await fetch(instance.url+'/api/bootstrap',{headers:{'X-PracticeBridge':'1',Origin:instance.url}}).then(response=>response.json()),state=()=>fs.readFile(path.join(dataDir,'state.json'),'utf8').then(JSON.parse),epoch=(await state()).workspaceEpoch;
  const api=async(route,body)=>{const response=await fetch(instance.url+'/api'+route,{method:'POST',headers:{'Content-Type':'application/json','X-PracticeBridge':'1','X-PracticeBridge-Token':bootstrap.bootToken,'X-PracticeBridge-Epoch':epoch},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};return {instance,models,sent,api,epoch,state};
}

test('R1 actual source job checkpoints with null auxiliary fields compile into strict unscored practice',async t=>{
  const pack=native();for(const question of pack.groups[0].questions){delete question.explanation;delete question.transcript;}
  let f;f=await fixture(t,{pack,fetchImpl:async()=>{const job=Object.values(f.store.read().materialJobs)[0],chunk=job.chunks.find(chunk=>chunk.state==='running');return remote(proposals(await f.repository.readArtifact(chunk.scopeRef)));}});
  f.jobs=createMaterialJobs({store:f.store,models:f.models,repository:f.repository,...f.source});const expectedEpoch=f.store.captureEpoch(),expectedBinding=f.models.binding(),preview=await f.jobs.prepare({materialId:f.material.id,expectedEpoch,expectedBinding});
  const started=await f.jobs.start({...preview,expectedEpoch,expectedBinding,consent:true});await f.jobs.awaitIdle();assert.equal(f.jobs.view(started.jobId).state,'completed');
  const loaded=await f.repository.load(f.material.id);assert.ok(loaded.candidates.every(candidate=>candidate.readiness.canAnswer&&!candidate.readiness.canScore));
  assert.ok(loaded.candidates.every(candidate=>candidate.fields.answer===null&&candidate.fieldStates.explanation==='missing'&&candidate.fieldStates.transcript==='missing'));
  const result=await compile(f,loaded),questions=result.normalizedPack.groups[0].questions;assert.equal(result.receipt.added,2);assert.ok(questions.every(question=>question.answer===null&&typeof question.explanation==='string'&&question.transcript===undefined));
  assert.deepEqual(questions.map(question=>[question.id,question.prompt,question.sourcePositionV1.originalOrdinalInTask]),[['q1','When does gate 1 open?',1],['q2','When does gate 2 open?',2]]);
});

test('R2 prepared ASR requests pass the real worker budget validator and reject a 301-second range before dispatch',async t=>{
  const wav=audio(),f=await fixture(t,{extraFiles:[encode('original.wav',wav)]}),localTool={toolId:'media.transcribe',inputAssetIds:[sha(wav)],parameters:{startSeconds:0,endSeconds:30}},plan=await planFor(f,localTool);
  const request={jobId:'self-authored-asr',expectedEpoch:f.store.captureEpoch(),sourceRevision:plan.sourceRevision,...plan.chunks[0].localTool};
  const checked=validateAsrRequest(request);assert.equal(checked.budget.maxOutputBytes,1048576);assert.equal(checked.budget.maxDurationSeconds,30);assert.equal(Object.hasOwn(checked.budget,'maxPixels'),false);
  await assert.rejects(planFor(f,{...localTool,parameters:{startSeconds:0,endSeconds:301}}),error=>error.status===400);
  const edge=await planFor(f,{...localTool,parameters:{startSeconds:200,endSeconds:500}});assert.equal(edge.chunks[0].localTool.parameters.endSeconds,500);assert.equal(edge.chunks[0].localTool.budget.maxDurationSeconds,300);
  for(const [field,limit] of [['timeoutMs',900000],['maxOutputBytes',1048576],['maxInputBytes',100*1024*1024],['maxDurationSeconds',300],['maxMemoryBytes',12*1024**3]]){assert.doesNotThrow(()=>validateAsrRequest({...request,budget:{...request.budget,[field]:limit}}));assert.throws(()=>validateAsrRequest({...request,budget:{...request.budget,[field]:limit+1}}),error=>error.code==='budget_invalid');}
  await planFor(f,{...localTool,parameters:{startSeconds:6900,endSeconds:7200}});await assert.rejects(planFor(f,{...localTool,parameters:{startSeconds:6901,endSeconds:7201}}),error=>error.code==='range_invalid');
});

test('R3 AI import preview rejects missing or stale service approval before a real model factory dispatch',async t=>{
  const f=await httpFixture(t),oldBinding=f.models.binding();await f.models.updateSettings({baseUrl:'https://self-authored-new.invalid/v1',model:'new-model'});
  const body={title:'Selected source only',text:'The gate opens at nine. When does the gate open? A. At nine. B. At ten.',files:[],useAI:true,consent:true};
  const stale=await f.api('/import/preview',{...body,expectedBinding:oldBinding});assert.equal(stale.status,409);assert.equal(f.sent.length,0);
  assert.equal((await f.api('/import/preview',body)).status,428);assert.equal(f.sent.length,0);
  const valid=await f.api('/import/preview',{...body,expectedBinding:f.models.binding()});assert.equal(valid.status,502);assert.equal(f.sent.length,1);assert.equal(f.sent[0].url,'https://self-authored-new.invalid/v1/chat/completions');
});

test('R3 preview retains its original binding through asynchronous preparation until structure dispatch',async t=>{
  const f=await httpFixture(t),expectedBinding=f.models.binding(),structure=f.models.structure;let captured;
  f.models.structure=async input=>{captured=input.expectedBinding;await f.models.updateSettings({apiKey:'replacement-test-only'});return structure(input);};
  const result=await f.api('/import/preview',{title:'Delayed selected source',text:'The gate opens at nine. When does the gate open? A. At nine. B. At ten.',files:[],useAI:true,consent:true,expectedBinding});
  assert.equal(result.status,409);assert.deepEqual(captured,expectedBinding);assert.equal(f.sent.length,0);
});

test('R4 same-group question swaps, cross-field references and reassigned option IDs are rejected',async t=>{
  const f=await fixture(t),plan=await planFor(f),payload=plan.chunks[0],valid=proposals(payload),job={materialId:f.material.id,sourceRevision:plan.sourceRevision};
  const swapped=structuredClone(valid),first=structuredClone(swapped.proposals[0]);swapped.proposals[0].fields=swapped.proposals[1].fields;swapped.proposals[0].evidence=swapped.proposals[1].evidence;swapped.proposals[1].fields=first.fields;swapped.proposals[1].evidence=first.evidence;
  await assert.rejects(f.source.applyChunk({job,payload,output:swapped,expectedSetRevision:0}),/来源|字段|本题/);
  const wrongField=structuredClone(valid);wrongField.proposals[0].fields.transcript=wrongField.proposals[0].fields.prompt;wrongField.proposals[0].evidence.push({...wrongField.proposals[0].evidence[0],field:'transcript'});await assert.rejects(f.source.applyChunk({job,payload,output:wrongField,expectedSetRevision:0}),/来源|字段|本题/);
  const wrongOptions=structuredClone(valid);wrongOptions.proposals[0].fields.options.reverse();await assert.rejects(f.source.applyChunk({job,payload,output:wrongOptions,expectedSetRevision:0}),/选项|来源|字段/);
  assert.equal(f.store.read().candidateSets[f.material.id],undefined);const loaded=await publish(f,plan,valid),result=await compile(f,loaded);assert.deepEqual(result.normalizedPack.groups[0].questions.map(question=>question.prompt),native().groups[0].questions.map(question=>question.prompt));
});

test('R4 complete field coverage rejects a correct-owner quote with a missing NOT clause or shortened option',async t=>{
  const pack=native();pack.groups[0].questions[0].prompt='Choose the gate that opens at nine, NOT at ten.';
  const f=await fixture(t,{pack}),plan=await planFor(f),payload=plan.chunks[0],job={materialId:f.material.id,sourceRevision:plan.sourceRevision};
  for(const shortenQuote of [false,true]){const output=proposals(payload);output.proposals[0].fields.prompt='Choose the gate that opens at nine';if(shortenQuote)output.proposals[0].evidence[0].quote=output.proposals[0].fields.prompt;await assert.rejects(f.source.applyChunk({job,payload,output,expectedSetRevision:0}),/字段|完整|覆盖/);}
  const shortened=proposals(payload);shortened.proposals[0].fields.options[0].text='At';await assert.rejects(f.source.applyChunk({job,payload,output:shortened,expectedSetRevision:0}),/字段|完整|覆盖/);
});

test('R4 repeated wording retains question ownership while complete multiline options and independent answer fields survive',async t=>{
  const pack=native();pack.groups[0].questions[1].prompt=pack.groups[0].questions[0].prompt;pack.groups[0].questions[0].options[0].text='At nine,\n\nin Room 2.';
  const f=await fixture(t,{pack}),plan=await planFor(f),payload=plan.chunks[0],output=proposals(payload),wrong=structuredClone(output);
  wrong.proposals[0].evidence[0].blockId=wrong.proposals[1].evidence[0].blockId;await assert.rejects(f.source.applyChunk({job:{materialId:f.material.id,sourceRevision:plan.sourceRevision},payload,output:wrong,expectedSetRevision:0}),error=>error.code==='FIELD_SOURCE_OWNER_MISMATCH');
  const answer=payload.blocks.find(block=>payload.questions[0].sourceBlockIds.includes(block.id)&&block.label.endsWith(':answer'));output.proposals[0].fields.answer='A';output.proposals[0].evidence.push({field:'answer',blockId:answer.id,quote:answer.text});
  const loaded=await publish(f,plan,output),compiled=await compile(f,loaded);assert.equal(loaded.candidates[0].fields.answer,'A');assert.equal(loaded.candidates[0].readiness.canScore,false);assert.equal(compiled.normalizedPack.groups[0].questions[0].options[0].text,pack.groups[0].questions[0].options[0].text);assert.equal(compiled.normalizedPack.groups[0].questions[0].answer,null);
});

test('R4 an established source candidate keeps locked values and identity when model nulls are no-op proposals',async t=>{
  const f=await fixture(t),before=await f.repository.ingestPack({materialId:f.material.id,pack:f.pack,method:'native-json',expectedEpoch:f.store.captureEpoch()}),plan=await planFor(f),payload=plan.chunks[0];
  const applied=await f.source.applyChunk({job:{materialId:f.material.id,sourceRevision:plan.sourceRevision},payload,output:proposals(payload),expectedSetRevision:before.revision});await f.store.transact(state=>f.repository.commitPrepared(state,applied.prepared,{expectedEpoch:f.store.captureEpoch()}));
  const after=await f.repository.load(f.material.id);assert.deepEqual(after.candidates,before.candidates);
});

test('F1 a first all-null model proposal preserves complete host fields and remains strictly compilable without a verified answer',async t=>{
  const f=await fixture(t),plan=await planFor(f),payload=plan.chunks[0],output=proposals(payload);for(const proposal of output.proposals){proposal.fields={prompt:null,options:null,answer:null,explanation:null,transcript:null};proposal.evidence=[];}
  const loaded=await publish(f,plan,output);assert.deepEqual(loaded.candidates.map(candidate=>candidate.fields.prompt),f.pack.groups[0].questions.map(question=>question.prompt));assert.deepEqual(loaded.candidates[0].fields.options,f.pack.groups[0].questions[0].options);assert.equal(loaded.candidates[0].fields.transcript,f.pack.groups[0].questions[0].transcript);assert.ok(loaded.candidates.every(candidate=>candidate.readiness.canAnswer&&!candidate.readiness.canScore&&candidate.fields.answer===null));
  const compiled=await compile(f,loaded);assert.equal(compiled.receipt.added,2);assert.ok(compiled.normalizedPack.groups[0].questions.every(question=>question.answer===null));
});

test('F2 existing ambiguous or unreadable fields remain unchanged across a null no-op without a new revision',async t=>{
  for(const state of ['ambiguous','unreadable']){
    const f=await fixture(t),first=await f.repository.ingestPack({materialId:f.material.id,pack:f.pack,method:'native-json',expectedEpoch:f.store.captureEpoch()});first.candidates[0].revision++;first.candidates[0].fieldStates.prompt=state;
    const prepared=await f.repository.prepareCandidates({materialId:f.material.id,sourceRevision:first.sourceRevision,candidates:first.candidates,artifactIndex:first.artifactIndex,expectedSetRevision:first.revision});await f.store.transact(snapshot=>f.repository.commitPrepared(snapshot,prepared,{expectedEpoch:f.store.captureEpoch()}));
    const before=await f.repository.load(f.material.id),plan=await planFor(f),payload=plan.chunks[0],output=proposals(payload);for(const proposal of output.proposals){proposal.fields={prompt:null,options:null,answer:null,explanation:null,transcript:null};proposal.evidence=[];}
    const applied=await f.source.applyChunk({job:{materialId:f.material.id,sourceRevision:plan.sourceRevision,workspaceEpoch:f.store.captureEpoch()},payload,output,expectedSetRevision:before.revision});await f.store.transact(snapshot=>f.repository.commitPrepared(snapshot,applied.prepared,{expectedEpoch:f.store.captureEpoch()}));
    const after=await f.repository.load(f.material.id);assert.deepEqual(after.candidates,before.candidates);assert.equal(after.candidates[0].fieldStates.prompt,state);assert.equal(after.candidates[0].revision,2);assert.equal(after.candidates[0].readiness.canAnswer,false);
  }
});

test('R5 explicit unknown v2 original ordinal survives source, candidate and strict compilation despite a display ordinal',async t=>{
  const pack=native();pack.schemaVersion=2;pack.groups[0].questions.forEach((question,index)=>{question.ordinalInTask=index+4;question.sourcePositionV1={sourceTaskId:'preserved-source-task',originalOrdinalInTask:index===0?null:7};});
  const f=await fixture(t,{pack}),plan=await planFor(f);assert.deepEqual(plan.chunks[0].questions.map(question=>question.originalOrdinalInTask),[null,7]);
  const loaded=await publish(f,plan,proposals(plan.chunks[0])),result=await compile(f,loaded);assert.deepEqual(result.normalizedPack.groups[0].questions.map(question=>question.sourcePositionV1.originalOrdinalInTask),[null,7]);
});

test('F4 original v2 task IDs survive real job source, candidate and compiler independently from display group scopes',async t=>{
  const pack=native();pack.schemaVersion=2;pack.groups[0].questions.forEach((question,index)=>{question.ordinalInTask=index+4;question.sourcePositionV1={sourceTaskId:`preserved-original-task-${index+1}`,originalOrdinalInTask:index===0?null:7};});
  const f=await fixture(t,{pack}),plan=await planFor(f),loaded=await publish(f,plan,proposals(plan.chunks[0])),compiled=await compile(f,loaded),expected=pack.groups[0].questions.map(question=>question.sourcePositionV1);
  assert.deepEqual(plan.chunks[0].questions.map(question=>question.sourceTaskId),expected.map(position=>position.sourceTaskId));assert.notEqual(plan.chunks[0].sourceScope,expected[0].sourceTaskId);assert.deepEqual(loaded.candidates.map(candidate=>candidate.sourceTaskId),expected.map(position=>position.sourceTaskId));assert.deepEqual(compiled.normalizedPack.groups[0].questions.map(question=>question.sourcePositionV1),expected);
});

test('R6 ASR mapping checks are bound to actual audio blob, target and pre-comparison candidate revision',async t=>{
  for(const scenario of [{asset:'b.wav',target:'audio',expected:'notChecked'},{asset:'a.wav',target:'audio',expected:'matched'},{asset:'a.wav',target:'groupAudio',expected:'notChecked'},{asset:'a.wav',target:'audio',stale:true,expected:'notChecked'}]){
    const a=audio(0),b=audio(1),pack=native();pack.groups[0].questions=pack.groups[0].questions.slice(0,1);pack.groups[0].questions[0].audio='a.wav';
    const f=await fixture(t,{pack,extraFiles:[encode('a.wav',a),encode('b.wav',b)]}),epoch=f.store.captureEpoch();let loaded=await f.repository.ingestPack({materialId:f.material.id,pack,files:new Map([['a.wav',a],['b.wav',b]]),method:'native-json',expectedEpoch:epoch});
    if(scenario.stale){loaded.candidates[0].revision++;const prepared=await f.repository.prepareCandidates({materialId:f.material.id,sourceRevision:loaded.sourceRevision,candidates:loaded.candidates,artifactIndex:loaded.artifactIndex,expectedSetRevision:loaded.revision});await f.store.transact(state=>f.repository.commitPrepared(state,prepared,{expectedEpoch:epoch}));loaded=await f.repository.load(f.material.id);}
    const candidate=loaded.candidates[0],mappingRef=candidate.mappings[0].assetId,selectedHash=sha(scenario.asset==='a.wav'?a:b),localTool={toolId:'media.transcribe',inputAssetIds:[selectedHash],parameters:{startSeconds:0,endSeconds:1},target:{candidateId:candidate.candidateId,candidateRevision:candidate.revision,targetId:scenario.target}};
    if(scenario.expected==='notChecked'){await assert.rejects(planFor(f,localTool),error=>error.code==='MAPPING_BINDING_MISMATCH');continue;}
    const plan=await planFor(f,localTool),segmentsRef=await f.repository.writeArtifact({state:'completed',transcript:'The gate opens at nine.',segments:[{start:0,end:1,text:'The gate opens at nine.'}],durationSeconds:1,originalAssetId:selectedHash,sourceRevision:plan.sourceRevision,timeRange:localTool.parameters,actual:{engine:'protocol-double-not-real-inference',device:'cpu',modelId:'self-authored-fixture',modelRevision:'fixture-1',computeType:'float32'},issues:[]});
    const applied=await f.source.applyTool({job:{materialId:f.material.id,sourceRevision:loaded.sourceRevision,workspaceEpoch:epoch},payload:plan.chunks[0],result:{state:'completed',artifactRefs:[segmentsRef],issues:[]},expectedSetRevision:loaded.revision});await f.store.transact(state=>f.repository.commitPrepared(state,applied.prepared,{expectedEpoch:epoch}));
    const updated=await f.repository.load(f.material.id),mapping=updated.candidates[0].mappings[0],comparison=Object.values(updated.artifactIndex).find(entry=>entry.kind==='asr-comparison').value;
    assert.equal(mapping.assetId,mappingRef);assert.equal(mapping.contentCheckState,scenario.expected);assert.equal(mapping.candidateRevision,updated.candidates[0].revision);assert.equal(comparison.assetId,selectedHash);assert.equal(comparison.targetId,scenario.target);assert.equal(comparison.candidateRevision,updated.candidates[0].revision);
  }
});

test('R7 legacy assessment persists the full nonsecret production binding and rejects changed credentials afterward',async t=>{
  let calls=0;const f=await fixture(t,{fetchImpl:async()=>{calls++;return remote({status:'processable',summary:'The source has a native structure.',detectedSections:['reading'],missingInformation:[],recommendedProcessor:'native',warnings:[],canCreateDraft:true});}}),binding=f.models.binding();
  const result=await f.processing.assess(f.material.id,{consent:true,expectedBinding:binding});assert.equal(result.material.status,'assessed');assert.deepEqual(f.inbox.get(f.material.id).modelBinding,binding);assert.equal(calls,1);
  await f.models.updateSettings({apiKey:'changed-test-only-key'});await assert.rejects(f.processing.convert(f.material.id,{consent:true,expectedBinding:binding}),error=>error.status===409);await assert.rejects(f.processing.convert(f.material.id,{consent:true,expectedBinding:f.models.binding()}),/重新评估/);assert.equal(calls,1);
  const legacy=Object.fromEntries(['provider','baseUrl','model','timeoutSeconds','maxOutputTokens'].map(key=>[key,binding[key]]));await f.inbox.update(f.material.id,{modelBinding:legacy});assert.deepEqual(f.inbox.get(f.material.id).modelBinding,legacy);
});

test('R7 exported persistence projection accepts legacy history but rejects partial authority and secrets',async t=>{
  const f=await fixture(t),binding=f.models.binding(),legacy=Object.fromEntries(['provider','baseUrl','model','timeoutSeconds','maxOutputTokens'].map(key=>[key,binding[key]]));
  assert.deepEqual(modelBindingValue(binding),binding);assert.deepEqual(modelBindingValue(legacy),legacy);assert.equal(modelBindingValue(null),null);
  for(const patch of [{apiKey:'not-a-real-key'},{credentialHash:'a'.repeat(64)},{bindingRevision:'unverified-slot'},{credentialVersion:null},{structuredOutputMode:'auto'},{baseUrl:'https://user:password@example.invalid/v1'},{baseUrl:'https://example.invalid/v1?key=not-real'},{maxOutputTokens:200001}])assert.throws(()=>modelBindingValue({...binding,...patch}));
  const partial={...binding};delete partial.credentialVersion;assert.throws(()=>modelBindingValue(partial));
  assert.deepEqual(modelBindingValue({...legacy,timeoutSeconds:null,maxOutputTokens:null}),{...legacy,timeoutSeconds:null,maxOutputTokens:null});
});

test('R8 HTTP cancel and continue require positive generation and preserve internal host cancellation',async t=>{
  const f=await httpFixture(t),received=await f.api('/materials',{files:[encode('practice-pack.json',JSON.stringify(native()))]}),prefix=`/materials/${received.body.material.id}/jobs`,expectedBinding=f.models.binding(),expectedEpoch=f.epoch;
  const prepared=await f.api(prefix+'/prepare',{expectedEpoch,expectedBinding}),started=await f.api(prefix+'/start',{...prepared.body,expectedEpoch,expectedBinding,consent:true});assert.equal(started.status,202);const jobId=started.body.job.jobId;await f.instance.materialJobs.awaitIdle();const first=f.instance.materialJobs.view(jobId);
  for(const operation of ['cancel','continue']){
    const base={expectedEpoch,expectedBinding,consent:true};assert.equal((await f.api(`${prefix}/${jobId}/${operation}`,base)).status,428);
    for(const value of [null,0,-1,1.5,'1'])assert.equal((await f.api(`${prefix}/${jobId}/${operation}`,{...base,expectedGeneration:value})).status,400);
  }
  assert.equal(f.sent.length,1);assert.equal(f.instance.materialJobs.view(jobId).generation,first.generation);
  const cancelled=await f.api(`${prefix}/${jobId}/cancel`,{expectedEpoch,expectedGeneration:first.generation});assert.equal(cancelled.status,200);
  for(const operation of ['cancel','continue'])assert.equal((await f.api(`${prefix}/${jobId}/${operation}`,{expectedEpoch,expectedBinding,consent:true,expectedGeneration:first.generation})).status,409);
  const continued=await f.api(`${prefix}/${jobId}/continue`,{expectedEpoch,expectedBinding,consent:true,expectedGeneration:cancelled.body.job.generation});assert.equal(continued.status,202);await f.instance.materialJobs.awaitIdle();assert.equal(f.sent.length,2);
  await f.instance.materialJobs.cancel({jobId,expectedEpoch});assert.equal(f.instance.materialJobs.view(jobId).state,'cancelled');
});
