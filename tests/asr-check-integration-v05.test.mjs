import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createStore} from '../src/store.mjs';
import {createMaterialInbox} from '../src/materials.mjs';
import {createMaterialProcessing} from '../src/material-processing.mjs';
import {createCandidateRepository} from '../src/material-candidates.mjs';
import {createMaterialJobSource} from '../src/material-job-source.mjs';
import {createMaterialToolRuntime} from '../src/material-tool-runtime.mjs';
import {assessCandidate} from '../src/material-candidates.mjs';
import {effectiveContentCheck} from '../src/asr-checks.mjs';
import {runAsrProcess} from '../src/workers/asr.mjs';

const root=path.resolve('test-results/asr-check-integration-v05'),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const upload=(name,value)=>({name,data:Buffer.from(value).toString('base64')});
const range={startSeconds:0,endSeconds:1},reference='The gate opens at nine.';
function wav(mark){const bytes=Buffer.alloc(32044);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(32000,40);bytes.writeInt16LE(mark,44);return bytes;}
async function fixture(t,{probeMedia}={}){
  await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'run-')),store=await createStore({dataDir}),inbox=createMaterialInbox({store}),repository=createCandidateRepository({store}),a=wav(0),b=wav(1);
  const pack={schemaVersion:1,id:'source',version:'1',title:'Self-authored audio relation',groups:[{id:'group',section:'reading',taskKind:'read_daily',title:'Gate',passage:reference,questions:[{id:'q1',type:'single_choice',prompt:'When does the gate open?',options:[{id:'A',text:'At nine.'},{id:'B',text:'At ten.'}],answer:null,explanation:'',transcript:reference,audio:'a.wav'}]}]},material=await inbox.receive({files:[upload('practice-pack.json',JSON.stringify(pack)),upload('a.wav',a),upload('b.wav',b)]});
  await repository.ingestPack({materialId:material.id,pack,method:'native-json',files:new Map([['a.wav',a],['b.wav',b]]),expectedEpoch:store.captureEpoch(),probeMedia});
  const processing=createMaterialProcessing({inbox,models:{},registerDraft:()=>{}}),source=createMaterialJobSource({store,inbox,repository,materialProcessing:processing}),runtime=await createMaterialToolRuntime({store,inbox,repository,getJobs:()=>({list:()=>[]})});
  t.after(async()=>{await runtime.close();await processing.stop();await store.close();assert.ok(path.resolve(dataDir).startsWith(root+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});
  const f={store,inbox,repository,material,source,runtime,a:sha(a),b:sha(b),load:()=>repository.load(material.id)};
  f.plan=async({assetId=f.a,timeRange=range,target=true}={})=>{const loaded=await f.load(),candidate=loaded.candidates[0];return source.sourceProvider({materialId:material.id,expectedEpoch:store.captureEpoch(),localTool:{toolId:'media.transcribe',inputAssetIds:[assetId],parameters:timeRange,...(target?{target:{candidateId:candidate.candidateId,candidateRevision:candidate.revision,targetId:'audio'}}:{})}});};
  f.apply=async(plan,{metadata={},transcript=reference}={})=>{const loaded=await f.load(),tool=plan.chunks[0].localTool;
    const segments={state:'completed',transcript,segments:[{start:tool.parameters.startSeconds,end:tool.parameters.endSeconds,text:transcript}],durationSeconds:tool.parameters.endSeconds-tool.parameters.startSeconds,originalAssetId:tool.inputAssetIds[0],sourceRevision:plan.sourceRevision,timeRange:tool.parameters,actual:{engine:'protocol-double-not-real-inference',device:'cpu',modelId:'self-authored-fixture',modelRevision:'fixture-1',computeType:'float32'},issues:[],...metadata};
    const ref=await repository.writeArtifact(segments),applied=await source.applyTool({job:{materialId:material.id,sourceRevision:plan.sourceRevision,workspaceEpoch:store.captureEpoch()},payload:plan.chunks[0],result:{state:'completed',artifactRefs:[ref],issues:[]},expectedSetRevision:loaded.revision});await store.transact(state=>repository.commitPrepared(state,applied.prepared,{expectedEpoch:store.captureEpoch()}));return f.load();};
  f.evidence=()=>runtime.evidence(material.id,{author:true});
  f.patch=async(fields,mapping)=>{const loaded=await f.load(),candidate=loaded.candidates[0];return repository.patchCandidate({materialId:material.id,candidateId:candidate.candidateId,expectedRevision:candidate.revision,expectedEpoch:store.captureEpoch(),fields:fields||{},...(mapping?{mapping}:{}),actor:'user'});};return f;
}

test('E prepare rejects comparison of B against mapped A, while independent B transcription remains available',async t=>{
  const f=await fixture(t);await assert.rejects(f.plan({assetId:f.b}),error=>error.code==='MAPPING_BINDING_MISMATCH');
  const loaded=await f.apply(await f.plan({assetId:f.b,target:false}));assert.equal(loaded.candidates[0].mappings[0].contentCheckState,'notChecked');assert.ok(Object.values(loaded.artifactIndex).some(entry=>entry.kind==='asr-segments'&&entry.value.originalAssetId===f.b));
});

test('E commit rejects ASR evidence with a different asset, time range or source revision',async t=>{
  const f=await fixture(t),plan=await f.plan();
  for(const metadata of [{originalAssetId:f.b},{timeRange:{startSeconds:0,endSeconds:0.5}},{sourceRevision:'b'.repeat(64)}])await assert.rejects(f.apply(plan,{metadata}),error=>error.code==='ASR_EVIDENCE_SCOPE_MISMATCH');
  assert.equal((await f.load()).candidates[0].revision,1);
});

test('E old matched evidence becomes historical after reference text changes',async t=>{
  const f=await fixture(t);await f.apply(await f.plan());assert.equal((await f.evidence()).filter(item=>item.state==='matched').length,1);
  await f.patch({transcript:'The gate does not open at nine.'});assert.equal((await f.evidence()).filter(item=>item.state==='matched').length,0);
});

test('E mapping A to B to A cannot reactivate an earlier matched check',async t=>{
  const f=await fixture(t);await f.apply(await f.plan());const loaded=await f.load(),media=name=>Object.entries(loaded.artifactIndex).find(([,entry])=>entry.kind==='media'&&entry.value.name===name)[0];
  await f.patch({}, {targetId:'audio',assetId:media('b.wav'),contentChecked:false});await f.patch({}, {targetId:'audio',assetId:media('a.wav'),contentChecked:false});assert.equal((await f.evidence()).filter(item=>item.state==='matched').length,0);
});

test('E same audio with a new selected range only applies the new immutable check',async t=>{
  const f=await fixture(t);await f.apply(await f.plan());await f.apply(await f.plan({timeRange:{startSeconds:0,endSeconds:0.5}}));
  const current=(await f.evidence()).filter(item=>item.state==='matched');assert.equal(current.length,1);assert.deepEqual(current[0].evidence.sourceRange,{startSeconds:0,endSeconds:0.5});
});

test('E a reference or mapping change during transcription is rechecked before comparison publication',async t=>{
  const f=await fixture(t),plan=await f.plan();await f.patch({transcript:'The gate opens at ten.'});await assert.rejects(f.apply(plan),error=>error.code==='MAPPING_BINDING_MISMATCH');assert.equal((await f.evidence()).length,0);
});

test('E cached states need the immutable evidence, transform identity and current epoch in readiness',async t=>{
  const f=await fixture(t),loaded=await f.apply(await f.plan(),{transcript:'The gate does not open at nine.'}),candidate=loaded.candidates[0],mapping=candidate.mappings[0],context={workspaceEpoch:f.store.captureEpoch()};
  assert.equal(effectiveContentCheck(candidate,mapping,loaded.artifactIndex,context).state,'conflict');assert.equal(assessCandidate(candidate,loaded.artifactIndex,1,context).capabilities.canAnswer,false);
  assert.equal(effectiveContentCheck(candidate,{...mapping,contentCheckState:'matched'},loaded.artifactIndex,context).state,'conflict');
  const changed=structuredClone(loaded.artifactIndex);changed[mapping.assetId].value.evidence.transformRevision='another-transform';assert.equal(effectiveContentCheck(candidate,mapping,changed,context).state,'notChecked');
  const missing=structuredClone(loaded.artifactIndex);delete missing[mapping.contentCheckRef];assert.equal(effectiveContentCheck(candidate,mapping,missing,context).state,'notChecked');
  assert.equal(assessCandidate(candidate,loaded.artifactIndex,1,{workspaceEpoch:'another-workspace-epoch'}).blockingIssues.some(issue=>issue.code==='media_content_conflict'),false);
});

test('E independent B evidence stays visible beside an existing A comparison and human review has its own source',async t=>{
  const f=await fixture(t);await f.apply(await f.plan());await f.apply(await f.plan({assetId:f.b,target:false}));const evidence=await f.evidence();assert.equal(evidence.filter(item=>item.state==='matched').length,1);assert.equal(evidence.find(item=>item.kind==='asr-segments').assetId,f.b);
  const loaded=await f.load(),mapping=loaded.candidates[0].mappings[0];await f.patch({}, {targetId:'audio',assetId:mapping.assetId,contentChecked:true});const after=await f.load(),reviewed=after.candidates[0];assert.equal(reviewed.mappings[0].contentCheckMethod,'user-review');assert.equal(effectiveContentCheck(reviewed,reviewed.mappings[0],after.artifactIndex,{workspaceEpoch:f.store.captureEpoch()}).state,'matched');assert.equal((await f.evidence()).filter(item=>item.state==='matched').length,0);
});

test('E restoring a pre-retraction state under a new workspace epoch cannot revive its matched check',async t=>{
  const f=await fixture(t);await f.apply(await f.plan());const snapshot=f.store.read(),item=(await f.evidence())[0];
  await f.source.retractEvidence({materialId:f.material.id,candidateId:item.candidateId,evidenceRef:item.evidenceRef,expectedRevision:item.candidateRevision,expectedEpoch:f.store.captureEpoch()});assert.equal((await f.evidence())[0].state,'notChecked');
  const barrier=await f.store.beginRestore(f.store.captureEpoch());try{await barrier.publish(snapshot);}finally{barrier.release();}
  const restored=await f.evidence();assert.equal(restored.filter(item=>item.state==='matched').length,0);assert.equal(restored[0].evidence.reference,reference);assert.equal(restored[0].evidence.transcript,reference);
});

test('F3 an already verified actual duration rejects out-of-range preparation before worker dispatch',async t=>{
  const f=await fixture(t,{probeMedia:async()=>({decodeState:'playable',codec:'pcm_s16le',durationSeconds:1,actualDurationSeconds:1,containerDurationSeconds:1})});
  await f.plan({timeRange:{startSeconds:0,endSeconds:1}});await f.plan({timeRange:{startSeconds:0.2,endSeconds:0.8}});await assert.rejects(f.plan({timeRange:{startSeconds:0,endSeconds:2}}),error=>error.code==='ASR_REQUEST_OUTSIDE_DECODED_RANGE');assert.equal((await f.evidence()).length,0);
});

test('F3 short actual decoding through the production Node protocol stays partial evidence and cannot update a mapping',async t=>{
  const f=await fixture(t),sourceRange={startSeconds:0,endSeconds:30},plan=await f.plan({timeRange:sourceRange}),before=await f.load();
  const configuration={interpreter:process.execPath,modelDirectory:root,modelId:'base',device:'cpu',deviceIndex:0,computeType:'int8_float32',dllDirectories:[],confirmed:true};
  const spawnProcess=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>queueMicrotask(()=>child.emit('close',-1));let input='';child.stdin.on('data',bytes=>input+=bytes);child.stdin.on('finish',()=>{const request=JSON.parse(input),result={protocolVersion:1,state:'completed',actual:{engine:'faster-whisper',device:'cpu',deviceIndex:[0],computeType:'int8_float32',modelId:request.configuration.profile.model_id,modelRevision:request.configuration.profile.revision,versions:{'faster-whisper':'1.2.1',ctranslate2:'4.8.2',av:'18.1.0'}},segments:[{start:0,end:1,text:reference,avgLogprob:-0.1,noSpeechProb:0}],transcript:reference,durationSeconds:1,elapsedSeconds:1};child.stdout.end(JSON.stringify(result));child.emit('close',0);});return child;};
  const validated=await runAsrProcess({configuration,request:{operation:'transcribe',parameters:sourceRange,budget:plan.chunks[0].localTool.budget},spawnProcess}),after=await f.apply(plan,{metadata:validated}),evidence=await f.evidence();
  assert.deepEqual(after.candidates,before.candidates);assert.equal(evidence.filter(item=>item.checkApplied).length,0);assert.equal(evidence[0].kind,'asr-segments');assert.equal(evidence[0].state,'partial');assert.equal(evidence[0].reason,'ASR_DECODED_RANGE_INCOMPLETE');assert.deepEqual(evidence[0].requestedRange,sourceRange);assert.deepEqual(evidence[0].sourceRange,{startSeconds:0,endSeconds:1});
  assert.equal(validated.state,'partial');assert.deepEqual(validated.requestedRange,sourceRange);assert.deepEqual(validated.decodedRange,{startSeconds:0,endSeconds:1});assert.equal(validated.rangeComplete,false);
});

test('F3 correct subranges use actual sample-aligned source ranges and stale short-range caches cannot match',async t=>{
  const f=await fixture(t),requestedRange={startSeconds:0.25001,endSeconds:0.75001},plan=await f.plan({timeRange:requestedRange});await f.apply(plan,{metadata:{durationSeconds:0.5}});
  const current=(await f.evidence()).find(item=>item.checkApplied);assert.ok(current);assert.deepEqual(current.evidence.requestedRange,requestedRange);assert.deepEqual(current.evidence.sourceRange,{startSeconds:0.25,endSeconds:0.75});
  const loaded=await f.load(),candidate=loaded.candidates[0],mapping=candidate.mappings[0],index=structuredClone(loaded.artifactIndex),check=index[mapping.contentCheckRef].value,raw=index[check.asrEvidenceRef].value,wrongRange={startSeconds:0,endSeconds:30};
  check.requestedRange=wrongRange;check.sourceRange=wrongRange;check.binding.requestedRange=wrongRange;check.binding.sourceRange=wrongRange;raw.timeRange=wrongRange;raw.requestedRange=wrongRange;raw.durationSeconds=1;raw.decodedRange={startSeconds:0,endSeconds:1};raw.rangeComplete=false;
  const derived=effectiveContentCheck(candidate,mapping,index,{workspaceEpoch:f.store.captureEpoch()});assert.equal(derived.state,'notChecked');assert.equal(derived.checkApplied,false);assert.equal(derived.reason,'ASR_DECODED_RANGE_INCOMPLETE');
});

for(const scenario of [
  {name:'aligned control',requestedRange:{startSeconds:0.25,endSeconds:0.75},outside:false},
  {name:'fractional request with the same PCM range',requestedRange:{startSeconds:0.25001,endSeconds:0.75001},outside:false},
  {name:'fractional PCM boundary',requestedRange:{startSeconds:0.25049,endSeconds:0.75049},outside:false},
  {name:'a start beyond the millisecond rounding envelope',requestedRange:{startSeconds:0.25049,endSeconds:0.75049},start:0.249,outside:true},
  {name:'an end beyond the millisecond rounding envelope',requestedRange:{startSeconds:0.25049,endSeconds:0.75049},start:0.251,end:0.751,outside:true},
])test(`F5 production millisecond timestamps: ${scenario.name}`,async t=>{
  const f=await fixture(t),plan=await f.plan({timeRange:scenario.requestedRange}),durationSeconds=(Math.floor(scenario.requestedRange.endSeconds*16000)-Math.floor(scenario.requestedRange.startSeconds*16000))/16000;
  // Mirror worker.py round(relative_time + requested_offset, 3) for these non-tie values.
  const segment={start:scenario.start??Math.round(scenario.requestedRange.startSeconds*1000)/1000,end:scenario.end??Math.round((scenario.requestedRange.startSeconds+durationSeconds)*1000)/1000,text:reference,avgLogprob:-0.1,noSpeechProb:0};
  const configuration={interpreter:process.execPath,modelDirectory:root,modelId:'base',device:'cpu',deviceIndex:0,computeType:'int8_float32',dllDirectories:[],confirmed:true};
  const spawnProcess=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>queueMicrotask(()=>child.emit('close',-1));let input='';child.stdin.on('data',bytes=>input+=bytes);child.stdin.on('finish',()=>{const config=JSON.parse(input).configuration;child.stdout.end(JSON.stringify({protocolVersion:1,state:'completed',actual:{engine:'faster-whisper',device:'cpu',deviceIndex:[0],computeType:'int8_float32',modelId:config.profile.model_id,modelRevision:config.profile.revision,versions:{'faster-whisper':'1.2.1',ctranslate2:'4.8.2',av:'18.1.0'}},segments:[segment],transcript:reference,durationSeconds,elapsedSeconds:1}));child.emit('close',0);});return child;};
  const result=await runAsrProcess({configuration,request:{operation:'transcribe',parameters:scenario.requestedRange,budget:plan.chunks[0].localTool.budget},spawnProcess});assert.equal(result.rangeComplete,true);await f.apply(plan,{metadata:result});const comparison=(await f.evidence()).find(item=>item.kind==='asr-comparison');
  assert.equal(result.issues.some(issue=>issue.code==='segment_outside_audio'),scenario.outside);assert.equal(comparison.state,scenario.outside?'inconclusive':'matched');assert.deepEqual(comparison.evidence.sourceRange,result.decodedRange);assert.equal(comparison.checkApplied,true);
});
