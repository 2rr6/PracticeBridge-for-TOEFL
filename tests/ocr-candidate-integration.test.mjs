import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createStore} from '../src/store.mjs';
import {createMaterialInbox} from '../src/materials.mjs';
import {createCandidateRepository,materialSourceRevision,dependencyClosure} from '../src/material-candidates.mjs';
import {createMaterialCompiler} from '../src/material-compiler.mjs';
import {prepareOcrCandidateSet} from '../src/ocr-candidates.mjs';
import {authoredScanPng} from './helpers/ocr-fixture.mjs';
import {hash} from '../src/ocr-policy.mjs';
import {inspectProcessingSnapshot,readProcessingBytes} from '../src/processing-backup.mjs';
import {buildExamPlan} from '../src/exam-plan.mjs';
import {renderTask} from '../public/exam-views.mjs';

// This exercises real candidate/schema/compiler/CAS boundaries with an explicit
// synthetic OCR protocol record. Actual engine/UI acceptance is a separate run.
test('OCR source review compiles a real unscored subset with complete original-image backup closure',async t=>{
  const root=path.resolve('test-results/ocr-candidate-integration');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'run-'));
  const store=await createStore({dataDir:dir}),inbox=createMaterialInbox({store}),repository=createCandidateRepository({store}),compiler=createMaterialCompiler({store,repository});
  t.after(async()=>{await store.close();assert.ok(dir.startsWith(root+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  const image=authoredScanPng(),imageRef=hash(image.bytes),material=await inbox.receive({files:[{name:'self-authored-scan.png',data:image.bytes.toString('base64')}]}),sourceRevision=materialSourceRevision(material);
  const artifactDir=path.join(dir,'processing-artifacts');await fs.mkdir(artifactDir,{recursive:true});await fs.writeFile(path.join(artifactDir,imageRef),image.bytes);
  const evidenceRef=await repository.writeArtifact({version:1,kind:'ocr-evidence',state:'needs_review',text:image.lines.join('\n'),words:[],confidence:null,source:{assetId:imageRef,sourceRevision,page:1,region:{x:0,y:0,width:1,height:1},imageRef,width:1200,height:1000},engine:{backend:'synthetic-protocol-fixture'},issues:[],answerVerified:false});
  const proposal={prompt:'Which door is NOT open?',options:[{id:'A',text:'The red door.'},{id:'B',text:'The blue door.'}],passage:'The red door is NOT open. The blue door is open.',instructions:'Read the notice and choose one answer.',sourceQuestionNumber:1};
  const input={repository,store,readImage:ref=>readProcessingBytes(dir,ref),material,sourceRevision,evidenceRef,proposal};
  const unreviewed=await prepareOcrCandidateSet(input);assert.equal(unreviewed.candidates[0].readiness.canAnswer,false);assert.equal(unreviewed.candidates[0].readiness.canScore,false);
  const prepared=await prepareOcrCandidateSet({...input,review:{completeQuestion:true,completeDependencies:true,readable:true,answerSafe:true,fieldsConfirmed:true,criticalDifferencesResolved:true}}),epoch=store.getWorkspaceEpoch();
  await store.transact(state=>repository.commitPrepared(state,prepared,{expectedEpoch:epoch}));
  const loaded=await repository.load(material.id),candidate=loaded.candidates[0];assert.equal(candidate.readiness.canAnswer,true);assert.equal(candidate.readiness.canScore,false);assert.equal(candidate.originalOrdinalInTask,null);assert.equal(candidate.fields.answer,null);
  const closure=dependencyClosure(candidate.dependencyRefs,loaded.artifactIndex);assert.ok([...closure.values()].some(entry=>entry.kind==='ocr-evidence'));assert.ok([...closure.values()].some(entry=>entry.kind==='media'));
  const output=await compiler.compilePracticeSubset({materialId:material.id,sourceRevision,selectedIds:[candidate.candidateId],candidateRevisions:{[candidate.candidateId]:candidate.revision},expectedEpoch:epoch,importOperationId:'reviewed-ocr-fixture'});
  assert.equal(output.normalizedPack.schemaVersion,2);assert.equal(output.normalizedPack.groups[0].questions[0].answer,null);assert.equal(output.normalizedPack.groups[0].questions[0].sourcePositionV1.originalOrdinalInTask,null);
  const group=output.normalizedPack.groups[0],task=buildExamPlan(output.normalizedPack).sections[0].modules[0].tasks[0];
  const html=renderTask({task,group,question:group.questions[0],answers:{},phase:'response',mode:'practice'});assert.ok(html.includes(proposal.instructions));assert.ok(html.includes(proposal.passage));assert.ok(html.includes(proposal.prompt));
  const backup=await inspectProcessingSnapshot(store.read(),{readBytes:ref=>readProcessingBytes(dir,ref)});assert.ok(backup.files.has(evidenceRef));assert.ok(backup.files.has(imageRef));assert.ok(backup.blobInfo.has(imageRef));assert.deepEqual(await inbox.loadFiles(material.id),[{name:'self-authored-scan.png',data:image.bytes.toString('base64')}]);
});
