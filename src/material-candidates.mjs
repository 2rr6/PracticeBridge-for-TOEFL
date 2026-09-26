import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import {atomicWrite} from './store.mjs';
import {InputError, canonicalJSON, identifyMedia,collectMediaPaths,mapPackageMedia} from './package.mjs';
import {EXAM_TASK_KINDS} from './exam-plan.mjs';
import {canonicalizeMediaFiles,resolveMediaMappings} from './media-manifest.mjs';
import {mediaDecodeEvidence} from './material-tools.mjs';
import {effectiveContentCheck,invalidateContentCheck} from './asr-checks.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const ajv=new Ajv2020({strict:true,allowUnionTypes:true,allErrors:true,useDefaults:false,coerceTypes:false,removeAdditional:false});
const schema=JSON.parse(await fs.readFile(new URL('../schemas/material-candidate.v1.json',import.meta.url),'utf8'));
const validate=ajv.compile(schema);
const fieldNames=Object.keys(schema.properties.fields.properties);
const objective=new Set(['single_choice','fill_blank','sentence_order']);
const types=new Set(['single_choice','fill_blank','sentence_order','email','discussion','interview','listen_repeat']);
const present=value=>typeof value==='string'?Boolean(value.trim()):Array.isArray(value)?value.length>0:value!==null&&value!==undefined;
const fail=(message,status=400)=>{throw new InputError(message,status);};
function nativeEvidence(pack,name){
  const blocks=[],fieldEvidence=[];
  const add=(fieldPath,value)=>{const reference=/\.(answer|explanation|transcript)$/.test(fieldPath),visibility=reference?'reference':'source',id=`native-${hash(fieldPath).slice(0,24)}`;
    blocks.push({id,name,text:Array.isArray(value)?value.join('\n'):String(value??''),paragraph:blocks.length+1,page:null,visibility,layoutState:'unknown'});
    fieldEvidence.push({path:fieldPath,state:present(value)?'known':'missing',method:'native-manifest',visibility,sourceReferences:[{blockId:id,visibility}],blockIds:[id],valueLocated:present(value)});
  };
  for(const [gi,group] of (pack.groups||[]).entries()){add(`groups.${gi}.passage`,group.passage);for(const [qi,question] of (group.questions||[]).entries()){const prefix=`groups.${gi}.questions.${qi}`;for(const key of ['prompt','answer','explanation','transcript'])if(Object.hasOwn(question,key))add(`${prefix}.${key}`,question[key]);for(const [oi,option] of (question.options||[]).entries())add(`${prefix}.options.${oi}.text`,option.text);}}
  return {documentLayout:{blocks,readingOrder:blocks.map(b=>b.id)},fieldEvidence};
}
function worksheetAnswerEvidence(pack,layout,evidence){
  if(!layout?.blocks||!layout.readingOrder)return evidence;
  const byId=new Map(layout.blocks.map(block=>[block.id,block])),blocks=layout.readingOrder.map(id=>byId.get(id)).filter(Boolean),result=structuredClone(evidence);
  for(const [gi,group] of (pack.groups||[]).entries())for(const [qi,question] of (group.questions||[]).entries()){
    if(question.type!=='single_choice'||typeof question.answer!=='string')continue;
    const number=question.localNumber??Number(question.source?.match(/原题号\s+(\d+)/)?.[1]);if(!Number.isInteger(number)||number<1)continue;
    const prefix=`groups.${gi}.questions.${qi}`,prompt=result.find(entry=>entry.path===prefix+'.prompt');if(prompt?.blockIds?.length!==1)continue;
    const at=blocks.findIndex(block=>block.id===prompt.blockIds[0]);if(at<0)continue;
    const heading=block=>/^(Reading|Listening|Speaking|Writing)\s*[:：]/i.test(block.text.trim());
    let end=at+1;while(end<blocks.length&&blocks[end].name===blocks[at].name&&!heading(blocks[end]))end++;
    const matches=[];for(const block of blocks.slice(at,end)){const key=block.text.match(/^(?:Answer key|Answers?)\s*:\s*(.+)$/i);if(!key)continue;const pattern=new RegExp(`(?:^|[;,\\s])${number}\\s*[.):]?\\s*([A-Za-z])(?=$|[;,\\s])`,'g');for(const match of key[1].matchAll(pattern))matches.push({block,value:match[1]});}
    if(!matches.length)continue;
    const known=matches.length===1&&matches[0].value===question.answer,refs=[...new Set(matches.map(match=>match.block.id))];
    const entry={path:prefix+'.answer',state:known?'known':matches.length>1?'ambiguous':'conflict',method:'literal-answer-key-match',visibility:'reference',sourceReferences:refs.map(blockId=>({blockId,visibility:'reference'})),blockIds:refs,valueLocated:known};
    const index=result.findIndex(item=>item.path===entry.path);if(index<0)result.push(entry);else result[index]=entry;
  }
  return result;
}
export function assertWorkspaceEpoch(state,expectedEpoch){if(typeof expectedEpoch!=='string'||expectedEpoch!==state.workspaceEpoch)fail('工作区 epoch 已改变或缺失；请重新打开材料。',409);}
export const materialSourceRevision=material=>hash(canonicalJSON({files:material.files,text:material.text}));
export const newCandidateId=()=>`candidate-${crypto.randomUUID()}`;
export function validateCandidate(candidate){if(!validate(candidate))fail(`候选结构无效：${ajv.errorsText(validate.errors).slice(0,2000)}`);return candidate;}

export function dependencyClosure(refs,index){
  const result=new Map(),visiting=new Set();
  const visit=ref=>{if(result.has(ref))return;if(visiting.has(ref))fail('共享材料依赖包含循环。');const value=index instanceof Map?index.get(ref):index[ref];if(!value)fail('共享材料依赖缺失。');visiting.add(ref);for(const child of value.dependencyRefs||[])visit(child);visiting.delete(ref);result.set(ref,value);};
  refs.forEach(visit);return result;
}

/** Host-derived capabilities. Values and evidence states are independent. */
export function assessCandidate(candidate,artifactIndex={},contractVersion=1,{workspaceEpoch}={}){
  if(contractVersion!==1)fail('不支持的候选执行契约。');
  const blockingIssues=[],warnings=[],f=candidate.fields||{},states=candidate.fieldStates||{};
  const block=(code,path,reason)=>blockingIssues.push({code,path,reason});
  let dependencies=[];try{dependencies=[...dependencyClosure(candidate.dependencyRefs||[],artifactIndex).values()];}catch{block('missing_dependency','dependencyRefs','共享材料尚未完整提供。');}
  const group=dependencies.find(d=>d.kind==='group')?.value||{};
  if(!present(f.prompt)||states.prompt!=='known')block('missing_prompt','prompt','题干缺失或尚未核对。');
  if(!types.has(candidate.answerType)||!EXAM_TASK_KINDS.includes(candidate.taskKind))block('unsupported_interaction','answerType','此交互暂不支持，候选仍保留。');
  const requiredType={complete_words:'fill_blank',read_daily:'single_choice',read_academic:'single_choice',listen_response:'single_choice',listen_conversation:'single_choice',listen_announcement:'single_choice',listen_talk:'single_choice',build_sentence:'sentence_order',write_email:'email',academic_discussion:'discussion',listen_repeat:'listen_repeat',interview:'interview'}[candidate.taskKind];
  if(requiredType&&candidate.answerType!==requiredType)block('kind_type_mismatch','answerType','题型与作答控件不一致。');
  if(['read_daily','read_academic','complete_words'].includes(candidate.taskKind)&&!present(group.passage)&&!present(group.image))block('missing_passage','passage','缺少完整共享文章或题面。');
  const interaction=f.interaction;
  if(interaction&&!['sentence_select','sentence_insert'].includes(interaction.kind))block('unsupported_interaction','interaction','此交互不能作为单选题。');
  if(['single_choice','sentence_order'].includes(candidate.answerType)&&!interaction&&(!Array.isArray(f.options)||f.options.length<2||states.options!=='known'||f.options.some(o=>!present(o.id)||!present(o.text))||new Set(f.options.map(o=>o.id)).size!==f.options.length))block('missing_options','options','选项不完整或有歧义。');
  if(interaction&&(!present(group.passage)||!Array.isArray(interaction.candidates)||interaction.candidates.length<(interaction.kind==='sentence_insert'?4:2)))block('missing_interaction_targets','interaction','正文交互位置不完整。');
  if(interaction){
    const targets=interaction.candidates||[],isInsert=interaction.kind==='sentence_insert';
    if(interaction.textField!=='passage'||interaction.offsetUnit!=='utf16'||interaction.textHash!==hash(group.passage||'')||(isInsert&&(!present(interaction.sentence)||targets.length!==4)))block('invalid_interaction_contract','interaction','缺少原文哈希、完整位置或待插入原句。');
    if(new Set(targets.map(t=>t.id)).size!==targets.length||targets.some((target,i)=>!present(target.id)||!Number.isInteger(target.start)||!Number.isInteger(target.end)||target.start<0||target.end>(group.passage||'').length||(isInsert?target.start!==target.end:target.start>=target.end)||(i>0&&target.start<=targets[i-1].start)))block('invalid_interaction_offsets','interaction','正文交互区间无效。');
  }
  if(candidate.answerType==='sentence_order'&&Object.hasOwn(f,'answerSlots')&&(!Number.isInteger(f.answerSlots)||f.answerSlots<1||f.answerSlots>(f.options?.length||0)||(f.sentenceFrame?.match(/_{2,}/g)||[]).length!==f.answerSlots))block('missing_sentence_frame','sentenceFrame','组句题的句框和空位不完整。');
  if(candidate.taskKind==='complete_words'&&!group.inlineBlanks)block('missing_inline_blanks','inlineBlanks','补字原文位置尚未完整核对。');
  if(candidate.taskKind==='complete_words'&&group.inlineBlanks){const inline=group.inlineBlanks,anchors=inline.anchors,passage=group.passage||'';
    if(inline.textField!=='passage'||inline.offsetUnit!=='utf16'||inline.answerMode!=='missing_letters'||inline.textHash!==hash(passage)||!Array.isArray(anchors)||!anchors.some(a=>a.questionId===candidate.sourceQuestionId)||anchors.some((a,i)=>![a.prefixStart,a.prefixEnd,a.start,a.end,a.missingLetterCount].every(Number.isInteger)||typeof a.rawGap!=='string'||typeof a.prefix!=='string'||a.prefixStart<0||a.prefixEnd!==a.start||a.start>=a.end||a.end>passage.length||passage.slice(a.prefixStart,a.prefixEnd)!==a.prefix||passage.slice(a.start,a.end)!==a.rawGap||(a.rawGap.match(/[_-]/g)||[]).length!==a.missingLetterCount||(i>0&&a.prefixStart<anchors[i-1].end)))block('invalid_inline_contract','inlineBlanks','补字原文哈希或 UTF-16 区间不完整。');
  }
  const media=dependencies.filter(d=>d.kind==='media');
  const available=name=>media.some(d=>d.value.name===name&&!['failed','partial'].includes(d.value.evidence?.decodeState));
  if(['listen_response','listen_conversation','listen_announcement','listen_talk','listen_repeat'].includes(candidate.taskKind)&&!available(f.audio||group.audio))block('missing_audio','audio','缺少可用的关键音频。');
  for(const name of [f.audio,f.image,group.audio,group.image,...(group.directions||[]).map(d=>d.audio)].filter(Boolean))if(!available(name))block('missing_media','media','明确引用的媒体尚不可用。');
  for(const mapping of candidate.mappings||[])if(effectiveContentCheck(candidate,mapping,artifactIndex,{workspaceEpoch}).state==='conflict')block('media_content_conflict',mapping.targetId,'媒体内容与本题存在已记录的冲突。');
  for(const issue of candidate.issues||[])if(issue.state==='open'&&issue.scope==='answerability')block(issue.code,issue.path,issue.reason);
  const answerEvidence=(candidate.fieldEvidence||[]).filter(e=>e.path==='answer');
  const keyProven=states.answer==='known'&&present(f.answer)&&!answerEvidence.some(e=>['conflict','ambiguous','unreadable'].includes(e.state))&&!(candidate.issues||[]).some(i=>i.state==='open'&&i.scope==='scoring')&&answerEvidence.some(e=>e.state==='known'&&e.valueLocated===true&&['native-manifest','user-review','literal-answer-row-match','literal-answer-key-match'].includes(e.method));
  const validKey=candidate.answerType==='single_choice'?typeof f.answer==='string'&&(f.interaction?.candidates||f.options||[]).some(o=>o.id===f.answer):candidate.answerType==='sentence_order'?Array.isArray(f.answer)&&f.answer.length===(f.answerSlots??f.options?.length)&&new Set(f.answer).size===f.answer.length&&f.answer.every(id=>f.options?.some(o=>o.id===id)):true;
  if(!keyProven)warnings.push({code:'unverified_answer',path:'answer',reason:'无来源核实的答案，仅可不计分练习。'});
  const canAnswer=blockingIssues.length===0,canScore=canAnswer&&keyProven&&validKey&&objective.has(candidate.answerType);
  return {capabilities:{canDisplay:present(f.prompt)||present(f.image)||present(group.image),canAnswer,canScore,canSimulateOriginal:canAnswer&&keyProven&&validKey&&!candidate.adaptationKind&&candidate.originalOrdinalInTask!=null&&media.every(d=>d.value.evidence?.decodeState==='playable')},answerVerified:keyProven&&validKey,blockingIssues,warnings};
}

/** Processing JSON is a separate CAS namespace, never a media-serving path. */
export function createCandidateRepository({store}){
  const directory=path.join(store.dataDir,'processing-artifacts');
  async function writeArtifact(value){let serialized;try{serialized=canonicalJSON(value);JSON.parse(serialized);}catch{fail('处理产物必须是有限的 JSON。');}const bytes=Buffer.from(serialized);if(bytes.length>16*1024*1024)fail('处理产物超过 16 MB，请拆分产物。');const ref=hash(bytes),destination=path.join(directory,ref);await fs.mkdir(directory,{recursive:true});try{const stat=await fs.lstat(destination);if(!stat.isFile()||stat.isSymbolicLink()||!(await fs.readFile(destination)).equals(bytes))fail('处理产物完整性异常。',500);}catch(error){if(error.code!=='ENOENT')throw error;await atomicWrite(destination,bytes);}return ref;}
  async function readArtifact(ref){if(!/^[a-f0-9]{64}$/.test(ref||''))fail('处理产物引用无效。');const file=path.join(directory,ref),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)fail('处理产物不可用。');const bytes=await fs.readFile(file);if(hash(bytes)!==ref)fail('处理产物完整性校验失败。');return JSON.parse(bytes);}
  const getSet=(state,materialId)=>state.candidateSets?.[materialId];
  async function load(materialId,{state=store.read()}={}){const set=getSet(state,materialId);if(!set)fail('材料尚无候选，请先整理。',404);const index=await readArtifact(set.artifactIndexRef),candidates=await Promise.all(set.candidates.map(async item=>validateCandidate(await readArtifact(item.ref))));return {...structuredClone(set),candidates,artifactIndex:index};}
  async function prepareCandidates({materialId,sourceRevision,candidates,artifactIndex,expectedSetRevision=0}){
    const items=[],previous=getSet(store.read(),materialId);
    if((previous?.revision||0)!==expectedSetRevision)fail('候选集合版本已更新。',409);
    if(!Array.isArray(candidates)||candidates.length>1000||new Set(candidates.map(c=>c.candidateId)).size!==candidates.length)fail('候选数量或身份无效。');
    if(previous?.candidates.some(old=>!candidates.some(candidate=>candidate.candidateId===old.candidateId)))fail('继续处理不能丢弃已有候选，请合并完整候选集合。',409);
    for(const candidate of candidates){
      const copy=structuredClone(candidate);copy.readiness={canDisplay:false,canAnswer:false,canScore:false,canSimulateOriginal:false};validateCandidate(copy);
      if(copy.materialId!==materialId||copy.sourceRevision!==sourceRevision)fail('候选不能引用另一批材料或来源版本。');
      const old=previous?.candidates.find(item=>item.candidateId===copy.candidateId);
      if(!old&&copy.revision!==1||old&&![old.revision,old.revision+1].includes(copy.revision))fail('候选修订必须从 1 开始并逐次增加。',409);
      if(old&&copy.revision===old.revision){const before=await readArtifact(old.ref),withoutReadiness=value=>{const result={...value};delete result.readiness;return result;};if(canonicalJSON(withoutReadiness(before))!==canonicalJSON(withoutReadiness(copy)))fail('已有候选内容变动必须生成新修订。',409);}
      copy.readiness=assessCandidate(copy,artifactIndex,1,{workspaceEpoch:store.read().workspaceEpoch}).capabilities;validateCandidate(copy);items.push({candidateId:copy.candidateId,revision:copy.revision,ref:await writeArtifact(copy),readiness:copy.readiness});
    }
    return {materialId,sourceRevision,expectedSetRevision,artifactIndexRef:await writeArtifact(artifactIndex),candidates:items};
  }
  function commitPrepared(state,prepared,{expectedEpoch}){
    assertWorkspaceEpoch(state,expectedEpoch);const material=state.materials?.find(m=>m.id===prepared.materialId);if(!material||materialSourceRevision(material)!==prepared.sourceRevision)fail('原件版本已改变。',409);
    state.candidateSets||={};const previous=getSet(state,material.id);if((previous?.revision||0)!==prepared.expectedSetRevision)fail('候选已有更新，本次结果冲突。',409);
    state.candidateSets[material.id]={sourceRevision:prepared.sourceRevision,revision:(previous?.revision||0)+1,artifactIndexRef:prepared.artifactIndexRef,candidates:prepared.candidates,history:[...(previous?.history||[]),...(previous?[{revision:previous.revision,artifactIndexRef:previous.artifactIndexRef,candidates:previous.candidates}]:[])]};
    material.candidateSummary={total:prepared.candidates.length,answerable:prepared.candidates.filter(c=>c.readiness.canAnswer).length,pending:prepared.candidates.filter(c=>!c.readiness.canAnswer).length};
    material.status='draft_ready';material.draft={candidateReview:true,sourceRevision:prepared.sourceRevision};material.updatedAt=new Date().toISOString();
    return state.candidateSets[material.id];
  }
  async function ingestPack({materialId,pack,files=new Map(),method='parser',documentLayout=null,fieldEvidence=[],issues=[],expectedEpoch,probeMedia,signal,assertCurrent}){
    const snapshot=store.read();assertWorkspaceEpoch(snapshot,expectedEpoch);const material=snapshot.materials.find(m=>m.id===materialId);if(!material)fail('找不到材料。',404);
    const sourceRevision=materialSourceRevision(material),previous=getSet(snapshot,materialId);if(previous)return load(materialId); // Reprocessing cannot replace reviewed fields.
    const check=()=>{signal?.throwIfAborted();assertCurrent?.();const current=store.read();assertWorkspaceEpoch(current,expectedEpoch);const original=current.materials.find(item=>item.id===materialId);if(!original||materialSourceRevision(original)!==sourceRevision)fail('原材料已变化；旧的本机探测未采用。',409);};check();
    if(method.startsWith('native'))({documentLayout,fieldEvidence}=nativeEvidence(pack,material.files.find(file=>/\.json$/i.test(file.name))?.name||'练习包原件'));
    else if(method==='worksheet')fieldEvidence=worksheetAnswerEvidence(pack,documentLayout,fieldEvidence);
    const artifactIndex={},add=async value=>{check();const ref=await writeArtifact(value);check();artifactIndex[ref]=value;return ref;};
    const sourceRef=await add({kind:'document',value:{documentLayout,fieldEvidence,originals:material.files.map(f=>({id:f.id,name:f.name}))},dependencyRefs:[]});
    const probes=new Map(),canonical=await canonicalizeMediaFiles(files,{probeMedia:typeof probeMedia==='function'?async asset=>{check();const result=await probeMedia(asset);check();probes.set(asset.originalAssetId,result);return result;}:undefined}),mediaRefs=new Map();check();
    canonical.entries=canonical.entries.map(evidence=>mediaDecodeEvidence(evidence,probes.get(evidence.originalHash)));
    const mediaManifestRef=await add({kind:'media-manifest',value:{entries:canonical.entries},dependencyRefs:[sourceRef]});
    for(const [name,bytes] of canonical.files){const blob=await store.writeBlob(bytes,identifyMedia(name,bytes).mime),evidence=canonical.entries.find(e=>canonical.nameMap.get(e.originalName)===name);mediaRefs.set(name,await add({kind:'media',value:{name,blob,evidence},dependencyRefs:[]}));}
    const context=mapPackageMedia({groups:[],...(Array.isArray(pack.examSets)?{examSets:pack.examSets}:{})},name=>canonical.nameMap.get(name)||name);
    const contextRef=await add({kind:'pack-context',value:context,dependencyRefs:[sourceRef,...collectMediaPaths(context).filter(name=>mediaRefs.has(name)).map(name=>mediaRefs.get(name))]});
    const candidates=[];
    for(const [gi,group] of (pack.groups||[]).entries()){
      const shared=structuredClone(group);delete shared.questions;delete shared.id;
      for(const key of ['audio','image'])if(shared[key])shared[key]=canonical.nameMap.get(shared[key])||shared[key];
      for(const d of shared.directions||[])if(d.audio)d.audio=canonical.nameMap.get(d.audio)||d.audio;
      const groupRef=await add({kind:'group',sourceGroupIndex:gi,sourceGroupId:group.id||null,sourceQuestionIds:(group.questions||[]).map(q=>q.id||null),value:shared,dependencyRefs:[sourceRef,contextRef,mediaManifestRef,...[shared.audio,shared.image,...(shared.directions||[]).map(d=>d.audio)].filter(n=>mediaRefs.has(n)).map(n=>mediaRefs.get(n))]});
      for(const [qi,q] of (group.questions||[]).entries()){
        const fields=Object.fromEntries(fieldNames.filter(key=>Object.hasOwn(q,key)).map(key=>[key,structuredClone(q[key])]));
        let unsupportedInteractionRef=null;
        if(fields.interaction&&!['sentence_select','sentence_insert'].includes(fields.interaction.kind)){unsupportedInteractionRef=await add({kind:'unsupported-interaction',value:fields.interaction,dependencyRefs:[sourceRef]});fields.interaction={kind:String(fields.interaction.kind||'unsupported'),rawArtifactRef:unsupportedInteractionRef};}
        for(const key of ['audio','image'])if(fields[key])fields[key]=canonical.nameMap.get(fields[key])||fields[key];
        fields.answer??=null;
        const prefix=`groups.${gi}.questions.${qi}.`,evidence=fieldEvidence.filter(e=>e.path.startsWith(prefix)).map(e=>({...e,path:e.path.slice(prefix.length),artifactRef:sourceRef}));
        if(method==='ai-draft')for(const entry of evidence)if(entry.path==='answer'){entry.state='referenced';entry.valueLocated=false;entry.method='model-proposal';}
        const sourceTaskId=q.sourcePositionV1?.sourceTaskId||`${materialId}:${sourceRevision.slice(0,16)}:${group.id||gi}`;
        const kind=group.taskKind||({single_choice:group.section==='listening'?'listen_response':'read_daily',fill_blank:'complete_words',sentence_order:'build_sentence',email:'write_email',discussion:'academic_discussion',interview:'interview',listen_repeat:'listen_repeat'})[q.type]||'unsupported';
        const candidate={schemaVersion:1,candidateId:newCandidateId(),materialId,sourceRevision,sourceTaskId,originalOrdinalInTask:q.sourcePositionV1?q.sourcePositionV1.originalOrdinalInTask:q.ordinalInTask??qi+1,sourceQuestionNumber:q.localNumber??(Number(q.source?.match(/原题号\s+(\d+)/)?.[1])||null),taskKind:kind,answerType:q.type||'unknown',fields,fieldStates:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,present(v)?'known':'missing'])),fieldEvidence:evidence,dependencyRefs:[groupRef,...[fields.audio,fields.image].filter(n=>mediaRefs.has(n)).map(n=>mediaRefs.get(n))],mappings:[],issues:[],revision:1,readiness:{canDisplay:false,canAnswer:false,canScore:false,canSimulateOriginal:false},adaptationKind:q.candidateLineageV1?.adaptationKind||null,parentCandidateId:q.candidateLineageV1?.parentCandidateId||null};
        const candidatePath=`groups[${gi}].questions[${qi}]`;
        candidate.sourceQuestionId=q.id||null;
        if(unsupportedInteractionRef)candidate.dependencyRefs.push(unsupportedInteractionRef);
        for(const issue of issues.filter(issue=>issue.severity==='error'&&(issue.path?.startsWith(candidatePath)||issue.path===`groups[${gi}].passage`))){
          const resolvedAlias=issue.path===`${candidatePath}.audio`&&canonical.nameMap.has(q.audio)&&canonical.nameMap.get(q.audio)!==q.audio&&issue.message===`媒体内容与文件类型不符或格式不受支持：${q.audio}`;
          candidate.issues.push({code:'source_validation',scope:/answer|explanation/.test(issue.path)?'scoring':'answerability',path:issue.path,reason:String(issue.message).slice(0,2000),state:resolvedAlias?'resolved':'open',evidenceRef:sourceRef});
        }
        for(const [targetId,name,role] of [['audio',fields.audio,'question'],['image',fields.image,'question'],['groupAudio',shared.audio,'stimulus'],['groupImage',shared.image,'stimulus'],...(shared.directions||[]).filter(d=>d.audio).map(d=>[`direction:${d.id}`,d.audio,'directions'])]){
          if(!name)continue;
          const assets=[...mediaRefs].map(([originalName,assetId])=>({originalName,assetId,scopeId:sourceTaskId,role}));
          const target={targetId,scopeId:sourceTaskId,role,candidateRevision:1,...(method.startsWith('native')?{explicitRef:name}:{filenameHints:[name]})};
          candidate.mappings.push({...resolveMediaMappings({assets,targets:[target]}).mappings[0],candidateRevision:1});
        }
        candidates.push(candidate);
      }
    }
    const prepared=await prepareCandidates({materialId,sourceRevision,candidates,artifactIndex});check();await store.transact(state=>{check();return commitPrepared(state,prepared,{expectedEpoch});},{expectedEpoch});return load(materialId);
  }
  async function patchCandidate({materialId,candidateId,expectedRevision,expectedEpoch,fields,actor='user',mapping,reviewFields=[]}){
    const snapshot=store.read();assertWorkspaceEpoch(snapshot,expectedEpoch);const loaded=await load(materialId,{state:snapshot}),candidate=loaded.candidates.find(c=>c.candidateId===candidateId);if(!candidate||candidate.revision!==expectedRevision)fail('候选已有更新，编辑冲突。',409);
    if(!['user','model'].includes(actor))fail('候选编辑来源无效。');
    if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.keys(fields).some(k=>!fieldNames.includes(k)))fail('字段 patch 包含未知字段。');
    if(!Array.isArray(reviewFields)||reviewFields.some(key=>!fieldNames.includes(key))||reviewFields.length&&actor!=='user')fail('只有用户可确认字段校对。');
    fields={...Object.fromEntries(reviewFields.map(key=>[key,candidate.fields[key]??null])),...fields};
    fields=Object.fromEntries(Object.entries(fields).filter(([key,value])=>reviewFields.includes(key)||canonicalJSON(value)!==canonicalJSON(candidate.fields[key])));
    if(!Object.keys(fields).length&&!mapping)return candidate;
    if(actor==='model'&&candidate.fieldEvidence.some(e=>Object.hasOwn(fields,e.path)&&e.method==='user-review'))fail('模型结果与人工校对字段冲突。',409);
    candidate.revision++;candidate.fields={...candidate.fields,...structuredClone(fields)};
    for(const [key,value] of Object.entries(fields)){candidate.fieldStates[key]=present(value)?'known':'missing';candidate.fieldEvidence=candidate.fieldEvidence.filter(e=>e.path!==key);candidate.fieldEvidence.push({path:key,state:present(value)?'known':'missing',method:actor==='user'?'user-review':'model-proposal',visibility:['answer','explanation'].includes(key)?'reference':'source',sourceReferences:[],valueLocated:actor==='user'&&present(value)});}
    if(actor==='user')for(const issue of candidate.issues)if(Object.keys(fields).some(key=>issue.path===key||issue.path.endsWith(`.${key}`)||issue.path.includes(`.${key}[`)))issue.state='resolved';
    if(mapping){
      if(actor!=='user'||Object.keys(mapping).some(key=>!['targetId','assetId','contentChecked'].includes(key))||!['audio','image','groupAudio','groupImage'].includes(mapping.targetId)||loaded.artifactIndex[mapping.assetId]?.kind!=='media'||typeof mapping.contentChecked!=='boolean')fail('媒体映射目标无效。');
      const asset=loaded.artifactIndex[mapping.assetId],mediaField=/audio/i.test(mapping.targetId)?'audio':'image';if(!asset.value.blob.mime.startsWith(mediaField+'/'))fail('媒体格式与对应角色不符。');
      let affected=[candidate];
      if(mapping.targetId.startsWith('group')){
        const oldRef=candidate.dependencyRefs.find(ref=>loaded.artifactIndex[ref]?.kind==='group'),group=structuredClone(loaded.artifactIndex[oldRef]);if(!group)fail('找不到共享材料。');group.value[mediaField]=asset.value.name;group.dependencyRefs=[...new Set([...group.dependencyRefs,mapping.assetId])];const newRef=await writeArtifact(group);loaded.artifactIndex[newRef]=group;
        affected=loaded.candidates.filter(item=>item.dependencyRefs.includes(oldRef));for(const item of affected){item.dependencyRefs=item.dependencyRefs.map(ref=>ref===oldRef?newRef:ref);if(item!==candidate)item.revision++;}
      }else{candidate.fields[mediaField]=asset.value.name;candidate.fieldStates[mediaField]='known';candidate.dependencyRefs=[...new Set([...candidate.dependencyRefs,mapping.assetId])];}
      for(const item of affected){item.mappings=item.mappings.filter(m=>m.targetId!==mapping.targetId).map(m=>invalidateContentCheck(m,item.revision));item.mappings.push({targetId:mapping.targetId,assetId:mapping.assetId,mappingBasis:'user',mappingState:'applied',contentCheckState:mapping.contentChecked?'matched':'notChecked',contentCheckMethod:'user-review',candidateRevision:item.revision});}
    }
    candidate.mappings=candidate.mappings.map(m=>m.candidateRevision===candidate.revision?m:invalidateContentCheck(m,candidate.revision));
    const prepared=await prepareCandidates({materialId,sourceRevision:loaded.sourceRevision,candidates:loaded.candidates,artifactIndex:loaded.artifactIndex,expectedSetRevision:loaded.revision});await store.transact(state=>commitPrepared(state,prepared,{expectedEpoch}));return (await load(materialId)).candidates.find(c=>c.candidateId===candidateId);
  }
  return {writeArtifact,readArtifact,load,prepareCandidates,commitPrepared,ingestPack,patchCandidate};
}
