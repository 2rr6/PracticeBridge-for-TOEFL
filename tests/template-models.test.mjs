import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createModels, PACKAGE_SCHEMA, NORMALIZED_PACKAGE_SCHEMA, TASK_KINDS, hasReadingInteractionEvidence } from '../src/models.mjs';
import { validatePackage } from '../src/package.mjs';

// All content is synthetic and all model responses are local doubles.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const testRoot=path.join(root,'test-results','template-models-tests');
const passage="🌿 The commu____'s garden welcomed child___ after school.";
const prompt='Complete the words by entering only the missing letters.';
const source=['Garden practice','Reading · Module 1','Time: 2 minutes',prompt,passage,'Answer key: 1 nity; 2 ren'].join('\n');
const baseQuestion=(id,localNumber,answer)=>({id,type:'fill_blank',prompt,options:[],answer,explanation:'',audio:null,image:null,timeLimitSeconds:0,prepareSeconds:0,source:'original.txt · original printed item '+localNumber,localNumber,ordinalInTask:localNumber});
const anchor=(questionId,localNumber,prefix,rawGap)=>{
  const prefixStart=passage.indexOf(prefix+rawGap),start=prefixStart+prefix.length;
  return {questionId,localNumber,prefixStart,prefixEnd:start,start,end:start+rawGap.length,missingLetterCount:rawGap.length,prefix,rawGap,source:'original.txt'};
};
const originalPack=()=>({
  schemaVersion:1,examContractVersion:1,minReaderVersion:'0.3.0',id:'original-garden',version:'1.0.0',title:'Garden practice',description:'',rights:'',
  groups:[{id:'words',section:'reading',title:'Garden practice',passage,audio:null,image:null,taskKind:'complete_words',
    presentation:{screen:'all_questions',passageVisibility:'attempt',questionPromptVisibility:'attempt'},
    timing:{scope:'inherit_module',durationSeconds:null,prepareSeconds:null,basis:'unknown',source:''},
    inlineBlanks:{textField:'passage',offsetUnit:'utf16',answerMode:'missing_letters',anchors:[anchor('q1',1,'commu','____'),anchor('q2',2,'child','___')]},
    questions:[baseQuestion('q1',1,'nity'),baseQuestion('q2',2,'ren')]}],
  examSets:[{id:'set-1',title:'Garden practice',sections:[{id:'reading',section:'reading',title:'Reading',modules:[{id:'reading-1',title:'Module 1',sourceNumber:1,taskIds:['words'],timing:{scope:'module',durationSeconds:120,prepareSeconds:null,basis:'document',source:'original.txt · Time: 2 minutes'},instructions:{text:prompt,audio:null,source:'original.txt',basis:'document',verifiedContent:true}}]}]}],
});
const response=output=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}),{status:200});
async function fixture(t,output){
  fs.mkdirSync(testRoot,{recursive:true});const dataDir=fs.mkdtempSync(path.join(testRoot,'run-')),calls=[];
  const models=createModels({dataDir,fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return response(typeof output==='function'?output():output);}});
  await models.updateSettings({provider:'compatible',baseUrl:'https://models.example.invalid/v1',model:'synthetic-template',structuredOutput:'json_object',timeoutSeconds:5,maxOutputTokens:3000});
  t.after(()=>{const target=path.resolve(dataDir);assert.ok(target.startsWith(testRoot+path.sep));fs.rmSync(target,{recursive:true,force:true});});
  return {models,calls};
}
const structure=(models,text=source)=>models.structure({text,title:'Garden practice',mediaNames:[],consent:true});
const invalid=(models,text=source)=>assert.rejects(()=>structure(models,text),error=>error.code==='invalid_model_output');

test('AI template preserves execution hierarchy, inline source offsets and missing-letter answers',async t=>{
  const pack=originalPack(),{models,calls}=await fixture(t,pack),result=await structure(models);
  assert.equal(result.pack.examContractVersion,1);assert.equal(result.pack.minReaderVersion,'0.3.0');
  assert.deepEqual(result.pack.examSets[0].sections[0].modules[0].taskIds,['words']);
  assert.equal(result.pack.groups[0].inlineBlanks.answerMode,'missing_letters');
  assert.equal(result.pack.groups[0].inlineBlanks.textHash,undefined,'A model need not invent a content hash');
  const [first,second]=result.pack.groups[0].inlineBlanks.anchors;
  assert.equal(passage.slice(first.prefixStart,first.prefixEnd),'commu');assert.equal(passage.slice(first.start,first.end),'____');
  assert.equal(passage.slice(first.end,first.end+2),"'s",'Fixed suffix text remains in the passage');
  assert.equal(passage.slice(second.start,second.end),'___');
  assert.equal(result.pack.groups[0].questions[0].answer,'nity');assert.equal(result.pack.groups[0].questions[1].answer,'ren');
  assert.equal(result.pack.examSets[0].sections[0].modules[0].timing.durationSeconds,120);
  assert.deepEqual(result.issues,[]);assert.equal(calls.length,1);
  assert.match(calls[0].body.messages[0].content,/不能根据答案长度生成标记/);
  assert.match(calls[0].body.messages[0].content,/不产生使用权、版权或许可提醒/);
  assert.deepEqual(pack,originalPack(),'Source model fixtures are not mutated');
});

test('model wire schema exposes all 12 task kinds while canonical packages can omit extensions',async t=>{
  assert.equal(new Set(TASK_KINDS).size,12);
  assert.ok(PACKAGE_SCHEMA.required.includes('examSets'));
  assert.ok(PACKAGE_SCHEMA.required.includes('examContractVersion'));
  assert.ok(!NORMALIZED_PACKAGE_SCHEMA.required.includes('examSets'));
  const group=PACKAGE_SCHEMA.properties.groups.items;
  assert.ok(group.required.includes('inlineBlanks'));assert.ok(group.required.includes('presentation'));
  assert.equal(group.properties.taskKind.enum.filter(value=>value!==null).length,12);
  const legacy=originalPack();delete legacy.examSets;delete legacy.examContractVersion;delete legacy.minReaderVersion;
  const g=legacy.groups[0];for(const field of ['taskKind','presentation','timing','inlineBlanks'])delete g[field];
  for(const q of g.questions){delete q.localNumber;delete q.ordinalInTask;}
  const {models}=await fixture(t,legacy),result=await structure(models);
  assert.deepEqual(result.pack,legacy,'An older model response does not acquire fake execution or source metadata');
});

test('unknown execution versions, missing version markers and repeated questions are rejected',async t=>{
  const cases=[];
  for(const key of ['examContractVersion','minReaderVersion']){const pack=originalPack();delete pack[key];cases.push(pack);}
  const future=originalPack();future.examContractVersion=2;cases.push(future);
  const reader=originalPack();reader.minReaderVersion='99.0.0';cases.push(reader);
  const repeated=originalPack();repeated.examSets[0].sections[0].modules.push({...structuredClone(repeated.examSets[0].sections[0].modules[0]),id:'repeated-module'});cases.push(repeated);
  const missing=originalPack();missing.examSets[0].sections[0].modules[0].taskIds=['absent-task'];cases.push(missing);
  for(const pack of cases){const {models}=await fixture(t,pack);await invalid(models);}
});

test('model-generated blank locations must follow original gaps, not an answer-derived reconstruction',async t=>{
  const {models}=await fixture(t,originalPack());
  const filledSource=source.replace(passage,"🌿 The community's garden welcomed children after school.");
  await invalid(models,filledSource);
  const offset=originalPack();offset.groups[0].inlineBlanks.anchors[0].start--;
  await invalid((await fixture(t,offset)).models);
  const guessedCount=originalPack();guessedCount.groups[0].inlineBlanks.anchors[0].missingLetterCount=3;guessedCount.groups[0].questions[0].answer='abc';
  await invalid((await fixture(t,guessedCount)).models);
  const fabricatedHash=originalPack();fabricatedHash.groups[0].inlineBlanks.textHash='0'.repeat(64);
  await invalid((await fixture(t,fabricatedHash)).models);
  const validHash=originalPack();validHash.groups[0].inlineBlanks.textHash=crypto.createHash('sha256').update(passage).digest('hex');
  assert.equal((await structure((await fixture(t,validHash)).models)).issues.length,0);
});

test('unprovided numerical time is unknown while an explicit minute value remains verified',async t=>{
  const pack=originalPack();pack.groups[0].timing={scope:'task',durationSeconds:45,prepareSeconds:null,basis:'document',source:'invented duration'};
  pack.groups[0].questions[0].timeLimitSeconds=45;
  pack.examSets[0].sections[0].modules[0].timing.prepareSeconds=0;
  const result=await structure((await fixture(t,pack)).models);
  assert.equal(result.pack.groups[0].timing.durationSeconds,null);assert.equal(result.pack.groups[0].timing.basis,'unknown');
  assert.equal(result.pack.groups[0].questions[0].timeLimitSeconds,0);
  const moduleTime=result.pack.examSets[0].sections[0].modules[0].timing;
  assert.equal(moduleTime.durationSeconds,120);assert.equal(moduleTime.prepareSeconds,null);assert.equal(moduleTime.basis,'document');
  assert.ok(result.issues.some(issue=>issue.message.includes('数字时限')));
});

test('new display blocks and source transcripts cannot be used to invent missing material',async t=>{
  const pack=originalPack();const g=pack.groups[0];
  g.transcript='A fabricated recording transcript.';g.questions[0].transcript='A fabricated question transcript.';
  g.presentation.document={kind:'notice',title:'Garden practice',blocks:[{kind:'paragraph',text:passage},{kind:'table',rows:[['Garden practice','Invented translated cell.']]}]};
  const result=await structure((await fixture(t,pack)).models);
  assert.equal(result.pack.groups[0].transcript,'');assert.equal(result.pack.groups[0].questions[0].transcript,'');
  assert.equal(result.pack.groups[0].presentation.document.blocks[0].text,passage);
  assert.equal(result.pack.groups[0].presentation.document.blocks[1].rows[0][1],'');
  assert.ok(result.issues.some(issue=>issue.severity==='error'&&issue.path.includes('rows')));
});

test('directions use separate media references without claiming to have heard an unprovided recording',async t=>{
  const pack=originalPack();pack.groups[0].directions=[{id:'directions-1',text:'',audio:'directions.ogg',source:'filename only',basis:'filename',verifiedContent:true}];
  const {models}=await fixture(t,pack);
  const result=await models.structure({text:source,title:'Garden practice',mediaNames:['directions.ogg'],consent:true});
  assert.deepEqual(result.pack.groups[0].directions,[]);
  assert.ok(result.issues.some(issue=>issue.path.endsWith('.audio')));
  assert.ok(result.issues.some(issue=>issue.path.endsWith('.verifiedContent')));
});

test('unsupported interaction objects and invalid metadata limits fail instead of being discarded',async t=>{
  const wrongTask=originalPack();wrongTask.groups[0].taskKind='listen_talk';await invalid((await fixture(t,wrongTask)).models);
  const unknown=originalPack();unknown.groups[0].questions[0].unsupportedInteraction={kind:'arbitrary-widget'};await invalid((await fixture(t,unknown)).models);
  const excessive=originalPack();excessive.groups[0].inlineBlanks.anchors[0].missingLetterCount=101;await invalid((await fixture(t,excessive)).models);
  const negative=originalPack();negative.groups[0].questions[0].localNumber=-1;await invalid((await fixture(t,negative)).models);
});

const readingSentences=['🌿 A quiet path crosses the park.','Rain fills a small pond.','Birds rest near the water.','Shade keeps the path cool.'];
const readingPassage=readingSentences.join(' ');
function readingPack(kind){
  const pack=originalPack(),group=pack.groups[0],module=pack.examSets[0].sections[0].modules[0];
  group.taskKind='read_academic';group.passage=readingPassage;group.presentation.screen='one_question';delete group.inlineBlanks;
  const inserting=kind==='sentence_insert',sentence='The pond also supports insects.';
  const question={...baseQuestion('reading-q1',1,'B'),type:'single_choice',prompt:inserting?`Choose the marked position for this sentence:\n${sentence}`:'Click the sentence that describes the pond.',interaction:{kind,textField:'passage',offsetUnit:'utf16',candidates:readingSentences.map((text,index)=>({id:'ABCD'[index],start:readingPassage.indexOf(text),end:readingPassage.indexOf(text)+(inserting?0:text.length)})),...(inserting?{sentence}:{})}};
  group.questions=[question];module.instructions.text=question.prompt;
  return pack;
}
function readingSource(pack,{marked=true,anonymous=false}={}){
  const question=pack.groups[0].questions[0],insert=question.interaction.kind==='sentence_insert';
  const body=marked?readingSentences.map((text,index)=>insert?`${anonymous?'##':`[${'ABCD'[index]}]`}${text}`:`[${'ABCD'[index]}]${text}[/${'ABCD'[index]}]`).join(' '):readingPassage;
  return `Garden practice\nTime: 2 minutes\n${question.prompt}\n${body}\nAnswer key: 1 B`;
}

test('explicit sentence selection and insertion survive strict AI and native template normalization',async t=>{
  for(const kind of ['sentence_select','sentence_insert']){
    const original=readingPack(kind),{models,calls}=await fixture(t,original),result=await structure(models,readingSource(original));
    const question=result.pack.groups[0].questions[0];
    assert.equal(question.interaction.kind,kind);assert.equal(question.answer,'B');assert.deepEqual(question.options,[]);
    assert.equal(question.interaction.textHash,undefined,'Model hashes are optional, native hashes are computed locally');
    assert.deepEqual(result.issues,[]);assert.equal(result.pack.groups[0].passage,readingPassage);
    const checked=validatePackage(result.pack);
    assert.deepEqual(checked.issues.filter(issue=>issue.severity==='error'),[]);
    assert.equal(checked.pack.groups[0].questions[0].interaction.textHash,crypto.createHash('sha256').update(readingPassage).digest('hex'));
    assert.deepEqual(checked.pack.groups[0].questions[0].interaction.candidates,question.interaction.candidates);
    assert.match(calls[0].body.messages[0].content,/不得扁平化成普通单选列表或扩展成多选题/);
  }
});

test('nullable insertion extensions use their own schema branch while selection rejects a sentence payload',async t=>{
  const inserting=readingPack('sentence_insert');inserting.groups[0].questions[0].interaction.sentence=null;inserting.groups[0].questions[0].interaction.textHash=null;
  const result=await structure((await fixture(t,inserting)).models,readingSource(inserting));
  assert.equal(result.pack.groups[0].questions[0].interaction.sentence,undefined);assert.equal(result.pack.groups[0].questions[0].interaction.textHash,undefined);
  assert.deepEqual(result.issues,[]);
  const selecting=readingPack('sentence_select');selecting.groups[0].questions[0].interaction.sentence='A sentence should not be injected into a selection.';
  await invalid((await fixture(t,selecting)).models,readingSource(selecting));
});

test('legal reading offsets alone do not claim that original candidate markers have been verified',async t=>{
  const pack=readingPack('sentence_insert'),plain=readingSource(pack,{marked:false});
  const result=await structure((await fixture(t,pack)).models,plain);
  assert.ok(result.issues.some(issue=>issue.severity==='error'&&issue.path.endsWith('.interaction.candidates')));
  assert.equal(result.pack.groups[0].questions[0].interaction.candidates.length,4,'An unverified interaction is retained for review instead of replaced with radio options');
  const anonymous=readingSource(pack,{anonymous:true});assert.equal(hasReadingInteractionEvidence(readingPassage,pack.groups[0].questions[0].interaction,anonymous),true);
  const reversed=structuredClone(pack.groups[0].questions[0].interaction);reversed.candidates.forEach((candidate,index)=>candidate.id='DCBA'[index]);
  assert.equal(hasReadingInteractionEvidence(readingPassage,reversed,anonymous),false,'Unlabelled markers do not establish a different candidate-ID order');
  assert.equal(hasReadingInteractionEvidence(readingPassage,{kind:'sentence_insert',candidates:[]},plain),false);
});

test('invalid reading ranges, candidate sets, inserted text and interaction kinds are rejected',async t=>{
  const mutations=[
    pack=>{pack.groups[0].questions[0].interaction.candidates.pop();},
    pack=>{pack.groups[0].questions[0].interaction.candidates[1].id='A';},
    pack=>{pack.groups[0].questions[0].interaction.candidates[1].start=0;pack.groups[0].questions[0].interaction.candidates[1].end=0;},
    pack=>{pack.groups[0].questions[0].interaction.candidates[0].end=1;},
    pack=>{pack.groups[0].questions[0].interaction.candidates[0].start=1;pack.groups[0].questions[0].interaction.candidates[0].end=1;},
    pack=>{pack.groups[0].questions[0].interaction.candidates[3].start=500000;pack.groups[0].questions[0].interaction.candidates[3].end=500000;},
    pack=>{pack.groups[0].questions[0].interaction.textHash='0'.repeat(64);},
    pack=>{pack.groups[0].questions[0].answer=['A','B'];},
    pack=>{pack.groups[0].questions[0].answer='Z';},
    pack=>{pack.groups[0].questions[0].options=[{id:'A',text:'First position'}];},
    pack=>{pack.groups[0].questions[0].interaction.sentence='An unprovided replacement sentence.';},
    pack=>{pack.groups[0].questions[0].interaction.kind='multiple_sentence_selection';},
    pack=>{pack.groups[0].taskKind='listen_response';pack.groups[0].section='listening';},
  ];
  for(const mutate of mutations){const pack=readingPack('sentence_insert'),text=readingSource(pack);mutate(pack);await invalid((await fixture(t,pack)).models,text);}
  const overlap=readingPack('sentence_select'),original=readingSource(overlap);overlap.groups[0].questions[0].interaction.candidates[0].end=overlap.groups[0].questions[0].interaction.candidates[1].end;
  await invalid((await fixture(t,overlap)).models,original);
});

test('feedback separates review transcripts from the student answer and rejects transcript-only quotes',async t=>{
  const output={summary:'A direct answer.',strengths:[],corrections:[{quote:'The town reused water.',issue:'Do not attribute this to the student.',suggestion:'Use the student answer.',category:'error'}],revisedAnswer:'I enjoyed helping.',modelAnswer:'I enjoyed helping because the work was useful.',nextSteps:[],limitations:[]};
  const {models,calls}=await fixture(t,output),snapshot={type:'interview',prompt:'Describe an activity.',groupTranscript:'The town reused water.',transcript:'Describe an activity you enjoyed.'};
  const evaluation=await models.feedback({attempt:{questionSnapshot:snapshot,answer:'',transcript:'I enjoyed helping.',transcriptConfirmed:true},consent:true});
  const input=JSON.parse(calls[0].body.messages.at(-1).content);
  assert.deepEqual(input.reviewTranscripts,{group:'The town reused water.',question:'Describe an activity you enjoyed.'});
  assert.equal(input.question.groupTranscript,undefined);assert.equal(input.question.transcript,undefined);
  assert.equal(input.answerText,'I enjoyed helping.');assert.deepEqual(evaluation.corrections,[]);
  assert.match(calls[0].body.messages[0].content,/不是学生答案/);
  assert.equal(snapshot.groupTranscript,'The town reused water.');
});

test('source transcripts do not authorize sending an unconfirmed student transcription',async t=>{
  const {models,calls}=await fixture(t,{});
  await assert.rejects(()=>models.feedback({attempt:{questionSnapshot:{type:'interview',transcript:'Provided source transcript.'},answer:'',transcript:'Unconfirmed student text.',transcriptConfirmed:false},consent:true}),/确认/);
  assert.equal(calls.length,0);
});

test('the published schema is generated from the same canonical template contract as model output',()=>{
  const published=JSON.parse(fs.readFileSync(path.join(root,'docs','practicebridge.schema.json'),'utf8'));
  delete published.$schema;delete published.title;delete published.description;
  assert.deepEqual(published,NORMALIZED_PACKAGE_SCHEMA);
});
