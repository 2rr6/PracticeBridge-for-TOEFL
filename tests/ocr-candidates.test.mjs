import test from 'node:test';
import assert from 'node:assert/strict';
import { compareOcrEvidence, projectOcrEvidence, reliableTextRegion } from '../src/ocr-evidence.mjs';
import {prepareOcrCandidateSet} from '../src/ocr-candidates.mjs';
import {hash} from '../src/ocr-policy.mjs';
import {authoredScanPng} from './helpers/ocr-fixture.mjs';

test('OCR disagreements preserve negation and exact blank counts without choosing a winner',()=>{
  for(const [source,recognized,code] of [['The door is NOT open.','The door is open.','critical_negation_conflict'],['A ca _ _ sleeps.','A ca _ sleeps.','blank_anchor_conflict']]){
    const d=compareOcrEvidence(source,recognized);assert.equal(d.textLayer,source);assert.equal(d.ocrText,recognized);assert.equal(d.preferred,null);assert.ok(d.issues.some(i=>i.code===code));
  }
});
test('empty recognition is valid evidence with no recovered question',()=>{
  const result=projectOcrEvidence({data:{text:'',confidence:0,blocks:[],version:'5.5.1'},source:{assetId:'a'.repeat(64),page:1,imageRef:'b'.repeat(64),width:600,height:800},engine:{backend:'tesseract.js',packageVersion:'7.0.0'}});
  assert.equal(result.state,'empty');assert.equal(result.words.length,0);assert.ok(result.issues.some(i=>i.code==='ocr_empty'));assert.equal(result.source.imageRef,'b'.repeat(64));
});
test('word coordinates and actual engine version survive projection',()=>{
  const data={text:'NOT',confidence:83,version:'5.5.1-actual',blocks:[{paragraphs:[{lines:[{words:[{text:'NOT',confidence:83,bbox:{x0:10,y0:20,x1:60,y1:45}}]}]}]}]};
  const r=projectOcrEvidence({data,source:{assetId:'a'.repeat(64),page:1,imageRef:'b'.repeat(64),width:600,height:800},engine:{backend:'tesseract.js',packageVersion:'7.0.0'}});
  assert.deepEqual(r.words[0].bbox,{x0:10,y0:20,x1:60,y1:45});assert.equal(r.engine.engineVersion,'5.5.1-actual');assert.equal(r.state,'needs_review');
});
test('only region-owned trustworthy text skips OCR; sparse or damaged text does not',()=>{
  assert.equal(reliableTextRegion({text:'1. Which door is NOT open? A. Red. B. Blue.',items:[{str:'1. Which door is NOT open? A. Red. B. Blue.',visible:true}],imageIntersects:false}),true);
  assert.equal(reliableTextRegion({text:'Header',items:[{str:'Header',visible:true}],imageIntersects:true}),false);
  assert.equal(reliableTextRegion({text:'Bad \ufffd text',items:[{str:'Bad \ufffd text',visible:true}],imageIntersects:false}),false);
});
test('host producer keeps full source closure and unreviewed fields pending; no answer inferred',async()=>{
  const image=authoredScanPng().bytes,imageId=hash(image),sourceRevision='c'.repeat(64),evidenceRef='d'.repeat(64),material={id:'00000000-0000-4000-8000-000000000000',files:[{id:'a'.repeat(64),name:'original.png'}]};
  const evidence={kind:'ocr-evidence',state:'needs_review',text:'NOT open',words:[],issues:[{code:'critical_negation_conflict',reason:'Source differs'}],source:{assetId:material.files[0].id,sourceRevision,imageRef:imageId,page:1,width:1200,height:1000}};
  const repository={readArtifact:async()=>evidence,writeArtifact:async value=>hash(Buffer.from(JSON.stringify(value))),prepareCandidates:async input=>input};
  const input={repository,store:{writeBlob:async()=>({id:imageId,mime:'image/png',size:image.length})},readImage:async()=>image,material,sourceRevision,evidenceRef,proposal:{prompt:'Which door is NOT open?',options:[{id:'A',text:'Red.'},{id:'B',text:'Blue.'}],passage:'The red door is NOT open. The blue door is open.',instructions:'Read the notice and choose one answer.',sourceQuestionNumber:1}};
  const draft=await prepareOcrCandidateSet(input),candidate=draft.candidates[0];assert.equal(candidate.fields.answer,null);assert.equal(candidate.fieldStates.prompt,'ambiguous');assert.equal(candidate.originalOrdinalInTask,null);assert.equal(candidate.adaptationKind,'ocr_reconstructed');assert.ok(candidate.issues.some(i=>i.scope==='answerability'&&i.state==='open'));
  const group=draft.artifactIndex[candidate.dependencyRefs[0]];assert.equal(group.value.passage,input.proposal.passage);assert.equal(group.value.directions[0].text,input.proposal.instructions);assert.deepEqual(group.value.presentation.document.blocks.map(b=>b.text),[input.proposal.instructions,input.proposal.passage]);const source=draft.artifactIndex[group.dependencyRefs[0]];assert.ok(source.dependencyRefs.every(ref=>draft.artifactIndex[ref]));assert.ok(Object.values(draft.artifactIndex).some(a=>a.kind==='media'&&a.value.blob.id===imageId));
  const reviewed=await prepareOcrCandidateSet({...input,review:{completeQuestion:true,completeDependencies:true,readable:true,answerSafe:true,fieldsConfirmed:true,criticalDifferencesResolved:true}});assert.equal(reviewed.candidates[0].fieldStates.prompt,'known');assert.equal(reviewed.candidates[0].fields.answer,null);assert.ok(reviewed.candidates[0].issues.every(i=>i.state==='resolved'));
  await assert.rejects(prepareOcrCandidateSet({...input,proposal:{...input.proposal,answer:'A'}}));
});
