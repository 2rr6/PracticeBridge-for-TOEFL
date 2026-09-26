import crypto from 'node:crypto';
import {hash,ocrError} from './ocr-policy.mjs';

const HASH=/^[a-f0-9]{64}$/;
const text=(v,max=100000)=>typeof v==='string'&&v.trim()&&v.length<=max;

/** HOST producer, never registered as a model tool. `review` is supplied by the
 * authenticated human review command, after checking its epoch, revision and
 * displayed source; model-provided review flags must not reach this function.
 * This returns an immutable prepared set. T06 publishes it with its checkpoint
 * in repository.commitPrepared inside the guarded store transaction. */
export async function prepareOcrCandidateSet({repository,store,readImage,material,sourceRevision,evidenceRef,proposal,review=null,prior=null}={}){
  if(!repository?.readArtifact||!repository?.writeArtifact||!repository?.prepareCandidates||!store?.writeBlob||typeof readImage!=='function'||!HASH.test(sourceRevision||'')||!HASH.test(evidenceRef||'')||!material?.id||!Array.isArray(material.files))throw ocrError('OCR_CANDIDATE_INVALID','OCR 候选缺少宿主来源。');
  const evidence=await repository.readArtifact(evidenceRef);
  if(evidence.kind!=='ocr-evidence'||evidence.source?.sourceRevision!==sourceRevision||!material.files.some(f=>f.id===evidence.source.assetId)||!HASH.test(evidence.source.imageRef||'')||evidence.state==='empty')throw ocrError('OCR_CANDIDATE_SOURCE_INVALID','OCR 证据不属于此材料版本或没有可恢复文字。');
  if(!proposal||Object.keys(proposal).some(k=>!['prompt','options','passage','instructions','sourceQuestionNumber','originalOrdinalInTask','title'].includes(k))||!text(proposal.prompt)||!Array.isArray(proposal.options)||proposal.options.length<2||proposal.options.length>10||proposal.options.some(o=>!o||Object.keys(o).some(k=>!['id','text'].includes(k))||!text(o.id,10)||!text(o.text,20000))||new Set(proposal.options.map(o=>o.id)).size!==proposal.options.length||!text(proposal.passage)||!text(proposal.instructions,20000))throw ocrError('OCR_CANDIDATE_INCOMPLETE','请保留完整题干、选项、说明和共享文章；不能用通用原图说明替代题目。');
  if(proposal.originalOrdinalInTask!=null&&(!Number.isInteger(proposal.originalOrdinalInTask)||proposal.originalOrdinalInTask<1||proposal.originalOrdinalInTask>1000))throw ocrError('OCR_CANDIDATE_INVALID','原 task 序号无效。');
  if(proposal.sourceQuestionNumber!=null&&!(Number.isInteger(proposal.sourceQuestionNumber)&&proposal.sourceQuestionNumber>0)&&!(typeof proposal.sourceQuestionNumber==='string'&&proposal.sourceQuestionNumber.length<=100))throw ocrError('OCR_CANDIDATE_INVALID','原题号无效。');
  if(prior&&(prior.sourceRevision!==sourceRevision||!Array.isArray(prior.candidates)))throw ocrError('OCR_CANDIDATE_STALE','已有候选属于其他材料版本。',409);
  const humanReviewed=review?.completeQuestion===true&&review?.completeDependencies===true&&review?.readable===true&&review?.answerSafe===true&&review?.fieldsConfirmed===true&&review?.criticalDifferencesResolved===true;
  const sourceVisibility=review?.answerSafe===true?'source':'reference';
  const artifactIndex=structuredClone(prior?.artifactIndex||{}),add=async value=>{const ref=await repository.writeArtifact(value);artifactIndex[ref]=value;return ref;};
  const image=await readImage(evidence.source.imageRef);if(!Buffer.isBuffer(image)||image.length<24||image.length>16*1024*1024||hash(image)!==evidence.source.imageRef||!image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||image.readUInt32BE(16)!==evidence.source.width||image.readUInt32BE(20)!==evidence.source.height)throw ocrError('OCR_CANDIDATE_SOURCE_INVALID','OCR 原图证据校验失败。');
  const imageBlob=await store.writeBlob(image,'image/png'),imageName=`derived/ocr/${imageBlob.id}.png`;
  const mediaRef=await add({kind:'media',value:{name:imageName,blob:imageBlob,evidence:{originalAssetId:evidence.source.assetId,originalHash:evidence.source.assetId,detectedFormat:'png',detectedMime:'image/png',decodeState:'playable',mappingBasis:'user',contentCheckState:'notChecked'}},dependencyRefs:[]});
  // Keep the complete OCR value inside the dependency closure. The original
  // processing reference is provenance; the image also has a standard media
  // blob so backup and author review can retain it through their usual path.
  const ocrRef=await add({kind:'ocr-evidence',value:{...evidence,originalEvidenceRef:evidenceRef,pageImageBlob:imageBlob},dependencyRefs:[mediaRef]});
  const blockId=`ocr-${evidenceRef.slice(0,24)}`,sourceRef=await add({kind:'document',value:{originals:material.files.map(f=>({id:f.id,name:f.name})),ocrEvidenceRef:ocrRef,pageImageMediaRef:mediaRef,review:review?structuredClone(review):null,documentLayout:{blocks:[{id:blockId,name:material.files.find(f=>f.id===evidence.source.assetId).name,page:evidence.source.page,text:evidence.text,visibility:sourceVisibility,layoutState:'ocr-needs-review',sourceRegion:evidence.source.region,words:evidence.words,image:imageName}],readingOrder:[blockId]},fieldEvidence:[]},dependencyRefs:[ocrRef,mediaRef]});
  const groupRef=await add({kind:'group',sourceGroupId:`ocr-page-${evidence.source.page}-${evidenceRef.slice(0,12)}`,sourceGroupIndex:0,sourceQuestionIds:[null],value:{section:'reading',taskKind:'read_daily',title:text(proposal.title,300)?proposal.title:'扫描材料校对练习',passage:proposal.passage,directions:[{id:`ocr-direction-${evidenceRef.slice(0,16)}`,text:proposal.instructions,audio:null,source:`原件第 ${evidence.source.page} 页`,basis:'user',verifiedContent:humanReviewed}],presentation:{document:{kind:'notice',title:'',blocks:[{kind:'paragraph',text:proposal.instructions},{kind:'paragraph',text:proposal.passage}]}}},dependencyRefs:[sourceRef]});
  const fields={prompt:proposal.prompt,options:structuredClone(proposal.options),answer:null,explanation:'',source:`原件第 ${evidence.source.page} 页；OCR 候选${proposal.sourceQuestionNumber!=null?`；原题号 ${proposal.sourceQuestionNumber}`:''}`};
  const fieldStates={prompt:humanReviewed?'known':'ambiguous',options:humanReviewed?'known':'ambiguous',answer:'missing',explanation:'missing',source:humanReviewed?'known':'ambiguous'};
  const fieldEvidence=['prompt','options','source'].map(field=>({path:field,state:fieldStates[field],method:humanReviewed?'user-review':'ocr-proposal',visibility:'source',sourceReferences:[{blockId,visibility:sourceVisibility}],blockIds:[blockId],artifactRef:sourceRef,valueLocated:humanReviewed}));
  const issues=[];
  if(!humanReviewed)issues.push({code:'ocr_complete_source_review_required',scope:'answerability',path:'source',reason:'需在原图中核对完整题界、说明、全部共享材料、可读性与关键差异。',state:'open',evidenceRef});
  for(const issue of evidence.issues||[])issues.push({code:issue.code,scope:'source-quality',path:'source',reason:issue.reason,state:humanReviewed?'resolved':'open',evidenceRef});
  const candidate={schemaVersion:1,candidateId:`candidate-${crypto.randomUUID()}`,materialId:material.id,sourceRevision,sourceQuestionId:null,sourceTaskId:`${material.id}:${sourceRevision.slice(0,16)}:ocr:${evidence.source.page}`,originalOrdinalInTask:proposal.originalOrdinalInTask??null,sourceQuestionNumber:proposal.sourceQuestionNumber??null,taskKind:'read_daily',answerType:'single_choice',fields,fieldStates,fieldEvidence,dependencyRefs:[groupRef],mappings:[],issues,revision:1,readiness:{canDisplay:true,canAnswer:false,canScore:false,canSimulateOriginal:false},adaptationKind:'ocr_reconstructed',parentCandidateId:null};
  return repository.prepareCandidates({materialId:material.id,sourceRevision,candidates:[...(prior?.candidates||[]),candidate],artifactIndex,expectedSetRevision:prior?.revision||0});
}
