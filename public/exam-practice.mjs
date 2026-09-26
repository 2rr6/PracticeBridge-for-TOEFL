import { $, $$, esc, icon, duration, notify, fileData, saveBlob, saveText } from './ui.mjs';
import { renderTask, renderSentence, mediaMarkup, taskLabels, sectionLabels, isSpokenTask, isListeningTask, sentenceSlots, answerStatus, plainParagraphs } from './exam-views.mjs';
import { formatPracticeAnswer } from './practice.mjs';
import { reduceBlankEdit } from './exam-letters.mjs';
import { resolveTiming, TIME_POLICY_VERSION } from './exam-timing.mjs';
import { createExamCoach } from './exam-coach.mjs';
import { createRecordingGate, capRecordingBlob } from './exam-audio.mjs';

const clone = value => structuredClone(value);
const answerFields = value => ({ answer: value.answer, recordingId: value.recordingId || null, transcript: value.transcript || '', transcriptConfirmed: Boolean(value.transcriptConfirmed) });
const fingerprint = value => JSON.stringify(value);
const titleCase = value => value[0].toUpperCase() + value.slice(1);
const examTime = seconds => { const n=Math.max(0,Math.ceil(seconds||0));return [Math.floor(n/3600),Math.floor(n%3600/60),n%60].map(value=>String(value).padStart(2,'0')).join(':'); };

function dialog({ title, text, confirm = 'Continue', cancel = 'Back', content = '' }) {
  return new Promise(resolve => {
    const host = document.createElement('div'); host.className = 'exam-modal-backdrop';
    host.innerHTML = `<div class="exam-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2><p>${esc(text)}</p>${content}<div class="exam-modal-actions"><button class="exam-action" data-result="cancel">${esc(cancel)}</button><button class="exam-action primary" data-result="confirm">${esc(confirm)}</button></div></div>`;
    document.body.append(host); const oldFocus = document.activeElement;
    const finish = value => { host.remove(); oldFocus?.focus?.(); resolve(value); };
    host.querySelector('[data-result=cancel]').onclick = () => finish(false);
    host.querySelector('[data-result=confirm]').onclick = () => finish(true);
    host.onkeydown = event => {
      if (event.key === 'Escape') finish(false);
      if (event.key === 'Tab') { const buttons = [...host.querySelectorAll('input,button,select,textarea')]; const first = buttons[0], last = buttons.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    };
    host.querySelector('[data-result=cancel]').focus();
  });
}

export async function createExamPractice(container, { library, session, setId, sectionId, groupId, mode = 'practice', preset = 'document', api, refresh, openReport, settings, hash }) {
  let run = session?.sessionVersion === 2 ? clone(session) : (await api('/sessions', {
    sessionVersion: 2, libraryId: library.libraryId, mode, preset,
    ...(setId ? { setId } : {}), ...(sectionId ? { sectionId } : {}), ...(groupId ? { groupId } : {}),
    ...(session?.id ? { legacySessionId: session.id } : {}),
  })).session;
  if (!run?.planSnapshot) throw new Error('没有可运行的机考练习计划。');
  mode = run.mode;
  let localAnswers = clone(run.answers || {}), dirty = new Map(), editSequence = 0, writeChain = Promise.resolve(), saveTimeout, lastEditAt = null;
  let disposed = false, workspaceInterrupted=false, recoveryAcknowledged=false, transitioning = false, committing = false, finished = Boolean(run.finished), saveError = '', helper = null, showTime = true;
  let renderVersion = 0, currentHost, mediaComplete = false, currentSources = [], recorder = null, stream = null, microphoneReady = false, recordingState = null, micContext = null, micFrame = null;
  let serverAt = Date.parse(run.serverNow || new Date().toISOString()), localAt = performance.now(), expiryHandling = false, interval;
  const scrollPositions = new Map();
  const expiredResponses = new Set();
  let coach, helperEpoch = 0;
  const controller = { hash: hash || location.hash, close,interruptWorkspace,acknowledgeWorkspaceRecovery:()=>{recoveryAcknowledged=true;} };
  controller.hash = `#exam/${library.libraryId}/${run.planSnapshot.id}/all/${run.mode}/${run.id}`;
  if(location.hash!==controller.hash)history.replaceState(null,'',controller.hash);
  const modules = run.planSnapshot.sections.flatMap(section => section.modules.map(module => ({ ...module, sectionId: section.id, section: section.section })));
  const groups = new Map(library.groups.map(group => [group.id, group]));
  const questions = new Map(library.groups.flatMap(group => group.questions.map(question => [question.id, { question, group }])));
  const getModule = () => modules.find(module => module.id === run.cursor.moduleId);
  const getTask = () => getModule().tasks.find(task => task.id === run.cursor.taskId);
  const getQuestion = () => questions.get(run.cursor.questionId || getTask().questionIds[0]).question;
  const getGroup = () => groups.get(getTask().groupId);
  const getEntry = (qid = getQuestion().id) => localAnswers[qid] ||= { answer: questions.get(qid).question.type === 'sentence_order' ? [] : '', recordingId: null, transcript: '', transcriptConfirmed: false };
  const contextRef = () => ({sessionId:run.id,writerToken:run.writerToken,expectedRevision:run.revision,...Object.fromEntries(['moduleId','taskId','questionId','phase'].map(key=>[key,run.cursor[key]]))});
  const coachContext = () => ({key:JSON.stringify([run.cursor.moduleId,run.cursor.taskId,getTask().screen==='all_questions'?getTask().questionIds:[run.cursor.questionId],run.cursor.phase,run.cursor.phaseIndex||0,helper,helperEpoch,finished]),allowed:(mode==='practice'||finished)&&!run.timingInterruption,label:`${sectionLabels[getModule().section]} · ${taskLabels[getTask().kind]}${rangeLabel()?` · ${rangeLabel()}`:''}`});
  async function captureCoachContext(expectedKey) {
    await persist({assisted:true});
    if(disposed||coachContext().key!==expectedKey)throw new Error('页面已切换，问题保留在原页对话中；本次没有发送。');
    const ref=clone(contextRef());
    if(mode==='practice')await api('/chat/exposure',{context:ref,helper});
    if(disposed||coachContext().key!==expectedKey)throw new Error('页面已切换，请在当前页重新发送。');
    return ref;
  }
  const now = () => serverAt + performance.now() - localAt;
  const mediaUrl = value => !value ? null : library.mediaUrls?.[value] || value;
  const pages = module => module.tasks.flatMap(task => task.screen === 'all_questions' ? [{ task, questionId: task.questionIds[0], questionIds: task.questionIds }] : task.questionIds.map(questionId => ({ task, questionId, questionIds: [questionId] })));
  const currentPageIndex = () => pages(getModule()).findIndex(page => page.task.id === getTask().id && page.questionIds.includes(getQuestion().id));
  const activeTimer = () => run.timers?.[run.activeTimerId];
  function clockValue(timer = activeTimer()) {
    if (!timer) return null;
    const extra = timer.runningSince ? Math.max(0, now() - Date.parse(timer.runningSince)) : 0;
    const elapsed = Math.max(0, (timer.consumedMs || 0) + extra);
    return { elapsed, remaining: timer.durationSeconds === null ? null : Math.max(0, timer.durationSeconds * 1000 - elapsed), timer };
  }
  function synchronize(next) {
    run = clone(next); serverAt = Date.parse(next.serverNow || new Date().toISOString()); localAt = performance.now();
    for (const [qid, value] of Object.entries(next.answers || {})) if (!dirty.has(qid)) localAnswers[qid] = clone(value);
    finished = Boolean(next.finished);
  }
  function setSaveStatus(text = '', error = false) { const element = $('#exam-save-state', container); if (element) { element.textContent = text; element.style.color = error ? '#a0442d' : ''; } }
  function changed(qid) {
    if (getEntry(qid).attemptId || disposed) return;
    dirty.set(qid, ++editSequence); lastEditAt = new Date(now()).toISOString(); saveError = ''; setSaveStatus('Saving…'); clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => persist().catch(() => {}), 180);
  }
  function persist(extra = {}) {
    clearTimeout(saveTimeout);
    const operation = async () => {
      if (disposed || finished) return;
      const captured = new Map(dirty), patchAnswers = Object.fromEntries([...captured.keys()].map(qid => [qid, answerFields(getEntry(qid))]));
      if (!captured.size && !Object.keys(extra).length) return;
      const beforeRevision = run.revision;
      const body = { expectedRevision: beforeRevision, writerToken: run.writerToken, ...(captured.size ? { answers: patchAnswers, capturedAt: lastEditAt } : {}), ...extra };
      try {
        let response;
        try { response = await api(`/sessions/${run.id}`, body, 'PATCH'); }
        catch (error) {
          // A lost response can follow a successful save. Read the receipt without resending stale edits.
          const state = await api('/state').catch(() => null), saved = state?.sessions.find(item => item.id === run.id);
          const sameEdits = saved && saved.writerToken === run.writerToken && saved.revision === beforeRevision + 1 && Object.entries(patchAnswers).every(([qid, value]) => fingerprint(answerFields(saved.answers[qid] || {})) === fingerprint(value));
          const sameCursor = !extra.cursor || Object.entries(extra.cursor).every(([key, value]) => saved?.cursor[key] === value);
          if (!sameEdits || !sameCursor || (extra.timer && saved.paused !== (extra.timer.action === 'pause'))) throw error;
          response = { session: saved };
        }
        for (const [qid, sequence] of captured) if (dirty.get(qid) === sequence) dirty.delete(qid);
        synchronize(response.session); saveError = ''; setSaveStatus(dirty.size ? 'Saving…' : 'Saved');
      } catch (error) { saveError = error.message; setSaveStatus('未保存 · 请重试', true); notify(error.message, true); throw error; }
    };
    const result = writeChain.then(operation); writeChain = result.catch(() => {}); return result;
  }
  function practiceMayContinue() { return mode==='practice'&&!isSpokenTask(getTask()); }
  function inputAllowed() { return !disposed && !finished && !committing && !run.paused && !run.timingInterruption && (practiceMayContinue()||clockValue()?.remaining !== 0); }
  function saveScroll() {
    const pane = $('.exam-reading-pane', container);
    if (pane) scrollPositions.set(getTask().id, pane.scrollTop);
  }
  function directionsFor(task) { return (task.directions || []).filter(direction => direction.audio || (['listening','speaking'].includes(groups.get(task.groupId)?.section) && direction.text?.trim())); }
  function missingStimuli(module=getModule()) { return module.tasks.filter(task=>isListeningTask(task)||isSpokenTask(task)).flatMap(task=>task.questionIds.filter(qid=>!questions.get(qid).question.audio&&!groups.get(task.groupId).audio)); }
  function resolvedTiming(task,module=getModule()) {
    return resolveTiming(task,module,run.preset,{questionId:task.questionIds.includes(run.cursor.questionId)?run.cursor.questionId:undefined});
  }
  function timingSummary(task,module) {
    if(task.kind!=='listen_repeat')return duration(resolvedTiming(task,module).durationSeconds);
    const ranges=[];
    task.questionIds.forEach((questionId,index)=>{const seconds=resolveTiming(task,module,run.preset,{questionId}).durationSeconds,last=ranges.at(-1);if(last?.seconds===seconds)last.end=index+1;else ranges.push({start:index+1,end:index+1,seconds});});
    return ranges.length===1?duration(ranges[0].seconds):ranges.map(range=>`${range.start}${range.end===range.start?'':'–'+range.end}题 ${duration(range.seconds)}`).join(' / ');
  }
  function sourcesFor(task, question) {
    const group = groups.get(task.groupId), result = [];
    const isFirst = question.id === task.questionIds[0];
    if (isFirst && group.audio) result.push(group.audio);
    if (question.audio && question.audio !== group.audio) result.push(question.audio);
    return result.map(mediaUrl);
  }
  async function startCurrentTask({ skipDirections = false } = {}) {
    const task = getTask(), question = getQuestion();
    if((isListeningTask(task)||isSpokenTask(task))&&!question.audio&&!getGroup().audio){notify('本题缺少题目音频。请先返回材料补齐音频，再开始机考练习。',true);return;}
    const directions = directionsFor(task);
    const phase = !skipDirections && directions.length ? 'directions' : sourcesFor(task, question).length && (isListeningTask(task) || isSpokenTask(task)) ? 'stimulus' : 'response';
    if (isSpokenTask(task) && !microphoneReady) { notify('请先完成麦克风检查。', true); return; }
    await move({ phase, phaseIndex: 0 });
    if (phase === 'response' && isSpokenTask(task) && !getEntry().recordingId) await startRecording();
    else if (['directions', 'stimulus'].includes(phase)) await tryPlay();
  }
  function rangeLabel() {
    if(run.cursor.phase==='review'&&getModule().section==='writing')return '';
    if (['instructions', 'directions', 'stimulus'].includes(run.cursor.phase)) return run.cursor.phase === 'instructions' ? '' : taskLabels[getTask().kind];
    const module = getModule(), task = getTask();
    const count = module.tasks.reduce((total, item) => total + item.questionIds.length, 0);
    const start = task.numberStart || module.tasks.slice(0, module.tasks.indexOf(task)).reduce((total, item) => total + item.questionIds.length, 1);
    const index = task.questionIds.indexOf(getQuestion().id);
    if (task.screen === 'all_questions') return task.questionIds.length === 1 ? `Question ${start} of ${count}` : `Questions ${start}–${task.numberEnd || start + task.questionIds.length - 1} of ${count}`;
    if (module.section === 'writing') {
      if(task.kind==='build_sentence')return `Question ${index + 1} of ${task.questionIds.length}`;
      const written=module.tasks.filter(item=>item.kind!=='build_sentence');
      const writtenStart=written.slice(0,written.indexOf(task)).reduce((total,item)=>total+item.questionIds.length,1);
      return `Question ${writtenStart+index} of ${written.reduce((total,item)=>total+item.questionIds.length,0)}`;
    }
    return `Question ${start + index} of ${count}`;
  }
  function render() {
    if(workspaceInterrupted)return;
    ++renderVersion; if(helper)++helperEpoch;helper = null;
    if (finished) { renderCompleted(); return; }
    const task = getTask(), module = getModule(), question = getQuestion(), phase = run.cursor.phase;
    const hasBack = (phase === 'review'&&module.section==='writing') || (phase === 'response' && currentPageIndex() > 0 && (module.navigation.back === 'module' || (module.navigation.back === 'task' && pages(module)[currentPageIndex() - 1].task.id === task.id)));
    const hasReview = mode==='practice' && phase === 'response' && module.section === 'reading' && module.navigation.review !== 'none';
    const navLabel = phase === 'instructions' ? 'Begin' : ['directions', 'stimulus', 'prepare'].includes(phase) ? 'Continue' : phase === 'review' ? 'Continue' : 'Next';
    container.innerHTML = `<div class="exam-shell" data-session-id="${esc(run.id)}" data-task-kind="${task.kind}" data-question-id="${esc(question.id)}" data-phase="${phase}"><header class="exam-top"><div class="exam-tools"><button class="exam-tool" id="exam-exit">退出</button>${mode === 'practice' ? `<button class="exam-tool" id="exam-reset">重置记录</button><button class="exam-tool green gap" id="exam-ai">AI 对话</button>${isListeningTask(task) || isSpokenTask(task) ? '<button class="exam-tool green" id="exam-transcript">显示文本</button>' : ''}<button class="exam-tool green" id="exam-answers">${['write_email','academic_discussion','interview'].includes(task.kind) ? '显示范文' : '显示答案'}</button>` : ''}</div><nav class="exam-navigation" aria-label="Test navigation">${hasReview ? '<button id="exam-review">Review</button>' : ''}${isListeningTask(task) || isSpokenTask(task) ? '<button id="exam-volume" aria-label="Volume">Volume ♫</button>' : ''}${hasBack ? `<button id="exam-back">${icon('back')} Back</button>` : ''}<button id="exam-next">${navLabel} ${icon('chevron')}</button></nav></header><div class="exam-statusbar"><div class="exam-section-status"><span>${sectionLabels[module.section]}</span>${rangeLabel() ? `<span class="exam-range">${esc(rangeLabel())}</span>` : ''}</div><div class="exam-clock" id="exam-clock"><span id="exam-time"></span><button id="exam-hide-time">${showTime ? 'Hide Time' : 'Show Time'}</button>${mode === 'practice' ? '<button id="exam-pause" aria-label="Pause practice">Ⅱ</button>' : ''}</div></div>${run.legacySessionId && phase === 'instructions' ? '<p class="exam-inline-notice">已恢复之前的草稿。本轮按科目规则计时；原有作答记录继续保留。</p>' : ''}<div class="exam-content" id="exam-content"><div class="exam-task-host" id="exam-task-host"></div></div><span class="exam-save-dot" id="exam-save-state" role="status">Saved</span></div>`;
    currentHost = $('#exam-task-host', container);
    if (phase === 'instructions') renderInstructions();
    else if (phase === 'review') renderReview();
    else {
      const direction = directionsFor(task)[run.cursor.phaseIndex || 0];
      currentSources = sourcesFor(task, question);
      const source = phase === 'directions' ? mediaUrl(direction?.audio) : phase==='response'&&isListeningTask(task) ? mediaUrl(getGroup().audio||question.audio) : currentSources[run.cursor.phaseIndex || 0];
      const sourceName = Object.entries(library.mediaUrls || {}).find(([,url])=>url === source)?.[0] || source;
      currentHost.innerHTML = renderTask({ task, group: getGroup(), question, answers: localAnswers, phase, mode, source, sourceName, direction, recording: recordingView() });
      bindAnswers(); bindMedia(); bindRecording();
      const pane = $('.exam-reading-pane', container); if (pane) pane.scrollTop = scrollPositions.get(task.id) || 0;
    }
    $('#exam-exit').onclick = exitPractice;
    $('#exam-next').onclick = () => transition(next);
    $('#exam-back')?.addEventListener('click', () => transition(() => phase==='review'?move({phase:'response'}):navigatePage(-1)));
    $('#exam-review')?.addEventListener('click', () => transition(() => move({ phase: 'review' })));
    $('#exam-hide-time').onclick = () => { showTime = !showTime; $('#exam-hide-time').textContent = showTime ? 'Hide Time' : 'Show Time'; updateClock(); };
    $('#exam-pause')?.addEventListener('click', () => transition(pause));
    $('#exam-volume')?.addEventListener('click', volumeDialog);
    $('#exam-reset')?.addEventListener('click', () => transition(resetRun));
    $('#exam-answers')?.addEventListener('click', () => showHelper('answers'));
    $('#exam-transcript')?.addEventListener('click', () => showHelper('transcript'));
    $('#exam-ai')?.addEventListener('click', () => coach.toggle());
    coach?.update();updateClock(); if (run.paused) renderPaused();
  }
  function renderInstructions() {
    const module = getModule(), speaking = module.section === 'speaking';
    const policy = module.navigation.back === 'module' ? 'You can use the available navigation controls to check your answers within this module. After you finish this module, you cannot return to it.' : module.navigation.back === 'task' ? 'Complete each task in order. You can check answers within the current task. After you move to the next task, you cannot return.' : 'Complete each question in order. After you move to the next question, you cannot return to an earlier answer.';
    const defaults = module.tasks.some(task => resolvedTiming(task,module).basis==='preset');
    const missing=missingStimuli(module);
    currentHost.innerHTML = `<section class="exam-intro"><h1>${sectionLabels[module.section]}${module.sourceNumber ? ` · Module ${module.sourceNumber}` : ''}</h1>${plainParagraphs(module.instructions?.text || policy)}${module.instructions?.text ? `<p>${policy}</p>` : ''}<table><thead><tr><th>Task</th><th>Questions</th><th>Time</th></tr></thead><tbody>${module.tasks.map(task => {const timing=resolvedTiming(task,module);return `<tr><td>${taskLabels[task.kind]}</td><td>${task.questionIds.length}</td><td>${timingSummary(task,module)}${timing.policyReason==="user_standard"?" · 设定标准":timing.basis==='preset'?' · 练习默认':timing.basis==='user'?' · 自定义':''}${timing.scope === 'module' ? ' · module' : timing.scope === 'task' ? ' · task' : ''}</td></tr>`;}).join('')}</tbody></table>${defaults ? '<p class="exam-inline-notice">材料未写明时限的题目使用软件练习默认值，并以倒计时显示；这不代表原材料给出了这些时限。</p>' : ''}${missing.length?`<p class="exam-media-missing" role="alert">还有 ${missing.length} 道听说题缺少题目音频。补齐后可以开始机考练习。</p><a class="exam-action" href="#collection/${library.libraryId}">返回题库</a>`:speaking ? `<div class="exam-mic-check"><button class="exam-action" id="check-microphone">Check Microphone</button><span id="microphone-status" role="status">${microphoneReady ? 'Microphone is ready.' : 'Check your microphone before you begin.'}</span><meter id="microphone-level" min="0" max="1" value="0" aria-label="Microphone level"></meter></div>` : ''}${missing.length?'':'<p>Click <b>Begin</b> when you are ready.</p>'}</section>`;
    $('#check-microphone')?.addEventListener('click', checkMicrophone);
    if(module.instructions?.audio){
      $('.exam-intro',currentHost).insertAdjacentHTML('beforeend',mediaMarkup(mediaUrl(module.instructions.audio),{mode,sourceName:module.instructions.audio}));
      bindMedia();
    }
  }
  function renderReview() {
    const module = getModule(), taskOnly = module.navigation.review === 'task', tasks = taskOnly ? [getTask()] : module.tasks;
    if(module.section==='writing'){
      currentHost.innerHTML='<section class="exam-intro exam-time-remaining"><h1>Time Remaining</h1><p>You can continue working on your response while time remains.</p><p>Select <b>Back</b> to review or revise your answers.</p><p>Select <b>Continue</b> to finish this task.</p><p>Once you leave this task, you cannot return to it.</p></section>';return;
    }
    currentHost.innerHTML = `<section class="exam-review"><h1>Review</h1><p>Check your answers. Select a question to return to it.</p><table class="exam-review-table"><thead><tr><th>Question</th><th>Status</th><th>Marked for Review</th></tr></thead><tbody>${tasks.flatMap(task => task.questionIds.map((qid, index) => {
      const status = answerStatus(questions.get(qid).question, getEntry(qid), task), number = (task.numberStart || 1) + index;
      return `<tr><td><button class="exam-review-link" data-review-qid="${esc(qid)}">Question ${number}</button></td><td><span class="exam-review-status ${status}">${({ answered:'Answered',unanswered:'Not Answered',partial:'Partially Answered',saved:'Submitted' })[status]}</span></td><td><input type="checkbox" data-mark="${esc(qid)}" aria-label="Mark question ${number} for review" ${run.marked?.[qid] ? 'checked' : ''}></td></tr>`;
    })).join('')}</tbody></table><div class="exam-review-actions"><button class="exam-action" id="return-from-review">Return to Question</button><button class="exam-action primary" id="end-review-scope">${taskOnly ? 'Finish Task' : 'Finish Module'}</button></div></section>`;
    $$('[data-review-qid]', currentHost).forEach(button => button.onclick = () => transition(async () => {
      const qid = button.dataset.reviewQid, target = module.tasks.find(task => task.questionIds.includes(qid));
      await move({ taskId: target.id, questionId: qid, phase: 'response' });
      const input = $$('[data-qid]', container).find(element => element.dataset.qid === qid); input?.focus(); input?.scrollIntoView({ block: 'center' });
    }));
    $$('[data-mark]', currentHost).forEach(input => input.onchange = () => persist({ marked: { [input.dataset.mark]: input.checked } }).catch(() => {}));
    $('#return-from-review').onclick = () => transition(() => move({ phase: 'response' }));
    $('#end-review-scope').onclick = () => transition(() => taskOnly ? finishTask() : commitModule());
  }
  async function transition(action) {
    if (transitioning || committing || disposed || finished) return;
    transitioning = true;
    updateClock();
    const previousControls = $$('input,textarea,button',currentHost).map(element=>({element,disabled:element.disabled}));
    previousControls.forEach(({element})=>element.disabled=true);
    try { await action(); } catch (error) { notify(error.message, true); } finally { previousControls.forEach(({element,disabled})=>{if(element.isConnected)element.disabled=workspaceInterrupted||disabled;});transitioning = false; updateClock(); }
  }
  async function move(cursor) {
    saveScroll(); await persist({ cursor }); render();
  }
  async function next() {
    if (run.paused) return;
    if (recordingState?.active || recordingState?.saving || recordingState?.blob) { await finishRecording(); if (recordingState?.blob) return; }
    const phase = run.cursor.phase, task = getTask();
    if (phase === 'instructions') {
      if($('#prompt-audio',container)&&!mediaComplete){
        if(mode==='exam'){notify('Listen to the instructions before you begin.');return;}
        if(!await dialog({title:'Skip these instructions?',text:'跳过说明音频会记录为使用过练习辅助。',confirm:'Skip'}))return;
        await persist({assisted:true});
      }
      await startCurrentTask(); return;
    }
    if (phase === 'review') { if(getModule().navigation.review==='task')await finishTask(true);else await commitModule('manual',true); return; }
    if (phase === 'directions' || phase === 'stimulus') {
      if (!mediaComplete && $('#prompt-audio', container)) {
        if (mode === 'exam') { notify('Listen to the recording before you continue.'); return; }
        const skip = await dialog({ title: 'Skip this recording?', text: '跳过或额外回放会记录为使用过练习辅助。', confirm: 'Skip' });
        if (!skip) return;
        await persist({ assisted: true });
      }
      await mediaEnded(); return;
    }
    if (phase === 'prepare') { await startRecording(); return; }
    if (isSpokenTask(task) && !getEntry().recordingId) {
      if (!await dialog({ title: 'No response recorded', text: '本题没有已保存的录音。继续后将按未作答记录。', confirm: 'Next' })) return;
    }
    await navigatePage(1);
  }
  async function navigatePage(delta) {
    const module = getModule(), all = pages(module), index = currentPageIndex(), target = all[index + delta];
    if (!target) {
      if (delta < 0) return;
      if (mode==='practice'&&module.navigation.review !== 'none') await move({ phase: 'review' }); else await commitModule('manual',mode==='exam');
      return;
    }
    const newTask = target.task.id !== getTask().id;
    if (newTask && module.section === 'writing' && delta > 0) {
      if(mode==='exam'){await finishTask(true);return;}
      await move({phase:'review'});return;
    }
    let phase = 'response';
    if (delta > 0 && newTask && directionsFor(target.task).length) phase = 'directions';
    else if (delta > 0 && (isListeningTask(target.task) || isSpokenTask(target.task)) && sourcesFor(target.task, questions.get(target.questionId).question).length) phase = 'stimulus';
    await move({ taskId: target.task.id, questionId: target.questionId, phase, phaseIndex: 0 });
    if (['directions','stimulus'].includes(phase)) await tryPlay();
    else if (isSpokenTask(target.task) && !getEntry().recordingId) await startRecording();
  }
  async function finishTask(confirmed=false) {
    const all = pages(getModule()), nextTask = all.find(page => page.task.id !== getTask().id && getModule().tasks.indexOf(page.task) > getModule().tasks.indexOf(getTask()));
    if (!nextTask) { await commitModule('manual',confirmed); return; }
    if (!confirmed&&!await dialog({ title: 'Finish this task?', text: 'After you continue, you cannot return to this task.', confirm: 'Continue' })) return;
    await move({ taskId: nextTask.task.id, questionId: nextTask.questionId, phase: directionsFor(nextTask.task).length?'directions':'response', phaseIndex: 0 });
  }
  async function commitModule(reason = 'manual',confirmed=false) {
    if (committing || finished) return;
    const module = getModule();
    if (reason === 'manual' && !confirmed && !await dialog({ title: 'Finish this module?', text: 'Your answers will be saved. After you continue, you cannot return to this module.', confirm: 'Finish Module' })) return;
    committing = true;
    try {
      $$('input,textarea,button', currentHost).forEach(element => element.disabled = true);
      await finishRecording(); if (recordingState?.blob) throw new Error('请先保存或导出未保存的录音。');
      await persist();
      const body = { moduleId: module.id, expectedRevision: run.revision, writerToken: run.writerToken, submissionId: `${run.id}.${module.id}`, reason };
      let response;
      try { response = await api(`/sessions/${run.id}/commit-module`, body); }
      catch (error) {
        // Retry the same immutable submission identity, never generate another attempt batch.
        response = await api(`/sessions/${run.id}/commit-module`, body).catch(() => { throw error; });
      }
      synchronize(response.session); localAnswers = clone(run.answers); dirty.clear();
      await refresh(); render();
    } finally { committing = false; expiryHandling = false; }
  }
  function bindAnswers() {
    const question = getQuestion(), qid = question.id;
    $$('input[name=answer]', currentHost).forEach(input => input.onchange = () => { if (!inputAllowed()) return; getEntry().answer = input.value; changed(qid); });
    const text = $('#answer-input', currentHost);
    if (text) text.oninput = () => { if (!inputAllowed()) return; getEntry().answer = text.value; const count = $('#word-count', currentHost); if (count) count.textContent = String(text.value.trim().split(/\s+/).filter(Boolean).length); changed(qid); };
    $('#toggle-word-count', currentHost)?.addEventListener('click', event => { const count = $('#word-count', currentHost); count.hidden = !count.hidden; event.currentTarget.textContent = count.hidden ? 'Show Word Count' : 'Hide Word Count'; });
    if (question.type === 'sentence_order') bindSentence();
    if (getTask().kind === 'complete_words'&&getTask().inlineBlanks) bindLetters();
    $$('[data-candidate]',currentHost).forEach(button=>button.onclick=()=>{if(!inputAllowed()||getEntry().attemptId)return;saveScroll();getEntry().answer=button.dataset.candidate;changed(qid);render();});
    $$('[data-edit]', currentHost).forEach(button => button.onclick = () => editText(button.dataset.edit));
  }
  function bindLetters() {
    const all = $$('[data-letter-index]', currentHost);
    const words = getTask().inlineBlanks.anchors;
    const inputFor = (qid, index) => all.find(input => input.dataset.qid === qid && Number(input.dataset.letterIndex) === index);
    const cellsFor = anchor => Array.from({length:anchor.missingLetterCount},(_,i)=>String(getEntry(anchor.questionId).answer||'')[i]?.trim()||'');
    for (const input of all) {
      const qid = input.dataset.qid, index = Number(input.dataset.letterIndex), anchor = words.find(item => item.questionId === qid);
      let composing = false, compositionValue = null;
      input.tabIndex = index === 0 ? 0 : -1; input.setAttribute('aria-describedby', 'letter-help');
      input.onfocus = () => input.select();
      const edit = (text, { deletion = false, navigate = true, deferFocus = false } = {}) => {
        const before = cellsFor(anchor);
        if (!inputAllowed()) { input.value = before[index]; return; }
        const result = reduceBlankEdit(before,index,text,{deletion});
        if (!result.valid) { input.value=before[index]; notify('请输入缺失的英文字母，长度不能超过本词剩余空格。'); return; }
        result.cells.forEach((value,i)=>{inputFor(qid,i).value=value;});
        getEntry(qid).answer=result.answer; changed(qid);
        if (!navigate) return;
        const version=renderVersion,sequence=editSequence;
        const focus=()=>{
          if(!input.isConnected||renderVersion!==version||editSequence!==sequence||document.activeElement!==input)return;
          if(result.completed){const nextWord=words.slice(words.indexOf(anchor)+1).find(word=>cellsFor(word).some(value=>!value));if(nextWord)inputFor(nextWord.questionId,cellsFor(nextWord).findIndex(value=>!value)).focus();}
          else if(result.nextIndex!==index)inputFor(qid,result.nextIndex).focus();
        };
        // Chromium restores its composition selection after compositionend.
        // Let that finish, then move only if the same editor still owns focus.
        if(deferFocus)setTimeout(focus,0);else focus();
      };
      input.oninput = event => {
        if (composing || event.isComposing) return;
        if (compositionValue !== null) { const duplicate=input.value===compositionValue;compositionValue=null;if(duplicate)return; }
        const text=/^insert/.test(event.inputType||'')&&/^[A-Za-z]$/.test(event.data||'')?event.data:input.value;
        edit(text,{deletion:text==='',navigate:!/^history/.test(event.inputType||'')});
      };
      input.addEventListener('compositionstart',()=>{composing=true;compositionValue=null;});
      input.addEventListener('compositionend',event=>{composing=false;const value=event.data||input.value;edit(value,{deferFocus:true});compositionValue=input.value;});
      input.onkeydown = event => {
        if (event.isComposing || composing) return;
        compositionValue=null;
        if (event.key === 'Enter') { event.preventDefault(); return; }
        if (event.key === 'Tab') {
          const nextWord = words[words.indexOf(anchor) + (event.shiftKey ? -1 : 1)];
          if (nextWord) { event.preventDefault(); inputFor(nextWord.questionId, Math.max(0,cellsFor(nextWord).findIndex(value=>!value))).focus(); } return;
        }
        const target = event.key === 'ArrowLeft' ? Math.max(0,index-1) : event.key === 'ArrowRight' ? Math.min(anchor.missingLetterCount-1,index+1) : event.key === 'Home' ? 0 : event.key === 'End' ? anchor.missingLetterCount-1 : null;
        if (target !== null) { event.preventDefault(); inputFor(qid, target).focus(); return; }
        if(event.key==='Backspace'||event.key==='Delete'){
          event.preventDefault();if(!inputAllowed())return;
          if(input.value||event.key==='Delete')edit('',{deletion:true});
          else all[all.indexOf(input)-1]?.focus();
        }
      };
      input.onpaste = event => {
        event.preventDefault(); if (!inputAllowed()) return;
        const pasted = event.clipboardData.getData('text/plain');
        if (!/^[A-Za-z]+$/.test(pasted) || pasted.length > anchor.missingLetterCount - index) { notify('粘贴内容须为缺失字母，且不能超过当前单词剩余格数。'); return; }
        edit(pasted);
      };
    }
  }
  function bindSentence() {
    const qid = getQuestion().id;
    const fill = (id, target = null, from = null) => {
      if (!inputAllowed() || getEntry().attemptId) return;
      const limit = sentenceSlots(getQuestion()), answer = Array.from({length:limit},(_,index)=>getEntry().answer?.[index]||'');
      if (!getQuestion().options.some(option => option.id === id)) return;
      const existing = answer.indexOf(id); if (existing >= 0) answer[existing] = '';
      const slot = target === null ? Array.from({length:limit},(_,i)=>i).find(i=>!answer[i]) : target;
      if (slot === undefined || slot < 0 || slot >= limit) return;
      if (answer[slot] && existing >= 0) answer[existing] = answer[slot];
      answer[slot] = id; while(answer.length && !answer.at(-1))answer.pop();
      getEntry().answer = answer; changed(qid); redrawSentence();
    };
    $$('[data-token]', currentHost).forEach(button => {
      button.onclick = () => fill(button.dataset.token);
      button.ondragstart = event => event.dataTransfer.setData('text/plain', button.dataset.token);
    });
    $$('[data-slot]', currentHost).forEach(button => {
      const slot = Number(button.dataset.slot);
      button.onclick = () => { if (!inputAllowed() || getEntry().attemptId) return; const answer = [...(getEntry().answer || [])]; answer[slot] = ''; while(answer.length && !answer.at(-1))answer.pop(); getEntry().answer = answer; changed(qid); redrawSentence(); };
      button.ondragstart = event => { const id = getEntry().answer?.[slot]; if (id) event.dataTransfer.setData('text/plain', id); else event.preventDefault(); };
      button.ondragover = event => { event.preventDefault(); button.classList.add('drag-over'); };
      button.ondragleave = () => button.classList.remove('drag-over');
      button.ondrop = event => { event.preventDefault(); fill(event.dataTransfer.getData('text/plain'), slot); };
    });
  }
  function redrawSentence() { currentHost.innerHTML = renderSentence(getQuestion(), getEntry(), getTask().presentation); bindSentence(); }
  async function editText(command) {
    const input = $('#answer-input', currentHost); if (!input) return;
    try {
      input.focus();
      if (command === 'copy' || command === 'cut') {
        const selection = input.value.slice(input.selectionStart,input.selectionEnd); if (!selection) return;
        await navigator.clipboard.writeText(selection);
        if (command === 'cut' && inputAllowed()) document.execCommand('delete');
      } else if (command === 'paste') {
        if (!inputAllowed()) return;
        document.execCommand('insertText',false,await navigator.clipboard.readText());
      } else document.execCommand(command);
    } catch { notify('请使用键盘快捷键完成此编辑操作。'); }
  }
  function bindMedia() {
    const media = $('#prompt-audio', container); mediaComplete = !media;
    if (!media) return;
    const thisVersion = renderVersion;
    media.volume = Number(sessionStorage.getItem('examVolume') ?? 1);
    $('#play-stimulus').onclick = async () => {
      if (media.paused) { if (mode === 'practice'&&(media.ended||run.cursor.phase==='response')) await persist({ assisted: true }); await tryPlay(); }
      else if (mode === 'practice') { media.pause(); $('#play-stimulus').innerHTML = icon('play'); }
    };
    const updatePlayback = () => { if(disposed||thisVersion!==renderVersion)return;const total = Number.isFinite(media.duration) ? media.duration : 0; $('#audio-progress').value = total ? media.currentTime / total : 0; $('#audio-time').textContent = `${duration(media.currentTime)} / ${duration(total)}`; };
    media.ontimeupdate = updatePlayback;media.onloadedmetadata=updatePlayback;updatePlayback();
    const seek=$('#audio-progress');
    if(mode==='practice')seek.onchange=async()=>{if(!Number.isFinite(media.duration)||run.paused)return;const fraction=Number(seek.value);try{await persist({assisted:true});if(thisVersion===renderVersion)media.currentTime=Math.max(0,Math.min(media.duration,fraction*media.duration));}catch{updatePlayback();}};
    $('#audio-rate')?.addEventListener('change',async event=>{const control=event.target,rate=Number(control.value);try{await persist({assisted:true});if(thisVersion===renderVersion)media.playbackRate=rate;}catch{control.value=String(media.playbackRate);}});
    media.onplay = () => { $('#play-stimulus').textContent = 'Ⅱ'; $('#media-status').textContent = 'Listen carefully.'; };
    media.onpause = () => { if ($('#play-stimulus')) $('#play-stimulus').innerHTML = icon('play'); };
    media.onerror = () => { if (disposed || thisVersion !== renderVersion) return; $('#media-status').textContent = '无法播放这份材料。请检查媒体，或保存并退出。'; mediaComplete = false; notify('材料无法解码，本题尚未开始作答计时。',true); };
    media.onended = () => { if (disposed || thisVersion !== renderVersion) return; mediaComplete = true; transition(mediaEnded); };
  }
  async function tryPlay() { const media = $('#prompt-audio',container); if (!media || run.paused) return; try { await media.play(); } catch { $('#media-status').textContent = 'Click Play to start the recording.'; } }
  async function mediaEnded() {
    const phase = run.cursor.phase, task = getTask();
    if (!['directions','stimulus'].includes(phase)) return;
    $('#prompt-audio')?.pause();
    const count = phase === 'directions' ? directionsFor(task).length : currentSources.length;
    if ((run.cursor.phaseIndex || 0) + 1 < count) { await move({phaseIndex:(run.cursor.phaseIndex||0)+1}); await tryPlay(); return; }
    if (phase === 'directions') { await startCurrentTask({skipDirections:true}); return; }
    if (isSpokenTask(task)) {
      const preparation = task.timing?.prepareSeconds ?? getQuestion().prepareSeconds ?? 0;
      if (preparation > 0) { await move({phase:'prepare',phaseIndex:0}); return; }
      await startRecording();
    } else await move({phase:'response',phaseIndex:0});
  }
  async function checkMicrophone() {
    try {
      stream?.getTracks().forEach(track => track.stop());
      stream = await navigator.mediaDevices.getUserMedia({ audio:{echoCancellation:true,noiseSuppression:true},video:false }); microphoneReady = true;
      if(disposed){stream.getTracks().forEach(track=>track.stop());microphoneReady=false;return;}
      const status = $('#microphone-status'); if(status)status.textContent='Microphone is ready.';
      if(micFrame)cancelAnimationFrame(micFrame);await micContext?.close().catch(()=>{});
      if(disposed){stream?.getTracks().forEach(track=>track.stop());microphoneReady=false;return;}
      micContext=new AudioContext();const analyser=micContext.createAnalyser();analyser.fftSize=1024;micContext.createMediaStreamSource(stream).connect(analyser);const data=new Uint8Array(analyser.fftSize);
      const sample=()=>{if(disposed||!stream?.active||!$('#microphone-level'))return;analyser.getByteTimeDomainData(data);const rms=Math.sqrt(data.reduce((sum,value)=>sum+((value-128)/128)**2,0)/data.length);$('#microphone-level').value=Math.min(1,rms*5);micFrame=requestAnimationFrame(sample);};sample();
    } catch(error) { microphoneReady=false;notify(`无法使用麦克风：${error.message}`,true); }
  }
  function recordingRemaining() {
    const responseTimer=Object.values(run.timers||{}).find(timer=>timer.phase==='response'&&timer.questionId===getQuestion().id);
    return recordingState?.active?Math.max(0,recordingState.limitSeconds-(performance.now()-recordingState.started)/1000):(clockValue(responseTimer)?.remaining??resolvedTiming(getTask()).durationSeconds*1000)/1000;
  }
  function recordingView() { return { active:recordingState?.active,saving:recordingState?.saving,pending:recordingState?.blob,remaining:recordingRemaining(),exhausted:recordingRemaining()<=0 }; }
  function bindRecording() {
    $('#record-toggle')?.addEventListener('click',()=>transition(async()=>{if(recordingState?.active)await finishRecording();else await startRecording();}));
    $('#record-save-retry')?.addEventListener('click',()=>transition(saveRecording));
  }
  async function startRecording() {
    if (recordingState?.active || recordingState?.saving || recordingState?.blob || run.paused) return;
    if(mode==='exam'&&getEntry().recordingId){notify('本题回答已保存。请点击 Next 继续。');return;}
    if(run.cursor.phase==='response'&&clockValue()?.remaining===0){notify('本题回答时间已用完。请点击 Next 继续。');return;}
    const qid=getQuestion().id,taskId=getTask().id,sessionId=run.id,writerToken=run.writerToken,generation=crypto.randomUUID();
    try {
      if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持录音。');
      $('#prompt-audio')?.pause();if(micFrame)cancelAnimationFrame(micFrame);await micContext?.close().catch(()=>{});micContext=null;
      if (!stream?.active) stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if(disposed||run.id!==sessionId||getQuestion().id!==qid){stream?.getTracks().forEach(track=>track.stop());return;}
      if(run.cursor.phase!=='response')await persist({cursor:{phase:'response',phaseIndex:0}});
      const limitSeconds=Math.min(resolvedTiming(getTask()).durationSeconds,(clockValue()?.remaining??0)/1000);
      if(limitSeconds<=0){stream.getTracks().forEach(track=>track.stop());notify('本题回答时间已用完，已保存的录音仍可回听。请点击 Next 继续。');render();return;}
      const gate=await createRecordingGate(stream,limitSeconds);
      if(disposed){stream?.getTracks().forEach(track=>track.stop());await gate.close();return;}
      const mime=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));
      const localStream=stream, localRecorder=new MediaRecorder(gate.stream,mime?{mimeType:mime}:undefined);recorder=localRecorder;
      const capture={qid,taskId,sessionId,writerToken,generation,chunks:[],blob:null,active:true,saving:false,started:performance.now(),limitSeconds,gate,stopPromise:null};recordingState=capture;
      capture.stop=()=>{if(capture.stopRequested)return;capture.stopRequested=true;capture.stoppedAt=new Date(now()).toISOString();capture.elapsed=Math.min(limitSeconds,(performance.now()-capture.started)/1000);clearTimeout(capture.deadline);if(localRecorder.state==='recording')localRecorder.stop();localStream.getTracks().forEach(track=>track.stop());};
      capture.stopPromise=new Promise(resolve=>{
        localRecorder.ondataavailable=event=>{if(!capture.stopHandled&&event.data.size)capture.chunks.push(event.data);};
        localRecorder.onstop=async()=>{
          if(capture.stopHandled)return;capture.stopHandled=true;capture.active=false;clearTimeout(capture.deadline);capture.elapsed??=Math.min(limitSeconds,(performance.now()-capture.started)/1000);capture.stoppedAt??=new Date(now()).toISOString();
          capture.blob=new Blob(capture.chunks,{type:localRecorder.mimeType||mime||'audio/webm'});localStream.getTracks().forEach(track=>track.stop());if(recorder===localRecorder)recorder=null;
          if(disposed||capture!==recordingState||run.id!==capture.sessionId||run.writerToken!==capture.writerToken){await gate.close();resolve();return;}
          try{await persist({cursor:{phase:'saving'},capturedAt:capture.stoppedAt});await saveRecording(capture);}catch(error){render();renderRecordingRecovery(capture);}finally{await gate.close();}resolve();
        };
      });
      localRecorder.onerror=()=>{if(capture===recordingState&&!disposed)notify('录音出现错误，请保留页面并重试保存。',true);};
      localRecorder.start(250);
      capture.deadline=setTimeout(()=>capture.stop(),Math.max(0,limitSeconds*1000));
      render();
    } catch(error) { if(recorder?.state==='recording'){recorder.stop();await recordingState?.stopPromise;}stream?.getTracks().forEach(track=>track.stop());notify(`无法开始录音：${error.message}`,true); }
  }
  async function finishRecording() {
    const capture=recordingState;
    if(capture?.active&&recorder?.state==='recording'){capture.stop();await capture.stopPromise;}
    else if(capture?.saving)await capture.stopPromise;
    else if(capture?.blob)await saveRecording(capture);
  }
  async function saveRecording(capture=recordingState) {
    if(!capture?.blob||capture.saving||workspaceInterrupted)return;
    capture.saving=true;const status=$('#record-status');if(status)status.textContent='Saving your response…';
    try {
      if(!capture.bounded){capture.blob=await capRecordingBlob(capture.blob,Math.min(capture.limitSeconds,capture.elapsed),capture.gate?.context.state==='closed'?undefined:capture.gate?.context);capture.bounded=true;}
      if(workspaceInterrupted)throw new Error('工作区已恢复；这份旧录音只能由你导出保留。');
      if(capture.blob.size<64)throw new Error('录音没有有效数据，请重新录制。');
      const response=await api('/recordings',{...await fileData(new File([capture.blob],`answer-${capture.generation}.wav`,{type:capture.blob.type})),uploadId:capture.generation});
      if(disposed||capture!==recordingState||run.id!==capture.sessionId||run.writerToken!==capture.writerToken)throw new Error('录音属于之前的练习状态。请导出保存。');
      const entry=getEntry(capture.qid);entry.recordingId=response.recordingId;entry.recordingUrl=response.url;entry.transcript='';entry.transcriptConfirmed=false;changed(capture.qid);
      await persist({cursor:{phase:'recorded'}});capture.blob=null;capture.chunks=[];capture.saving=false;
      if(!disposed&&getQuestion().id===capture.qid)render();
    } catch(error) { notify(error.message,true);capture.saving=false;if(capture===recordingState&&!disposed){render();renderRecordingRecovery(capture);} }
  }
  function renderRecordingRecovery(capture) {
    const status=$('#record-status');if(status)status.textContent='录音尚未保存。可以重试，或导出一份本地文件。';
    const retry=$('#record-save-retry');if(retry)retry.hidden=false;
    if(!$('#export-pending-recording')){
      const button=document.createElement('button');button.id='export-pending-recording';button.className='exam-action';button.textContent='导出未保存录音';
      button.onclick=()=>{if(!capture.bounded){notify('请先重试处理录音长度，再导出文件。',true);return;}saveBlob(`answer-${capture.generation}.wav`,capture.blob);};
      $('.exam-recorder')?.append(button);
    }
  }
  async function pause() { $('#prompt-audio')?.pause(); await finishRecording();if(recordingState?.blob)return;await persist({timer:{action:'pause'}});renderPaused(); }
  function renderPaused() {
    const content=$('#exam-content');if(!content||$('.exam-pause-cover',content))return;
    if(run.timingInterruption){
      const cover=document.createElement('div');cover.className='exam-pause-cover';cover.innerHTML=`<h1>本轮计时无法继续</h1><p>${esc(run.timingInterruption.message||'旧练习只记录了整组口语耗时，无法确认当前题还剩多少时间。草稿和录音已保留；可以另开一轮逐题计时的练习。')}</p><button class="exam-action primary" id="exam-new-round">新开一轮练习</button><button class="exam-action" id="exam-paused-exit">保存并退出</button>`;content.append(cover);
      $$('input,textarea,button',currentHost).forEach(element=>element.disabled=true);
      for(const id of ['exam-ai','exam-answers','exam-transcript'])if($('#'+id))$('#'+id).hidden=true;
      $('#exam-pause')?.setAttribute('disabled','');
      $('#exam-new-round').onclick=()=>transition(()=>resetRun(true));$('#exam-paused-exit').onclick=exitPractice;return;
    }
    const cover=document.createElement('div');cover.className='exam-pause-cover';cover.innerHTML='<h1>Practice Paused</h1><p>Your answers have been saved.</p><button class="exam-action primary" id="exam-resume">Continue</button><button class="exam-action" id="exam-paused-exit">保存并退出</button>';content.append(cover);
    $('#exam-resume').onclick=()=>transition(async()=>{await persist({timer:{action:'resume'}});cover.remove();updateClock();});
    $('#exam-paused-exit').onclick=exitPractice;
  }
  function updateClock() {
    if(disposed||finished)return;
    for(const id of ['exam-next','exam-back','exam-review','exam-exit']){const button=$('#'+id);if(button)button.disabled=transitioning||committing||Boolean(recordingState?.saving)||(id!=='exam-exit'&&Boolean(run.timingInterruption))||(id==='exam-next'&&(Boolean(recordingState?.active)||(run.cursor.phase==='instructions'&&missingStimuli().length>0)));}
    const reading=clockValue(),clock=$('#exam-clock'),label=$('#exam-time');
    if(label){
      label.hidden=!showTime;
      if(run.timingInterruption){label.textContent='计时中断';clock?.classList.remove('urgent');}
      else{const remaining=recordingState?.active||(isSpokenTask(getTask())&&['saving','recorded'].includes(run.cursor.phase))?recordingRemaining()*1000:reading?.remaining??resolvedTiming(getTask()).durationSeconds*1000;label.textContent=examTime(remaining/1000);clock?.classList.toggle('urgent',remaining<=15000);}
    }
    if(recordingState?.active){const remaining=recordingRemaining();const el=$('#record-duration');if(el)el.textContent=duration(Math.ceil(remaining));const progress=$('#record-progress');if(progress)progress.value=remaining/recordingState.limitSeconds;}
    if(reading?.remaining===0&&!expiredResponses.has(run.activeTimerId)&&!['saving','recorded'].includes(run.cursor.phase)&&!run.paused&&!expiryHandling&&!transitioning&&!committing){expiryHandling=true;transition(handleExpiry).finally(()=>{expiryHandling=false;});}
  }
  async function handleExpiry() {
    const timer=activeTimer();if(!timer)return;
    if(practiceMayContinue()){
      expiredResponses.add(run.activeTimerId);
      notify('计时已结束，可以继续练习；点击 Next 后再进入下一题或环节。');
      return;
    }
    if(run.cursor.phase==='prepare'){await startRecording();return;}
    if(recordingState?.active)await finishRecording();
    if(recordingState?.blob)return;
    if(isSpokenTask(getTask())){expiredResponses.add(run.activeTimerId);render();return;}
    if(timer.scope==='module'){await commitModule('timeout');return;}
    if(timer.scope==='task'){
      const module=getModule(),nextTask=module.tasks[module.tasks.indexOf(getTask())+1];
      if(!nextTask)await commitModule('timeout');else await move({taskId:nextTask.id,questionId:nextTask.questionIds[0],phase:directionsFor(nextTask).length?'directions':'response',phaseIndex:0});
    } else {
      const all=pages(getModule()),nextPage=all[currentPageIndex()+1];
      if(!nextPage)await commitModule('timeout');else await navigatePage(1);
    }
  }
  async function showHelper(kind) {
    if(mode!=='practice'||disposed||finished||!['answers','transcript'].includes(kind))return;
    if(helper===kind){$('.exam-help-panel')?.remove();$('#exam-content').classList.remove('help-open');helper=null;++helperEpoch;coach.update();return;}
    const version=renderVersion;
    await persist({assisted:true});
    if(disposed||version!==renderVersion)return;
    const task=getTask(),group=getGroup(),question=getQuestion();
    const body=kind==='answers'?task.questionIds.map(qid=>{const q=questions.get(qid).question;return `<article><b>Question ${task.questionIds.indexOf(qid)+(task.numberStart||1)}</b><p>${esc(formatPracticeAnswer(q,q.answer)||'本材料未提供参考答案。')}</p>${q.explanation?`<p>${esc(q.explanation)}</p>`:''}</article>`;}).join('') : plainParagraphs([group.transcript|| (isListeningTask(task)?group.passage:''),question.transcript||(task.presentation?.questionPromptVisibility==='review'||isSpokenTask(task)?question.type==='listen_repeat'?question.answer:question.prompt:'')].filter(Boolean).join('\n\n')) || '<p>本材料未提供这部分文字。</p>';
    $('.exam-help-panel')?.remove();const panel=document.createElement('aside');panel.className='exam-help-panel';panel.innerHTML=`<h2>${kind==='answers'?'Answer':'Transcript'}</h2>${body}`;$('#exam-content').append(panel);$('#exam-content').classList.add('help-open');helper=kind;++helperEpoch;coach.update();
  }
  function volumeDialog() {
    dialog({title:'Volume',text:'调整题目音频的播放音量。',confirm:'Done',cancel:'Close',content:'<label>Volume <input id="exam-volume-input" type="range" min="0" max="1" step="0.05"></label>'});
    const input=$('#exam-volume-input');input.value=sessionStorage.getItem('examVolume')??'1';input.oninput=()=>{sessionStorage.setItem('examVolume',input.value);const audio=$('#prompt-audio');if(audio)audio.volume=Number(input.value);};
  }
  async function resetRun(confirmed=false) {
    if(!confirmed&&!await dialog({title:'Start a new practice?',text:'会开始新一轮练习。之前的草稿、作答和录音仍保留。',confirm:'Start New'}))return;
    await pause();if(recordingState?.blob)return;
    const response=await api('/sessions',{sessionVersion:2,libraryId:library.libraryId,...run.selection,mode,preset:run.preset});
    location.hash=`#exam/${library.libraryId}/${response.session.planSnapshot.id}/${sectionId||'all'}/${mode}/${response.session.id}`;
  }
  async function exitPractice() { if(transitioning||committing)return; if(await close())location.hash=`#collection/${library.libraryId}`; }
  async function interruptWorkspace(){
    if(workspaceInterrupted)return;
    workspaceInterrupted=true;disposed=true;clearTimeout(saveTimeout);clearInterval(interval);coach?.destroy();$('#prompt-audio')?.pause();
    const capture=recordingState;
    capture?.stop?.();stream?.getTracks().forEach(track=>track.stop());if(micFrame)cancelAnimationFrame(micFrame);
    for(const timer of Object.values(run.timers||{})){timer.consumedMs=clockValue(timer)?.elapsed??timer.consumedMs;timer.runningSince=null;timer.paused=true;}run.paused=true;
    for(const element of $$('button,input,textarea,select',container)){
      if(element.tagName==='TEXTAREA'||element.tagName==='INPUT'&&!['checkbox','radio','button'].includes(element.type))element.readOnly=true;else element.disabled=true;
    }
    setSaveStatus('工作区已恢复 · 本页计时和保存已停止',true);
    const panel=document.createElement('section');panel.id='workspace-practice-recovery';panel.className='notice';
    const message=document.createElement('p');message.textContent=capture?'正在保留恢复前的录音；它不会加入新工作区。':'本页输入仍在。可以导出一份仅供人工核对的练习副本。';
    const exportDraft=document.createElement('button');exportDraft.id='export-workspace-draft';exportDraft.className='exam-action';exportDraft.textContent='导出当前练习副本';
    exportDraft.onclick=()=>saveText(`PracticeBridge-恢复前练习-${run.id}.json`,JSON.stringify({kind:'practicebridge-unsaved-practice',version:1,createdAt:new Date().toISOString(),reason:'workspace_restored',note:'仅供人工核对；不能自动提交到恢复后的工作区。',libraryId:library.libraryId,sessionId:run.id,writerToken:run.writerToken,sessionRevision:run.revision,cursor:run.cursor,answers:localAnswers},null,2),'application/json;charset=utf-8');
    panel.append(message,exportDraft);$('#exam-content',container)?.prepend(panel);
    await micContext?.close().catch(()=>{});
    if(capture?.active)await capture.stopPromise;
    if(capture?.blob){
      let output=capture.blob,bounded=capture.bounded;
      if(!bounded)try{output=await capRecordingBlob(output,Math.min(capture.limitSeconds,capture.elapsed));bounded=true;}catch{}
      capture.blob=output;capture.bounded=bounded;
      $('#export-pending-recording',container)?.remove();
      const exportAudio=document.createElement('button');exportAudio.id='export-pending-recording';exportAudio.className='exam-action';exportAudio.textContent=bounded?'导出恢复前录音':'导出恢复前原始录音';
      const extension=output.type.includes('wav')?'wav':output.type.includes('ogg')?'ogg':'webm';
      exportAudio.onclick=()=>saveBlob(`answer-before-restore-${capture.generation}.${extension}`,output);
      panel.append(exportAudio);message.textContent=bounded?'恢复前的录音已停止，并保留了最后一段音频。请导出后再重新载入页面。':'录音已停止，但音频格式处理未完成。可先导出原始录音保留；它不会自动成为作答。';
    }else message.textContent='本页计时和录音已停止；当前输入仍保留，可以导出练习副本。';
    $('.exam-recorder',container)?.classList.remove('recording');
    const recordStatus=$('#record-status',container);if(recordStatus)recordStatus.textContent='已停止 · 恢复前的录音仅供手动导出';
  }
  async function close() {
    if(workspaceInterrupted&&!recoveryAcknowledged&&(dirty.size||recordingState?.blob||recordingState?.active)){notify('请先保留当前输入或导出录音，再选择“已保留输入，重新载入”。',true);return false;}
    if(disposed)return true;
    if(transitioning||committing){notify('正在保存练习，请稍候再离开。');return false;}
    clearTimeout(saveTimeout);
    try{if(!finished){$('#prompt-audio')?.pause();await finishRecording();if(recordingState?.blob)return false;await persist({timer:{action:'pause'}});}}
    catch{notify('草稿尚未保存，请重试后再离开。',true);return false;}
    disposed=true;coach?.destroy();clearInterval(interval);if(micFrame)cancelAnimationFrame(micFrame);await micContext?.close().catch(()=>{});stream?.getTracks().forEach(track=>track.stop());window.removeEventListener('beforeunload',beforeUnload);document.body.classList.remove('exam-mode');return true;
  }
  function beforeUnload(event) { if(workspaceInterrupted&&recoveryAcknowledged)return;if(dirty.size||recordingState?.active||recordingState?.blob||recordingState?.saving||committing){event.preventDefault();event.returnValue='';} }
  function renderCompleted() {
    clearInterval(interval);coach?.update();
    const entries=Object.entries(run.answers||{}).filter(([,entry])=>entry.attemptId);
    container.innerHTML=`<div class="exam-shell"><header class="exam-top"><button id="completed-exit">退出</button><span>${new Set(modules.map(module=>module.section)).size>1?'All Sections':sectionLabels[modules[0]?.section]||'Practice'} · Completed</span><button id="completed-library">Practice</button></header><div class="exam-content"><section class="exam-completed"><h1>Practice Completed</h1><p>${entries.length} 道作答已保存。现在可以查看答案、录音和反馈。</p><div class="exam-results-list">${entries.map(([qid,entry],i)=>`<div class="exam-result-row"><span>${i+1}</span><div><strong>${esc(questions.get(qid)?.question.prompt||qid)}</strong><small>${taskLabels[modules.flatMap(module=>module.tasks).find(task=>task.questionIds.includes(qid))?.kind]||''}</small></div><button class="exam-action" data-attempt="${esc(entry.attemptId)}">Review</button></div>`).join('')}</div></section></div></div>`;
    $('#completed-exit').onclick=exitPractice;$('#completed-library').onclick=exitPractice;
    $$('[data-attempt]',container).forEach(button=>button.onclick=()=>openReport(button.dataset.attempt));
  }
  coach=createExamCoach({sessionId:run.id,epoch:run.writerToken,api,settings,current:coachContext,capture:captureCoachContext});
  document.body.classList.add('exam-mode');
  window.addEventListener('beforeunload',beforeUnload);
  // Reopening a saved phase never starts media or microphone automatically.
  const sharedSpeakingTimer=!run.timingInterruption&&modules.some(module=>run.moduleStates[module.id]?.status!=='submitted'&&module.tasks.some(task=>isSpokenTask(task)&&Object.values(run.timers||{}).some(timer=>timer.moduleId===module.id&&timer.phase==='response'&&timer.scope!=='question'&&(timer.taskId===task.id||timer.scope==='module')&&timer.startedAt&&!timer.completed)));
  if(session?.sessionVersion===2&&!finished&&(run.timePolicyVersion!==TIME_POLICY_VERSION||sharedSpeakingTimer||(run.cursor.phase!=='instructions'&&!run.paused)))await persist({timer:{action:'pause'}});
  render();interval=setInterval(updateClock,200);
  return controller;
}
