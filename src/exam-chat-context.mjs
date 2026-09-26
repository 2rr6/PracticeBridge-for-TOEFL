import crypto from 'node:crypto';
import { InputError } from './package.mjs';
import { taskLabels } from '../public/exam-labels.mjs';
import { resolveTiming } from '../public/exam-timing.mjs';

const fail = (message, status = 409) => { throw new InputError(message, status); };
const copy = value => structuredClone(value);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const spoken = task => ['listen_repeat','interview'].includes(task.kind);
const listening = task => task.kind.startsWith('listen_') && !spoken(task);
const hasAnswer = value => value !== null && value !== undefined && (Array.isArray(value) ? value.some(hasAnswer) : typeof value === 'string' ? Boolean(value.trim()) : true);
const cleanBlocks = blocks => (blocks || []).map(block => {
  if ((block.type || block.kind) === 'image') return { kind:'image', description:block.alt || 'Task illustration' };
  if ((block.type || block.kind) === 'table') return { kind:'table', caption:block.caption, headerRow:block.headerRow, rows:block.rows };
  if ((block.type || block.kind) === 'list') return { kind:'list', items:block.items };
  return { kind:block.kind || block.type || 'paragraph', text:block.text };
});
const writtenAnswer = (question, entry = {}) => question.type === 'sentence_order' ? {
  selectedTokens:(Array.isArray(entry.answer) ? entry.answer : []).map(id => question.options?.find(option=>option.id===id)?.text || ''),
} : spoken({kind:question.type}) ? { hasSavedRecording:Boolean(entry.recordingId) } : { text:entry.answer ?? '' };
function referenceAnswer(question) {
  const answer=question.answer;
  if(question.type==='sentence_order')return (Array.isArray(answer)?answer:[]).map(id=>question.options?.find(option=>option.id===id)?.text||id).join(' ');
  if(question.options?.length)return question.options.find(option=>option.id===answer)?.text||answer;
  return answer;
}

/** Resolve a display unit from the server's frozen run, never client-supplied content. */
export function resolveExamPage(state, ref, writerToken) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('缺少当前题目位置。',400);
  if (ref.writerToken !== writerToken) fail('工作区已更新，请重新打开练习后提问。');
  const run=state.sessions.find(session=>session.id===ref.sessionId);
  if(!run || run.sessionVersion!==2)fail('找不到当前机考练习。',404);
  if(run.mode==='exam'&&!run.finished)fail('TEST 完成前不能使用题目 AI 辅助。',403);
  if(run.revision!==ref.expectedRevision)fail('作答或页面已经变化，请在当前页重新发送。');
  for(const key of ['moduleId','taskId','questionId','phase'])if(ref[key]!==run.cursor[key])fail('题目已切换，这条请求没有发送。');
  const library=state.libraries.find(item=>item.libraryId===run.libraryId);
  if(!library||library.contentHash!==run.sourceHash)fail('题库版本与本轮练习不一致。');
  const section=run.planSnapshot.sections.find(section=>section.modules.some(module=>module.id===run.cursor.moduleId));
  const module=section?.modules.find(module=>module.id===run.cursor.moduleId);
  const task=module?.tasks.find(task=>task.id===run.cursor.taskId);
  const group=library.originalPack.groups.find(group=>group.id===task?.groupId);
  const question=group?.questions.find(question=>question.id===run.cursor.questionId);
  if(!task||!group||!question)fail('无法核实当前题目的固定内容。');
  const ids=task.screen==='all_questions'?task.questionIds:[question.id];
  const scope=digest({sessionId:run.id,sourceHash:run.sourceHash,moduleId:module.id,taskId:task.id,ids,phase:run.cursor.phase,phaseIndex:run.cursor.phaseIndex||0,finished:Boolean(run.finished)});
  return {run,library,section,module,task,group,question,ids,scope};
}

export function buildExamPageContext(resolved, shownHelper = null) {
  const {run,section,module,task,group,question,ids}=resolved, phase=run.cursor.phase, p=task.presentation||{};
  const page={ section:section.section, task:taskLabels[task.kind], phase, questionIds:ids,
    media:{ hasImage:Boolean(group.image||question.image), hasAudio:Boolean(group.audio||question.audio), included:'当前页文字；不含图片或音频文件，也不含自动转写。' } };
  if(run.finished)page.completed={ answeredQuestions:Object.values(run.answers).filter(entry=>entry.attemptId).length, text:'本轮练习已完成。用户可打开具体作答回顾。' };
  else if(phase==='instructions'){
    const navigation=module.navigation.back==='module'?'You can use Back, Next, and Review to check your answers within this module. After you finish this module, you cannot return to it.':module.navigation.back==='task'?'Complete each task in order. You can check answers within the current task. After you move to the next task, you cannot return.':'Complete each question in order. After you move to the next question, you cannot return to an earlier answer.';
    page.instructions={text:module.instructions?.text||navigation,navigation,tasks:module.tasks.map(item=>{const time=resolveTiming(item,module,run.preset);return {task:taskLabels[item.kind],questions:item.questionIds.length,durationSeconds:time.durationSeconds,timeScope:time.scope,timingBasis:time.basis};})};
  }
  else if(phase==='directions'){
    const directions=(task.directions||[]).filter(direction=>direction.audio||(['listening','speaking'].includes(section.section)&&direction.text?.trim()));
    page.instructions=directions[run.cursor.phaseIndex||0]?.text||'Listen to the instructions.';
  }else if(phase==='stimulus')page.instructions='Listen carefully.';
  else if(phase==='review')page.review=section.section==='writing'?{instructions:'Time Remaining. You can review or revise your current task.'}:{questions:module.tasks.flatMap(item=>item.questionIds.map(id=>({id,answered:hasAnswer(run.answers[id]?.answer),marked:Boolean(run.marked?.[id])})))};
  else {
    if(task.kind==='complete_words'){
      page.instructions='Fill in the missing letters in the paragraph.';
      page.passage=group.passage;
      page.blanks=task.inlineBlanks?.anchors.map(anchor=>({questionId:anchor.questionId,start:anchor.start,end:anchor.end,prefixStart:anchor.prefixStart,missingLetterCount:anchor.missingLetterCount}));
      if(!page.blanks)page.prompt=question.prompt;
    }else if(['read_daily','read_academic'].includes(task.kind)){
      const doc=p.document||p.readingDocument||{};
      page.reading={title:doc.title,from:doc.from,to:doc.to,date:doc.date,subject:doc.subject};
      if(question.interaction){page.reading.passage=group.passage;page.interaction={kind:question.interaction.kind,sentence:question.interaction.sentence,candidates:question.interaction.candidates.map(item=>({id:item.id,start:item.start,end:item.end}))};}
      else if((doc.blocks||p.blocks)?.length)page.reading.blocks=cleanBlocks(doc.blocks||p.blocks);
      else page.reading.passage=group.passage;
      page.prompt=question.prompt; if(!question.interaction)page.options=question.options;
    }else if(task.kind==='build_sentence'){
      page.instructions='Make an appropriate sentence.';page.prompt=p.asker?.text||p.asker?.content||question.prompt.replace(question.sentenceFrame||'\0','').trim();
      page.sentenceFrame=question.sentenceFrame;page.options=question.options;
    }else if(task.kind==='write_email'){
      const email=p.email||{};
      page.email={to:email.to||question.prompt.match(/(?:^|\n)To:\s*([^\n]+)/)?.[1]||'',subject:email.subject||question.prompt.match(/(?:^|\n)Subject:\s*([^\n]+)/)?.[1]||'',instructions:email.body||email.text||question.prompt.replace(/(?:^|\n)Your Response:[\s\S]*$/i,'').replace(/^[\s\S]*?You will have \d+ minutes? to write the email\.\s*/i,'').replace(/^Write an Email\s*/i,'').trim()};
    }else if(task.kind==='academic_discussion'){
      const discussion=p.discussion||p.academic||{},posts=discussion.posts||discussion.participants||[];
      page.discussion={instructions:discussion.instructions||'',prompt:discussion.prompt||(!posts.length?question.prompt:''),posts:posts.map(post=>({speaker:post.speaker||post.name||post.role,text:post.text||post.content}))};
    }else if(spoken(task))page.instructions=task.kind==='listen_repeat'?'Listen and repeat what you hear.':'Answer the question.';
    else if(listening(task)){
      page.prompt=p.questionPromptVisibility==='review'||task.kind==='listen_response'?'Choose the best response.':question.prompt;
      page.options=question.options;
    }
    page.currentAnswers=ids.map(id=>({questionId:id,...writtenAnswer(group.questions.find(item=>item.id===id),run.answers[id])}));
  }
  if(shownHelper==='answers')page.openReferencePanel=task.questionIds.map(id=>{const q=group.questions.find(item=>item.id===id);return {questionId:id,answer:referenceAnswer(q),explanation:q.explanation||''};});
  if(shownHelper==='transcript')page.openTranscriptPanel=[group.transcript||(listening(task)?group.passage:''),question.transcript||(p.questionPromptVisibility==='review'||spoken(task)?question.type==='listen_repeat'?question.answer:question.prompt:'')].filter(Boolean).join('\n\n');
  if(JSON.stringify(page).length>90000)fail('当前页文字超过对话上限，请选择较短的问题内容。',413);
  return page;
}

export function createExamChat({readState,models,getWriterToken,memory=null}) {
  const exposures=new Map(), rooms=new Map(), pending=new Set(), memoryScopes=new Map();
  const resolve=ref=>resolveExamPage(readState(),ref,getWriterToken());
  function expose(ref,helper) {
    const page=resolve(ref);
    if(![null,'answers','transcript'].includes(helper))fail('无效的辅助面板。',400);
    if(page.run.mode!=='practice'||!page.run.assisted)fail('请先记录本次练习辅助。',403);
    const previous=exposures.get(page.run.id);
    exposures.set(page.run.id,{scope:page.scope,helper,epoch:previous?.scope===page.scope&&previous.helper===helper?previous.epoch:(previous?.epoch||0)+1});
    return {ok:true};
  }
  async function send(body) {
    const expectedBinding=body.expectedBinding;models.assertBinding?.(expectedBinding);
    const resolved=resolve(body.context),exposure=exposures.get(resolved.run.id);
    const visible=exposure?.scope===resolved.scope?exposure:null;
    const page=buildExamPageContext(resolved,visible?.helper||null), epoch=getWriterToken();
    const selected=memory?.preview(), include=body.memory?.include===true;
    const memorySnapshot=selected?{profileId:selected.profileId,memoryRevision:selected.memoryRevision,expectedEpoch:selected.expectedEpoch,include}:null;
    if(include&&(!selected||body.memory.profileId!==selected.profileId||body.memory.memoryRevision!==selected.memoryRevision||body.memory.expectedEpoch!==selected.expectedEpoch))fail('偏好预览已变化，请刷新后发送。');
    const memoryKey=digest(memorySnapshot),previousMemory=memoryScopes.get(resolved.run.id);
    const memoryGeneration=previousMemory?.key===memoryKey?previousMemory.generation:(previousMemory?.generation||0)+1;
    memoryScopes.set(resolved.run.id,{key:memoryKey,generation:memoryGeneration});
    const preferences=include?await memory.readAllowedPreferences({...memorySnapshot,mode:resolved.run.mode,phase:resolved.run.finished?'finished':resolved.run.cursor.phase}):[];
    if(epoch!==getWriterToken())fail('工作区已变化，请重新发送。');
    const authorized=memory?.preview();
    if(memorySnapshot&&(authorized.profileId!==memorySnapshot.profileId||authorized.memoryRevision!==memorySnapshot.memoryRevision||authorized.expectedEpoch!==memorySnapshot.expectedEpoch))fail('偏好授权已变化，请刷新后发送。');
    // A delayed recall cannot use a now-revoked page/helper exposure either.
    const current=resolve(body.context),currentExposure=exposures.get(current.run.id);
    if(current.scope!==resolved.scope||JSON.stringify(currentExposure)!==JSON.stringify(exposure))fail('当前页面或辅助面板已变化，请重新发送。');
    const scopeKey=digest({page:resolved.scope,helper:visible?.helper||null,epoch:visible?.epoch||0,memory:memorySnapshot,memoryGeneration});
    let room=body.conversationId&&rooms.get(body.conversationId);
    if(room&&(room.scopeKey!==scopeKey||room.epoch!==epoch))room=null;
    if(!room){room={id:crypto.randomUUID(),scopeKey,epoch,messages:[],receipts:new Map()};rooms.set(room.id,room);}
    if(rooms.size>80){const old=[...rooms.values()].find(item=>item!==room&&!pending.has(item.id));if(old)rooms.delete(old.id);}
    const requestId=body.requestId;
    if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId))fail('对话请求标识无效。',400);
    if(room.receipts.has(requestId))return copy(room.receipts.get(requestId));
    if(pending.has(room.id))fail('这段对话正在等待回复。');
    pending.add(room.id);
    const snapshotId=crypto.randomUUID(), history=copy(room.messages.slice(-12));
    try {
      const result=await models.chat({message:body.message,history,consent:true,expectedBinding,context:{page:copy(page),snapshotId,preferences:copy(preferences)}});
      if(epoch!==getWriterToken())fail('工作区已重新打开，本次旧对话不再写入当前页面。');
      room.messages.push({role:'user',content:body.message},{role:'assistant',content:result.reply});room.messages=room.messages.slice(-24);
      const receipt={...result,conversationId:room.id,contextSnapshotId:snapshotId,scopeKey,memorySnapshot};
      room.receipts.set(requestId,receipt);if(room.receipts.size>20)room.receipts.delete(room.receipts.keys().next().value);
      return copy(receipt);
    }finally{pending.delete(room.id);}
  }
  return {expose,send};
}
