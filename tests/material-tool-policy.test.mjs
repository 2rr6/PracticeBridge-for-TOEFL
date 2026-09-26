import test from 'node:test';
import assert from 'node:assert/strict';
import {createMaterialTools,MATERIAL_TOOL_IDS} from '../src/material-tools.mjs';

const asset='a'.repeat(64),other='b'.repeat(64),artifact='c'.repeat(64),epoch='11111111-1111-4111-8111-111111111111';
const params={
  'assets.list':{offset:0,limit:10},'source.read':{artifactRef:artifact,blockId:'source-1',start:0,end:20},
  'document.render':{language:'eng',pages:[{page:1,region:{x:0,y:0,width:0.2,height:0.2}}]},
  'document.ocr':{language:'eng',pages:[{page:1,region:{x:0,y:0,width:0.2,height:0.2}}]},
  'media.probe':{},'media.canonicalize':{outputFormat:'mp3'},'media.transcribe':{startSeconds:0,endSeconds:10},
  'mapping.propose':{candidateId:'candidate-1',candidateRevision:1,targetId:'audio',assetId:asset},
  'candidates.validate':{candidateIds:['candidate-1']},'draft.patch':{candidateId:'candidate-1',candidateRevision:1,fields:{prompt:'source proposal'}}
};
function fixture(){
  let revision=2,calls=0;const stored=[];
  const job={jobId:'job-one',materialId:'material-one',workspaceEpoch:epoch,generation:1,sourceRevision:'d'.repeat(64),state:'running',scope:{assetIds:[asset],artifactRefs:[artifact],allowedToolIds:MATERIAL_TOOL_IDS,allowLocalAsr:true,regions:{[asset]:{pages:2,width:500,height:500,durationSeconds:60}}},budget:{limits:{maxToolTextBytes:16384,maxDurationMs:900000},elapsedMs:0},run:{deadlineAt:Date.now()+900000}};
  const adapters=Object.fromEntries(MATERIAL_TOOL_IDS.map(id=>[id,async()=>{calls++;return {state:'completed',text:'self-authored local evidence',artifactRefs:[]};}]));
  const registry=createMaterialTools({assertCurrent:r=>{if(r.expectedEpoch!==epoch||r.generation!==1||r.sourceRevision!==job.sourceRevision||r.expectedSetRevision!==revision)throw Object.assign(new Error('stale guard'),{status:409});return job;},resolveAsset:async id=>({id,materialId:job.materialId,sourceRevision:job.sourceRevision,size:100,mime:'audio/wav'}),resolveCandidate:async id=>id==='candidate-1'?{candidateId:id,materialId:job.materialId,sourceRevision:job.sourceRevision,revision:1}:null,adapters,publishArtifact:async v=>{stored.push(v);return 'e'.repeat(64);}});
  const request=id=>({jobId:job.jobId,expectedEpoch:epoch,generation:1,sourceRevision:job.sourceRevision,expectedSetRevision:2,toolId:id,inputAssetIds:['assets.list','source.read','candidates.validate','draft.patch'].includes(id)?[]:[asset],parameters:structuredClone(params[id]),budget:{timeoutMs:1000,maxOutputBytes:65536,maxInputBytes:1000,maxDurationSeconds:20,maxPixels:1000000}});
  return {registry,job,adapters,request,calls:()=>calls,stored,edit:()=>revision++};
}

test('each fixed tool runs through job scope and refuses shell/URL/unknown arguments and stale guards',async()=>{
  for(const id of MATERIAL_TOOL_IDS){const f=fixture(),request=f.request(id);const result=await f.registry.runMaterialTool(request);assert.equal(result.state,'completed');assert.equal(f.calls(),1);
    for(const extra of [{shell:'powershell'},{url:'https://private.test/material'},{path:'C:/private/file'}])await assert.rejects(f.registry.runMaterialTool({...request,parameters:{...request.parameters,...extra}}));
    await assert.rejects(f.registry.runMaterialTool({...request,expectedEpoch:'old'}));await assert.rejects(f.registry.runMaterialTool({...request,generation:0}));f.edit();await assert.rejects(f.registry.runMaterialTool(request));assert.equal(f.calls(),1);
  }
});

test('asset, document region, source slice, media duration and local ASR approval are scoped before dispatch',async()=>{
  for(const id of MATERIAL_TOOL_IDS){const f=fixture(),request=f.request(id);await assert.rejects(f.registry.runMaterialTool({...request,inputAssetIds:[other]}));assert.equal(f.calls(),0);}
  for(const id of ['document.render','document.ocr']){const f=fixture(),r=f.request(id);r.parameters.pages[0].region.x=0.95;await assert.rejects(f.registry.runMaterialTool(r));assert.equal(f.calls(),0);}
  const f=fixture();const read=f.request('source.read');read.parameters.artifactRef=other;await assert.rejects(f.registry.runMaterialTool(read));
  const asr=f.request('media.transcribe');asr.parameters.endSeconds=61;await assert.rejects(f.registry.runMaterialTool(asr));f.job.scope.allowLocalAsr=false;await assert.rejects(f.registry.runMaterialTool(f.request('media.transcribe')));assert.equal(f.calls(),0);
});

test('overlong tool replies publish complete bounded artifacts and return refs, never silently sliced text',async()=>{
  const f=fixture();f.adapters['source.read']=async()=>({state:'completed',text:'x'.repeat(20000),artifactRefs:[]});
  const result=await f.registry.runMaterialTool(f.request('source.read'));assert.equal(result.text,undefined);assert.equal(result.paged,true);assert.equal(result.artifactRefs.length,1);assert.equal(f.stored[0].text.length,20000);assert.ok(Buffer.byteLength(JSON.stringify(result))<=16384);
  f.adapters['source.read']=async()=>({state:'completed',text:'x'.repeat(70000)});await assert.rejects(f.registry.runMaterialTool(f.request('source.read')),/预算|输出/);
});

test('host-approved page selections keep unknown pixel dimensions in the fixed worker and reject unapproved page ranges',async()=>{
  for(const toolId of ['document.render','document.ocr']){
    const f=fixture(),r=f.request(toolId);f.job.scope.regions[asset]={pageLimit:2,rangeBasis:'explicit_page_selection_worker_dimensions'};
    await f.registry.runMaterialTool(r);assert.equal(f.calls(),1);
    r.parameters.pages[0].page=3;await assert.rejects(f.registry.runMaterialTool(r),error=>error.code==='region_outside_scope');assert.equal(f.calls(),1);
    r.parameters.pages[0].page=1;r.parameters.pages[0].region.x=.95;await assert.rejects(f.registry.runMaterialTool(r),error=>error.code==='region_outside_scope');assert.equal(f.calls(),1);
    r.parameters.pages[0].region.x=0;f.job.scope.regions[asset].pageLimit=201;await assert.rejects(f.registry.runMaterialTool(r),error=>error.code==='region_outside_scope');
    f.job.scope.regions[asset].pageLimit=2;f.job.scope.regions[asset].width=1;await assert.rejects(f.registry.runMaterialTool(r),error=>error.code==='region_outside_scope');
    f.job.scope.regions[asset]={pages:2,width:500,height:500};r.budget.maxPixels=1;await assert.rejects(f.registry.runMaterialTool(r),error=>error.code==='region_outside_scope');assert.equal(f.calls(),1,'the existing known-dimension pixel precheck remains active');
  }
});

test('version changes and cancellation during a slow helper prevent publication; unavailable helper stays explicit',async()=>{
  const f=fixture();let release;f.adapters['document.ocr']=()=>new Promise(r=>{release=r;});const pending=f.registry.runMaterialTool(f.request('document.ocr'));await new Promise(r=>setImmediate(r));f.edit();release({state:'completed',text:'late',artifactRefs:[]});await assert.rejects(pending);assert.equal(f.stored.length,0);
  const g=fixture();g.adapters['media.transcribe']=()=>new Promise(()=>{});const running=g.registry.runMaterialTool(g.request('media.transcribe'));await new Promise(r=>setImmediate(r));await g.registry.cancel('job-one');await assert.rejects(running,/取消|终止/);
  const h=fixture();delete h.adapters['document.ocr'];await assert.rejects(h.registry.runMaterialTool(h.request('document.ocr')),error=>error.code==='tool_unavailable');assert.equal(h.calls(),0);
});
