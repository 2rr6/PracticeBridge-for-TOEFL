import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createOcrWorker} from './workers/ocr.mjs';
import {OCR_LIMITS,hash,ocrError,validateOcrRequest,assertNoOcrPathLinks} from './ocr-policy.mjs';
import {prepareOcrCandidateSet} from './ocr-candidates.mjs';
import {materialSourceRevision} from './material-candidates.mjs';

const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const completedJobs=new Set(['completed','completed_with_pending']);
const documentTools=new Set(['document.ocr','document.render']);
const evidenceStates=new Set(['needs_review','empty','text_layer','rendered','unavailable','failed']);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,keys)=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
const fail=(code,message,status=409)=>{throw ocrError(code,message,status);};
const baseKeys=['materialId','expectedEpoch','sourceRevision','expectedSetRevision'];
export const OCR_HUMAN_REVIEW_FIELDS=Object.freeze(['completeQuestion','completeDependencies','readable','answerSafe','fieldsConfirmed','criticalDifferencesResolved']);

/** Host-only bridge. Only `adapter` is passed to T06's fixed tool runtime.
 * `authorizeHuman(context)` must inspect server-created authentication context,
 * never request JSON or a model-supplied flag. Author methods are not tools. */
export function createMaterialOcr({store,repository,getJobs,ocrService,authorizeHuman,workerFactory=createOcrWorker,clock=Date.now}={}){
  if(!store?.read||!store?.transact||!repository?.readArtifact||!repository?.commitPrepared||typeof getJobs!=='function'||typeof authorizeHuman!=='function'||!ocrService?.status||!path.isAbsolute(ocrService.assetDir||'')||!path.isAbsolute(ocrService.artifactDir||''))throw TypeError('Material OCR requires fixed host services and authenticated human authority.');
  let service=ocrService,paused=false,generation=0;
  const active=new Set(),sessions=new Map();
  const assertRunning=(version,signal)=>{if(paused||generation!==version||signal?.aborted)fail('OCR_CANCELLED','本次 OCR 操作已停止，请重新打开材料。');};
  function tracked(work){
    if(paused)return Promise.reject(ocrError('OCR_PAUSED','材料 OCR 正在停止或恢复。',503));
    const version=generation,controller=new AbortController(),entry={controller,promise:null};
    entry.promise=Promise.resolve().then(()=>work({signal:controller.signal,check:()=>assertRunning(version,controller.signal)}));
    active.add(entry);entry.promise.then(()=>active.delete(entry),()=>active.delete(entry));return entry.promise;
  }
  async function human(context){if(await authorizeHuman(context)!==true)fail('OCR_HUMAN_REQUIRED','此操作只允许已认证的人工作者校对。',403);}
  function validateBase(input,additional=[]){
    if(!exact(input,[...baseKeys,...additional])||typeof input.materialId!=='string'||!input.materialId||input.materialId.length>200||!UUID.test(input.expectedEpoch||'')||!HASH.test(input.sourceRevision||'')||!Number.isSafeInteger(input.expectedSetRevision)||input.expectedSetRevision<0)fail('OCR_REVIEW_INVALID','校对请求缺少材料与版本保护。',400);
  }
  function current(input,state=store.read()){
    if(state.workspaceEpoch!==input.expectedEpoch)fail('OCR_STALE_WORKSPACE','工作区已恢复，请重新打开原图校对。');
    const material=state.materials?.find(item=>item.id===input.materialId);
    if(!material)fail('OCR_MATERIAL_MISSING','找不到这批材料。',404);
    if(materialSourceRevision(material)!==input.sourceRevision)fail('OCR_STALE_SOURCE','原材料已经改变，请重新核对。');
    if((state.candidateSets?.[material.id]?.revision||0)!==input.expectedSetRevision)fail('OCR_REVIEW_CONFLICT','候选已更新；未保存修改仍需按原版本处理。');
    return material;
  }
  function checkpointCurrent(state,proof,assetId){
    const job=state.materialJobs?.[proof.jobId],chunk=job?.chunks?.find(item=>item.chunkId===proof.chunkId);
    if(!job||job.materialId!==proof.materialId||job.workspaceEpoch!==proof.expectedEpoch||job.sourceRevision!==proof.sourceRevision||job.generation!==proof.jobGeneration||!completedJobs.has(job.state)||chunk?.state!=='completed'||chunk.checkpointRef!==proof.checkpointRef||assetId&&!job.scope?.assetIds?.includes(assetId))fail('OCR_EVIDENCE_UNOWNED','成功作业检查点已改变；不能读取或采用此证据。',403);
  }
  async function proofs(input){
    const jobs=getJobs()?.list?.({materialId:input.materialId});
    if(!Array.isArray(jobs))fail('OCR_JOBS_UNAVAILABLE','材料作业记录尚未就绪。',503);
    const found=new Map();let checkpoints=0;
    for(const job of jobs){
      if(job.materialId!==input.materialId||job.workspaceEpoch!==input.expectedEpoch||job.sourceRevision!==input.sourceRevision||!completedJobs.has(job.state))continue;
      for(const chunk of job.chunks||[]){
        if(chunk.state!=='completed'||!HASH.test(chunk.checkpointRef||''))continue;
        if(++checkpoints>800)fail('OCR_EVIDENCE_LIMIT','这批材料的检查点过多，请分批核对。',413);
        const checkpoint=await repository.readArtifact(chunk.checkpointRef);
        if(checkpoint.kind!=='local-tool-checkpoint'||!documentTools.has(checkpoint.toolId))continue;
        const proof={materialId:job.materialId,expectedEpoch:job.workspaceEpoch,sourceRevision:job.sourceRevision,jobId:job.jobId,jobGeneration:job.generation,chunkId:chunk.chunkId,checkpointRef:chunk.checkpointRef,toolId:checkpoint.toolId,assetIds:[...(job.scope?.assetIds||[])]};
        let result=checkpoint.result;
        if(result?.paged===true){
          if(!Array.isArray(result.artifactRefs)||result.artifactRefs.length!==1||!HASH.test(result.artifactRefs[0]))continue;
          const wrapper=await repository.readArtifact(result.artifactRefs[0]);
          if(wrapper.kind!=='tool-result'||wrapper.toolId!==checkpoint.toolId||!Array.isArray(wrapper.parentAssetIds)||wrapper.parentAssetIds.length!==1||!proof.assetIds.includes(wrapper.parentAssetIds[0]))continue;
          result=wrapper;proof.resultRef=checkpoint.result.artifactRefs[0];
        }
        if(!plain(result)||!Array.isArray(result.evidence)||!Array.isArray(result.artifactRefs)||result.evidence.length>4)continue;
        for(const row of result.evidence){
          if(!plain(row)||!HASH.test(row.ref||'')||!Number.isInteger(row.page)||row.page<1||row.page>200||!evidenceStates.has(row.state))continue;
          const artifact=result.artifactRefs.find(item=>plain(item)&&item.ref===row.ref&&item.page===row.page&&['ocr-evidence','document-region-evidence'].includes(item.kind));
          if(!artifact||row.imageRef!==null&&!HASH.test(row.imageRef||''))continue;
          if(row.imageRef&&!result.artifactRefs.some(item=>plain(item)&&item.kind==='page-image'&&item.ref===row.imageRef&&item.page===row.page))continue;
          checkpointCurrent(store.read(),proof);
          found.set(row.ref,{...proof,evidenceRef:row.ref,imageRef:row.imageRef,page:row.page,state:row.state,kind:artifact.kind});
          if(found.size>1000)fail('OCR_EVIDENCE_LIMIT','页面证据过多，请分批核对。',413);
        }
      }
    }
    return found;
  }
  async function owned(input){
    const material=current(input),proof=(await proofs(input)).get(input.evidenceRef);
    if(!proof)fail('OCR_EVIDENCE_UNOWNED','此页面不在本材料当前成功作业的证据中。',403);
    const evidence=await repository.readArtifact(proof.evidenceRef);
    if(evidence.kind!==proof.kind||evidence.source?.sourceRevision!==input.sourceRevision||evidence.source?.page!==proof.page||evidence.source?.imageRef!==proof.imageRef||!material.files.some(file=>file.id===evidence.source?.assetId)||!proof.assetIds.includes(evidence.source?.assetId))fail('OCR_EVIDENCE_UNOWNED','OCR 证据来源与本材料或作业不一致。',403);
    current(input);checkpointCurrent(store.read(),proof,evidence.source.assetId);return {material,proof,evidence};
  }
  async function imageBytes(record){
    const source=record.evidence.source;
    if(!HASH.test(source.imageRef||''))fail('OCR_IMAGE_UNAVAILABLE','此证据没有页面原图。',404);
    const filename=path.join(service.artifactDir,source.imageRef);await assertNoOcrPathLinks(filename);
    const stat=await fs.lstat(filename);if(!stat.isFile()||stat.size<24||stat.size>16*1024*1024)fail('OCR_IMAGE_INVALID','页面原图格式或大小无效。',422);
    const bytes=await fs.readFile(filename);
    if(hash(bytes)!==source.imageRef||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(16)!==source.width||bytes.readUInt32BE(20)!==source.height)fail('OCR_IMAGE_INVALID','页面原图完整性或尺寸校验失败。',422);
    return bytes;
  }
  function tokenSession(input){
    const session=sessions.get(input.reviewToken);
    if(!session||session.expiresAt<=clock()||session.materialId!==input.materialId)fail('OCR_REVIEW_EXPIRED','原图校对会话已失效，请重新打开。');
    for(const key of baseKeys)if(Object.hasOwn(input,key)&&input[key]!==session[key])fail('OCR_REVIEW_CONFLICT','校对会话与请求版本不一致。');
    return session;
  }
  async function enabled(){const status=await service.status();if(status.enabled!==true)fail('OCR_DISABLED','请先安装并启用本机英语 OCR。',503);}
  function adapter({request,resolveAsset,checkGuard}={}){
    return tracked(async operation=>{
      if(typeof resolveAsset!=='function'||typeof checkGuard!=='function'||!plain(request?.budget))fail('OCR_ADAPTER_INVALID','OCR 缺少宿主资产和版本保护。',400);
      if(request.cancelToken!==undefined&&!(request.cancelToken instanceof AbortSignal))fail('OCR_ADAPTER_INVALID','OCR 取消信号无效。',400);
      const {cancelToken,...raw}=request,budget={...request.budget};
      for(const key of ['timeoutMs','maxPages','maxPixels','maxOutputBytes','maxMemoryBytes'])if(Number.isInteger(budget[key]))budget[key]=Math.min(budget[key],OCR_LIMITS[key]);
      const signal=AbortSignal.any([operation.signal,...(cancelToken?[cancelToken]:[])]),local={...structuredClone(raw),budget,cancelToken:signal};
      validateOcrRequest(local);signal.throwIfAborted();operation.check();await enabled();operation.check();
      const worker=workerFactory({assetDir:service.assetDir,artifactDir:service.artifactDir,resolveAsset,checkGuard:async basic=>{operation.check();signal.throwIfAborted();await checkGuard(basic);await enabled();operation.check();signal.throwIfAborted();}});
      const result=await worker.runMaterialTool(local);operation.check();signal.throwIfAborted();await enabled();operation.check();return result;
    });
  }
  function summary({materialId}={}){
    return tracked(async operation=>{
      const snapshot=store.read(),material=snapshot.materials?.find(item=>item.id===materialId);if(!material)fail('OCR_MATERIAL_MISSING','找不到这批材料。',404);
      const input={materialId,expectedEpoch:snapshot.workspaceEpoch,sourceRevision:materialSourceRevision(material),expectedSetRevision:snapshot.candidateSets?.[materialId]?.revision||0};
      const available=await proofs(input),status=await service.status();operation.check();current(input);
      // Summary never reads the raw OCR JSON or image, and exposes no raw text.
      return {...input,enabled:status.enabled===true,authorRequired:true,entries:[...available.values()].map(item=>({evidenceRef:item.evidenceRef,page:item.page,state:item.state,kind:item.kind,hasImage:Boolean(item.imageRef),jobId:item.jobId,canReview:item.kind==='ocr-evidence'&&item.state==='needs_review'}))};
    });
  }
  function openAuthor(input,context){
    return tracked(async operation=>{
      validateBase(input,['evidenceRef','author']);if(input.author!==true||!HASH.test(input.evidenceRef||''))fail('OCR_AUTHOR_CONFIRMATION','请先明确打开可能含答案的作者原图视图。',403);
      await human(context);operation.check();const record=await owned(input);await imageBytes(record);operation.check();current(input);
      for(const [key,session] of sessions)if(session.expiresAt<=clock())sessions.delete(key);
      while(sessions.size>=64)sessions.delete(sessions.keys().next().value);
      const reviewToken=crypto.randomUUID(),expiresAt=clock()+15*60*1000;
      sessions.set(reviewToken,{...Object.fromEntries(baseKeys.map(key=>[key,input[key]])),evidenceRef:input.evidenceRef,proof:record.proof,imageRef:record.evidence.source.imageRef,expiresAt});
      return {...Object.fromEntries(baseKeys.map(key=>[key,input[key]])),reviewToken,expiresAt,evidenceRef:input.evidenceRef,evidence:record.evidence,canReview:record.evidence.kind==='ocr-evidence'&&record.evidence.state==='needs_review',reviewFields:[...OCR_HUMAN_REVIEW_FIELDS]};
    });
  }
  function readImage(input,context){
    return tracked(async operation=>{
      if(!exact(input,['materialId','reviewToken'])||!UUID.test(input.reviewToken||''))fail('OCR_REVIEW_INVALID','原图会话无效。',400);
      await human(context);const session=tokenSession(input),record=await owned(session),bytes=await imageBytes(record);operation.check();current(session);tokenSession(input);
      return {bytes,mime:'image/png',cacheControl:'no-store'};
    });
  }
  function review(input,context){
    return tracked(async operation=>{
      validateBase(input,['reviewToken','author','proposal','review']);
      if(input.author!==true||!UUID.test(input.reviewToken||'')||!exact(input.review,OCR_HUMAN_REVIEW_FIELDS)||!OCR_HUMAN_REVIEW_FIELDS.every(field=>input.review[field]===true))fail('OCR_REVIEW_INCOMPLETE','请逐项完成六项人工来源确认；不会自动补全题界或答案。',422);
      await human(context);const session=tokenSession(input),record=await owned(session);operation.check();
      if(record.evidence.kind!=='ocr-evidence'||record.evidence.state!=='needs_review')fail('OCR_REVIEW_UNAVAILABLE','此证据尚没有可人工恢复的 OCR 文字。',422);
      let prior;try{prior=await repository.load(input.materialId);}catch(error){if(error.status!==404)throw error;prior=null;}
      current(input);operation.check();
      const prepared=await prepareOcrCandidateSet({repository,store,readImage:async ref=>{if(ref!==record.evidence.source.imageRef)fail('OCR_EVIDENCE_UNOWNED','页面原图不属于此校对。',403);return imageBytes(record);},material:record.material,sourceRevision:input.sourceRevision,evidenceRef:session.evidenceRef,proposal:input.proposal,review:Object.fromEntries(OCR_HUMAN_REVIEW_FIELDS.map(field=>[field,true])),prior});
      operation.check();const added=prepared.candidates.filter(item=>!prior?.candidates.some(candidate=>candidate.candidateId===item.candidateId));
      if(added.length!==1||added[0].readiness?.canAnswer!==true||added[0].readiness.canScore!==false||added[0].readiness.canSimulateOriginal!==false)fail('OCR_REVIEW_UNAVAILABLE','此校对还不能形成完整的不计分练习。',422);
      const committed=await store.transact(async state=>{
        operation.check();await human(context);tokenSession(input);current(input,state);checkpointCurrent(state,record.proof,record.evidence.source.assetId);
        return repository.commitPrepared(state,prepared,{expectedEpoch:input.expectedEpoch});
      },{expectedEpoch:input.expectedEpoch});
      sessions.delete(input.reviewToken);
      return {materialId:input.materialId,expectedEpoch:input.expectedEpoch,sourceRevision:input.sourceRevision,expectedSetRevision:committed.revision,candidateId:added[0].candidateId,candidateRevision:added[0].revision,readiness:added[0].readiness,answer:null,originalOrdinalInTask:input.proposal.originalOrdinalInTask??null,sourceQuestionNumber:input.proposal.sourceQuestionNumber??null,canCompile:true};
    });
  }
  async function closeAuthor(input,context){
    await human(context);if(!exact(input,['materialId','reviewToken']))fail('OCR_REVIEW_INVALID','校对会话无效。',400);
    const session=sessions.get(input.reviewToken);if(session?.materialId===input.materialId)sessions.delete(input.reviewToken);return {closed:true};
  }
  async function quiesce(){paused=true;generation++;sessions.clear();for(const entry of active)entry.controller.abort();while(active.size)await Promise.allSettled([...active].map(entry=>entry.promise));}
  function reset({ocrService:nextService}={}){
    if(active.size)fail('OCR_BUSY','请等待全部 OCR 操作停止后重置。');
    if(nextService){if(!nextService.status||!path.isAbsolute(nextService.assetDir||'')||!path.isAbsolute(nextService.artifactDir||''))throw TypeError('Invalid replacement OCR service');service=nextService;}
    sessions.clear();generation++;paused=false;
  }
  return {adapter,summary,openAuthor,readImage,review,closeAuthor,quiesce,reset,busy:()=>active.size>0};
}
