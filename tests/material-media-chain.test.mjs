import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {startServer} from '../src/server.mjs';
import {createModels} from '../src/models.mjs';
import {readZip} from '../src/package.mjs';
import {appFetch} from './auth-client.mjs';
import {createStore} from '../src/store.mjs';
import {createMaterialInbox} from '../src/materials.mjs';
import {createCandidateRepository,materialSourceRevision} from '../src/material-candidates.mjs';
import {createWorkerHost} from '../src/workers/host.mjs';
import {createMediaWorker} from '../src/workers/media.mjs';

const ffmpeg=process.env.PRACTICEBRIDGE_TEST_FFMPEG?path.resolve(process.env.PRACTICEBRIDGE_TEST_FFMPEG):null,ffprobe=process.env.PRACTICEBRIDGE_TEST_FFPROBE?path.resolve(process.env.PRACTICEBRIDGE_TEST_FFPROBE):null;
const optional={skip:!ffmpeg||!ffprobe?'Explicit PRACTICEBRIDGE_TEST_FFMPEG and PRACTICEBRIDGE_TEST_FFPROBE paths are required; no tool discovery or download.':false};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const within=async(promise,message,ms=5000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]);}finally{clearTimeout(timer);}};
function wav(seconds=4){const rate=16000,samples=rate*seconds,bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);for(let index=0;index<samples;index++)bytes.writeInt16LE(Math.round(8000*Math.sin(index*2*Math.PI*440/rate)),44+index*2);return bytes;}
async function fixture(t,{configure=true}={}){
  for(const filename of [ffmpeg,ffprobe]){assert.ok(path.isAbsolute(filename));assert.equal((await fs.lstat(filename)).isFile(),true);}
  const base=path.resolve('test-results/material-media-chain');await fs.mkdir(base,{recursive:true});const run=await fs.mkdtemp(path.join(base,'run-')),dataDir=path.join(run,'data'),wave=wav(),wavPath=path.join(run,'authored.wav'),mp3Path=path.join(run,'authored.mp3');await fs.writeFile(wavPath,wave);
  const encoded=spawnSync(ffmpeg,['-hide_banner','-v','error','-nostdin','-f','wav','-i',wavPath,'-map','0:a:0','-c:a','libmp3lame','-b:a','128k','-write_xing','1','-f','mp3',mp3Path],{shell:false,windowsHide:true,timeout:15000,maxBuffer:1024*1024});assert.equal(encoded.status,0,encoded.stderr?.toString());const mp3=await fs.readFile(mp3Path),broken=mp3.subarray(0,Math.floor(mp3.length*.6));
  let remoteCalls=0;const models=createModels({dataDir,fetchImpl:async()=>{remoteCalls++;throw Error('No external model requests in local media tests');}}),app=await startServer({dataDir,models});t.after(async()=>{await app.close();assert.equal(remoteCalls,0);});
  const api=async(route,body)=>{const response=await appFetch(app.url+'/api'+route,{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-PracticeBridge':'1'},body:JSON.stringify(body)})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const bytes=async route=>{const response=await appFetch(app.url+'/api'+route);assert.equal(response.status,200,await response.clone().text());return Buffer.from(await response.arrayBuffer());};
  if(configure)await api('/material-tools/media-configuration',{ffmpegPath:ffmpeg,ffprobePath:ffprobe,confirmed:true});
  const receive=async(name,audio,extras=[])=>{const pack={schemaVersion:1,title:'Authored local media chain',version:'1',groups:[{id:'g',title:'Authored tone task',section:'listening',taskKind:'listen_response',questions:[{id:'q',type:'single_choice',prompt:'Which tone is the supplied source?',options:[{id:'A',text:'The supplied tone.'},{id:'B',text:'Another tone.'}],answer:null,explanation:'',transcript:'Self-authored tone; no semantic transcript is claimed.',audio:name}]}]};const received=await api('/materials',{files:[{name:'authored.json',data:Buffer.from(JSON.stringify(pack)).toString('base64')},{name,data:audio.toString('base64')},...extras.map(([name,bytes])=>({name,data:bytes.toString('base64')}))]});await api('/materials/'+received.material.id+'/assess',{useAI:false});await api('/materials/'+received.material.id+'/convert',{useAI:false});return received.material;};
  const candidates=id=>api('/materials/'+id+'/candidates?author=1');
  const job=async(material,toolId,assetId)=>{const route='/materials/'+material.id,description=await api(route+'/jobs'),scope={expectedEpoch:description.expectedEpoch,expectedBinding:description.binding},localTool={toolId,inputAssetIds:[assetId],parameters:toolId==='media.canonicalize'?{outputFormat:'mp3'}:{}};const preview=await api(route+'/jobs/prepare',{...scope,localTool}),started=await api(route+'/jobs/start',{...scope,previewId:preview.previewId,scopeDigest:preview.scopeDigest,consent:true});await app.materialJobs.awaitIdle();return app.materialJobs.view(started.job.jobId);};
  const artifact=async ref=>{const raw=await fs.readFile(path.join(dataDir,'processing-artifacts',ref));assert.equal(hash(raw),ref);return JSON.parse(raw);};
  const backup=async()=>{const raw=await bytes('/backup');return {raw,files:await readZip(raw)};};
  return {run,dataDir,app,api,bytes,receive,candidates,job,artifact,backup,wave,mp3,broken};
}

test('production fixed FFmpeg inspection turns a mislabeled MP3 into a byte-identical mapped alias',optional,async t=>{
  const f=await fixture(t),material=await f.receive('question-2.ogg',f.mp3,[['broken.ogg',f.broken]]),loaded=await f.candidates(material.id),candidate=loaded.candidates[0];
  assert.equal(candidate.fields.audio,'question-2.mp3','Configured production conversion must publish the decoded MP3 alias');
  assert.equal(candidate.readiness.canAnswer,true);assert.equal(candidate.readiness.canScore,false);
  const mapping=candidate.mappings.find(item=>item.targetId==='audio'),media=loaded.artifactIndex[mapping.assetId];assert.equal(mapping.mappingState,'applied');assert.equal(mapping.contentCheckState,'notChecked');assert.equal(media.kind,'media');assert.equal(media.value.blob.id,hash(f.mp3));assert.equal(media.value.evidence.decodeState,'playable');assert.equal(media.value.evidence.codec,'mp3');assert.equal(media.value.evidence.derivativeRefs[0].parentHash,hash(f.mp3));assert.equal(media.value.evidence.derivativeRefs[0].outputHash,hash(f.mp3));assert.deepEqual(await f.bytes('/materials/'+material.id+'/candidates/media/'+mapping.assetId),f.mp3);
  const original=material.files.find(item=>item.name==='question-2.ogg');assert.equal(original.id,hash(f.mp3));assert.equal(hash(await fs.readFile(path.join(f.dataDir,'input-blobs',original.id))),original.id);
  const compiled=await f.api('/materials/'+material.id+'/compile',{expectedEpoch:loaded.expectedEpoch,sourceRevision:loaded.sourceRevision,candidateRevisions:{[candidate.candidateId]:candidate.revision},selectedIds:[candidate.candidateId],importOperationId:crypto.randomUUID()}),exported=await readZip(await f.bytes('/library/'+compiled.receipt.libraryId+'/export'));assert.deepEqual(exported.get('question-2.mp3'),f.mp3);
  await fs.writeFile(path.join(f.run,'alias-evidence.json'),JSON.stringify({originalHash:original.id,canonicalName:candidate.fields.audio,mapping,media},null,2));
});

test('a real playback derivative is registered for user mapping with source provenance and exact backup restoration',optional,async t=>{
  const f=await fixture(t),material=await f.receive('source.wav',f.wave),before=await f.candidates(material.id),old=before.candidates[0],oldMapping=old.mappings.find(item=>item.targetId==='audio');
  const checked=await f.api('/materials/'+material.id+'/candidates/'+old.candidateId+'/patch',{expectedEpoch:before.expectedEpoch,expectedRevision:old.revision,fields:{},mapping:{targetId:'audio',assetId:oldMapping.assetId,contentChecked:true}});assert.equal(checked.candidate.mappings[0].contentCheckState,'matched');
  const job=await f.job(material,'media.canonicalize',hash(f.wave));assert.equal(job.state,'completed');const checkpoint=await f.artifact(job.chunks[0].checkpointRef),derivativeRef=checkpoint.result.artifactRefs[0],derivative=await f.artifact(derivativeRef);assert.equal(derivative.kind,'media-derivative');assert.equal(derivative.value.parentHash,hash(f.wave));
  const registered=await f.candidates(material.id),entry=Object.entries(registered.artifactIndex).find(([,value])=>value.kind==='media'&&value.value.blob.id===derivative.value.blob.id);
  assert.ok(entry,'The actual tool derivative must join the candidate media index, not remain an unreachable result reference');
  const [mediaRef,media]=entry;assert.ok(media.dependencyRefs.includes(derivativeRef));assert.equal(media.value.evidence.derivedFrom,hash(f.wave));assert.deepEqual(media.value.evidence.sourceRange,{startSeconds:0,endSeconds:4});assert.equal(media.value.evidence.decoderMetadata.engine,'ffprobe+ffmpeg');
  const current=registered.candidates[0],mapped=await f.api('/materials/'+material.id+'/candidates/'+current.candidateId+'/patch',{expectedEpoch:registered.expectedEpoch,expectedRevision:current.revision,fields:{},mapping:{targetId:'audio',assetId:mediaRef,contentChecked:false}});assert.equal(mapped.candidate.revision,current.revision+1);assert.equal(mapped.candidate.mappings[0].assetId,mediaRef);assert.equal(mapped.candidate.mappings[0].contentCheckState,'notChecked');assert.equal(mapped.candidate.mappings[0].candidateRevision,mapped.candidate.revision);
  const playback=await f.bytes('/materials/'+material.id+'/candidates/media/'+mediaRef);assert.equal(hash(playback),derivative.value.blob.id);assert.equal(hash(await fs.readFile(path.join(f.dataDir,'input-blobs',hash(f.wave)))),hash(f.wave));
  const selected=mapped.candidate,compiled=await f.api('/materials/'+material.id+'/compile',{expectedEpoch:registered.expectedEpoch,sourceRevision:registered.sourceRevision,candidateRevisions:{[selected.candidateId]:selected.revision},selectedIds:[selected.candidateId],importOperationId:crypto.randomUUID()}),libraryId=compiled.receipt.libraryId,formal=await readZip(await f.bytes('/library/'+libraryId+'/export'));assert.deepEqual(formal.get(media.value.name),playback);
  const saved=await f.backup(),manifest=JSON.parse(saved.files.get('practicebridge-backup.json'));assert.deepEqual(saved.files.get('blobs/'+derivative.value.blob.id),playback);assert.ok(manifest.processingArtifacts[derivativeRef]);await f.api('/restore',{file:{name:'authored-media-backup.zip',data:saved.raw.toString('base64')}});
  const restored=await f.candidates(material.id);assert.deepEqual(restored.artifactIndex[mediaRef],media);assert.equal(restored.candidates[0].mappings[0].assetId,mediaRef);assert.deepEqual(await f.bytes('/materials/'+material.id+'/candidates/media/'+mediaRef),playback);assert.notEqual(restored.expectedEpoch,registered.expectedEpoch);assert.deepEqual((await readZip(await f.bytes('/library/'+libraryId+'/export'))).get(media.value.name),playback);
  await fs.writeFile(path.join(f.run,'derivative-evidence.json'),JSON.stringify({job,derivativeRef,derivative,mediaRef,media,candidateRevision:mapped.candidate.revision,restoredEpoch:restored.expectedEpoch},null,2));
});

test('truncated MP3 bytes never become a complete alias or playback derivative',optional,async t=>{
  const f=await fixture(t),material=await f.receive('source.wav',f.wave,[['broken.ogg',f.broken]]),job=await f.job(material,'media.canonicalize',hash(f.broken));assert.equal(job.state,'completed_with_pending');const checkpoint=await f.artifact(job.chunks[0].checkpointRef);assert.equal(checkpoint.result.state,'partial');assert.deepEqual(checkpoint.result.artifactRefs,[]);assert.equal(checkpoint.result.evidence[0].decodeState,'partial');assert.equal(checkpoint.result.evidence[0].missingLocationState,'unknown');
  const loaded=await f.candidates(material.id);assert.equal(Object.values(loaded.artifactIndex).some(entry=>entry.kind==='media'&&entry.value.blob.id===hash(f.broken)),false);assert.equal(hash(await fs.readFile(path.join(f.dataDir,'input-blobs',hash(f.broken)))),hash(f.broken));
});

async function nativeFixture(t){
  const base=path.resolve('test-results/material-media-chain');await fs.mkdir(base,{recursive:true});const run=await fs.mkdtemp(path.join(base,'cancel-')),store=await createStore({dataDir:run}),inbox=createMaterialInbox({store}),repository=createCandidateRepository({store}),wave=wav();
  const pack={schemaVersion:1,title:'Authored cancellation',version:'1',groups:[{id:'g',title:'Authored tone task',section:'listening',taskKind:'listen_response',questions:[{id:'q',type:'single_choice',prompt:'Which tone is supplied?',options:[{id:'A',text:'This tone.'},{id:'B',text:'Another tone.'}],answer:null,audio:'source.wav'}]}]},material=await inbox.receive({files:[{name:'authored.json',data:Buffer.from(JSON.stringify(pack)).toString('base64')},{name:'source.wav',data:wave.toString('base64')}]}),expectedEpoch=store.captureEpoch();t.after(()=>store.close());
  return {run,store,inbox,repository,wave,material,pack,expectedEpoch,input:{materialId:material.id,pack,files:new Map([['source.wav',wave]]),method:'native',expectedEpoch}};
}

test('cancelling a real slow decoder waits for its actual exit and prevents native candidate publication',optional,async t=>{
  const f=await nativeFixture(t),controller=new AbortController();let entered,closed,child;
  const began=new Promise(resolve=>entered=resolve),exited=new Promise(resolve=>closed=resolve),host=createWorkerHost({executablePaths:[ffmpeg,ffprobe],spawnProcess:(executable,args,options)=>{const slow=[...args];if(executable===ffmpeg&&args.includes('s16le'))slow.splice(slow.indexOf('-i'),0,'-re');const spawned=spawn(executable,slow,options);if(executable===ffmpeg&&args.includes('s16le')){child=spawned;spawned.once('spawn',entered);spawned.once('close',closed);}return spawned;}});
  const jobId='actual-slow-media-probe',sourceRevision=materialSourceRevision(f.material),budget={timeoutMs:10000,maxOutputBytes:1024*1024,maxDurationSeconds:10},worker=createMediaWorker({ffmpegPath:ffmpeg,ffprobePath:ffprobe,artifactDir:path.join(f.run,'staging'),resolveAsset:async()=>({path:path.join(f.run,'input-blobs',hash(f.wave)),hash:hash(f.wave),name:'source.wav',size:f.wave.length}),spawnProcess:host.spawnProcess});
  const probeMedia=()=>host.run({jobId,signal:controller.signal,budget:{...budget,maxMemoryBytes:768*1024*1024}},async()=>{const result=await worker.runMaterialTool({jobId,expectedEpoch:f.expectedEpoch,sourceRevision,toolId:'media.probe',inputAssetIds:[hash(f.wave)],parameters:{},budget,cancelToken:controller.signal});return result.evidence[0];});
  const pending=f.repository.ingestPack({...f.input,probeMedia,signal:controller.signal}).then(value=>({ok:true,value}),error=>({ok:false,error}));
  try{await within(began,'The real decoder did not start');assert.equal(child.exitCode,null);controller.abort();const outcome=await pending;await within(exited,'The real decoder did not exit');assert.equal(host.busy(),false);assert.equal(outcome.ok,false,'An aborted real decoder must not be downgraded to unavailable and publish candidates');assert.equal(f.store.read().candidateSets[f.material.id],undefined);assert.equal(hash(await fs.readFile(path.join(f.run,'input-blobs',hash(f.wave)))),hash(f.wave));await fs.writeFile(path.join(f.run,'cancel-evidence.json'),JSON.stringify({realFfmpegPid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode,closeObserved:true,hostBusy:host.busy(),candidatePublished:false,originalHash:hash(f.wave)},null,2));}
  finally{controller.abort();await host.cancel(jobId);}
});

test('an explicitly requested real probe exposes an alias for an older unresolved candidate without silently choosing its mapping',optional,async t=>{
  const f=await fixture(t,{configure:false}),material=await f.receive('question-2.ogg',f.mp3),before=await f.candidates(material.id);assert.equal(before.candidates[0].mappings[0].assetId,null);
  await f.api('/material-tools/media-configuration',{ffmpegPath:ffmpeg,ffprobePath:ffprobe,confirmed:true});const job=await f.job(material,'media.probe',hash(f.mp3));assert.equal(job.state,'completed');const loaded=await f.candidates(material.id),entry=Object.entries(loaded.artifactIndex).find(([,media])=>media.kind==='media'&&media.value.name==='question-2.mp3');assert.ok(entry);assert.equal(entry[1].value.evidence.derivedFrom,hash(f.mp3));assert.equal(entry[1].value.evidence.decoderMetadata.engine,'ffprobe+ffmpeg');assert.equal(loaded.candidates[0].mappings[0].assetId,before.candidates[0].mappings[0].assetId);assert.equal(loaded.candidates[0].mappings[0].mappingState,before.candidates[0].mappings[0].mappingState);assert.ok(loaded.candidates[0].revision>before.candidates[0].revision);
  const candidate=loaded.candidates[0],mapped=await f.api('/materials/'+material.id+'/candidates/'+candidate.candidateId+'/patch',{expectedEpoch:loaded.expectedEpoch,expectedRevision:candidate.revision,fields:{},mapping:{targetId:'audio',assetId:entry[0],contentChecked:false}});assert.equal(mapped.candidate.fields.audio,'question-2.mp3');assert.equal(mapped.candidate.mappings[0].contentCheckState,'notChecked');assert.equal(mapped.candidate.readiness.canAnswer,true);assert.deepEqual(await f.bytes('/materials/'+material.id+'/candidates/media/'+entry[0]),f.mp3);
});

test('ASR missing parameters and 301-second selections fail before any CAS, job or ASR dispatch',async t=>{
  const base=path.resolve('test-results/material-media-chain');await fs.mkdir(base,{recursive:true});const dataDir=await fs.mkdtemp(path.join(base,'asr-preflight-'));let asrCalls=0;const app=await startServer({dataDir,asrWorkerFactory:()=>{asrCalls++;throw Error('Preflight must not start ASR');}});t.after(()=>app.close());
  const post=async(route,body)=>{const response=await appFetch(app.url+'/api'+route,{method:'POST',headers:{'Content-Type':'application/json','X-PracticeBridge':'1'},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
  const received=await post('/materials',{files:[{name:'authored.wav',data:wav(1).toString('base64')}]}),material=received.value.material,response=await appFetch(app.url+'/api/materials/'+material.id+'/jobs'),description=await response.json(),scope={expectedEpoch:description.expectedEpoch,expectedBinding:description.binding};
  for(const parameters of [undefined,{startSeconds:0,endSeconds:301}]){const result=await post('/materials/'+material.id+'/jobs/prepare',{...scope,localTool:{toolId:'media.transcribe',inputAssetIds:[material.files[0].id],...(parameters?{parameters}:{})}});assert.equal(result.status,400);if(parameters)assert.match(result.value.error,/单次本地转写最多 300 秒/);}
  assert.equal(asrCalls,0);assert.deepEqual(app.materialJobs.list(),[]);assert.deepEqual(await fs.readdir(path.join(dataDir,'processing-artifacts')).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error)),[]);
});

test('native publication rechecks the host generation after entering the serialized writer',async t=>{
  const f=await nativeFixture(t);let generation=1,entered,release;const arrived=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve),transact=f.store.transact;let armed=true;
  f.store.transact=(mutator,options)=>transact(async state=>{if(armed){armed=false;entered();await held;}return mutator(state);},options);
  const pending=f.repository.ingestPack({...f.input,assertCurrent:()=>{if(generation!==1)throw Object.assign(Error('host operation generation changed'),{status:409});}}).then(value=>({ok:true,value}),error=>({ok:false,error}));
  try{await arrived;generation++;release();const result=await pending;assert.equal(result.ok,false,'A queued candidate write cannot survive the host generation change');assert.equal(f.store.read().candidateSets[f.material.id],undefined);}
  finally{release();}
});

