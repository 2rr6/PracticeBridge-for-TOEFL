import crypto from 'node:crypto';
import {InputError,canonicalJSON,validatePackage,collectMediaPaths,contentHash} from './package.mjs';
import {assessCandidate,dependencyClosure,assertWorkspaceEpoch,materialSourceRevision} from './material-candidates.mjs';

const digest=value=>crypto.createHash('sha256').update(canonicalJSON(value)).digest('hex');
const fail=(message,status=409)=>{throw new InputError(message,status);};

export function createMaterialCompiler({store,repository}){
  function receiptResult(state,stored){if(!stored.receipt)return {normalizedPack:null,mediaRefs:[],lineage:null,completeness:stored.completeness,receipt:null};const library=state.libraries.find(l=>l.libraryId===stored.receipt.libraryId);if(!library)fail('导入收据引用的题库缺失。',500);return {normalizedPack:library.originalPack,mediaRefs:[...new Set(Object.values(library.mediaMap))].map(id=>state.blobs[id]),lineage:library.lineage,completeness:stored.completeness,receipt:stored.receipt};}
  const committedIn=(state,candidate)=>state.libraries.find(l=>l.lineage?.materialId===candidate.materialId&&l.lineage?.sourceRevision===candidate.sourceRevision&&l.lineage.candidates.some(ref=>ref.candidateId===candidate.candidateId&&ref.revision===candidate.revision));
  async function compilePracticeSubset(request){
    const allowed=['materialId','sourceRevision','candidateRevisions','selectedIds','importOperationId','expectedEpoch'];
    if(!request||Object.keys(request).some(key=>!allowed.includes(key)))fail('编译请求包含未知字段。',400);
    const {materialId,sourceRevision,candidateRevisions,selectedIds,importOperationId,expectedEpoch}=request;
    const snapshot=store.read();assertWorkspaceEpoch(snapshot,expectedEpoch);
    if(typeof importOperationId!=='string'||!/^[A-Za-z0-9-]{1,100}$/.test(importOperationId)||!Array.isArray(selectedIds)||selectedIds.length>1000||new Set(selectedIds).size!==selectedIds.length||!candidateRevisions||Array.isArray(candidateRevisions))fail('候选选择或操作 ID 无效。',400);
    const requestDigest=digest(request),previous=snapshot.importReceipts?.[importOperationId];
    if(previous){if(previous.requestDigest!==requestDigest)fail('同一操作 ID 的请求内容不同，发生冲突。');return structuredClone(receiptResult(snapshot,previous));}
    const loaded=await repository.load(materialId,{state:snapshot});if(loaded.sourceRevision!==sourceRevision)fail('材料来源版本已改变。');
    const requested=selectedIds.map(id=>{const candidate=loaded.candidates.find(c=>c.candidateId===id);if(!candidate||candidate.revision!==candidateRevisions[id])fail('候选版本已更新。');return candidate;});
    for(const candidate of requested)if(!assessCandidate(candidate,loaded.artifactIndex,1,{workspaceEpoch:snapshot.workspaceEpoch}).capabilities.canAnswer)fail('所选候选仍有待补材料，不能加入可用部分。',400);
    const selected=requested.filter(candidate=>!committedIn(snapshot,candidate));
    const pending=loaded.candidates.filter(c=>!assessCandidate(c,loaded.artifactIndex,1,{workspaceEpoch:snapshot.workspaceEpoch}).capabilities.canAnswer).length;
    const completeness={materialCoverage:'partial',examCompleteness:'unknown',selectionCoverage:'selected-only',selected:requested.length,pending,total:loaded.candidates.length};
    if(!selected.length)return store.transact(state=>{
      assertWorkspaceEpoch(state,expectedEpoch);if(state.candidateSets?.[materialId]?.revision!==loaded.revision)fail('候选已更新。');state.importReceipts||={};const prior=state.importReceipts[importOperationId];if(prior&&prior.requestDigest!==requestDigest)fail('同一操作 ID 内容冲突。');
      const libraries=[...new Map(requested.map(candidate=>{const library=committedIn(state,candidate);if(!library)fail('候选导入位置已改变。');return [library.libraryId,library];})).values()];
      const receipt=libraries.length?{operationId:importOperationId,libraryId:libraries[0].libraryId,libraryIds:libraries.map(l=>l.libraryId),contentHash:libraries[0].contentHash,selectionKey:digest({materialId,sourceRevision,selected:requested.map(c=>[c.candidateId,c.revision]).sort()}),selected:requested.length,added:0,pending}:null;
      state.importReceipts[importOperationId]=prior||{requestDigest,receipt,completeness};return receiptResult(state,state.importReceipts[importOperationId]);
    });
    const groups=new Map(),media=new Map(),sourceGroups=new Map(),contexts=new Map(),questionIds=new Set();
    for(const candidate of selected){
      const closure=dependencyClosure(candidate.dependencyRefs,loaded.artifactIndex),entry=[...closure].find(([,d])=>d.kind==='group');if(!entry)fail('缺少共享题组。',400);
      const [groupRef,dependency]=entry;let group=groups.get(groupRef);
      if(!group){const sourceId=dependency.sourceGroupId,id=sourceId&&![...groups.values()].some(g=>g.id===sourceId)?sourceId:`group-${groupRef.slice(0,24)}`;group={...structuredClone(dependency.value),id,taskKind:candidate.taskKind,questions:[]};groups.set(groupRef,group);sourceGroups.set(sourceId,[...(sourceGroups.get(sourceId)||[]),id]);}
      const assessment=assessCandidate(candidate,loaded.artifactIndex,1,{workspaceEpoch:snapshot.workspaceEpoch});
      const id=candidate.sourceQuestionId&&!questionIds.has(candidate.sourceQuestionId)?candidate.sourceQuestionId:candidate.candidateId;questionIds.add(id);
      const question={...structuredClone(candidate.fields),id,type:candidate.answerType,ordinalInTask:group.questions.length+1,localNumber:Number.isInteger(candidate.sourceQuestionNumber)?candidate.sourceQuestionNumber:null,sourcePositionV1:{sourceTaskId:candidate.sourceTaskId,originalOrdinalInTask:candidate.originalOrdinalInTask},candidateLineageV1:{candidateId:candidate.candidateId,revision:candidate.revision,adaptationKind:candidate.adaptationKind,parentCandidateId:candidate.parentCandidateId}};
      // Missing optional notes remain missing in the candidate. The strict
      // package projection omits them and keeps the unknown answer as null.
      for(const field of ['explanation','transcript'])if(question[field]===null)delete question[field];
      if(!assessment.answerVerified)question.answer=null;
      group.questions.push(question);
      for(const [ref,item] of closure)if(item.kind==='media')media.set(item.value.name,item.value.blob);else if(item.kind==='pack-context')contexts.set(ref,item.value);
    }
    // Keep the complete shared passage and immutable offsets; remap only selected anchors.
    for(const [ref,group] of groups)if(group.inlineBlanks){const same=selected.filter(c=>c.dependencyRefs.includes(ref));group.inlineBlanks.anchors=group.inlineBlanks.anchors.flatMap(anchor=>{const candidate=same.find(c=>c.sourceQuestionId===anchor.questionId),question=candidate&&group.questions.find(q=>q.candidateLineageV1.candidateId===candidate.candidateId);return question?[{...anchor,questionId:question.id}]:[];});}
    const selectionKey=digest({materialId,sourceRevision,selected:selected.map(c=>[c.candidateId,c.revision]).sort()}),material=snapshot.materials.find(m=>m.id===materialId);
    const input={schemaVersion:2,id:`subset-${selectionKey.slice(0,24)}`,version:'1',title:`${material.title} · 可用部分`,description:'所选候选的部分练习；完整考试范围尚未确认。',rights:'',coverageV1:{materialCoverage:'partial',examCompleteness:'unknown',selectionCoverage:'selected-only'},groups:[...groups.values()]};
    const context=[...contexts.values()][0];
    if(context?.examSets){input.examContractVersion=1;input.minReaderVersion='0.5.0';input.examSets=structuredClone(context.examSets).flatMap(set=>{set.sections=set.sections.flatMap(section=>{section.modules=section.modules.flatMap(module=>{module.taskIds=module.taskIds.flatMap(id=>sourceGroups.get(id)||[]);return module.taskIds.length?[module]:[];});return section.modules.length?[section]:[];});return set.sections.length?[set]:[];});}
    const files=new Map();for(const [name,blob] of media)files.set(name,await store.readBlob(blob.id));
    const validated=validatePackage(input,files);if(validated.issues.some(i=>i.severity==='error'))fail(`所选候选未通过正式题包校验：${validated.issues.filter(i=>i.severity==='error').map(i=>i.message).join('；')}`,400);
    const mediaMap=Object.fromEntries(collectMediaPaths(validated.pack).map(name=>[name,media.get(name).id])),hash=contentHash(validated.pack,mediaMap);
    const lineage={version:1,materialId,sourceRevision,selectionKey,revisesLibraryIds:snapshot.libraries.filter(l=>l.lineage?.materialId===materialId&&l.lineage.candidates.some(old=>selected.some(c=>c.candidateId===old.candidateId&&c.revision>old.revision))).map(l=>l.libraryId),candidates:selected.map(c=>({candidateId:c.candidateId,revision:c.revision,adaptationKind:c.adaptationKind,parentCandidateId:c.parentCandidateId})),completeness};
    return store.transact(state=>{
      assertWorkspaceEpoch(state,expectedEpoch);const prior=state.importReceipts?.[importOperationId];if(prior){if(prior.requestDigest!==requestDigest)fail('同一操作 ID 内容冲突。');return receiptResult(state,prior);}
      const current=state.candidateSets?.[materialId],currentMaterial=state.materials.find(m=>m.id===materialId);if(!currentMaterial||materialSourceRevision(currentMaterial)!==sourceRevision||current?.revision!==loaded.revision)fail('候选或原件已更新，请重新选择。');
      if(selected.some(candidate=>committedIn(state,candidate)))fail('候选导入状态刚刚更新，请重试；没有重复加入题目。');
      let library=state.libraries.find(l=>l.lineage?.selectionKey===selectionKey);
      if(!library){library={libraryId:crypto.randomUUID(),importedAt:new Date().toISOString(),contentHash:hash,originalPack:validated.pack,mediaMap,lineage};for(const blob of media.values())state.blobs[blob.id]=blob;state.libraries.push(library);}
      const receipt={operationId:importOperationId,libraryId:library.libraryId,libraryIds:[...new Set([library.libraryId,...requested.flatMap(c=>{const found=committedIn(state,c);return found?[found.libraryId]:[];})])],contentHash:library.contentHash,selectionKey,selected:requested.length,added:selected.length,pending};
      const stored={requestDigest,receipt,completeness};
      state.importReceipts||={};state.importReceipts[importOperationId]=stored;currentMaterial.libraryId=library.libraryId;currentMaterial.status=pending?'needs_information':'imported';currentMaterial.updatedAt=new Date().toISOString();return receiptResult(state,stored);
    });
  }
  return {compilePracticeSubset};
}
