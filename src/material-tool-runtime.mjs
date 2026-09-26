import fs from 'node:fs/promises';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {InputError} from './package.mjs';
import {atomicWrite} from './store.mjs';
import {materialSourceRevision,assessCandidate} from './material-candidates.mjs';
import {effectiveContentCheck,asrDecodedScope} from './asr-checks.mjs';
import {createMaterialTools} from './material-tools.mjs';
import {createWorkerHost} from './workers/host.mjs';
import {createMediaWorker} from './workers/media.mjs';
import {createAsrWorker} from './workers/asr.mjs';
import {createAsrProvider} from './asr-provider.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const minimalRequest=request=>Object.fromEntries(['jobId','expectedEpoch','sourceRevision','toolId','inputAssetIds','parameters','budget','cancelToken'].map(key=>[key,request[key]]));
const unavailable=message=>{throw Object.assign(new InputError(message,503),{code:'tool_unavailable'});};

/** Host-only adapters keep paths, process setup and provider configuration outside tool messages. */
export async function createMaterialToolRuntime({store,inbox,repository,getJobs,asrWorkerFactory=createAsrWorker,ocrAdapter=null}={}){
  const contexts=new AsyncLocalStorage(),hosts=new Set(),runs=new Set();
  let mediaConfiguration=null;
  const mediaSettingsFile=path.join(store.dataDir,'media-host','configuration.json');
  try{const value=JSON.parse(await fs.readFile(mediaSettingsFile,'utf8'));if(typeof value.ffmpegPath==='string'&&typeof value.ffprobePath==='string')mediaConfiguration={ffmpegPath:value.ffmpegPath,ffprobePath:value.ffprobePath,confirmed:false};}catch{}
  const fullRequest=basic=>{const request=contexts.getStore();if(!request||request.jobId!==basic.jobId||request.expectedEpoch!==basic.expectedEpoch||request.sourceRevision!==basic.sourceRevision)throw new InputError('工具来源与当前宿主范围不匹配。',409);return request;};
  const assertCurrent=request=>getJobs().assertCurrent(request);
  async function resolveAsset(assetId,request){
    const job=assertCurrent(request),material=inbox.get(job.materialId),original=material.files.find(f=>f.id===assetId);
    let filename,info;
    if(original){filename=path.join(store.dataDir,'input-blobs',assetId);info=original;}
    else{
      const refs=job.scope.artifactRefs||[];let entry;
      for(const ref of refs){const value=await repository.readArtifact(ref);if(value.kind==='media'&&value.value?.blob?.id===assetId){entry=value.value;break;}}
      if(!entry)throw new InputError('资产不属于这项作业的原件或已验证派生范围。',403);
      filename=path.join(store.dataDir,'blobs',assetId);info={id:assetId,name:entry.name,size:entry.blob.size,mime:entry.blob.mime};
    }
    const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==info.size)throw new InputError('媒体资产大小或位置无效。',409);
    const bytes=await fs.readFile(filename);if(hash(bytes)!==assetId)throw new InputError('媒体原件完整性校验失败。',409);
    assertCurrent(request);return {...info,path:filename,hash:assetId,materialId:material.id,sourceRevision:materialSourceRevision(material)};
  }
  async function resolveCandidate(candidateId,request){const job=assertCurrent(request),set=await repository.load(job.materialId);return set.candidates.find(c=>c.candidateId===candidateId);}
  const publishArtifact=async(value,request)=>{assertCurrent(request);const ref=await repository.writeArtifact(value);assertCurrent(request);return ref;};
  async function runHost(host,jobId,signal,budget,work){hosts.add(host);const promise=host.run({jobId,signal,budget},work);runs.add(promise);try{return await promise;}finally{runs.delete(promise);if(!host.busy())hosts.delete(host);}}
  const asr=await createAsrProvider({dataDir:store.dataDir,artifactDir:path.join(store.dataDir,'tool-staging','asr'),
    resolveAsset:(assetId,basic)=>resolveAsset(assetId,fullRequest(basic)),assertCurrent:basic=>assertCurrent(fullRequest(basic)),
    publishArtifact:async({bytes,hash:expectedHash,request:basic})=>{if(hash(bytes)!==expectedHash)throw new InputError('转写产物 hash 不符。',409);return publishArtifact(JSON.parse(bytes),fullRequest(basic));},
    workerFactory:options=>{
      const host=createWorkerHost({executablePaths:[options.configuration.interpreter]});
      const worker=asrWorkerFactory({...options,spawnProcess:host.spawnProcess});
      return {...worker,selfTest:signal=>runHost(host,'asr-selftest',signal,{timeoutMs:180000,maxMemoryBytes:12*1024**3},()=>worker.selfTest(signal)),runMaterialTool:request=>runHost(host,request.jobId,request.cancelToken,request.budget,()=>worker.runMaterialTool(request))};
    },
  });
  const adapters={
    'assets.list':async(p,{job,request})=>{const records=[];for(const id of job.scope.assetIds.slice(p.offset,p.offset+p.limit)){const asset=await resolveAsset(id,request);records.push({assetId:id,name:asset.name,mime:asset.mime,size:asset.size});}return {state:'completed',assets:records,total:job.scope.assetIds.length,offset:p.offset,nextOffset:p.offset+records.length<job.scope.assetIds.length?p.offset+records.length:null,artifactRefs:[]};},
    'source.read':async(p)=>{const artifact=await repository.readArtifact(p.artifactRef),blocks=artifact.value?.documentLayout?.blocks||[];const block=blocks.find(block=>block.id===p.blockId);if(!block||typeof block.text!=='string'||p.end>block.text.length)throw new InputError('来源段落或字符范围不存在。',403);return {state:'completed',text:block.text.slice(p.start,p.end),artifactRefs:[],evidence:[{artifactRef:p.artifactRef,blockId:p.blockId,start:p.start,end:p.end}]};},
    'candidates.validate':async(p,{job})=>{const loaded=await repository.load(job.materialId);return {state:'completed',candidates:p.candidateIds.map(id=>{const candidate=loaded.candidates.find(c=>c.candidateId===id);return {candidateId:id,revision:candidate.revision,...assessCandidate(candidate,loaded.artifactIndex,1,{workspaceEpoch:job.workspaceEpoch})};}),artifactRefs:[]};},
    'mapping.propose':async p=>({state:'completed',mapping:{...p,mappingState:'proposed',contentCheckState:'notChecked'},artifactRefs:[]}),
    'draft.patch':async p=>({state:'completed',patch:p,artifactRefs:[]}),
    'media.transcribe':async(p,{request})=>contexts.run(request,()=>asr.runMaterialTool(minimalRequest(request))),
  };
  for(const toolId of ['media.probe','media.canonicalize'])adapters[toolId]=async(p,{request})=>{
    if(!mediaConfiguration?.confirmed)unavailable('FFmpeg 本机工具尚未确认配置；不会搜索或下载程序。');
    const configuration={...mediaConfiguration},host=createWorkerHost({executablePaths:[configuration.ffmpegPath,configuration.ffprobePath]});
    const artifactDir=path.join(store.dataDir,'tool-staging','media');
    const worker=createMediaWorker({...configuration,artifactDir,resolveAsset:id=>resolveAsset(id,request),spawnProcess:host.spawnProcess});
    const basic=minimalRequest(request);basic.toolId=toolId==='media.canonicalize'?'media.playback':'media.probe';basic.budget=Object.fromEntries(['timeoutMs','maxOutputBytes','maxDurationSeconds'].map(key=>[key,request.budget[key]]));
    const result=await runHost(host,request.jobId,request.cancelToken,request.budget,()=>worker.runMaterialTool(basic));
    const artifactRefs=[];
    for(const artifact of result.artifactRefs||[]){
      if(!artifact.hostPath){artifactRefs.push(artifact);continue;}
      const filename=path.resolve(artifact.hostPath),allowedRoot=path.resolve(artifactDir)+path.sep;if(!filename.startsWith(allowedRoot))throw new InputError('媒体派生文件超出宿主临时目录。',500);
      const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==artifact.size)throw new InputError('媒体派生产物无效。',500);const bytes=await fs.readFile(filename);if(hash(bytes)!==artifact.assetId)throw new InputError('媒体派生产物完整性失败。',500);
      const blob=await store.writeBlob(bytes,artifact.mime),ref=await publishArtifact({kind:'media-derivative',value:{blob,parentHash:artifact.parentHash,recipeVersion:artifact.recipeVersion,name:artifact.name},dependencyRefs:[]},request);artifactRefs.push(ref);await fs.unlink(filename);
    }
    const {artifactRefs:unused,...publicResult}=result;return {...publicResult,artifactRefs};
  };
  if(ocrAdapter)for(const toolId of ['document.render','document.ocr'])adapters[toolId]=async(p,{request})=>contexts.run(request,()=>ocrAdapter({
    request:{...minimalRequest(request),parameters:{language:'eng',pages:p.pages},budget:{timeoutMs:request.budget.timeoutMs,maxPages:p.pages.length,maxPixels:request.budget.maxPixels,maxOutputBytes:request.budget.maxOutputBytes,maxMemoryBytes:request.budget.maxMemoryBytes||805306368}},
    resolveAsset:(assetId,basic)=>resolveAsset(assetId,fullRequest(basic)),checkGuard:basic=>assertCurrent(fullRequest(basic)),
  }));
  const tools=createMaterialTools({assertCurrent,resolveAsset,resolveCandidate,adapters,publishArtifact,workerHost:{run:(_options,work)=>work(),cancel:async jobId=>{await Promise.all([...hosts].map(host=>host.cancel(jobId)));}}});
  async function configureMedia(input){
    if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['ffmpegPath','ffprobePath','confirmed'].includes(key))||input.confirmed!==true)throw new InputError('请明确确认固定本机媒体程序。');
    for(const key of ['ffmpegPath','ffprobePath']){if(typeof input[key]!=='string'||!path.isAbsolute(input[key]))throw new InputError('媒体程序须为明确的本机绝对路径。');const stat=await fs.lstat(input[key]);if(!stat.isFile()||stat.isSymbolicLink())throw new InputError('媒体程序路径无效。');}
    if(runs.size)throw new InputError('本机工具运行期间不能更换程序。',409);
    await atomicWrite(mediaSettingsFile,JSON.stringify({ffmpegPath:path.resolve(input.ffmpegPath),ffprobePath:path.resolve(input.ffprobePath),confirmed:false}));mediaConfiguration={...input};return view();
  }
  function view(){return {media:mediaConfiguration?{...mediaConfiguration}:null,ocr:{available:Boolean(ocrAdapter),language:'eng'},asr:asr.view(),tools:tools.available().map(item=>({...item,available:item.toolId.startsWith('media.')&&item.toolId!=='media.transcribe'?Boolean(mediaConfiguration?.confirmed):item.toolId==='media.transcribe'?asr.view().state==='ready':item.available})),networkIsolation:'not_verified',memory:'sampled_native_process_memory'};}
  async function quiesce(){asr.cancel();await Promise.all([...hosts].flatMap(host=>['asr-selftest',...getJobs()?.list?.().map(job=>job.jobId)||[]].map(id=>host.cancel(id))));await Promise.allSettled([...runs]);}
  async function close(){await quiesce();asr.disable();if(mediaConfiguration)mediaConfiguration.confirmed=false;}
  async function describeMaterial(materialId){
    const material=inbox.get(materialId),assets=new Map(material.files.map(file=>[file.id,{assetId:file.id,name:file.name,mime:file.mime,size:file.size,origin:'original'}]));
    let loaded;try{loaded=await repository.load(materialId);}catch(error){if(error.status!==404)throw error;}
    for(const entry of Object.values(loaded?.artifactIndex||{}))if(entry.kind==='media')assets.set(entry.value.blob.id,{assetId:entry.value.blob.id,name:entry.value.name,mime:entry.value.blob.mime,size:entry.value.blob.size,origin:'candidate',durationSeconds:entry.value.evidence?.actualDurationSeconds??null});
    return {assets:[...assets.values()],candidates:(loaded?.candidates||[]).map(candidate=>({candidateId:candidate.candidateId,revision:candidate.revision,label:`原题 ${candidate.sourceQuestionNumber??candidate.originalOrdinalInTask??'序号未知'}`,answerType:candidate.answerType})),expectedSetRevision:loaded?.revision||0};
  }
  async function readMaterialAsset(materialId,assetId){
    const described=await describeMaterial(materialId),asset=described.assets.find(a=>a.assetId===assetId);if(!asset)throw new InputError('此媒体不属于当前材料。',404);
    const filename=path.join(store.dataDir,asset.origin==='original'?'input-blobs':'blobs',assetId),stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==asset.size)throw new InputError('媒体文件不可用。',404);const bytes=await fs.readFile(filename);if(hash(bytes)!==assetId)throw new InputError('媒体原件完整性校验失败。',409);return {bytes,mime:asset.mime};
  }
  async function evidence(materialId,{author=false}={}){
    const snapshot=store.read();let loaded;try{loaded=await repository.load(materialId,{state:snapshot});}catch(error){if(error.status!==404)throw error;return [];}
    const result=[];
    for(const candidate of loaded.candidates)for(const ref of candidate.dependencyRefs){const entry=loaded.artifactIndex[ref];if(entry?.kind==='asr-comparison'){
      const mapping=candidate.mappings.find(item=>item.contentCheckRef===ref),derived=mapping?effectiveContentCheck(candidate,mapping,loaded.artifactIndex,{workspaceEpoch:snapshot.workspaceEpoch}):{state:'notChecked',checkApplied:false,reason:entry.value.retracted?'CHECK_RETRACTED':'HISTORICAL_CHECK'};
      result.push({kind:'asr-comparison',evidenceRef:ref,candidateId:candidate.candidateId,candidateRevision:candidate.revision,state:derived.state,checkApplied:derived.checkApplied,reason:derived.reason,retracted:entry.value.retracted,...(author?{evidence:entry.value}:{})});
    }}
    const compared=new Set(Object.values(loaded.artifactIndex).filter(entry=>entry.kind==='asr-comparison').flatMap(entry=>[entry.value.asrEvidenceRef,...entry.dependencyRefs.filter(ref=>loaded.artifactIndex[ref]?.kind==='asr-segments')]));
    for(const [ref,entry] of Object.entries(loaded.artifactIndex))if(entry.kind==='asr-segments'&&!compared.has(ref)){
      let scope;try{scope=asrDecodedScope(entry.value.timeRange,entry.value.durationSeconds);}catch{}
      const partial=entry.value.state==='partial'||scope&&!scope.rangeComplete;
      result.push({kind:'asr-segments',evidenceRef:ref,state:partial?'partial':'notChecked',checkApplied:false,reason:entry.checkNotApplied?.reason||(partial?'ASR_DECODED_RANGE_INCOMPLETE':null),...(author?{transcript:entry.value.transcript,actual:entry.value.actual,issues:entry.value.issues,assetId:entry.value.originalAssetId,requestedRange:scope?.requestedRange||null,sourceRange:scope?.decodedRange||null,rangeComplete:scope?.rangeComplete??false,rangePrecision:scope?.rangePrecision||null}:{})});
    }
    return result;
  }
  return {tools,asr:{...asr,quiesce},view,configureMedia,quiesce,close,resolveAsset,describeMaterial,readMaterialAsset,evidence};
}
