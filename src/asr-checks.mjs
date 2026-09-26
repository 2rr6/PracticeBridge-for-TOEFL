import {createHash} from 'node:crypto';
import {InputError,canonicalJSON} from './package.mjs';

const digest=value=>createHash('sha256').update(canonicalJSON(value)).digest('hex');
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const fail=(code,message,status=409)=>{throw Object.assign(new InputError(message,status),{code});};
const plain=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const rangeValid=value=>plain(value)&&Object.keys(value).length===2&&Number.isFinite(value.startSeconds)&&value.startSeconds>=0&&Number.isFinite(value.endSeconds)&&value.endSeconds>value.startSeconds;
export const ASR_CHECK_METHOD='asr-text-comparison-v1';
export const ASR_RANGE_PRECISION='pcm-16000-floor-v1';

/** Python selects floor(start*16000)..floor(end*16000) PCM samples. */
export function asrDecodedScope(requestedRange,durationSeconds){
  if(!rangeValid(requestedRange)||!Number.isFinite(durationSeconds)||durationSeconds<=0)fail('ASR_EVIDENCE_SCOPE_MISMATCH','转写缺少有效的实际解码范围。',502);
  const startSample=Math.floor(requestedRange.startSeconds*16000),endSample=Math.floor(requestedRange.endSeconds*16000),samples=durationSeconds*16000,decodedSamples=Math.round(samples);
  if(!Number.isSafeInteger(decodedSamples)||decodedSamples<1||Math.abs(samples-decodedSamples)>0.000001||decodedSamples>endSample-startSample)fail('ASR_EVIDENCE_SCOPE_MISMATCH','转写实际解码长度不符合本次 PCM 采样范围。',502);
  return {requestedRange:structuredClone(requestedRange),decodedRange:{startSeconds:startSample/16000,endSeconds:(startSample+decodedSamples)/16000},rangeComplete:decodedSamples===endSample-startSample,rangePrecision:ASR_RANGE_PRECISION};
}

export function asrReferenceText(candidate,index,targetId){
  const group=index[candidate.dependencyRefs.find(ref=>index[ref]?.kind==='group')]?.value;
  const value=targetId==='groupAudio'?group?.transcript:candidate.fields.transcript||(candidate.answerType==='listen_repeat'&&typeof candidate.fields.answer==='string'?candidate.fields.answer:null);
  return typeof value==='string'?value:null;
}

/** The existing candidate/mapping revisions supply a monotonic relation version. */
export function captureAsrCheckBinding({candidate,artifactIndex,workspaceEpoch,assetId,sourceRange,requestedRange=sourceRange,targetId}){
  const mappings=(candidate?.mappings||[]).filter(mapping=>mapping.targetId===targetId&&mapping.mappingState==='applied');
  const mapping=mappings.length===1?mappings[0]:null,media=artifactIndex[mapping?.assetId];
  const group=artifactIndex[candidate?.dependencyRefs.find(ref=>artifactIndex[ref]?.kind==='group')]?.value;
  const currentName=targetId==='groupAudio'?group?.audio:candidate?.fields.audio;
  if(!candidate||!['audio','groupAudio'].includes(targetId)||!mapping||mapping.candidateRevision!==candidate.revision||media?.kind!=='media'||media.value?.blob?.id!==assetId||currentName!==media.value.name||typeof workspaceEpoch!=='string'||!workspaceEpoch||!rangeValid(sourceRange)||!rangeValid(requestedRange))fail('MAPPING_BINDING_MISMATCH','当前音频映射、候选版本或选定范围与核对任务不一致；可以改为独立转写。');
  return {version:1,workspaceEpoch,materialId:candidate.materialId,sourceRevision:candidate.sourceRevision,candidateId:candidate.candidateId,candidateRevision:candidate.revision,mappingId:digest([candidate.materialId,candidate.candidateId,targetId]),mappingRevision:mapping.candidateRevision,mappingAssetRef:mapping.assetId,mappingBasis:mapping.mappingBasis,targetId,assetHash:assetId,sourceRange:structuredClone(sourceRange),requestedRange:structuredClone(requestedRange),rangePrecision:ASR_RANGE_PRECISION,transformIdentity:digest(media.value),referenceTextHash:digest(asrReferenceText(candidate,artifactIndex,targetId))};
}

export function assertAsrEvidenceScope(segments,{assetHash,sourceRevision,sourceRange,requestedRange=sourceRange},{requireComplete=true}={}){
  const actual=segments?.actual;
  if(!plain(segments)||!['completed','partial'].includes(segments.state)||segments.originalAssetId!==assetHash||segments.sourceRevision!==sourceRevision||!same(segments.timeRange,requestedRange)||typeof segments.transcript!=='string'||!Array.isArray(segments.segments)||!plain(actual)||!['engine','device','modelId','modelRevision','computeType'].every(key=>typeof actual[key]==='string'&&actual[key].length>0))fail('ASR_EVIDENCE_SCOPE_MISMATCH','转写证据的实际音频、区间、来源版本或处理器身份不符合本次请求。',502);
  const scope=asrDecodedScope(requestedRange,segments.durationSeconds);
  if(['requestedRange','decodedRange','rangeComplete','rangePrecision'].some(key=>Object.hasOwn(segments,key)&&!same(segments[key],scope[key])))fail('ASR_EVIDENCE_SCOPE_MISMATCH','转写声明的范围与实际解码长度不一致。',502);
  if(requireComplete&&(!scope.rangeComplete||segments.state!=='completed'))fail('ASR_DECODED_RANGE_INCOMPLETE','实际解码未覆盖完整请求范围，转写只能保留为部分证据，未应用核对。',409);
  if(requireComplete&&!same(sourceRange,scope.decodedRange))fail('ASR_EVIDENCE_SCOPE_MISMATCH','核对范围不是实际解码的 PCM 范围。',502);
  return digest(actual);
}

export function assertCurrentAsrBinding(binding,input){
  if(!binding||!same(binding,captureAsrCheckBinding(input)))fail('MAPPING_BINDING_MISMATCH','转写期间音频映射或参考文字已有变化；旧结果不能核对新修订。');
}

export function invalidateContentCheck(mapping,candidateRevision){
  const copy={...mapping,candidateRevision,contentCheckState:'notChecked'};
  delete copy.contentCheckRef;delete copy.contentCheckMethod;
  return copy;
}

/** A cached mapping state is never sufficient authority for an automatic check. */
export function effectiveContentCheck(candidate,mapping,index,{workspaceEpoch}={}){
  const inactive=reason=>({state:'notChecked',checkApplied:false,reason,method:null});
  if(mapping.mappingState!=='applied'||mapping.candidateRevision!==candidate.revision)return inactive('MAPPING_BINDING_MISMATCH');
  if(mapping.contentCheckMethod==='user-review'&&mapping.mappingBasis==='user'&&!mapping.contentCheckRef)return {state:mapping.contentCheckState,checkApplied:mapping.contentCheckState!=='notChecked',reason:null,method:'user-review'};
  const entry=index[mapping.contentCheckRef],check=entry?.value;
  if(mapping.contentCheckMethod!==ASR_CHECK_METHOD||entry?.kind!=='asr-comparison'||entry.candidateId!==candidate.candidateId||check?.method!==ASR_CHECK_METHOD||check.retracted)return inactive(check?.retracted?'CHECK_RETRACTED':'NO_CURRENT_CHECK');
  try{
    const binding=check.binding;
    assertCurrentAsrBinding(binding,{candidate,artifactIndex:index,workspaceEpoch,assetId:check.assetId,sourceRange:check.sourceRange,requestedRange:check.requestedRange||check.sourceRange,targetId:mapping.targetId});
    if(check.candidateRevision!==candidate.revision||check.targetId!==mapping.targetId||check.reference!==asrReferenceText(candidate,index,mapping.targetId))return inactive('MAPPING_BINDING_MISMATCH');
    const segments=index[check.asrEvidenceRef];
    if(segments?.kind!=='asr-segments'||!entry.dependencyRefs.includes(check.asrEvidenceRef)||assertAsrEvidenceScope(segments.value,binding)!==check.processorIdentity||segments.value.transcript!==check.transcript)return inactive('ASR_EVIDENCE_SCOPE_MISMATCH');
    if(!['notChecked','matched','conflict','inconclusive'].includes(check.state))return inactive('INVALID_CHECK_DECISION');
    return {state:check.state,checkApplied:check.state!=='notChecked',reason:null,method:ASR_CHECK_METHOD};
  }catch(error){return inactive(error.code||'MAPPING_BINDING_MISMATCH');}
}

export function derivedMappings(candidate,index,context){return (candidate.mappings||[]).map(mapping=>({...mapping,contentCheckState:effectiveContentCheck(candidate,mapping,index,context).state}));}
