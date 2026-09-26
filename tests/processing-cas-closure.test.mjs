import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createStore,emptyState} from '../src/store.mjs';
import {createMaterialInbox} from '../src/materials.mjs';
import {canonicalJSON} from '../src/package.mjs';
import {inspectProcessingSnapshot} from '../src/processing-backup.mjs';
import * as processingBackup from '../src/processing-backup.mjs';
import {materialSourceRevision,createCandidateRepository} from '../src/material-candidates.mjs';
import {authoredScanPng} from './helpers/ocr-fixture.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
  const files=new Map(),state=emptyState();state.materialJobs={fixture:'reader callback scope only; job schema is independently validated by its owner'};
  const save=value=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(canonicalJSON(value)),ref=hash(bytes);files.set(ref,bytes);return ref;};
  const inspect=roots=>inspectProcessingSnapshot(state,{readBytes:async ref=>{assert.ok(files.has(ref),'required CAS file must exist');return files.get(ref);},inspectJobs:async({follow})=>{for(const root of roots)await follow(typeof root==='string'?root:root.ref,{role:root.role||'artifact'});}});
  return {files,state,save,inspect};
}

test('processing closure keeps request inputs and raw page images without treating schema property definitions as references',async()=>{
  const f=fixture(),imageRef=f.save(authoredScanPng().bytes);
  const raw=f.save({version:1,kind:'ocr-evidence',source:{imageRef},text:'Self-authored local source.'});
  const input=f.save({model:'authored-model-protocol',messages:[{role:'user',content:'The source includes artifactRef as a vocabulary word.'}],responseSchema:{type:'object',properties:{artifactRef:{type:'string'},artifactRefs:{type:'array',items:{type:'string'}}}},metadata:{artifactRef:'a'.repeat(64),inputRef:'source-defined-field',blob:{id:'authored-card'}}});
  const checkpoint=f.save({kind:'material-checkpoint',output:{prompt:{artifactRef:'b'.repeat(64)},dependencyRefs:['c'.repeat(64)]}}),roots=[checkpoint,{ref:input,role:'model-request'},raw];
  const snapshot=await f.inspect(roots);assert.deepEqual([...snapshot.files.keys()].sort(),[checkpoint,input,raw,imageRef].sort());
  f.files.delete(input);await assert.rejects(f.inspect(roots));
});

test('processing closure validates a pending artifact index and retains media metadata before library import',async()=>{
  const f=fixture(),bytes=authoredScanPng().bytes,blob={id:hash(bytes),size:bytes.length,mime:'image/png'};
  const entry={kind:'media-derivative',value:{blob,parentHash:'f'.repeat(64),recipeVersion:1},dependencyRefs:[]},entryRef=f.save(entry);
  const document={kind:'document',value:{originals:[],documentLayout:{blocks:[]}},dependencyRefs:[]},sourceRef=f.save(document);
  const indexRef=f.save({[entryRef]:entry,[sourceRef]:document}),scopeValue={artifactIndexRef:indexRef,sourceRef,localTool:{toolId:'media.probe'},dependencyRefs:[]},scope=f.save(scopeValue),roots=[{ref:scope,role:'job-scope'}];
  const snapshot=await f.inspect(roots);assert.ok(snapshot.files.has(entryRef));assert.deepEqual(snapshot.blobInfo.get(blob.id),blob);assert.equal(f.state.blobs[blob.id],undefined);
  const forgedIndex=f.save({[entryRef]:{...entry,value:{...entry.value,name:'uncommitted different content'}}});
  await assert.rejects(f.inspect([{ref:f.save({...scopeValue,artifactIndexRef:forgedIndex}),role:'job-scope'}]));
  f.files.delete(entryRef);await assert.rejects(f.inspect(roots));
});

test('job snapshot ownership is checked before following its complete validated roots',async()=>{
  assert.equal(typeof processingBackup.createMaterialJobSnapshotInspector,'function');
  const f=fixture(),material={id:'00000000-0000-4000-8000-000000000001',files:[],text:'Self-authored job scope'};f.state.materials=[material];
  const root=f.save({model:'authored-model-protocol',messages:[]}),job={materialId:material.id,workspaceEpoch:f.state.workspaceEpoch,sourceRevision:materialSourceRevision(material),generation:1,expectedSetRevision:0};
  f.state.materialJobs={local:job};let validated=0;
  // Only the reader adapter is under test here. The production caller supplies
  // the full T06 schema/ledger validator and its complete root-reference list.
  const inspectJobs=processingBackup.createMaterialJobSnapshotInspector({validateJobs:state=>{assert.equal(state,f.state);validated++;},references:()=>[{ref:root,role:'model-request'}]});
  const inspect=()=>inspectProcessingSnapshot(f.state,{readBytes:async ref=>f.files.get(ref),inspectJobs});
  assert.equal((await inspect()).files.has(root),true);assert.equal(validated,1);
  for(const patch of [{materialId:'00000000-0000-4000-8000-000000000099'},{workspaceEpoch:'00000000-0000-4000-8000-000000000099'},{sourceRevision:'a'.repeat(64)},{generation:0},{expectedSetRevision:1}]){
    f.state.materialJobs.local={...job,...patch};await assert.rejects(inspect(),error=>error.status===400);
  }
  f.state.materialJobs.local=job;
  const rejected=processingBackup.createMaterialJobSnapshotInspector({validateJobs:()=>{throw Object.assign(new Error('invalid ledger'),{code:'invalid_material_jobs',status:500});},references:()=>[root]});
  await assert.rejects(inspectProcessingSnapshot(f.state,{readBytes:async ref=>f.files.get(ref),inspectJobs:rejected}),error=>error.status===400);
});

test('opaque source interaction values stay data through rawArtifactRef while their host dependencies remain in the backup',async t=>{
  const base=path.resolve('test-results/processing-opaque-source');await fs.mkdir(base,{recursive:true});const dataDir=await fs.mkdtemp(path.join(base,'run-'));
  const store=await createStore({dataDir}),inbox=createMaterialInbox({store}),repository=createCandidateRepository({store});
  t.after(async()=>{await store.close();assert.ok(dataDir.startsWith(base+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});
  const interaction={kind:'multi_select',minimum:2,maximum:3,rows:[{id:'x',text:'Self-authored source row'}],inputRef:'source-control-1',diagnosticRef:'author-defined-help-panel',blob:{id:'drag-card-1',label:'Source card'},artifactRef:'a'.repeat(64),dependencyRefs:['b'.repeat(64)]};
  const pack={schemaVersion:1,id:'authored-opaque-source',version:'1',title:'Authored opaque source',groups:[{id:'g',section:'reading',taskKind:'read_daily',title:'Controls',passage:'Preserve these source-defined control names.',questions:[{id:'q',type:'single_choice',prompt:'Choose the marked controls.',options:[{id:'A',text:'First control'},{id:'B',text:'Second control'}],answer:null,explanation:'',interaction}]}]};
  const material=await inbox.receive({files:[{name:'practice-pack.json',data:Buffer.from(JSON.stringify(pack)).toString('base64')}]});
  const saved=await repository.ingestPack({materialId:material.id,pack,method:'native',expectedEpoch:store.captureEpoch()}),rawRef=saved.candidates[0].fields.interaction.rawArtifactRef,raw=await repository.readArtifact(rawRef);
  assert.equal(saved.candidates[0].readiness.canAnswer,false);assert.deepEqual(raw.value,interaction);
  const snapshot=await inspectProcessingSnapshot(store.read(),{readBytes:ref=>processingBackup.readProcessingBytes(dataDir,ref)});
  assert.ok(snapshot.files.has(rawRef));assert.ok(raw.dependencyRefs.length>0);for(const ref of raw.dependencyRefs)assert.ok(snapshot.files.has(ref));
  assert.equal(snapshot.files.has(interaction.artifactRef),false);assert.equal(snapshot.files.has(interaction.dependencyRefs[0]),false);assert.equal(snapshot.blobInfo.size,0);
});

test('known group and scope values preserve source vocabulary while unknown required outer kinds and versions fail closed',async()=>{
  const f=fixture(),sourceValue={artifactRef:'not-a-reference',dependencyRefs:['d'.repeat(64)],kind:'ocr-evidence',source:{imageRef:'source-image-label'},blob:{id:'card-1'}};
  const document={kind:'document',value:{documentLayout:{blocks:[{id:'authored',text:'Original source',...sourceValue}]}},dependencyRefs:[]},sourceRef=f.save(document);
  const group={kind:'group',value:{passage:'Authored group',presentation:sourceValue},dependencyRefs:[sourceRef]},groupRef=f.save(group),indexRef=f.save({[sourceRef]:document,[groupRef]:group});
  const scope=f.save({artifactIndexRef:indexRef,sourceRef,groupRef,dependencyRefs:[groupRef],questions:[{prototype:sourceValue}],blocks:[sourceValue]}),roots=[{ref:scope,role:'job-scope'}];
  const snapshot=await f.inspect(roots);assert.equal(snapshot.files.size,4);assert.equal(snapshot.blobInfo.size,0);
  for(const value of [{kind:'future-unknown-evidence',value:sourceValue,dependencyRefs:[]},{kind:'group',version:2,value:{},dependencyRefs:[]},{kind:'ocr-evidence',version:2,source:{imageRef:null}}])await assert.rejects(f.inspect([f.save(value)]),error=>error.code==='UNSUPPORTED_ARTIFACT_VERSION');
  f.files.delete(sourceRef);await assert.rejects(f.inspect(roots));
});

test('paged OCR result closure retains explicit raw evidence and PNG descriptors without interpreting source prose',async()=>{
  const f=fixture(),imageRef=f.save(authoredScanPng().bytes),rawRef=f.save({kind:'document-region-evidence',version:1,source:{imageRef},textLayer:'A source example: {artifactRef: user-defined}.',issues:[]});
  const result={state:'completed',artifactRefs:[{ref:imageRef,kind:'page-image',mime:'image/png',page:1},{ref:rawRef,kind:'document-region-evidence',page:1}],evidence:[{ref:rawRef,imageRef,page:1}],issues:[{code:'author-review',evidenceRef:rawRef}]};
  const fullRef=f.save({kind:'tool-result',toolId:'document.render',parentAssetIds:['c'.repeat(64)],...result}),checkpoint=f.save({kind:'local-tool-checkpoint',toolId:'document.render',result:{state:'completed',paged:true,artifactRefs:[fullRef]}});
  assert.equal((await f.inspect([{ref:checkpoint,role:'job-checkpoint'}])).files.size,4);
  f.files.delete(imageRef);await assert.rejects(f.inspect([{ref:checkpoint,role:'job-checkpoint'}]));
});

test('ASR raw result, wrapper and comparison use separate roles and retain their registered media dependency',async()=>{
  const f=fixture(),image=authoredScanPng().bytes,blob={id:hash(image),size:image.length,mime:'image/png'};
  const mediaRef=f.save({kind:'media',value:{blob,name:'authored.png'},dependencyRefs:[]});
  const raw={protocolVersion:1,originalAssetId:'a'.repeat(64),transcript:'The source text says artifactRef.',segments:[{text:'No dependency lookup here.',artifactRef:'source-defined'}],actual:{engine:'authored-protocol'}},rawRef=f.save(raw);
  const resultRef=f.save({kind:'tool-result',value:{state:'completed',artifactRefs:[rawRef],evidence:[{artifactRef:rawRef}]},dependencyRefs:[]}),segmentsRef=f.save({kind:'asr-segments',value:raw,dependencyRefs:[resultRef]});
  const comparisonRef=f.save({kind:'asr-comparison',value:{method:'asr-text-comparison-v1',asrEvidenceRef:segmentsRef,reference:'Original text',binding:{sourceAssetHash:'b'.repeat(64)}},dependencyRefs:[segmentsRef,mediaRef]});
  const snapshot=await f.inspect([{ref:comparisonRef,role:'asr-comparison'}]);assert.equal(snapshot.files.size,5);assert.deepEqual(snapshot.blobInfo.get(blob.id),blob);
  f.files.delete(rawRef);await assert.rejects(f.inspect([{ref:comparisonRef,role:'asr-comparison'}]));
});

test('shared source roots across jobs count as the actual CAS closure while every distinct read role is retained',async()=>{
  const f=fixture(),material={id:randomUUID(),title:'Authored shared groups',text:'Two jobs retain the same two hundred complete groups.',files:[]};f.state.materials=[material];
  const index={},add=value=>{const ref=f.save(value);index[ref]=value;return ref;},sourceRef=add({kind:'document',value:{originals:[],documentLayout:{blocks:[]}},dependencyRefs:[]}),contextRef=add({kind:'pack-context',value:{groups:[]},dependencyRefs:[sourceRef]});
  const groups=Array.from({length:200},(_,i)=>add({kind:'group',sourceGroupId:`g${i}`,value:{title:`Group ${i}`,passage:'The complete authored source.'},dependencyRefs:[sourceRef,contextRef]})),artifactIndexRef=f.save(index);
  const chunks=groups.map((groupRef,i)=>({chunkId:randomUUID(),sourceScope:`scope-${i}`,scopeRef:f.save({sourceScope:`scope-${i}`,questions:[],blocks:[],artifactIndexRef,sourceRef,groupRef,dependencyRefs:[groupRef]}),dependencyRefs:[groupRef],checkpointRef:null,conflictRef:null,repairRef:null}));
  const chunkPlanRef=f.save({sourceIndexRef:sourceRef,chunks:chunks.map(({sourceScope,scopeRef})=>({sourceScope,scopeRef}))}),job=()=>({materialId:material.id,workspaceEpoch:f.state.workspaceEpoch,sourceRevision:materialSourceRevision(material),generation:1,expectedSetRevision:0,scope:{sourceIndexRef:sourceRef,chunkPlanRef,artifactRefs:Object.keys(index)},chunks:structuredClone(chunks),requests:[]});
  f.state.materialJobs={[randomUUID()]:job(),[randomUUID()]:job()};
  const inspectJobs=processingBackup.createMaterialJobSnapshotInspector({validateJobs:state=>assert.equal(Object.keys(state.materialJobs).length,2)});
  const snapshot=await inspectProcessingSnapshot(f.state,{readBytes:async ref=>f.files.get(ref),inspectJobs});assert.equal(snapshot.files.size,404);
  // The same bytes claimed as a second incompatible role must still be checked.
  const incompatible=processingBackup.createMaterialJobSnapshotInspector({validateJobs:()=>{},references:()=>[{ref:sourceRef,role:'document'},{ref:sourceRef,role:'group'}]});
  await assert.rejects(inspectProcessingSnapshot(f.state,{readBytes:async ref=>f.files.get(ref),inspectJobs:incompatible}),error=>error.code==='UNSUPPORTED_ARTIFACT_VERSION');
});
