import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../src/material-candidates.mjs').catch(() => ({}));
test('candidate boundary exists and distinguishes answerability from scoring', async () => {
  assert.equal(typeof module.assessCandidate, 'function', 'host readiness assessment is required');
  const candidate = { taskKind:'read_daily', answerType:'single_choice', fields:{prompt:'What color?',options:[{id:'A',text:'Red'},{id:'B',text:'Blue'}],answer:null}, fieldStates:{prompt:'known',options:'known',answer:'missing'}, dependencyRefs:['passage'], mappings:[], issues:[] };
  const artifacts = {passage:{kind:'group',value:{section:'reading',passage:'The flag is blue.'},dependencyRefs:[]}};
  assert.deepEqual(module.assessCandidate(candidate, artifacts).capabilities, {canDisplay:true,canAnswer:true,canScore:false,canSimulateOriginal:false});
  assert.equal(module.assessCandidate({...candidate,taskKind:'listen_conversation'},artifacts).capabilities.canAnswer,false);
  assert.equal(module.assessCandidate({...candidate,answerType:'multiple_choice'},artifacts).capabilities.canAnswer,false);
});
test('an answer reference without literal value evidence cannot enable scoring', () => {
  assert.equal(typeof module.assessCandidate,'function');
  const candidate={taskKind:'read_daily',answerType:'single_choice',fields:{prompt:'Choose.',options:[{id:'A',text:'One'},{id:'B',text:'Two'}],answer:'A'},fieldStates:{prompt:'known',options:'known',answer:'known'},dependencyRefs:['p'],fieldEvidence:[{path:'answer',state:'known',valueLocated:false,method:'parser-source-reference'}],mappings:[],issues:[]};
  assert.equal(module.assessCandidate(candidate,{p:{kind:'group',value:{passage:'Whole passage.'},dependencyRefs:[]}}).capabilities.canScore,false);
});
test('readiness rejects kind/type mismatch, incomplete insertion positions and answer conflicts', () => {
  const artifacts={p:{kind:'group',value:{section:'reading',passage:'Whole passage.'},dependencyRefs:[]}};
  const candidate={taskKind:'read_daily',answerType:'single_choice',fields:{prompt:'Choose.',options:[{id:'A',text:'One'},{id:'B',text:'Two'}],answer:'A'},fieldStates:{prompt:'known',options:'known',answer:'known'},dependencyRefs:['p'],fieldEvidence:[{path:'answer',state:'conflict',valueLocated:true,method:'literal-answer-row-match'}],mappings:[],issues:[]};
  assert.equal(module.assessCandidate({...candidate,answerType:'interview'},artifacts).capabilities.canAnswer,false);
  assert.equal(module.assessCandidate({...candidate,fields:{...candidate.fields,interaction:{kind:'sentence_insert',candidates:[{id:'A',start:0,end:0},{id:'B',start:1,end:1},{id:'C',start:2,end:2},{id:'D',start:3,end:3}]}}},artifacts).capabilities.canAnswer,false,'insertion sentence and immutable text offsets required');
  assert.equal(module.assessCandidate(candidate,artifacts).capabilities.canScore,false);
});
test('complete-word readiness keeps immutable UTF-16 passage anchors mandatory',()=>{
  const candidate={taskKind:'complete_words',answerType:'fill_blank',sourceQuestionId:'q1',fields:{prompt:'Fill the missing letters.',answer:null},fieldStates:{prompt:'known',answer:'missing'},dependencyRefs:['p'],fieldEvidence:[],mappings:[],issues:[]};
  const artifacts={p:{kind:'group',value:{section:'reading',passage:'The ca__ ran.',inlineBlanks:{textField:'passage',offsetUnit:'utf16',answerMode:'missing_letters',textHash:'0'.repeat(64),anchors:[{questionId:'q1',prefixStart:4,prefixEnd:6,start:6,end:8,prefix:'ca',rawGap:'__',missingLetterCount:2}]}},dependencyRefs:[]}};
  assert.equal(module.assessCandidate(candidate,artifacts).capabilities.canAnswer,false,'stale source hash cannot be marked native ready');
});
