import {createHash} from 'node:crypto';

export const NATIVE_MATRIX_TASKS=Object.freeze([
  ['complete_words','fill_blank','reading'],
  ['read_daily','single_choice','reading'],
  ['read_academic','single_choice','reading'],
  ['listen_response','single_choice','listening'],
  ['listen_conversation','single_choice','listening'],
  ['listen_announcement','single_choice','listening'],
  ['listen_talk','single_choice','listening'],
  ['build_sentence','sentence_order','writing'],
  ['write_email','email','writing'],
  ['academic_discussion','discussion','writing'],
  ['listen_repeat','listen_repeat','speaking'],
  ['interview','interview','speaking'],
].map(([taskKind,answerType,section])=>Object.freeze({taskKind,answerType,section})));

const source='Independently authored native-matrix fixture. Audio is a generated tone for player controls, not speech or a pronunciation reference.';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const timing=(scope,seconds=120)=>({scope,durationSeconds:seconds,prepareSeconds:0,basis:'user',source});
const groupId=kind=>`matrix-${kind}`;
const questionId=kind=>`matrix-q-${kind}`;

/** A deterministic local signal. It proves WAV decoding/player events only. */
function controlTone(){
  const sampleRate=16000,frames=12800,bytes=Buffer.alloc(44+frames*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(sampleRate,24);bytes.writeUInt32LE(sampleRate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);
  for(let i=0;i<frames;i++){const fade=Math.min(1,i/400,(frames-i)/400);bytes.writeInt16LE(Math.round(Math.sin(i/sampleRate*2*Math.PI*440)*1600*fade),44+i*2);}
  return bytes;
}

export function createNativeMatrixFixture(){
  const groups=[],rows=[],toneName='matrix-control-tone.wav',tone=controlTone();
  const question=(kind,type,prompt,answer,options=[])=>({id:questionId(kind),type,prompt,options,answer,explanation:`Private answer-review note for ${kind}; unavailable during TEST.`,audio:null,image:null,timeLimitSeconds:120,prepareSeconds:0,source,localNumber:kind==='listen_repeat'?6:1,ordinalInTask:1,sourcePositionV1:{sourceTaskId:`original-task-${kind}`,originalOrdinalInTask:kind==='listen_repeat'?6:1}});
  const choice=(kind,prompt,a,b,answer='A')=>question(kind,'single_choice',prompt,answer,[{id:'A',text:a},{id:'B',text:b}]);
  const add=(kind,title,q,{passage='',...extra}={})=>{
    q={...q,localNumber:kind==='listen_repeat'?6:rows.length+1};
    const spec=NATIVE_MATRIX_TASKS.find(row=>row.taskKind===kind),group={id:groupId(kind),section:spec.section,taskKind:kind,title,passage,audio:null,image:null,timing:timing(spec.section==='reading'?'inherit_module':spec.section==='writing'?'task':'question'),presentation:{screen:kind==='complete_words'?'all_questions':'one_question',passageVisibility:spec.section==='listening'||spec.section==='speaking'?'review':'attempt',questionPromptVisibility:spec.section==='speaking'?'review':'attempt'},questions:[q],...extra};
    if(spec.section==='reading')group.timing={scope:'inherit_module',durationSeconds:null,prepareSeconds:null,basis:'unknown',source:''};
    groups.push(group);rows.push({...spec,groupId:group.id,questionId:q.id,sourcePosition:structuredClone(q.sourcePositionV1),expectedAnswer:q.answer,reviewOnlyText:q.explanation});return group;
  };

  const words='🌿 Garden notes: stud____ record the soil temperature each morning.',prefixStart=words.indexOf('stud____'),start=prefixStart+4;
  add('complete_words','Garden observation notebook',question('complete_words','fill_blank','Type the four missing letters to complete the word in the paragraph.','ents'),{passage:words,inlineBlanks:{textField:'passage',offsetUnit:'utf16',answerMode:'missing_letters',textHash:sha(words),anchors:[{questionId:questionId('complete_words'),localNumber:1,prefixStart,prefixEnd:start,start,end:start+4,missingLetterCount:4,prefix:'stud',rawGap:'____',source}]}});
  const notice='The neighborhood library opens at nine on Saturday. Visitors may borrow a garden map from the front desk.';
  add('read_daily','Saturday library notice',choice('read_daily','What may visitors borrow from the front desk?','A garden map.','A bicycle.',null),{passage:notice,presentation:{screen:'one_question',passageVisibility:'attempt',questionPromptVisibility:'attempt',document:{kind:'notice',title:'Saturday opening',blocks:[{kind:'paragraph',text:notice}]}}});
  const academic='A shaded plot loses water more slowly than a sunny plot. In a small garden study, both plots received the same amount of water each morning. By evening, the shaded soil remained wetter. The observations suggest that reduced exposure to sunlight can slow evaporation.';
  add('read_academic','Shade and soil moisture',choice('read_academic','Why did the shaded soil remain wetter in the study?','It was exposed to less sunlight.','It received more water each morning.'),{passage:academic,presentation:{screen:'one_question',passageVisibility:'attempt',questionPromptVisibility:'attempt',document:{kind:'academic',title:'A garden study',blocks:[{kind:'paragraph',text:academic}]}}});
  const listening=[
    ['listen_response','A request at the front desk','Choose the most appropriate reply.','Of course. I can bring it this afternoon.','The wall was painted last year.','Could you bring the blue folder to the front desk this afternoon?'],
    ['listen_conversation','Planning a student display','What will the students do first?','Measure the display table.','Print all the photographs.','Ari: We should measure the table before choosing photographs. Lin: Good idea. Then we can decide how many photographs will fit.'],
    ['listen_announcement','A room change announcement','Where will the workshop take place?','In Room 204.','In the main hall.','The workshop has moved from the main hall to Room 204. It will begin at the originally scheduled time.'],
    ['listen_talk','A short talk about city trees','What benefit of trees does the speaker emphasize?','They provide shade for pedestrians.','They remove the need for sidewalks.','Trees can make a walking route more comfortable by providing shade. A row of trees does not replace a sidewalk, but it can reduce direct exposure to sunlight.'],
  ];
  for(const [kind,title,prompt,a,b,transcript] of listening)add(kind,title,choice(kind,prompt,a,b),{audio:toneName,transcript});
  add('build_sentence','A plan for the study group',{...question('build_sentence','sentence_order','What can the group do today?\nWe _____ _____ and _____ today.',['A','B','C'],[{id:'A',text:'can'},{id:'B',text:'read'},{id:'C',text:'write'},{id:'D',text:'reads'}]),sentenceFrame:'We _____ _____ and _____ today.',answerSlots:3});
  const emailPrompt='Write an email to Mira, the student-club coordinator. Ask to borrow a garden map for Thursday, explain where the club plans to walk, and say when you will return the map.';
  add('write_email','Borrowing a club map',question('write_email','email',emailPrompt,null),{presentation:{screen:'one_question',passageVisibility:'attempt',questionPromptVisibility:'attempt',email:{to:'Mira',subject:'Map for the club walk',instructions:emailPrompt,body:emailPrompt}}});
  const discussionPrompt='Should a university add more quiet study rooms or more shared discussion areas? Explain which improvement you would prioritize and why.';
  add('academic_discussion','Choosing a study space',question('academic_discussion','discussion',discussionPrompt,null),{presentation:{screen:'one_question',passageVisibility:'attempt',questionPromptVisibility:'attempt',discussion:{prompt:discussionPrompt,instructions:'Your professor is teaching a course about campus planning. Write a response that states and supports your view, and contributes to the discussion.',posts:[{speaker:'Ari',text:'I would add quiet rooms because students need places for sustained concentration.'},{speaker:'Lin',text:'I prefer discussion areas because group projects need space for conversation.'}]}}});
  const repeat='The bronze lantern remains beside the blue window.';
  add('listen_repeat','Repeating a short sentence',{...question('listen_repeat','listen_repeat','Listen and repeat the sentence.',repeat),audio:toneName,transcript:repeat});
  const interview='Describe a place where you enjoy studying. Explain what makes that place useful for you.';
  add('interview','Describing a study place',{...question('interview','interview',interview,null),audio:toneName,transcript:interview});

  const pending={id:'matrix-pending-media',section:'listening',taskKind:'listen_conversation',title:'Pending original audio',passage:'',audio:null,image:null,questions:[{...choice('pending-media','Which room will the speakers use? The required original audio was not supplied.','The south room.','The north room.'),id:'matrix-q-pending-media',localNumber:13,sourcePositionV1:{sourceTaskId:'original-task-pending-media',originalOrdinalInTask:1}}]};
  groups.push(pending);
  const sections=['reading','listening','writing','speaking'].map(section=>({id:`matrix-section-${section}`,section,title:section[0].toUpperCase()+section.slice(1),modules:[{id:`matrix-module-${section}`,title:`Authored ${section} module`,sourceNumber:1,taskIds:groups.filter(group=>group.section===section).map(group=>group.id),timing:section==='reading'?timing('module',600):{scope:'none',durationSeconds:null,prepareSeconds:null,basis:'unknown',source:''},navigation:{back:section==='reading'?'module':section==='writing'?'task':'none',review:section==='reading'?'module':section==='writing'?'task':'none',lockOnAdvance:true}}]}));
  const pack={schemaVersion:2,examContractVersion:1,minReaderVersion:'0.5.0',id:'self-authored-native-matrix',version:'1',title:'Self-authored twelve-task control matrix',description:'A local regression fixture for source preservation and browser controls. It is not an official TOEFL paper. Tone assets do not encode the supplied reference speech.',rights:'All text and tone data independently authored for this test.',groups,examSets:[{id:'native-matrix-set',title:'Authored material scope',sections}]};
  const files=new Map([['practicebridge.json',Buffer.from(JSON.stringify(pack,null,2))],[toneName,tone]]);
  const responses={complete_words:'ents',read_daily:'A',read_academic:'A',listen_response:'A',listen_conversation:'A',listen_announcement:'A',listen_talk:'A',build_sentence:['A','B','C'],write_email:'Hi Mira,\nCould our club borrow your garden map for Thursday? We plan to walk beside the pond and compare two shaded paths. I will return the map on Friday morning.\nThanks,\nAlex',academic_discussion:'I would prioritize quiet study rooms because students often need sustained concentration. For example, a small room lets a student revise a long report without nearby conversation. Discussion areas remain useful, so the university could keep one shared area while adding several quiet rooms.'};
  return {pack,files,rows,responses,pendingQuestionId:pending.questions[0].id,noKeyQuestionId:questionId('read_daily'),media:{name:toneName,sha256:sha(tone),durationSeconds:0.8,kind:'generated-tone-controls-only'},limits:{realSpeech:false,realAsr:false,realMicrophone:false,realWindowsIme:false}};
}
