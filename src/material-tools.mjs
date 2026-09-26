import Ajv from 'ajv';
import {InputError} from './package.mjs';

export const MATERIAL_TOOL_IDS=Object.freeze(['assets.list','source.read','document.render','document.ocr','media.probe','media.canonicalize','media.transcribe','mapping.propose','candidates.validate','draft.patch']);
const hash={type:'string',pattern:'^[a-f0-9]{64}$'};
const id={type:'string',minLength:1,maxLength:300};
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const number=(minimum,maximum)=>({type:'number',minimum,maximum});
const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const region=object({x:number(0,1),y:number(0,1),width:number(0.0001,1),height:number(0.0001,1)});
const documentParameters=object({language:{const:'eng'},pages:{type:'array',minItems:1,maxItems:4,items:object({page:integer(1,10000),region})}});
const text={type:['string','null'],maxLength:100000};
const fields={type:'object',additionalProperties:false,minProperties:1,properties:{prompt:text,answer:{anyOf:[text,{type:'array',maxItems:100,items:{type:'string',maxLength:20000}}]},explanation:text,transcript:text,options:{type:'array',maxItems:30,items:object({id,text:{type:'string',maxLength:20000}})}}};
const schemas={
  'assets.list':object({offset:integer(0,1000),limit:integer(1,100)}),
  'source.read':object({artifactRef:hash,blockId:id,start:integer(0,500000),end:integer(1,500000)}),
  'document.render':documentParameters,
  'document.ocr':documentParameters,
  'media.probe':object({}),
  'media.canonicalize':object({outputFormat:{const:'mp3'}}),
  'media.transcribe':object({startSeconds:number(0,7200),endSeconds:number(0.01,7200)}),
  'mapping.propose':object({candidateId:id,candidateRevision:integer(1,1000000),targetId:{enum:['audio','image','groupAudio','groupImage']},assetId:hash}),
  'candidates.validate':object({candidateIds:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:id}}),
  'draft.patch':object({candidateId:id,candidateRevision:integer(1,1000000),fields}),
};
const ajv=new Ajv({allErrors:true,strict:true,allowUnionTypes:true,useDefaults:false,coerceTypes:false,removeAdditional:false});
const validators=Object.fromEntries(Object.entries(schemas).map(([name,schema])=>[name,ajv.compile(schema)]));
const fail=(code,message,status=400)=>{throw Object.assign(new InputError(message,status),{code});};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const rootKeys=new Set(['jobId','expectedEpoch','generation','sourceRevision','expectedSetRevision','toolId','inputAssetIds','parameters','budget','cancelToken']);
const budgetCaps={timeoutMs:900000,maxOutputBytes:16*1024*1024,maxInputBytes:80*1024*1024,maxDurationSeconds:7200,maxPixels:40*1024*1024,maxMemoryBytes:8*1024*1024*1024};
const noAssets=new Set(['assets.list','source.read','candidates.validate','draft.patch']);

/** Preserve observed decoder facts without putting host paths in candidate CAS. */
export function mediaDecodeEvidence(evidence,probe,{derivedFrom}={}){
  if(!probe||probe.actualEngine!=='ffprobe+ffmpeg'||probe.actualDevice!=='cpu')return evidence;
  const duration=Number.isFinite(probe.actualDurationSeconds)&&probe.actualDurationSeconds>0?probe.actualDurationSeconds:null;
  return {...evidence,...(derivedFrom||evidence.derivativeRefs?.length?{derivedFrom:derivedFrom||evidence.originalHash}:{}),sourceRange:probe.decodeState==='playable'&&duration!==null?{startSeconds:0,endSeconds:duration}:null,decoderMetadata:{engine:probe.actualEngine,device:probe.actualDevice,codec:typeof probe.codec==='string'?probe.codec.slice(0,100):null,detectedFormat:typeof probe.detectedFormat==='string'?probe.detectedFormat.slice(0,30):null,actualDurationSeconds:duration,containerDurationSeconds:Number.isFinite(probe.containerDurationSeconds)?probe.containerDurationSeconds:null,pcmSampleRate:1000,pcmChannels:1,pcmSampleFormat:'s16le'}};
}

export function createMaterialTools({assertCurrent,resolveAsset,resolveCandidate,adapters={},publishArtifact,workerHost}={}){
  if(typeof assertCurrent!=='function'||typeof resolveAsset!=='function'||typeof publishArtifact!=='function')throw new TypeError('Material tools require host guards and artifact adapters.');
  const active=new Map();
  async function validate(request){
    if(!plain(request)||Object.keys(request).some(key=>!rootKeys.has(key))||!MATERIAL_TOOL_IDS.includes(request.toolId)||!Number.isSafeInteger(request.generation)||request.generation<1||!Number.isSafeInteger(request.expectedSetRevision)||request.expectedSetRevision<0)fail('invalid_tool_request','工具请求只允许固定操作与完整版本保护。');
    if(!validators[request.toolId](request.parameters))fail('invalid_tool_parameters','工具参数不允许命令、URL、路径或超范围字段。');
    if(!Array.isArray(request.inputAssetIds)||request.inputAssetIds.some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))||new Set(request.inputAssetIds).size!==request.inputAssetIds.length||(noAssets.has(request.toolId)?request.inputAssetIds.length!==0:request.inputAssetIds.length!==1))fail('invalid_tool_assets','工具只允许本次选定的内部资产。');
    const requiredBudget=['timeoutMs','maxOutputBytes','maxInputBytes','maxDurationSeconds',...(request.toolId.startsWith('document.')?['maxPixels']:[])];
    if(!plain(request.budget)||Object.entries(request.budget).some(([key,value])=>!Object.hasOwn(budgetCaps,key)||!Number.isFinite(value)||value<=0||value>budgetCaps[key])||requiredBudget.some(key=>!Object.hasOwn(request.budget,key)))fail('invalid_tool_budget','工具资源预算无效。');
    const job=await assertCurrent(request);
    if(!['running','queued'].includes(job.state)||!job.scope.allowedToolIds?.includes(request.toolId))fail('tool_not_approved','这项作业没有批准该工具。',403);
    if(request.toolId==='media.transcribe'&&job.scope.allowLocalAsr!==true)fail('asr_not_approved','本次作业尚未明确批准本地转写。',403);
    if(request.inputAssetIds.some(id=>!job.scope.assetIds.includes(id)))fail('asset_outside_scope','资产不属于这项作业的材料范围。',403);
    for(const id of request.inputAssetIds){const asset=await resolveAsset(id,request);if(!asset||asset.materialId!==job.materialId||asset.sourceRevision!==job.sourceRevision||asset.id!==id||!Number.isSafeInteger(asset.size)||asset.size>request.budget.maxInputBytes)fail('asset_outside_scope','资产归属或输入预算无效。',403);}
    const p=request.parameters,location=job.scope.regions?.[request.inputAssetIds[0]];
    if(request.toolId==='source.read'&&(!job.scope.artifactRefs?.includes(p.artifactRef)||p.end<=p.start||p.end-p.start>16384))fail('source_outside_scope','来源引用或读取区域超出范围。',403);
    if(request.toolId.startsWith('document.')){
      if(typeof adapters[request.toolId]!=='function')fail('tool_unavailable','英文 OCR／渲染工具当前不可用；不会自动下载。',503);
      if(p.pages.some(page=>page.region.x+page.region.width>1||page.region.y+page.region.height>1))fail('region_outside_scope','所选区域超出页面范围。',403);
      if(location?.rangeBasis==='explicit_page_selection_worker_dimensions'){
        if(Object.keys(location).some(key=>!['pageLimit','rangeBasis'].includes(key))||!Number.isSafeInteger(location.pageLimit)||location.pageLimit<1||location.pageLimit>200||p.pages.some(page=>page.page>location.pageLimit))fail('region_outside_scope','页码超出本次批准的范围。',403);
      }else if(!location||!Number.isSafeInteger(location.pages)||!Number.isFinite(location.width)||!Number.isFinite(location.height)||p.pages.some(page=>page.page>location.pages)||p.pages.reduce((sum,page)=>sum+Math.ceil(page.region.width*location.width)*Math.ceil(page.region.height*location.height),0)>request.budget.maxPixels)fail('region_outside_scope','页码、坐标或像素预算超出已确认区域。',403);
    }
    if(request.toolId==='media.transcribe'&&(!location||!Number.isFinite(location.durationSeconds)||p.endSeconds>location.durationSeconds||p.endSeconds<=p.startSeconds||p.endSeconds-p.startSeconds>request.budget.maxDurationSeconds))fail('region_outside_scope','转写时间范围尚未确认或超出预算。',403);
    const targets=p.candidateIds||p.candidateId&&[p.candidateId]||[];
    if(targets.length&&typeof resolveCandidate!=='function')fail('candidate_adapter_missing','候选版本检查尚未配置。',503);
    for(const target of targets){const candidate=await resolveCandidate(target,request);if(!candidate||candidate.materialId!==job.materialId||candidate.sourceRevision!==job.sourceRevision||p.candidateRevision!==undefined&&p.candidateRevision!==candidate.revision)fail('candidate_outside_scope','候选归属或人工修订版本已变化。',409);}
    if(request.toolId==='mapping.propose'&&(!request.inputAssetIds.includes(p.assetId)||!job.scope.assetIds.includes(p.assetId)))fail('asset_outside_scope','映射资产超出本次批准范围。',403);
    if(typeof adapters[request.toolId]!=='function')fail('tool_unavailable','这个可选本机工具尚不可用；已有原件与检查点保留。',503);
    await assertCurrent(request);
    return job;
  }
  async function runMaterialTool(input){
    const {cancelToken,...raw}=input||{};const request={...structuredClone(raw),cancelToken};
    const job=await validate(request);if(active.has(request.jobId))fail('tool_busy','该作业已有工具正在运行。',409);
    if(cancelToken?.aborted)fail('tool_cancelled','工具已取消。',409);
    const controller=new AbortController();const abort=()=>controller.abort('caller_cancelled');cancelToken?.addEventListener('abort',abort,{once:true});
    let rejectAbort;const cancelled=new Promise((_,reject)=>{rejectAbort=reject;});
    const onAbort=()=>rejectAbort(Object.assign(new InputError('工具已取消或达到时间预算。',409),{code:'tool_cancelled'}));controller.signal.addEventListener('abort',onAbort,{once:true});
    const timeoutMs=Math.min(request.budget.timeoutMs,job.run?.deadlineAt?job.run.deadlineAt-Date.now():job.budget.limits.maxDurationMs-job.budget.elapsedMs);
    if(timeoutMs<=0)fail('tool_budget_exhausted','作业时间预算已用尽。');
    const timer=setTimeout(()=>controller.abort('tool_timeout'),timeoutMs);
    const token={controller,promise:null};active.set(request.jobId,token);
    const operation=(async()=>{
      const context={request:{...request,cancelToken:controller.signal},job:structuredClone(job),signal:controller.signal,assertCurrent:()=>assertCurrent(request)};
      const run=()=>adapters[request.toolId](structuredClone(request.parameters),context);
      const result=workerHost?await workerHost.run({jobId:request.jobId,signal:controller.signal,budget:request.budget},run):await run();
      controller.signal.throwIfAborted();await assertCurrent(request);
      if(!plain(result)||!['completed','partial','unavailable','empty'].includes(result.state))fail('tool_protocol_invalid','本机工具返回格式无效。',502);
      const serialized=JSON.stringify(result);
      if(Buffer.byteLength(serialized)>request.budget.maxOutputBytes)fail('tool_output_budget','工具输出超过批准预算。',413);
      if(/"(?:hostPath|executable|interpreter|modelDirectory|apiKey|authorization)"\s*:/i.test(serialized))fail('tool_private_output','本机路径或配置不能进入工具返回。',502);
      if(Buffer.byteLength(serialized)<=Math.min(16384,job.budget.limits.maxToolTextBytes))return structuredClone(result);
      const ref=await publishArtifact({kind:'tool-result',toolId:request.toolId,parentAssetIds:request.inputAssetIds,...result},request);
      controller.signal.throwIfAborted();await assertCurrent(request);
      return {state:result.state,paged:true,artifactRefs:[ref],textBytes:Buffer.byteLength(result.text||''),actualEngine:typeof result.actualEngine==='string'?result.actualEngine.slice(0,100):null,actualDevice:typeof result.actualDevice==='string'?result.actualDevice.slice(0,100):null};
    })();
    token.promise=Promise.race([operation,cancelled]);
    try{return await token.promise;}finally{clearTimeout(timer);cancelToken?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);if(active.get(request.jobId)===token)active.delete(request.jobId);}
  }
  async function cancel(jobId){const operation=active.get(jobId);operation?.controller.abort('user_cancelled');await workerHost?.cancel?.(jobId);if(operation)await operation.promise.catch(()=>{});}
  return {runMaterialTool,cancel,validate,available:()=>MATERIAL_TOOL_IDS.map(toolId=>({toolId,available:typeof adapters[toolId]==='function'}))};
}
