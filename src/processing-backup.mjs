import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {InputError,canonicalJSON,LIMITS} from './package.mjs';
import {atomicWrite} from './store.mjs';
import {materialSourceRevision,validateCandidate,dependencyClosure} from './material-candidates.mjs';
import {extractProcessingEdges,materialJobRootEdges} from './processing-edges.mjs';

const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const MAX_ARTIFACT=16*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw new InputError('备份处理产物无效：'+message);};
const plain=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const equal=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
function shape(value,keys,required=keys){if(!plain(value)||Object.keys(value).some(key=>!keys.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail('存在未知或缺少的记录字段。');}
function count(value,max=1000000){if(!Number.isSafeInteger(value)||value<0||value>max)fail('记录数量或修订无效。');return value;}
function reference(value){if(typeof value!=='string'||!HASH.test(value))fail('引用不是 SHA-256 标识。');return value;}
function boundedTree(root){const stack=[[root,0]];let nodes=0;while(stack.length){const [value,depth]=stack.pop();if(++nodes>500000||depth>64)fail('产物结构过深或过大。');if(value&&typeof value==='object')for(const child of Object.values(value))stack.push([child,depth+1]);}}
const versionKey=(materialId,candidateId,revision)=>`${materialId}/${candidateId}/${revision}`;

export async function readProcessingBytes(dataDir,ref){
  reference(ref);const directory=path.join(dataDir,'processing-artifacts');
  try{
    const parent=await fs.lstat(directory),filename=path.join(directory,ref),stat=await fs.lstat(filename);
    if(!parent.isDirectory()||parent.isSymbolicLink()||!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_ARTIFACT)fail('产物文件位置或大小异常。');
    const bytes=await fs.readFile(filename);if(bytes.length!==stat.size||hash(bytes)!==ref)fail('产物内容已损坏。');return bytes;
  }catch(error){if(error.code==='ENOENT')fail('必需产物缺失，未生成不完整备份。');throw error;}
}

/** The scheduler supplies its schema/ledger validator and explicit CAS roots;
 * this backup adapter adds workspace/material ownership and the byte closure. */
export function createMaterialJobSnapshotInspector({validateJobs,references=materialJobRootEdges}={}){
  if(typeof validateJobs!=='function'||typeof references!=='function')throw TypeError('Job snapshots require their owning schema and reference adapters.');
  return async({state,follow})=>{
    try{validateJobs(state);}catch(error){if(error.code==='invalid_material_jobs')fail('材料作业格式或预算账本无效。');throw error;}
    const jobs=Object.values(state.materialJobs||{}),materials=new Map((state.materials||[]).map(material=>[material.id,material]));
    if(jobs.length>10000)fail('材料作业数量超过备份限制。');
    for(const job of jobs){
      const material=materials.get(job.materialId),revision=state.candidateSets?.[job.materialId]?.revision||0;
      if(!material||job.workspaceEpoch!==state.workspaceEpoch||job.sourceRevision!==materialSourceRevision(material)||!Number.isSafeInteger(job.generation)||job.generation<1||!Number.isSafeInteger(job.expectedSetRevision)||job.expectedSetRevision<0||job.expectedSetRevision>revision)fail('作业不属于本次工作区、原件或候选修订。');
    }
    const roots=references(state);if(!Array.isArray(roots))fail('材料作业产物引用列表无效。');
    const distinct=new Map(),files=new Set();
    for(const root of roots){if(!plain(root)||typeof root.role!=='string')fail('作业引用缺少宿主指定的产物角色。');reference(root.ref);distinct.set(root.ref+'/'+root.role,root);files.add(root.ref);}
    if(files.size>LIMITS.zipEntries)fail('材料作业产物引用超出备份限制。');
    for(const root of distinct.values())await follow(root.ref,{role:root.role});
  };
}

/** Traverse only the frozen state's explicit processing roots. Immutable files
 * can be added concurrently; unreferenced temporary work never joins a backup. */
export async function inspectProcessingSnapshot(state,{readBytes,inspectJobs,signal}={}){
  if(typeof readBytes!=='function')throw TypeError('Processing backup requires a scoped byte reader.');
  const sets=state.candidateSets===undefined?{}:state.candidateSets,receipts=state.importReceipts===undefined?{}:state.importReceipts,jobs=state.materialJobs===undefined?{}:state.materialJobs;
  if(!plain(sets)||Object.keys(sets).length>1000||!plain(receipts)||Object.keys(receipts).length>50000||!plain(jobs))fail('候选、收据或作业索引无效。');
  const files=new Map(),values=new Map(),blobInfo=new Map(),versions=new Map();let bytesTotal=0;
  async function load(ref,{image=false}={}){
    signal?.throwIfAborted();
    reference(ref);
    if(!files.has(ref)){
      if(files.size>=LIMITS.zipEntries)fail('产物数量超过备份限制。');
      const bytes=await readBytes(ref);signal?.throwIfAborted();
      if(!Buffer.isBuffer(bytes)||bytes.length>MAX_ARTIFACT||hash(bytes)!==ref)fail('必需产物缺失、超限或哈希不符。');
      bytesTotal+=bytes.length;if(bytesTotal>LIMITS.expandedBytes)fail('处理产物超过备份容量。');
      files.set(ref,bytes);
    }
    const bytes=files.get(ref);
    if(image){if(bytes.length<24||!bytes.subarray(0,8).equals(PNG)||bytes.readUInt32BE(16)<1||bytes.readUInt32BE(20)<1)fail('页面图像不是有效 PNG。');return null;}
    if(!values.has(ref)){let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('JSON 处理产物无法读取。');}boundedTree(value);values.set(ref,value);}
    return values.get(ref);
  }
  const scanned=new Set();
  async function follow(ref,{role='artifact'}={}){
    const value=await load(ref,{image:role==='page-image'}),key=ref+'/'+role;if(scanned.has(key)||role==='page-image')return;scanned.add(key);
    const edges=extractProcessingEdges(value,{role});
    if(role==='artifact-index'){
      for(const entry of edges.indexedArtifacts)if(!equal(await load(entry.ref),entry.value)||hash(Buffer.from(canonicalJSON(entry.value)))!==entry.ref)fail('共享产物与其索引不一致。');
      try{dependencyClosure(Object.keys(value),value);}catch{fail('共享产物依赖存在循环或缺失。');}
    }
    for(const blob of edges.blobs)addBlob(blob);
    for(const edge of edges.references)await follow(edge.ref,{role:edge.role});
  }
  function addBlob(info){
    shape(info,['id','size','mime']);reference(info.id);count(info.size,LIMITS.fileBytes);if(typeof info.mime!=='string'||!info.mime.startsWith('image/')&&!info.mime.startsWith('audio/'))fail('派生媒体类型无效。');
    if(blobInfo.has(info.id)&&!equal(blobInfo.get(info.id),info)||state.blobs?.[info.id]&&!equal(state.blobs[info.id],info))fail('同一媒体存在不同的记录。');
    blobInfo.set(info.id,structuredClone(info));
  }
  const materials=new Map((state.materials||[]).map(material=>[material.id,material]));
  for(const [materialId,set] of Object.entries(sets)){
    if(!UUID.test(materialId)||!materials.has(materialId))fail('候选集合不属于现有材料。');
    shape(set,['sourceRevision','revision','artifactIndexRef','candidates','history']);reference(set.sourceRevision);
    if(materialSourceRevision(materials.get(materialId))!==set.sourceRevision)fail('候选来源版本与原件不一致。');
    if(!Array.isArray(set.history)||set.history.length>10000||set.revision!==set.history.length+1)fail('候选修订历史不连续。');
    const frames=[...set.history,set];let previous=new Map();
    for(const [position,frame] of frames.entries()){
      if(frame!==set)shape(frame,['revision','artifactIndexRef','candidates']);
      if(frame.revision!==position+1||!Array.isArray(frame.candidates)||frame.candidates.length>1000)fail('候选历史修订无效。');
      const index=await load(frame.artifactIndexRef);if(!plain(index)||Object.keys(index).length>LIMITS.zipEntries)fail('共享产物索引无效。');
      await follow(frame.artifactIndexRef,{role:'artifact-index'});
      for(const [ref,entry] of Object.entries(index)){
        reference(ref);if(!plain(entry)||typeof entry.kind!=='string'||!Array.isArray(entry.dependencyRefs)||!equal(await load(ref),entry)||hash(Buffer.from(canonicalJSON(entry)))!==ref)fail('共享产物与索引不一致。');
        if(entry.dependencyRefs.length>LIMITS.zipEntries||entry.dependencyRefs.some(child=>!Object.hasOwn(index,child)))fail('共享产物依赖缺失。');
      }
      try{dependencyClosure(Object.keys(index),index);}catch{fail('共享产物依赖存在循环或缺失。');}
      const current=new Map();
      for(const item of frame.candidates){
        shape(item,['candidateId','revision','ref','readiness']);count(item.revision);if(item.revision<1||current.has(item.candidateId))fail('候选身份或修订重复。');
        const candidate=await load(item.ref);validateCandidate(candidate);
        if(candidate.candidateId!==item.candidateId||candidate.revision!==item.revision||candidate.materialId!==materialId||candidate.sourceRevision!==set.sourceRevision||!equal(candidate.readiness,item.readiness))fail('候选与索引、材料或修订不一致。');
        if(candidate.dependencyRefs.some(ref=>!Object.hasOwn(index,ref)))fail('候选共享依赖缺失。');
        const old=previous.get(item.candidateId);if(old&&(item.revision<old.revision||item.revision>old.revision+1))fail('候选修订发生倒退或跳跃。');
        const key=versionKey(materialId,item.candidateId,item.revision);if(versions.has(key)&&!equal(versions.get(key),candidate))fail('同一候选修订对应不同内容。');versions.set(key,candidate);current.set(item.candidateId,item);
        await follow(item.ref,{role:'candidate'});
      }
      if([...previous.keys()].some(id=>!current.has(id)))fail('候选历史丢失已有候选。');previous=current;
    }
    const summary=materials.get(materialId).candidateSummary;
    if(summary&&!equal(summary,{total:set.candidates.length,answerable:set.candidates.filter(c=>c.readiness.canAnswer).length,pending:set.candidates.filter(c=>!c.readiness.canAnswer).length}))fail('材料候选摘要与实际集合不同。');
  }
  for(const material of materials.values())if((material.candidateSummary||material.draft?.candidateReview)&&!Object.hasOwn(sets,material.id))fail('材料引用了缺失的候选集合。');
  validateLineageAndReceipts(state,versions);
  if(Object.keys(jobs).length){if(typeof inspectJobs!=='function')fail('当前备份流程尚不能完整保存材料作业。');await inspectJobs({state,load,follow,addBlob});}
  return {files,blobInfo,versions};
}

function validateLineageAndReceipts(state,versions){
  const libraries=new Map(state.libraries.map(l=>[l.libraryId,l]));
  for(const library of libraries.values())if(library.lineage!==undefined){
    const lineage=library.lineage;shape(lineage,['version','materialId','sourceRevision','selectionKey','revisesLibraryIds','candidates','completeness']);
    if(lineage.version!==1||!UUID.test(lineage.materialId)||!Array.isArray(lineage.candidates)||!lineage.candidates.length||!Array.isArray(lineage.revisesLibraryIds)||lineage.revisesLibraryIds.some(id=>id===library.libraryId||!libraries.has(id)))fail('题库来源链无效。');
    reference(lineage.sourceRevision);reference(lineage.selectionKey);
    const expectedKey=hash(Buffer.from(canonicalJSON({materialId:lineage.materialId,sourceRevision:lineage.sourceRevision,selected:lineage.candidates.map(c=>[c.candidateId,c.revision]).sort()})));
    if(expectedKey!==lineage.selectionKey)fail('题库选择标识不一致。');
    const rows=library.originalPack?.groups?.flatMap(group=>group.questions)||[];
    if(rows.length!==lineage.candidates.length||new Set(lineage.candidates.map(c=>c.candidateId)).size!==rows.length)fail('题库来源数量不一致。');
    for(const entry of lineage.candidates){
      shape(entry,['candidateId','revision','adaptationKind','parentCandidateId']);const candidate=versions.get(versionKey(lineage.materialId,entry.candidateId,entry.revision));
      if(!candidate||candidate.sourceRevision!==lineage.sourceRevision||candidate.adaptationKind!==entry.adaptationKind||candidate.parentCandidateId!==entry.parentCandidateId||rows.filter(q=>equal(q.candidateLineageV1,entry)).length!==1)fail('题库引用了缺失或不同的候选修订。');
    }
    completeness(lineage.completeness);
  }
  for(const [operationId,stored] of Object.entries(state.importReceipts||{})){
    if(!/^[A-Za-z0-9-]{1,100}$/.test(operationId))fail('导入操作标识无效。');shape(stored,['requestDigest','receipt','completeness']);reference(stored.requestDigest);completeness(stored.completeness);
    if(stored.receipt===null){if(stored.completeness.selected!==0)fail('非空导入缺少收据。');continue;}
    const receipt=stored.receipt;shape(receipt,['operationId','libraryId','libraryIds','contentHash','selectionKey','selected','added','pending']);
    const library=libraries.get(receipt.libraryId);
    if(receipt.operationId!==operationId||!library||receipt.contentHash!==library.contentHash||!Array.isArray(receipt.libraryIds)||!receipt.libraryIds.includes(receipt.libraryId)||new Set(receipt.libraryIds).size!==receipt.libraryIds.length||receipt.libraryIds.some(id=>!libraries.has(id)))fail('导入收据引用无效。');
    reference(receipt.selectionKey);for(const key of ['selected','added','pending'])count(receipt[key],1000);
    if(receipt.added>receipt.selected||receipt.selected!==stored.completeness.selected||receipt.pending!==stored.completeness.pending)fail('导入收据数量不一致。');
    if(receipt.added>0&&(!library.lineage||receipt.selectionKey!==library.lineage.selectionKey||receipt.added!==library.lineage.candidates.length))fail('新增导入收据与主库的来源选择或新增数量不同。');
  }
}
function completeness(value){shape(value,['materialCoverage','examCompleteness','selectionCoverage','selected','pending','total']);if(value.materialCoverage!=='partial'||value.examCompleteness!=='unknown'||value.selectionCoverage!=='selected-only')fail('来源完整性声明无效。');for(const key of ['selected','pending','total'])count(value[key],1000);if(value.selected>value.total||value.pending>value.total)fail('来源覆盖数量无效。');}

export function processingManifest(files){return Object.fromEntries([...files].sort(([a],[b])=>a.localeCompare(b)).map(([ref,bytes])=>[ref,{size:bytes.length,mime:bytes.subarray(0,8).equals(PNG)?'image/png':'application/json'}]));}
export function validateProcessingManifest(manifest,files){
  if(!plain(manifest)||Object.keys(manifest).length>LIMITS.zipEntries)fail('处理产物清单无效。');
  const result=new Map();
  for(const [ref,info] of Object.entries(manifest)){reference(ref);shape(info,['size','mime']);count(info.size,MAX_ARTIFACT);if(!['application/json','image/png'].includes(info.mime))fail('处理产物 MIME 无效。');const bytes=files.get('processing-artifacts/'+ref);if(!bytes||bytes.length!==info.size||hash(bytes)!==ref||(bytes.subarray(0,8).equals(PNG)?'image/png':'application/json')!==info.mime)fail('清单中必需产物缺失或损坏。');result.set(ref,bytes);}
  return result;
}
export async function writeProcessingFiles(dataDir,files){
  if(!files.size)return;const directory=path.join(dataDir,'processing-artifacts');await fs.mkdir(directory,{recursive:true});const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())fail('目标产物目录异常。');
  for(const [ref,bytes] of files){reference(ref);if(hash(bytes)!==ref)fail('待恢复产物哈希不符。');try{await readProcessingBytes(dataDir,ref);}catch(error){if(error instanceof InputError){try{await fs.lstat(path.join(directory,ref));}catch(absent){if(absent.code==='ENOENT'){await atomicWrite(path.join(directory,ref),bytes);continue;}throw absent;}}throw error;}}
}
