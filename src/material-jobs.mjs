import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import {InputError} from './package.mjs';
import {executionBudget,synchronizeExecutionLedger,unacknowledgedExecutions,acknowledgeExecutions} from './material-execution-ledger.mjs';
import {materialJobRootEdges} from './processing-edges.mjs';

// Hard ceilings a job may be approved for; the plan never exceeds 200 blocks.
export const MATERIAL_JOB_LIMITS=Object.freeze({maxRequests:200,maxInputPerRequest:24000,maxInputTokens:4800000,maxOutputTokens:1638400,maxFormatRepairs:1,maxToolTextBytes:16384,maxDurationMs:60*60*1000,maxRetriesPerChunk:2});
/** Default approval scales with the planned blocks: every block may need a
 * split, a retry or a repair, so a 22-block paper is not capped at 20 requests. */
export function defaultJobLimits(blockCount,binding={}){
  const cap=MATERIAL_JOB_LIMITS,requests=Math.min(cap.maxRequests,Math.max(1,blockCount)*2+4);
  return {...cap,maxRequests:requests,maxInputTokens:Math.min(cap.maxInputTokens,requests*cap.maxInputPerRequest),maxOutputTokens:Math.min(cap.maxOutputTokens,requests*(binding.maxOutputTokens||3000)),maxDurationMs:Math.min(cap.maxDurationMs,Math.max(15*60*1000,requests*(binding.timeoutSeconds||60)*1000))};
}
const clone=value=>structuredClone(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error=(code,message,status=409)=>Object.assign(new InputError(message,status),{code});
const millis=()=>Date.now();
const failDetails=(code,extra={})=>({code,...extra});
const pauseStates=new Set(['failed','request_outcome_unknown','cancelled','interrupted','needs_review','needs_information','budget_exhausted']);
const terminalChunks=new Set(['completed','superseded']);
const isObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
/** Rough size of a block's structured reply: its own (unshared) source text,
 * about 4 bytes per token plus JSON overhead, and per-question fields. Observed
 * replies ran at 0.7-0.9 of the actual input tokens. */
export function estimatedOutputTokens(payload){
  const shared=new Set(payload?.sharedBlockIds||[]);
  const own=Array.isArray(payload?.blocks)?payload.blocks.filter(block=>!shared.has(block.id)).reduce((sum,block)=>sum+Buffer.byteLength(String(block.text||'')),0):Buffer.byteLength(String(payload?.text||''));
  return Math.ceil(own/4*1.2)+80*(Array.isArray(payload?.questions)?payload.questions.length:1);
}
const jobSchema=JSON.parse(readFileSync(new URL('../schemas/material-job.v1.json',import.meta.url),'utf8'));
const validateJob=new Ajv({strict:true,allErrors:true,useDefaults:false,coerceTypes:false,removeAdditional:false}).compile(jobSchema);

export function validateMaterialJobs(state){
  if(state.materialJobs===undefined)return;
  const invalid=()=>{throw error('invalid_material_jobs','持久作业记录格式或预算账本无效；原工作区文件已保留。',500);};
  if(!isObject(state.materialJobs))invalid();
  for(const [id,job] of Object.entries(state.materialJobs)){
    if(!validateJob(job)||job.jobId!==id||Object.entries(MATERIAL_JOB_LIMITS).some(([key,max])=>job.budget.limits[key]<1||job.budget.limits[key]>max))invalid();
    if(!['queued','running','completed','completed_with_pending',...pauseStates].includes(job.state))invalid();
    const chunks=new Map(job.chunks.map(chunk=>[chunk.chunkId,chunk]));
    if(chunks.size!==job.chunks.length||new Set(job.requests.map(request=>request.requestId)).size!==job.requests.length)invalid();
    for(const chunk of job.chunks){
      if(!['pending','running',...terminalChunks,...pauseStates].includes(chunk.state)||chunk.formatRepairCount>job.budget.limits.maxFormatRepairs||chunk.retryCount>job.budget.limits.maxRetriesPerChunk)invalid();
      if(chunk.parentId&&!chunks.get(chunk.parentId)?.childIds.includes(chunk.chunkId)||chunk.childIds.some(id=>chunks.get(id)?.parentId!==chunk.chunkId))invalid();
    }
    for(const request of job.requests){
      if(!chunks.has(request.chunkId)||request.generation>job.generation||request.usageKnown!==(request.usage!==null)||request.usageKnown&&['reserved','in_flight','not_sent'].includes(request.state)||request.outcomeUnknown!==(request.state==='outcome_unknown'))invalid();
    }
    // Stored totals are a cache of the immutable request ledger, never separate
    // authority that a restore or continuation may use to release spent budget.
    const calculated=executionBudget(job,state.materialExecutionLedger);
    for(const [key,value] of Object.entries(calculated))if(!Number.isSafeInteger(value)||value!==job.budget[key])invalid();
    if(job.requests.filter(request=>request.state!=='not_sent').length>job.budget.limits.maxRequests)invalid();
  }
}

export function materialJobReferences(state){
  validateMaterialJobs(state);return [...new Set(materialJobRootEdges(state).map(edge=>edge.ref))];
}

/** Account only the runtime actually observed when the export is captured.
 * Neither the live writer nor the later age of this backup is running time. */
export function snapshotMaterialJobs(state,{now=Date.now()}={}){
  validateMaterialJobs(state);if(!Number.isSafeInteger(now)||now<0)throw error('invalid_snapshot_time','备份快照时间无效。',400);
  const snapshot=clone(state);
  for(const job of Object.values(snapshot.materialJobs||{}))if(job.run){const until=Math.min(now,job.run.deadlineAt);job.budget.elapsedMs+=Math.max(0,until-job.run.lastAccountedAt);job.run.lastAccountedAt=Math.max(job.run.lastAccountedAt,until);}
  synchronizeExecutionLedger(snapshot);validateMaterialJobs(snapshot);return snapshot;
}

/** Restore is a new authority, never a replay instruction or a budget reset. */
export function rebaseMaterialJobs(state,newEpoch,{previous}={}){
  validateMaterialJobs(state);
  if(typeof newEpoch!=='string'||!newEpoch)throw error('invalid_workspace_epoch','恢复版本无效。');
  synchronizeExecutionLedger(state,{previous,restoring:true});
  for(const job of Object.values(state.materialJobs||{})){
    job.workspaceEpoch=newEpoch;job.generation++;
    job.run=null;const unknown=unacknowledgedExecutions(state,job.jobId)>0;
    for(const chunk of job.chunks)if(['running','request_outcome_unknown'].includes(chunk.state))chunk.state=unknown?'request_outcome_unknown':'interrupted';
    if(!['completed','completed_with_pending'].includes(job.state)){
      if(unknown){job.state='request_outcome_unknown';job.lastError=failDetails('request_outcome_unknown');}else if(['queued','running','request_outcome_unknown'].includes(job.state)){job.state='interrupted';job.lastError=failDetails('workspace_restore');}
    }
    job.expectedSetRevision=state.candidateSets?.[job.materialId]?.revision||0;
  }
  synchronizeExecutionLedger(state);validateMaterialJobs(state);
  return state;
}

export function normalizeJobLimits(input={},defaults=MATERIAL_JOB_LIMITS){
  if(!isObject(input)||Object.keys(input).some(key=>!Object.hasOwn(MATERIAL_JOB_LIMITS,key)))throw error('invalid_budget','作业预算字段无效。',400);
  const result={...defaults};
  for(const [key,value] of Object.entries(input)){if(!Number.isSafeInteger(value)||value<1||value>MATERIAL_JOB_LIMITS[key])throw error('invalid_budget','作业预算须在本次允许上限内。',400);result[key]=value;}
  return result;
}

function recalculate(job){
  const budget=job.budget;
  for(const name of ['requestCount','reservedInput','reservedOutput','knownInput','knownOutput','unknownInput','unknownOutput'])budget[name]=0;
  for(const request of job.requests){
    if(request.state==='not_sent')continue;
    budget.requestCount++;
    if(request.usageKnown){budget.knownInput+=request.usage.inputTokens;budget.knownOutput+=request.usage.outputTokens;}
    else if(['reserved','in_flight'].includes(request.state)){budget.reservedInput+=request.reservation.input;budget.reservedOutput+=request.reservation.output;}
    else{budget.unknownInput+=request.reservation.input;budget.unknownOutput+=request.reservation.output;}
  }
  budget.chargedInput=budget.reservedInput+budget.knownInput+budget.unknownInput;
  budget.chargedOutput=budget.reservedOutput+budget.knownOutput+budget.unknownOutput;
}

function settle(job,requestId,output,time){
  const request=job.requests.find(item=>item.requestId===requestId);if(!request)return;
  // A known settlement is final; duplicate or older replies cannot charge twice.
  if(request.usageKnown)return;
  request.httpStatus=Number.isInteger(output.httpStatus)?output.httpStatus:null;
  request.finishReason=output.finishReason||null;
  request.code=output.code||null;
  request.outcomeUnknown=output.outcomeUnknown===true;
  request.usageKnown=output.usageKnown===true&&Number.isSafeInteger(output.usage?.inputTokens)&&output.usage.inputTokens>=0&&Number.isSafeInteger(output.usage?.outputTokens)&&output.usage.outputTokens>=0;
  request.usage=request.usageKnown?clone(output.usage):null;
  request.state=!output.requestStarted?'not_sent':request.outcomeUnknown?'outcome_unknown':'settled';
  request.settledAt=time;recalculate(job);
}

/** One scheduler, immutable inputs, and one writer for candidate/checkpoint/cost publication. */
export function createMaterialJobs({store,models,repository,sourceProvider,sourceRevisionOf,prepareChunk,applyChunk,applyTool,splitChunk,tools,clock=millis,sleep=(ms,signal)=>new Promise((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);reject(error('cancelled','作业已取消。'));};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
})}={}){
  if(!store?.transact||!models?.prepareStructured||!repository?.writeArtifact||!repository?.commitPrepared||typeof sourceProvider!=='function'||typeof sourceRevisionOf!=='function'||typeof prepareChunk!=='function'||typeof applyChunk!=='function')throw new TypeError('Material jobs require host source, candidate and transport adapters.');
  const previews=new Map(),active=new Map(),admissions=new Set();let stopped=false,paused=false,admissionGeneration=0,queue=Promise.resolve();
  const assertAdmitted=lease=>{if(stopped||paused||lease.generation!==admissionGeneration||lease.controller.signal.aborted)throw error('jobs_stopped','材料作业已暂停；本次准备或启动未继续。');};
  const admit=work=>{
    if(stopped||paused)return Promise.reject(error('jobs_stopped','材料作业当前已暂停。'));
    let finish;const lease={generation:admissionGeneration,controller:new AbortController(),done:new Promise(resolve=>{finish=resolve;})};admissions.add(lease);
    return Promise.resolve().then(()=>work(lease)).then(value=>{assertAdmitted(lease);return value;},failure=>{assertAdmitted(lease);throw failure;}).finally(()=>{admissions.delete(lease);finish();});
  };
  const get=(state,id)=>{const job=state.materialJobs?.[id];if(!job)throw error('job_not_found','找不到这项材料作业。',404);return job;};
  const material=(state,id)=>{const value=state.materials.find(m=>m.id===id);if(!value)throw error('material_not_found','原材料不存在。',404);return value;};
  const guard=(state,id,epoch,generation,checkSource=true)=>{
    if(state.workspaceEpoch!==epoch)throw error('stale_workspace','工作区已恢复；旧作业不能继续写入。');
    const job=get(state,id);if(job.workspaceEpoch!==epoch)throw error('stale_workspace','这项作业来自恢复前的工作区，不能直接继续。');
    if(generation!==undefined&&job.generation!==generation)throw error('stale_job','作业版本已改变；旧结果未采用。');
    if(checkSource&&sourceRevisionOf(material(state,job.materialId))!==job.sourceRevision)throw error('stale_source','原材料版本已改变；旧作业未采用。');
    return job;
  };
  const account=(job,time)=>{
    if(job.run?.lastAccountedAt!==null&&job.run?.lastAccountedAt!==undefined){const until=Math.min(time,job.run.deadlineAt);job.budget.elapsedMs+=Math.max(0,until-job.run.lastAccountedAt);job.run.lastAccountedAt=until;}
    job.updatedAt=time;
  };
  const stopRun=(job,time)=>{account(job,time);job.run=null;};
  const budgetAvailable=job=>job.budget.requestCount<job.budget.limits.maxRequests&&job.budget.chargedInput<job.budget.limits.maxInputTokens&&job.budget.chargedOutput<job.budget.limits.maxOutputTokens&&job.budget.elapsedMs<job.budget.limits.maxDurationMs;
  const transact=(epoch,work)=>store.transact(state=>{const result=work(state);synchronizeExecutionLedger(state);validateMaterialJobs(state);return result;},{expectedEpoch:epoch});
  const ready=(async()=>{
    const epoch=store.captureEpoch(),snapshot=store.read();validateMaterialJobs(snapshot);
    if(!Object.values(snapshot.materialJobs||{}).some(j=>['running','queued'].includes(j.state)||j.requests?.some(r=>['reserved','in_flight'].includes(r.state))))return;
    await transact(epoch,state=>{for(const job of Object.values(state.materialJobs||{})){
      if(!['running','queued'].includes(job.state)&&!job.requests.some(r=>['reserved','in_flight'].includes(r.state)))continue;
      job.generation++;let unknown=false;
      for(const request of job.requests)if(['reserved','in_flight'].includes(request.state)){request.state='outcome_unknown';request.outcomeUnknown=true;request.code='request_outcome_unknown';unknown=true;}
      for(const chunk of job.chunks)if(chunk.state==='running')chunk.state=unknown?'request_outcome_unknown':'pending';
      stopRun(job,clock());job.state=unknown?'request_outcome_unknown':'interrupted';job.lastError=failDetails(unknown?'request_outcome_unknown':'process_interrupted');recalculate(job);
    }});
  })();

  function view(jobId){
    const snapshot=store.read(),job=get(snapshot,jobId);
    return {jobId:job.jobId,materialId:job.materialId,sourceRevision:job.sourceRevision,workspaceEpoch:job.workspaceEpoch,generation:job.generation,state:job.state,binding:clone(job.authorizedBinding),budget:clone(job.budget),scope:clone(job.scope),completedBlocks:job.chunks.filter(c=>c.state==='completed').length,totalBlocks:job.chunks.filter(c=>c.state!=='superseded').length,pendingCandidates:job.chunks.reduce((n,c)=>n+(c.pendingCount||0),0),candidateCount:job.chunks.reduce((n,c)=>n+(c.candidateCount||0),0),unknownRequests:unacknowledgedExecutions(snapshot,jobId),lastError:clone(job.lastError),chunks:job.chunks.map(({chunkId,sourceScope,sourceLabel,state,candidateCount=0,pendingCount=0,lastError,checkpointRef,conflictRef,resolution})=>({chunkId,sourceScope,sourceLabel,state,candidateCount,pendingCount,lastError,checkpointRef,conflictRef,resolution})),createdAt:job.createdAt,updatedAt:job.updatedAt};
  }
  async function prepare({materialId,expectedEpoch,expectedBinding,limits,localTool}={},lease){
    await ready;assertAdmitted(lease);store.assertEpoch(expectedEpoch);models.assertBinding(expectedBinding);
    normalizeJobLimits(limits);const plan=await sourceProvider({materialId,expectedEpoch,localTool,signal:lease.controller.signal});assertAdmitted(lease);store.assertEpoch(expectedEpoch);models.assertBinding(expectedBinding);
    if(!isObject(plan)||plan.materialId!==materialId||typeof plan.sourceRevision!=='string'||!Array.isArray(plan.chunks)||!plan.chunks.length||plan.chunks.length>200||!isObject(plan.scope)||!Array.isArray(plan.scope.assetIds))throw error('source_scope_unavailable','尚未取得可追踪的完整题组范围；请先补充或核对来源。',400);
    const normalizedLimits=normalizeJobLimits(limits,defaultJobLimits(plan.chunks.length,expectedBinding));
    if(plan.chunks.some(c=>!isObject(c)||typeof c.sourceScope!=='string'||!c.sourceScope||!Array.isArray(c.dependencyRefs)))throw error('source_scope_unavailable','题组或共享材料范围无效。',400);
    const current=material(store.read(),materialId);if(sourceRevisionOf(current)!==plan.sourceRevision)throw error('stale_source','来源在准备过程中发生变化，请重新准备。');
    const previewId=randomUUID(),scopeDigest=digest({materialId,sourceRevision:plan.sourceRevision,scope:plan.scope,chunks:plan.chunks,limits:normalizedLimits});
    if(previews.size>=50)previews.delete(previews.keys().next().value);
    previews.set(previewId,{plan:clone(plan),expectedEpoch,expectedBinding:clone(expectedBinding),expectedSetRevision:plan.expectedSetRevision??store.read().candidateSets?.[materialId]?.revision??0,limits:normalizedLimits,scopeDigest,createdAt:clock()});
    return {previewId,scopeDigest,materialId,sourceRevision:plan.sourceRevision,expectedEpoch,binding:clone(expectedBinding),scope:clone(plan.scope),limits:clone(normalizedLimits),totalBlocks:plan.chunks.length,blocks:plan.chunks.map(c=>({sourceScope:c.sourceScope,sourceIds:clone(c.sourceIds||[])})),...(localTool?{localOperation:{...clone(localTool),...(plan.chunks[0].localTool?.budget?{budget:clone(plan.chunks[0].localTool.budget)}:{})}}:{}),estimateMethod:'conservative_utf8_bytes_plus_envelope',remoteInput:localTool?'none_local_tool_only':'selected_extracted_text_only',providerContextVerified:false};
  }
  async function chunkRecord(payload,parentId=null){
    const scopeRef=await repository.writeArtifact(payload),inputHash=digest(payload);
    return {chunkId:randomUUID(),chunkKey:digest({sourceScope:payload.sourceScope,inputHash,processorVersion:1,outputSchemaVersion:1}),sourceScope:payload.sourceScope,sourceLabel:payload.sourceLabel||null,scopeRef,dependencyRefs:clone(payload.dependencyRefs),inputHash,parentId,childIds:[],state:'pending',formatRepairCount:0,retryCount:0,expectedSetRevision:null,expectedCandidateRevisions:[],checkpointRef:null,conflictRef:null,repairRef:null,candidateCount:0,pendingCount:0,lastError:null};
  }
  async function start({previewId,scopeDigest,expectedEpoch,expectedBinding,consent,materialId}={},lease){
    await ready;assertAdmitted(lease);if(consent!==true)throw error('consent_required','请确认整项作业的来源范围、服务与预算。',400);
    store.assertEpoch(expectedEpoch);models.assertBinding(expectedBinding);const preview=previews.get(previewId);
    if(!preview||materialId&&preview.plan.materialId!==materialId||preview.scopeDigest!==scopeDigest||preview.expectedEpoch!==expectedEpoch||digest(preview.expectedBinding)!==digest(expectedBinding)||clock()-preview.createdAt>30*60*1000)throw error('preview_stale','作业确认范围已经改变或过期，请重新准备。');
    previews.delete(previewId);
    const {plan,limits}=preview;let jobId=randomUUID(),created=false;const time=clock();
    const jobKey=digest([plan.materialId,plan.sourceRevision,'material-jobs-1',expectedBinding]);
    const sourceIndexRef=await repository.writeArtifact(plan.sourceIndex),chunks=[];assertAdmitted(lease);for(const chunk of plan.chunks){chunks.push(await chunkRecord(chunk));assertAdmitted(lease);}
    const planRef=await repository.writeArtifact({sourceIndexRef,chunks:chunks.map(c=>({sourceScope:c.sourceScope,scopeRef:c.scopeRef}))});assertAdmitted(lease);
    await transact(expectedEpoch,state=>{
      assertAdmitted(lease);
      models.assertBinding(expectedBinding);if(sourceRevisionOf(material(state,plan.materialId))!==plan.sourceRevision)throw error('stale_source','来源已变化。');
      const existing=Object.values(state.materialJobs||{}).find(j=>j.workspaceEpoch===expectedEpoch&&j.jobKey===jobKey&&j.consent.scopeDigest===scopeDigest);
      if(existing){jobId=existing.jobId;return;}
      if(Object.values(state.materialJobs||{}).some(j=>j.materialId===plan.materialId&&['queued','running'].includes(j.state)))throw error('job_active','这批材料已有作业，请等待或先取消。');
      const job={schemaVersion:1,jobId,materialId:plan.materialId,sourceRevision:plan.sourceRevision,pipelineVersion:'material-jobs-1',jobKey,workspaceEpoch:expectedEpoch,generation:1,expectedSetRevision:preview.expectedSetRevision,state:'queued',createdAt:time,updatedAt:time,initialBinding:clone(expectedBinding),authorizedBinding:clone(expectedBinding),consent:{scopeDigest,approvedAt:time,revision:1},scope:{...clone(plan.scope),sourceIndexRef,chunkPlanRef:planRef},budget:{limits:clone(limits),elapsedMs:0},chunks,requests:[],run:null,lastError:null};recalculate(job);(state.materialJobs??={})[jobId]=job;created=true;
    });assertAdmitted(lease);if(created)enqueue(jobId,expectedEpoch,1);return view(jobId);
  }
  function enqueue(jobId,epoch,generation){
    const controller=new AbortController();const operation={controller,generation,promise:null};active.set(jobId,operation);
    const pending=queue.then(()=>run(jobId,epoch,generation,controller));
    operation.promise=pending.catch(()=>{}).finally(()=>{if(active.get(jobId)===operation)active.delete(jobId);});queue=operation.promise;
  }
  async function publishFailure(jobId,epoch,generation,stateName,details,chunkId,requestId,output){
    await transact(epoch,state=>{const job=guard(state,jobId,epoch,generation);if(output&&requestId)settle(job,requestId,output,clock());if(chunkId){const chunk=job.chunks.find(c=>c.chunkId===chunkId);chunk.state=stateName;chunk.lastError=details;}job.state=stateName;job.lastError=details;stopRun(job,clock());});
  }
  // A failure confined to one block (unusable output, refusal, a scope too
  // large to send) marks only that block; the run moves on to the next one.
  // Failures that make every later request doubtful (unknown outcome, spent
  // budget, rejected credentials, provider outage, conflicts) still stop it.
  async function blockFailure(jobId,epoch,generation,chunkId,stateName,details,requestId,output){
    await transact(epoch,state=>{const job=guard(state,jobId,epoch,generation);if(output&&requestId)settle(job,requestId,output,clock());const chunk=job.chunks.find(c=>c.chunkId===chunkId);chunk.state=stateName;chunk.lastError=details;account(job,clock());});
  }
  async function splitCurrent(jobId,epoch,generation,chunk,payload,job,requestId,output){
    if(!splitChunk)return false;
    const children=await splitChunk({payload,job:clone(job),chunk:clone(chunk)});
    if(!Array.isArray(children)||children.length<2||children.length>100)return false;
    const seen=new Set(),allowed=new Set(payload.sourceIds||[]);
    if(children.some(child=>!Array.isArray(child.sourceIds)||!child.sourceIds.length||child.sourceIds.some(id=>!allowed.has(id)||seen.has(id)||(seen.add(id),false))||digest(child.dependencyRefs)!==digest(payload.dependencyRefs)||child.sharedText!==payload.sharedText)||seen.size!==allowed.size)throw error('invalid_split','不能在丢失或重复来源依赖的情况下拆分题组。',400);
    const childRecords=[];for(const child of children)childRecords.push(await chunkRecord(child,chunk.chunkId));
    await transact(epoch,state=>{const current=guard(state,jobId,epoch,generation);if(current.chunks.length+childRecords.length>1000)throw error('budget_exhausted','作业块数量超过保留上限。');if(output)settle(current,requestId,output,clock());const parent=current.chunks.find(c=>c.chunkId===chunk.chunkId);parent.state='superseded';parent.childIds=childRecords.map(c=>c.chunkId);current.chunks.push(...childRecords);account(current,clock());});return true;
  }
  async function run(jobId,epoch,generation,controller){
    let runTimer,streak=0;
    // Three sent blocks failing in a row points at the service or settings
    // (wrong endpoint, unsuitable model), not the material: stop spending.
    const tooManyFailures=async()=>{if(++streak<3)return false;await publishFailure(jobId,epoch,generation,'failed',failDetails('repeated_block_failures'));return true;};
    try{
      await ready;controller.signal.throwIfAborted();
      await transact(epoch,state=>{const job=guard(state,jobId,epoch,generation);if(!budgetAvailable(job))throw error('budget_exhausted','已达到本次批准的作业预算。');job.state='running';job.run={lastAccountedAt:clock(),deadlineAt:clock()+job.budget.limits.maxDurationMs-job.budget.elapsedMs};});
      const deadlineAt=get(store.read(),jobId).run.deadlineAt;runTimer=setTimeout(()=>controller.abort('job_deadline'),Math.max(1,deadlineAt-clock()));
      while(true){
        controller.signal.throwIfAborted();const currentState=store.read(),job=guard(currentState,jobId,epoch,generation);if(job.scope.executionMode!=='local_tool')models.assertBinding(job.authorizedBinding);
        if((currentState.candidateSets?.[job.materialId]?.revision||0)!==job.expectedSetRevision)throw error('candidate_revision_conflict','候选在排队期间已有更新，作业未发送。');
        const chunk=job.chunks.find(c=>c.state==='pending');if(!chunk)break;
        if(!budgetAvailable(job)||clock()>=deadlineAt){await publishFailure(jobId,epoch,generation,'budget_exhausted',failDetails('budget_exhausted'),chunk.chunkId);return;}
        const payload=await repository.readArtifact(chunk.scopeRef);controller.signal.throwIfAborted();
        if(payload.localTool){
          if(!tools||typeof applyTool!=='function')throw error('tool_unavailable','本机工具尚未接入。',503);
          const request={jobId,expectedEpoch:epoch,generation,sourceRevision:job.sourceRevision,expectedSetRevision:job.expectedSetRevision,...clone(payload.localTool),cancelToken:controller.signal};
          delete request.target;
          await transact(epoch,state=>{const current=guard(state,jobId,epoch,generation);current.chunks.find(c=>c.chunkId===chunk.chunkId).state='running';account(current,clock());});
          const result=await tools.runMaterialTool(request);controller.signal.throwIfAborted();
          const applied=await applyTool({job:clone(job),chunk:clone(chunk),payload,result,expectedSetRevision:job.expectedSetRevision,signal:controller.signal});
          const checkpointRef=await repository.writeArtifact({kind:'local-tool-checkpoint',toolId:request.toolId,result,candidateCount:applied.candidateCount||0,pendingCount:applied.pendingCount||0});
          await transact(epoch,state=>{const current=guard(state,jobId,epoch,generation);controller.signal.throwIfAborted();if((state.candidateSets?.[job.materialId]?.revision||0)!==current.expectedSetRevision)throw error('candidate_revision_conflict','候选版本已变化。');repository.commitPrepared(state,applied.prepared,{expectedEpoch:epoch});current.expectedSetRevision=state.candidateSets[job.materialId].revision;const block=current.chunks.find(c=>c.chunkId===chunk.chunkId);block.state='completed';block.checkpointRef=checkpointRef;block.candidateCount=applied.candidateCount||0;block.pendingCount=applied.pendingCount||0;account(current,clock());});continue;
        }
        const source=await prepareChunk({job:clone(job),chunk:clone(chunk),payload,signal:controller.signal,deadlineAt,tools});
        if(chunk.repairRef){const diagnostic=await repository.readArtifact(chunk.repairRef);source.messages=[...source.messages,{role:'assistant',content:String(diagnostic.text||'').slice(0,16384)},{role:'user',content:'上次输出不是符合指定 schema 的完整 JSON。仅按同一来源和 schema 返回完整对象，不增加或猜测资料。'}];}
        const outputLimit=Math.min(job.authorizedBinding.maxOutputTokens,job.budget.limits.maxOutputTokens-job.budget.chargedOutput);
        // A truncated reply is paid for in full and then discarded. Split first
        // when this block's own text would likely not fit the output limit.
        if(!chunk.repairRef&&estimatedOutputTokens(payload)>job.authorizedBinding.maxOutputTokens*0.8&&await splitCurrent(jobId,epoch,generation,chunk,payload,job))continue;
        let prepared;
        try{prepared=await models.prepareStructured({...source,expectedBinding:job.authorizedBinding,outputLimit});}
        catch(failure){
          if(failure.code!=='input_too_large')throw failure;
          if(Buffer.byteLength(payload.sharedText||'')+64>job.budget.limits.maxInputPerRequest){await blockFailure(jobId,epoch,generation,chunk.chunkId,'needs_information',failDetails('CONTEXT_DEPENDENCY_TOO_LARGE'));continue;}
          if(await splitCurrent(jobId,epoch,generation,chunk,payload,job))continue;
          await blockFailure(jobId,epoch,generation,chunk.chunkId,'needs_information',failDetails('input_context_budget_exceeded'));continue;
        }
        const input=prepared.inputEstimate.tokens;
        if(input>job.budget.limits.maxInputPerRequest&&Buffer.byteLength(payload.sharedText||'')+64>job.budget.limits.maxInputPerRequest){await blockFailure(jobId,epoch,generation,chunk.chunkId,'needs_information',failDetails('CONTEXT_DEPENDENCY_TOO_LARGE'));continue;}
        if(input>job.budget.limits.maxInputPerRequest&&await splitCurrent(jobId,epoch,generation,chunk,payload,job))continue;
        if(input>job.budget.limits.maxInputPerRequest){await blockFailure(jobId,epoch,generation,chunk.chunkId,'needs_information',failDetails('input_context_budget_exceeded'));continue;}
        if(input+job.budget.chargedInput>job.budget.limits.maxInputTokens||prepared.maxOutputTokens+job.budget.chargedOutput>job.budget.limits.maxOutputTokens){await publishFailure(jobId,epoch,generation,'budget_exhausted',failDetails('budget_exhausted'),chunk.chunkId);return;}
        const inputRef=await repository.writeArtifact(prepared.requestArtifact),requestId=randomUUID();let expectedSetRevision;
        await transact(epoch,state=>{
          const current=guard(state,jobId,epoch,generation);controller.signal.throwIfAborted();models.assertBinding(current.authorizedBinding);account(current,clock());
          if(!budgetAvailable(current)||input+current.budget.chargedInput>current.budget.limits.maxInputTokens||prepared.maxOutputTokens+current.budget.chargedOutput>current.budget.limits.maxOutputTokens)throw error('budget_exhausted','已达到批准预算。');
          const block=current.chunks.find(c=>c.chunkId===chunk.chunkId);expectedSetRevision=current.expectedSetRevision;if((state.candidateSets?.[current.materialId]?.revision||0)!==expectedSetRevision)throw error('candidate_revision_conflict','候选在准备期间已有更新，请求未发送。');block.expectedSetRevision=expectedSetRevision;block.expectedCandidateRevisions=clone(state.candidateSets?.[current.materialId]?.candidates?.map(c=>({candidateId:c.candidateId,revision:c.revision}))||[]);block.state='running';
          current.requests.push({requestId,chunkId:block.chunkId,generation,requestDigest:prepared.requestDigest,inputRef,binding:clone(prepared.binding),reservation:{input,output:prepared.maxOutputTokens},state:'reserved',startedAt:clock(),settledAt:null,usage:null,usageKnown:false,outcomeUnknown:false,httpStatus:null,finishReason:null,code:null});recalculate(current);
        });
        const output=await models.sendPrepared(prepared.handle,{consent:true,signal:controller.signal,deadlineAt});
        // Cost can settle for a cancelled generation, but only in its original epoch.
        try{guard(store.read(),jobId,epoch,generation);}catch(stale){if(store.read().workspaceEpoch===epoch)await transact(epoch,state=>{const current=guard(state,jobId,epoch,undefined,false);settle(current,requestId,output,clock());});return;}
        if(output.outcomeUnknown){await publishFailure(jobId,epoch,generation,'request_outcome_unknown',failDetails('request_outcome_unknown',{step:output.kind,httpStatus:output.httpStatus}),chunk.chunkId,requestId,output);return;}
        if(output.kind==='http_error'&&[408,425,429,500,502,503,504].includes(output.httpStatus)&&chunk.retryCount<job.budget.limits.maxRetriesPerChunk){
          await transact(epoch,state=>{const current=guard(state,jobId,epoch,generation);settle(current,requestId,output,clock());const block=current.chunks.find(c=>c.chunkId===chunk.chunkId);block.retryCount++;block.state='pending';account(current,clock());});await sleep(Math.min(30000,output.retryAfterMs??500*(chunk.retryCount+1)),controller.signal);continue;
        }
        if(output.kind==='length'){
          const diagnosticRef=await repository.writeArtifact({kind:'model-diagnostic',requestId,code:'length',text:typeof output.text==='string'?output.text:''});
          await transact(epoch,state=>{const current=guard(state,jobId,epoch,generation);current.requests.find(r=>r.requestId===requestId).diagnosticRef=diagnosticRef;});
          if(await splitCurrent(jobId,epoch,generation,chunk,payload,job,requestId,output))continue;
        }
        if(!['completed','empty'].includes(output.kind)){
          const details=failDetails(output.kind==='length'?'length_requires_smaller_scope':output.code||output.kind,{step:output.kind,httpStatus:output.httpStatus,finishReason:output.finishReason}),stateName=output.kind==='length'?'needs_information':'failed';
          // Content-specific outcomes and request-specific rejections (400/413/422)
          // concern this block only; everything else stops the whole job.
          const blockOnly=['length','refusal','incomplete','unsupported_tool_calls','invalid_envelope','response_too_large'].includes(output.kind)||output.kind==='http_error'&&[400,413,422].includes(output.httpStatus);
          if(blockOnly){await blockFailure(jobId,epoch,generation,chunk.chunkId,stateName,details,requestId,output);if(await tooManyFailures())return;continue;}
          await publishFailure(jobId,epoch,generation,stateName,details,chunk.chunkId,requestId,output);return;
        }
        let applied,parsed,invalid=false;
        try{parsed=JSON.parse(output.text||'');applied=await applyChunk({job:clone(job),chunk:clone(chunk),payload,output:parsed,expectedSetRevision,expectedCandidateRevisions:clone(get(store.read(),jobId).chunks.find(c=>c.chunkId===chunk.chunkId).expectedCandidateRevisions),signal:controller.signal});}
        catch(failure){if(failure.status===409){applied={conflict:true};}else invalid=true;}
        if(invalid){
          const repairRef=await repository.writeArtifact({kind:'model-diagnostic',requestId,code:'invalid_candidate_json',text:typeof output.text==='string'?output.text:''});
          await transact(epoch,state=>{const current=guard(state,jobId,epoch,generation);current.requests.find(r=>r.requestId===requestId).diagnosticRef=repairRef;});
          if(chunk.formatRepairCount<job.budget.limits.maxFormatRepairs){await transact(epoch,state=>{const current=guard(state,jobId,epoch,generation);settle(current,requestId,output,clock());const block=current.chunks.find(c=>c.chunkId===chunk.chunkId);block.repairRef=repairRef;block.formatRepairCount++;block.state='pending';account(current,clock());});continue;}
          await blockFailure(jobId,epoch,generation,chunk.chunkId,'failed',failDetails('invalid_candidate_json'),requestId,output);if(await tooManyFailures())return;continue;
        }
        const checkpointRef=await repository.writeArtifact({kind:applied.conflict?'candidate-conflict':'material-checkpoint',requestId,sourceScope:chunk.sourceScope,output:parsed,candidateCount:applied.candidateCount||0,pendingCount:applied.pendingCount||0});
        try{
          await transact(epoch,state=>{
            const current=guard(state,jobId,epoch,generation);controller.signal.throwIfAborted();models.assertBinding(current.authorizedBinding);if(applied.conflict)throw error('candidate_conflict','人工修订已改变，模型结果保留为待比较建议。');
            if((state.candidateSets?.[current.materialId]?.revision||0)!==expectedSetRevision)throw error('candidate_conflict','人工修订已改变，旧结果未覆盖。');
            repository.commitPrepared(state,applied.prepared,{expectedEpoch:epoch});current.expectedSetRevision=state.candidateSets[job.materialId].revision;settle(current,requestId,output,clock());const block=current.chunks.find(c=>c.chunkId===chunk.chunkId);block.state='completed';block.checkpointRef=checkpointRef;block.candidateCount=applied.candidateCount||0;block.pendingCount=applied.pendingCount||0;block.lastError=null;account(current,clock());
          });
          streak=0;
        }catch(failure){
          if(failure.status!==409)throw failure;
          await transact(epoch,state=>{const current=guard(state,jobId,epoch,generation);settle(current,requestId,output,clock());const block=current.chunks.find(c=>c.chunkId===chunk.chunkId);block.state='needs_review';block.conflictRef=checkpointRef;block.lastError=failDetails('candidate_revision_conflict');current.state='needs_review';current.lastError=block.lastError;stopRun(current,clock());});return;
        }
      }
      // Unfinished blocks keep the job continuable; Continue retries only them.
      await transact(epoch,state=>{const job=guard(state,jobId,epoch,generation),unfinished=job.chunks.filter(c=>pauseStates.has(c.state));
        if(unfinished.length){job.state=unfinished.every(c=>c.state==='needs_information')?'needs_information':'failed';job.lastError=failDetails('blocks_unfinished');}
        else{job.state=job.chunks.some(c=>c.pendingCount>0)?'completed_with_pending':'completed';job.lastError=null;}
        stopRun(job,clock());});
    }catch(failure){
      try{await transact(epoch,state=>{
        const job=guard(state,jobId,epoch,generation);let unknown=false;
        for(const request of job.requests)if(['reserved','in_flight'].includes(request.state)){request.state='outcome_unknown';request.outcomeUnknown=true;request.code='request_outcome_unknown';unknown=true;}
        job.state=unknown?'request_outcome_unknown':controller.signal.aborted?'interrupted':failure.code==='budget_exhausted'?'budget_exhausted':failure.code==='candidate_revision_conflict'?'needs_review':'failed';
        job.lastError=failDetails(unknown?'request_outcome_unknown':controller.signal.aborted?'job_interrupted':failure.code||'job_processing_failed');
        for(const chunk of job.chunks)if(chunk.state==='running'){chunk.state=job.state;chunk.lastError=job.lastError;}stopRun(job,clock());recalculate(job);
      });}catch{}
    }finally{clearTimeout(runTimer);}
  }
  async function cancel({jobId,expectedEpoch,expectedGeneration,reason='user_cancelled'}={}){
    await ready;store.assertEpoch(expectedEpoch);guard(store.read(),jobId,expectedEpoch,expectedGeneration,false);const operation=active.get(jobId);operation?.controller.abort(reason);await tools?.cancel?.(jobId);
    await transact(expectedEpoch,state=>{const job=guard(state,jobId,expectedEpoch,expectedGeneration,false);if(['completed','completed_with_pending'].includes(job.state))return;job.generation++;job.state=reason==='workspace_restore'?'interrupted':'cancelled';job.lastError=failDetails(reason==='workspace_restore'?'workspace_restore':'user_cancelled');for(const request of job.requests)if(['reserved','in_flight'].includes(request.state)){request.state='outcome_unknown';request.outcomeUnknown=true;request.code='request_outcome_unknown';}for(const chunk of job.chunks)if(chunk.state==='running')chunk.state=job.state;stopRun(job,clock());recalculate(job);});return view(jobId);
  }
  async function continueJob({jobId,expectedEpoch,expectedGeneration,expectedBinding,consent,acknowledgeUnknown=false,keepCurrentCandidates=false}={},lease){
    await ready;assertAdmitted(lease);store.assertEpoch(expectedEpoch);models.assertBinding(expectedBinding);if(consent!==true)throw error('consent_required','请确认继续作业的范围、服务与剩余预算。',400);
    let generation;
    await transact(expectedEpoch,state=>{assertAdmitted(lease);const job=guard(state,jobId,expectedEpoch,expectedGeneration);if(!pauseStates.has(job.state))throw error('job_not_paused','这项作业当前不能继续。');if(!budgetAvailable(job))throw error('budget_exhausted','原作业预算已用尽，继续不能重置预算。');if(unacknowledgedExecutions(state,jobId)&&acknowledgeUnknown!==true)throw error('unknown_confirmation_required','部分远程请求结果和费用未知；请明确确认后再继续。',400);
      acknowledgeExecutions(state,jobId,clock());
      if(job.state==='needs_review'){
        if(keepCurrentCandidates!==true)throw error('candidate_conflict_pending','请先确认保留当前人工版本；冲突建议不会自动采用。');
        for(const chunk of job.chunks)if(chunk.state==='needs_review'){chunk.state='completed';chunk.resolution='kept_current_candidates';}
        job.expectedSetRevision=state.candidateSets?.[job.materialId]?.revision||0;
      }
      job.generation++;generation=job.generation;job.authorizedBinding=clone(expectedBinding);job.consent.revision++;job.consent.approvedAt=clock();job.state='queued';job.lastError=null;job.updatedAt=clock();for(const chunk of job.chunks)if(!terminalChunks.has(chunk.state))chunk.state='pending';
    });assertAdmitted(lease);enqueue(jobId,expectedEpoch,generation);return view(jobId);
  }
  async function awaitIdle(){await ready;while(active.size)await Promise.allSettled([...active.values()].map(item=>item.promise));}
  async function pause({reason='workspace_restore'}={}){
    paused=true;admissionGeneration++;for(const lease of admissions)lease.controller.abort(reason);previews.clear();await ready;
    const epoch=store.captureEpoch();await Promise.all([...active.keys()].map(jobId=>cancel({jobId,expectedEpoch:epoch,reason})));
    await Promise.allSettled([...admissions].map(lease=>lease.done));await awaitIdle();
    // An admitted writer may have committed queued state just before its final
    // admission check failed. Drain it too, including on an unsuccessful restore.
    const queued=Object.values(store.read().materialJobs||{}).filter(job=>['queued','running'].includes(job.state));
    await Promise.all(queued.map(job=>cancel({jobId:job.jobId,expectedEpoch:epoch,reason})));previews.clear();
  }
  function resume(){if(stopped)throw error('jobs_stopped','应用已关闭，不能重新启用作业。');paused=false;}
  async function stop(){stopped=true;await pause({reason:'application_close'});}
  function assertCurrent(request){
    if(!request||!Number.isSafeInteger(request.generation??request.jobGeneration)||!Number.isSafeInteger(request.expectedSetRevision)||typeof request.sourceRevision!=='string')throw error('tool_guard_required','工具请求缺少来源、作业或候选版本保护。',428);
    const state=store.read(),job=guard(state,request.jobId,request.expectedEpoch,request.generation??request.jobGeneration);
    if(request.sourceRevision!==job.sourceRevision)throw error('stale_source','工具来源版本无效。');
    if((state.candidateSets?.[job.materialId]?.revision||0)!==request.expectedSetRevision)throw error('candidate_conflict','人工候选版本已变化。');
    return job;
  }
  return {ready,prepare:input=>admit(lease=>prepare(input,lease)),start:input=>admit(lease=>start(input,lease)),view,list:({materialId}={})=>Object.values(store.read().materialJobs||{}).filter(j=>!materialId||j.materialId===materialId).map(j=>view(j.jobId)),cancel,continue:input=>admit(lease=>continueJob(input,lease)),awaitIdle,stop,busy:()=>active.size>0||admissions.size>0,
    assertCurrent,pause,resume};
}
