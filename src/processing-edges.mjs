import {InputError,LIMITS} from './package.mjs';

const HASH=/^[a-f0-9]{64}$/;
const plain=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const invalid=message=>{throw new InputError('备份处理产物无效：'+message);};
const unsupported=()=>{throw Object.assign(new InputError('备份含有无法识别的必要处理产物版本；原工作区未被替换。'),{code:'UNSUPPORTED_ARTIFACT_VERSION'});};
const legacyKinds=new Set(['document','group','media','media-manifest','pack-context','unsupported-interaction','media-derivative','asr-segments','asr-comparison','tool-result']);
const toolIds=new Set(['assets.list','source.read','candidates.validate','mapping.propose','draft.patch','media.probe','media.canonicalize','media.transcribe','document.render','document.ocr']);
function list(value){if(!Array.isArray(value)||value.length>LIMITS.zipEntries)invalid('依赖列表无效。');return value;}
function object(value){if(!plain(value))invalid('产物 envelope 无效。');return value;}
function legacy(value){if(value.version!==undefined||value.schemaVersion!==undefined)unsupported();}

/** These roles are assigned by validated host state/parent edges, never by a
 * source-defined property name. Text, schemas, prototypes and raw model output
 * are data even when they contain a valid hash or another apparent kind. */
export function extractProcessingEdges(value,{role='artifact'}={}){
  object(value);const references=[],blobs=[],indexedArtifacts=[];
  const add=(ref,childRole='artifact')=>{if(ref===undefined||ref===null)return;if(typeof ref!=='string'||!HASH.test(ref))invalid('引用不是 SHA-256 标识。');references.push({ref,role:childRole});};
  const required=(ref,childRole='artifact')=>{if(ref===undefined||ref===null)invalid('缺少必需产物引用。');add(ref,childRole);};
  const dependencies=()=>{for(const ref of list(value.dependencyRefs))required(ref);};
  const evidenceImage=raw=>{object(raw.source);add(raw.source.imageRef,'page-image');};
  const resultEdges=result=>{
    object(result);
    // This is the fixed result protocol at a host-owned result position. It is
    // not applied recursively to source text, patch.fields or returned schemas.
    for(const entry of list(result.artifactRefs||[])){
      if(typeof entry==='string')add(entry,result.paged===true?'tool-result':'tool-json');
      else{object(entry);if(entry.kind==='page-image'&&entry.mime==='image/png')required(entry.ref,'page-image');else if(['ocr-evidence','document-region-evidence'].includes(entry.kind))required(entry.ref,'artifact');else unsupported();}
    }
    for(const item of list(result.evidence||[])){object(item);add(item.artifactRef,'tool-json');add(item.ref,'artifact');add(item.imageRef,'page-image');}
    for(const item of list(result.issues||[])){object(item);add(item.evidenceRef,'artifact');}
  };
  if(role==='artifact-index'){
    if(Object.keys(value).length>LIMITS.zipEntries)invalid('共享产物索引超限。');
    for(const [ref,entry] of Object.entries(value)){object(entry);if(typeof entry.kind!=='string')unsupported();list(entry.dependencyRefs);add(ref);indexedArtifacts.push({ref,value:entry});}
    return {references,blobs,indexedArtifacts};
  }
  if(role==='candidate'){
    if(value.schemaVersion!==1)unsupported();dependencies();
    for(const item of list(value.fieldEvidence)){object(item);add(item.artifactRef);}
    for(const item of list(value.issues)){object(item);add(item.evidenceRef);}
    add(value.fields?.interaction?.rawArtifactRef);
    for(const mapping of list(value.mappings)){object(mapping);add(mapping.assetId,'media-artifact');for(const ref of list(mapping.candidates||[]))add(ref,'media-artifact');add(mapping.contentCheckRef,'asr-comparison');}
    return {references,blobs,indexedArtifacts};
  }
  if(role==='model-request')return {references,blobs,indexedArtifacts};
  if(role==='job-plan'){
    legacy(value);if(value.kind!==undefined)unsupported();required(value.sourceIndexRef,'document');for(const chunk of list(value.chunks)){object(chunk);required(chunk.scopeRef,'job-scope');}
    return {references,blobs,indexedArtifacts};
  }
  if(role==='job-scope'){
    legacy(value);if(value.kind!==undefined)unsupported();required(value.artifactIndexRef,'artifact-index');required(value.sourceRef,'document');if(value.localTool===undefined)required(value.groupRef,'group');else object(value.localTool);dependencies();
    if(value.localTool?.toolId==='source.read')add(value.localTool.parameters?.artifactRef,'document');
    return {references,blobs,indexedArtifacts};
  }
  if(role==='asr-raw'||role==='tool-json'&&value.kind===undefined){
    if(value.protocolVersion!==1||typeof value.transcript!=='string'||!Array.isArray(value.segments)||!HASH.test(value.originalAssetId||''))unsupported();
    return {references,blobs,indexedArtifacts};
  }
  if(role==='document'&&value.kind!=='document'||role==='group'&&value.kind!=='group'||role==='media-artifact'&&!['media','media-derivative'].includes(value.kind)||role==='asr-comparison'&&value.kind!=='asr-comparison'||role==='asr-segments'&&value.kind!=='asr-segments'||role==='tool-result'&&value.kind!=='tool-result'||role==='model-diagnostic'&&value.kind!=='model-diagnostic'||role==='job-checkpoint'&&!['material-checkpoint','local-tool-checkpoint'].includes(value.kind)||role==='job-conflict'&&value.kind!=='candidate-conflict')unsupported();
  if(!['artifact','document','group','media-artifact','asr-comparison','asr-segments','tool-result','tool-json','model-diagnostic','job-checkpoint','job-conflict'].includes(role))unsupported();
  if(value.kind==='ocr-evidence'||value.kind==='document-region-evidence'){
    if(value.version===1){evidenceImage(value);}
    else if(value.kind==='ocr-evidence'&&value.version===undefined&&value.value?.version===1){legacy(value);dependencies();required(value.value.originalEvidenceRef);evidenceImage(value.value);blobs.push(value.value.pageImageBlob);}
    else unsupported();
    return {references,blobs,indexedArtifacts};
  }
  legacy(value);
  if(['model-diagnostic','material-checkpoint','candidate-conflict'].includes(value.kind))return {references,blobs,indexedArtifacts};
  if(value.kind==='local-tool-checkpoint'){if(!toolIds.has(value.toolId))unsupported();resultEdges(value.result);return {references,blobs,indexedArtifacts};}
  if(!legacyKinds.has(value.kind))unsupported();
  if(value.kind==='tool-result'&&!Object.hasOwn(value,'value')){
    if(!toolIds.has(value.toolId))unsupported();resultEdges(value);return {references,blobs,indexedArtifacts};
  }
  if(!Object.hasOwn(value,'value'))invalid('缺少产物内容。');dependencies();
  if(['document','media','media-derivative','asr-comparison','tool-result'].includes(value.kind))object(value.value);
  switch(value.kind){
    case 'document':add(value.value.ocrEvidenceRef);add(value.value.pageImageMediaRef,'media-artifact');break;
    case 'media':case 'media-derivative':blobs.push(value.value.blob);break;
    case 'asr-comparison':add(value.value.asrEvidenceRef,'asr-segments');break;
    case 'tool-result':resultEdges(value.value);break;
    // The other registered envelopes own only dependencyRefs. Their complete
    // value is opaque, including all group/pack/unsupported source vocabulary.
  }
  return {references,blobs,indexedArtifacts};
}

export function materialJobRootEdges(state){
  const roots=[];const add=(ref,role)=>{if(ref!==null&&ref!==undefined)roots.push({ref,role});};
  for(const job of Object.values(state.materialJobs||{})){
    add(job.scope.sourceIndexRef,'document');add(job.scope.chunkPlanRef,'job-plan');for(const ref of job.scope.artifactRefs||[])add(ref,'artifact');
    for(const chunk of job.chunks){add(chunk.scopeRef,'job-scope');add(chunk.checkpointRef,'job-checkpoint');add(chunk.conflictRef,'job-conflict');add(chunk.repairRef,'model-diagnostic');for(const ref of chunk.dependencyRefs)add(ref,'artifact');}
    for(const request of job.requests){add(request.inputRef,'model-request');add(request.diagnosticRef,'model-diagnostic');}
  }
  return roots;
}
