import { $, $$, esc, icon, notify, download, date, sectionName } from './ui.mjs';
import { sectionLabels, taskLabels } from './exam-views.mjs';
import { PRACTICE_TIME_DEFAULTS } from './exam-timing.mjs';

export const examResumeHash = session => session.sessionVersion === 2 ? `#exam/${session.libraryId}/${session.planSnapshot.id}/all/${session.mode}/${session.id}` : `#practice/${session.libraryId}/${session.groupId}/${session.mode}/${session.id}`;
const planTasks = plan => (plan?.sections || []).flatMap(section => (section.modules || []).flatMap(module => (module.tasks || []).map(task => ({ section, module, task }))));
const answerEntry = value => value !== null && typeof value !== 'object' || Array.isArray(value) ? { answer: value } : value || {};
const hasValue = value => value !== null && value !== undefined && (typeof value === 'string' ? !!value.trim() : Array.isArray(value) ? value.some(hasValue) : typeof value === 'object' ? Object.values(value).some(hasValue) : true);
const hasResponse = value => { const entry = answerEntry(value); return hasValue(entry.answer) || !!entry.recordingId || hasValue(entry.transcript); };
const sessionTime = session => Date.parse(session.lastUserActivityAt) || Math.max(0, ...Object.values(session.answers || {}).map(value => Date.parse(answerEntry(value).savedAt) || 0)) || Date.parse(session.updatedAt || session.startedAt) || 0;
const stableValue = value => Array.isArray(value) ? value.map(stableValue) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])])) : value;
function sessionProjections(sessions, libraries = []) {
  const projections = new Map(), records = new Map(sessions.map(session => [session.id, session])), libraryById = new Map(libraries.map(library => [library.libraryId, library]));
  for (const session of sessions) {
    if (session.sessionVersion !== 2 || !session.legacySessionId) continue;
    const source = records.get(session.legacySessionId), library = libraryById.get(session.libraryId);
    if (!source || source.libraryId !== session.libraryId || source.mode !== session.mode || !planTasks(session.planSnapshot).length || (libraries.length && !library) || (library?.contentHash && session.sourceHash && library.contentHash !== session.sourceHash)) continue;
    const prior = projections.get(session.legacySessionId);
    if (!prior || (prior.finished && !session.finished) || (prior.finished === session.finished && sessionTime(session) > sessionTime(prior))) projections.set(session.legacySessionId, session);
  }
  return projections;
}

function resumeContext(session, library) {
  const tasks = session.sessionVersion === 2 ? planTasks(session.planSnapshot) : planTasks(library?.examPlan).filter(ref => ref.task.groupId === session.groupId);
  const current = tasks.find(ref => ref.task.questionIds?.includes(session.cursor?.questionId)) || tasks.find(ref => ref.task.id === session.cursor?.taskId) || tasks[0];
  const groupId = current?.task.groupId || session.groupId || session.selection?.groupId;
  const group = library?.groups?.find(item => item.id === groupId);
  const questionIds = current?.task.questionIds || group?.questions?.map(question => question.id) || [];
  const questionIndex = session.sessionVersion === 2 ? Math.max(0, questionIds.indexOf(session.cursor?.questionId)) : Math.min(Math.max(0, session.currentIndex || 0), Math.max(0, questionIds.length - 1));
  return { tasks, current, groupId, group, questionIds, questionIndex };
}

function resumeScope(session, library) {
  const context = resumeContext(session, library);
  const tasks = context.tasks.length ? context.tasks.map(({ section, module, task }) => [task.groupId, task.questionIds, section.id, module.id]) : [[session.groupId, context.questionIds]];
  // A legacy task and its current single-task plan describe the same scope.
  // Multi-task runs retain their actual module boundaries and question order.
  const scope = tasks.length === 1 ? [tasks[0][0], library ? tasks[0][1] : null] : tasks;
  return JSON.stringify([session.libraryId, session.sourceHash || library?.contentHash || null, session.contentRevision ?? library?.contentRevision ?? library?.version ?? null, session.planSnapshot?.version || library?.examPlan?.version || 1, session.mode || 'practice', scope, stableValue(session.preset ?? 'document')]);
}

function resumeProgress(session) {
  const responses = Object.values(session.answers || {}).filter(hasResponse).length;
  const questions = planTasks(session.planSnapshot).flatMap(ref => ref.task.questionIds || []);
  const position = session.sessionVersion === 2 ? Math.max(0, questions.indexOf(session.cursor?.questionId)) : session.currentIndex || 0;
  const submitted = Object.values(session.answers || {}).filter(value => answerEntry(value).attemptId).length;
  const marked = Object.values(session.marked || {}).some(Boolean);
  const locked = Object.values(session.moduleStates || {}).some(value => value.submission || value.lockedQuestionIds?.length || value.lockedTaskIds?.length);
  return { responses, position, rank: responses ? 2 : position > 0 || marked || locked || submitted ? 1 : 0 };
}
const compareResumeSessions = (a, b) => resumeProgress(b).rank - resumeProgress(a).rank || sessionTime(b) - sessionTime(a) || String(b.id).localeCompare(String(a.id));
const moduleQuestions = (module, library) => (module.tasks || (module.taskIds || []).map(id => ({ groupId: id, questionIds: library.groups.find(group => group.id === id)?.questions.map(question => question.id) || [] }))).flatMap(task => (task.questionIds || []).map(id => [task.groupId, id]));
const fullScopeSignature = (sections, library) => JSON.stringify((sections || []).map(section => [section.id, section.section, (section.modules || []).map(module => [module.id, moduleQuestions(module, library)])]));

export function matchingFullTestSessions(sessions, library, set) {
  if (!set.sections?.length) return [];
  const expected = fullScopeSignature(set.sections, library);
  return sessions.filter(session => {
    if (session.sessionVersion !== 2 || session.finished || session.libraryId !== library.libraryId || session.mode !== 'exam' || session.planSnapshot?.id !== set.id || session.selection?.sectionId || session.selection?.groupId) return false;
    if (library.contentHash && session.sourceHash !== library.contentHash) return false;
    return fullScopeSignature(session.planSnapshot.sections, library) === expected;
  }).sort(compareResumeSessions);
}

export function matchingSectionSessions(sessions, library, set, section, mode) {
  const available = set.sections?.find(item => item.section === section);
  if (!available) return [];
  const signature = modules => JSON.stringify((modules || []).map(module => [module.id, (module.tasks || (module.taskIds || []).map(id => ({ groupId: id, questionIds: library.groups.find(group => group.id === id)?.questions.map(question => question.id) || [] }))).map(task => [task.groupId, task.questionIds])]));
  const expected = signature(available.modules);
  return sessions.filter(session => {
    if (session.sessionVersion !== 2 || session.libraryId !== library.libraryId || session.mode !== mode || session.selection?.groupId || session.planSnapshot?.id !== set.id) return false;
    if (session.sourceHash && library.contentHash && session.sourceHash !== library.contentHash) return false;
    const actual = session.planSnapshot.sections.find(item => item.id === available.id && item.section === section);
    if (!actual || signature(actual.modules) !== expected) return false;
    return session.finished || session.cursor?.sectionId === available.id;
  }).sort(compareResumeSessions);
}

/** Read-only grouping: independent drafts and older empty entries stay accessible. */
export function resumableSessionGroups(sessions = [], libraries = []) {
  const libraryById = new Map(libraries.map(library => [library.libraryId, library]));
  const projections = sessionProjections(sessions, libraries);
  const grouped = new Map();
  for (const session of sessions) {
    if (session.finished || projections.has(session.id)) continue;
    const library = libraryById.get(session.libraryId);
    if (libraries.length && !library) continue;
    if (session.sessionVersion === 2 && (!planTasks(session.planSnapshot).length || (library?.contentHash && session.sourceHash && library.contentHash !== session.sourceHash))) continue;
    if (session.sessionVersion !== 2 && library && !library.groups?.some(group => group.id === session.groupId)) continue;
    const key = resumeScope(session, library);
    if (!grouped.has(key)) grouped.set(key, { key, library, candidates: [] });
    grouped.get(key).candidates.push(session);
  }
  const groups = [...grouped.values()].map(({ key, library, candidates }) => {
    candidates.sort(compareResumeSessions);
    const session = candidates[0], others = candidates.slice(1);
    const runs = [session, ...others.filter(item => resumeProgress(item).responses > 0)];
    const history = others.filter(item => !runs.includes(item)).map(item => ({ session: item, target: item, reason: '未作答的旧入口' }));
    return { key, library, session, runs, history };
  }).sort((a, b) => compareResumeSessions(a.session, b.session));
  for (const session of sessions) {
    const target = projections.get(session.id);
    if (!target) continue;
    const group = groups.find(item => item.runs.includes(target) || item.history.some(entry => entry.session.id === target.id)) || groups.find(item => item.key === resumeScope(target, libraryById.get(target.libraryId)));
    if (group) group.history.push({ session, target, reason: target.finished ? '旧草稿已在接续轮次完成' : '旧草稿已接续到新练习' });
  }
  return groups;
}

export function resumableSessions(sessions, libraries = []) {
  return resumableSessionGroups(sessions, libraries).flatMap(group => group.runs);
}

export function describeResumeSession(session, library) {
  const { tasks, current, group, groupId, questionIds, questionIndex } = resumeContext(session, library);
  const section = current?.section.section || group?.section;
  const moduleNumber = current?.module.sourceNumber;
  const taskTitle = group?.title?.replace(/^(?:Reading|Listening|Writing|Speaking|阅读|听力|写作|口语)\s*[·:：-]?\s*/i, '').replace(/^Module\s+\d+\s*[·:：-]?\s*/i, '').replace(/\s*·\s*原(?:题号|文第).*$/, '') || taskLabels[current?.task.kind || group?.taskKind] || groupId || '练习任务';
  const moduleLabel = moduleNumber ? `模块 ${moduleNumber}` : current?.section.modules?.length > 1 ? current.module.title : '';
  const taskLabel = [sectionName(section) || '练习', moduleLabel, taskTitle].filter(Boolean).join(' · ');
  const sections = [...new Set(tasks.map(ref => ref.section.section))];
  const scopeLabel = tasks.length > 1 ? `${sections.map(sectionName).join(' / ')} · ${tasks.length} 项任务` : taskLabel;
  const currentNumber = Number.isInteger(current?.task.numberStart) ? current.task.numberStart + questionIndex : null;
  const originalNumber = group?.questions?.find(question => question.id === questionIds[questionIndex])?.source?.match(/原题号\s*(\d+)/)?.[1];
  const progress = resumeProgress(session), total = tasks.length ? tasks.reduce((sum, ref) => sum + (ref.task.questionIds?.length || 0), 0) : questionIds.length;
  const questionLabel = `任务内第 ${questionIndex + 1}${questionIds.length ? ` / ${questionIds.length}` : ''} 题${originalNumber ? `（原题号 ${originalNumber}）` : currentNumber !== null ? `（练习题号 ${currentNumber}）` : ''}`;
  const presetNames = { readingModuleSeconds: '阅读模块', listeningQuestionSeconds: '听力每题', sentenceTaskSeconds: '组句任务', repeatSeconds: '跟读每题', interviewSeconds: '面谈每题' };
  const presetLabel = session.preset && typeof session.preset === 'object' ? Object.entries(session.preset).filter(([key]) => presetNames[key]).map(([key, value]) => `${presetNames[key]} ${value} 秒`).join('，') : session.preset === 'untimed' ? '旧计时预设' : '';
  return { scopeLabel, taskLabel, questionLabel, modeLabel: session.mode === 'exam' ? '模拟模式' : '练习模式', presetLabel, progressLabel: progress.responses ? `已填写或录音 ${progress.responses}${total ? ` / ${total}` : ''} 题` : progress.rank ? '已保存进度，尚无答案草稿' : '尚未作答', savedLabel: date(session.updatedAt || session.startedAt) };
}

export function renderResumeGroup(group, { showLibrary = true } = {}) {
  const row = (session, { heading, action = '继续', reason = '', target = session } = {}) => {
    const info = describeResumeSession(session, group.library);
    return `<div class="activity" data-resume-session="${esc(session.id)}"><div class="icon-badge">${icon('book')}</div><div class="activity-info"><strong>${esc(heading || (showLibrary ? group.library?.title || '未完成练习' : info.scopeLabel))}</strong><small>${esc(info.scopeLabel)} · ${info.modeLabel}${info.presetLabel ? `<br>计时预设：${esc(info.presetLabel)}` : ''}${info.scopeLabel !== info.taskLabel ? `<br>当前：${esc(info.taskLabel)}` : ''}<br>${esc(info.questionLabel)} · ${esc(info.progressLabel)}<br>${esc(reason || '保存于 ' + info.savedLabel)}</small></div><a class="button tiny" href="${esc(examResumeHash(target))}">${action} ${icon('arrow')}</a></div>`;
  };
  const rounds = [...group.runs].sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0) || String(a.id).localeCompare(String(b.id)));
  const mainReason = group.runs.length > 1 ? `第 ${rounds.indexOf(group.session) + 1} 轮 · 保存于 ${describeResumeSession(group.session, group.library).savedLabel}` : '';
  const others = group.runs.slice(1);
  return `<div data-resume-group="${esc(group.session.id)}">${row(group.session, { reason: mainReason })}${others.length ? `<details class="details" data-resume-rounds><summary>另有 ${others.length} 轮未完成草稿</summary>${others.map(session => row(session, { heading: `第 ${rounds.indexOf(session) + 1} 轮独立草稿`, action: '继续此轮' })).join('')}</details>` : ''}${group.history.length ? `<details class="details" data-resume-history><summary>${group.history.length} 条旧入口（已折叠，记录保留）</summary>${group.history.map(({ session, target, reason }) => row(session, { heading: reason, reason: '保存于 ' + describeResumeSession(session, group.library).savedLabel, target, action: target !== session ? target.finished ? '查看完成轮次' : '打开接续练习' : '继续旧记录' })).join('')}</details>` : ''}</div>`;
}

export function renderCompletedResumeSources(sessions = [], libraries = []) {
  const projections = sessionProjections(sessions, libraries), groups = resumableSessionGroups(sessions, libraries);
  const represented = new Set(groups.flatMap(group => group.history.map(entry => entry.session.id)));
  const sources = sessions.filter(session => projections.get(session.id)?.finished && !represented.has(session.id));
  if (!sources.length) return '';
  return `<details class="details" data-completed-resume-sources><summary>${sources.length} 条已完成接续的旧记录</summary>${sources.map(session => {
    const target = projections.get(session.id), library = libraries.find(item => item.libraryId === session.libraryId), info = describeResumeSession(session, library);
    return `<div class="activity" data-resume-source="${esc(session.id)}"><div class="activity-info"><strong>${esc(library?.title || '旧版练习')}</strong><small>${esc(info.scopeLabel)} · ${info.modeLabel}<br>旧草稿保留，接续轮次已完成。</small></div><a class="button tiny" href="${esc(examResumeHash(target))}">查看完成轮次</a></div>`;
  }).join('')}</details>`;
}

export function renderExamLibrary(container, { state, api, refresh, openReport, libraryId = null, showGuide }) {
  let mode = 'practice';
  const libraries = libraryId ? state.libraries.filter(library => library.libraryId === libraryId) : state.libraries;
  if (libraryId && !libraries.length) throw new Error('题库不存在。');
  const sets = libraries.flatMap(library => (library.examSets?.length ? library.examSets : [{ id: library.examPlan?.id || library.id, title: library.title, sections: library.examPlan?.sections || [] }]).map(set => ({ library, set })));
  container.innerHTML = `<div class="exam-library"><header class="exam-library-head"><nav class="exam-library-tabs"><a class="exam-home" href="#dashboard">HOME</a><button data-library-mode="exam">TEST</button><button class="active" data-library-mode="practice">PRACTICE</button></nav><h1>TOEFL TEST</h1><a class="exam-library-brand" href="#dashboard" aria-label="返回工作区">${icon('back')}<span>返回工作区</span></a></header><div class="exam-library-toolbar"><label class="search">${icon('search')}<input type="text" id="exam-library-search" aria-label="Search practice sets" placeholder="搜索套题"></label><div class="button-row"><button class="button tiny" id="exam-timing-settings">计时设置</button>${libraryId ? '<button class="button tiny" id="export-pack">导出题库包</button>' : '<button class="button tiny" id="format-guide">格式指南</button>'}<a class="button tiny" href="#import">添加材料</a></div></div><div class="exam-library-table-wrap"><table class="exam-library-table"><thead><tr><th>No.</th><th>Title</th>${['reading','listening','writing','speaking'].map(section => `<th>${sectionLabels[section]}</th>`).join('')}<th>Report</th></tr></thead><tbody id="exam-set-rows"></tbody></table></div><div class="exam-library-details"><span id="exam-mode-description">按科目进入练习，作答过程中可主动打开学习辅助。</span>${libraryId ? '<details id="exam-task-details"><summary>按任务练习与历史记录</summary><div id="exam-task-list"></div></details>' : ''}</div></div>`;
  const matchingRuns = (library, set, section) => matchingSectionSessions(state.sessions, library, set, section, mode);
  function renderRows() {
    const query = $('#exam-library-search', container).value.trim().toLowerCase();
    const filtered = sets.filter(({library,set}) => `${library.title} ${set.title}`.toLowerCase().includes(query));
    $('#exam-set-rows',container).innerHTML = filtered.length ? filtered.map(({library,set}, index) => {
      const fullTest = mode === 'exam' ? matchingFullTestSessions(state.sessions, library, set)[0] : null;
      const total = set.sections.reduce((sum, section) => sum + section.modules.reduce((count, module) => count + moduleQuestions(module, library).length, 0), 0);
      return `<tr data-library-id="${esc(library.libraryId)}" data-set-id="${esc(set.id)}"><td>${index + 1}</td><td><div>${esc(set.title || library.title)}<small class="exam-set-version"> v${esc(library.version)}</small></div>${mode === 'exam' ? `<div class="button-row"><button class="exam-action primary" data-start-full-test ${fullTest ? `data-session-id="${esc(fullTest.id)}"` : ''}>${library.coverageV1 ? fullTest ? '继续材料范围测试' : '开始材料范围测试' : fullTest ? '继续整套测试' : '开始整套测试'}</button><small class="hint">共 ${total} 题${library.coverageV1 ? ' · 部分材料，完整考试范围未知' : ''}</small></div>` : ''}</td>${['reading','listening','writing','speaking'].map(section => {
      const available = set.sections.find(item => item.section === section);
      if (!available) return '<td>—</td>';
      if (mode === 'exam') return `<td><span data-test-section-count="${section}">${available.modules.reduce((sum, module) => sum + moduleQuestions(module, library).length, 0)} 题</span></td>`;
      const runs = matchingRuns(library,set,section), active = runs.find(run => !run.finished), done = runs.some(run=>run.finished);
      return `<td><button class="exam-section-button ${section} ${active?'progress':done?'done':''}" data-start-section="${section}" data-section-id="${esc(available.id)}" ${active?`data-session-id="${esc(active.id)}"`:''}>${active?'继续练习':done?'已完成':'未开始'}</button></td>`;
    }).join('')}<td><button class="exam-action" data-library-report="${library.libraryId}">Report</button></td></tr>`;
    }).join('') : `<tr><td colspan="7">${libraries.length?'没有符合搜索条件的套题。':'还没有题库。添加自己的材料后，就可以开始练习。'}</td></tr>`;
    $$('[data-start-section]',container).forEach(button=>button.onclick=async()=>{
      if(button.dataset.sessionId){location.hash=examResumeHash(state.sessions.find(session=>session.id===button.dataset.sessionId));return;}
      const row=button.closest('tr'),library=libraries.find(item=>item.libraryId===row.dataset.libraryId);
      button.disabled=true;
      try{const preset=readPreset();const response=await api('/sessions',{sessionVersion:2,libraryId:library.libraryId,setId:row.dataset.setId,sectionId:button.dataset.sectionId,mode,preset});location.hash=examResumeHash(response.session);}catch(error){notify(error.message,true);button.disabled=false;}
    });
    $$('[data-start-full-test]',container).forEach(button=>button.onclick=async()=>{
      button.disabled=true;
      try{
        if(button.dataset.sessionId){const session=state.sessions.find(item=>item.id===button.dataset.sessionId);if(!session)throw new Error('这轮测试已不在当前工作区，请重新打开题库。');location.hash=examResumeHash(session);return;}
        const row=button.closest('tr'),response=await api('/sessions',{sessionVersion:2,libraryId:row.dataset.libraryId,setId:row.dataset.setId,mode:'exam',preset:readPreset()});
        if(button.isConnected)location.hash=examResumeHash(response.session);
      }catch(error){notify(error.message,true);button.disabled=false;}
    });
    $$('[data-library-report]',container).forEach(button=>button.onclick=()=>showLibraryReports(button.dataset.libraryReport));
  }
  function showLibraryReports(id) {
    const attempts=[...state.attempts].filter(attempt=>attempt.libraryId===id).reverse();
    const backdrop=document.createElement('div');backdrop.className='exam-modal-backdrop';
    backdrop.innerHTML=`<div class="exam-modal" role="dialog" aria-modal="true" aria-label="Saved responses"><h2>Saved Responses</h2><p>${attempts.length} 道已保存作答</p><div>${attempts.map(attempt=>`<div class="exam-result-row"><div><strong>${esc(attempt.questionSnapshot?.prompt||attempt.questionId)}</strong><small>${date(attempt.createdAt)}</small></div><button class="exam-action" data-report-id="${attempt.id}">Review</button></div>`).join('')}</div><div class="exam-modal-actions"><button class="exam-action" id="close-library-reports">Close</button></div></div>`;
    document.body.append(backdrop);$('#close-library-reports',backdrop).onclick=()=>backdrop.remove();
    $$('[data-report-id]',backdrop).forEach(button=>button.onclick=()=>{backdrop.remove();openReport(button.dataset.reportId);});
  }
  function readPreset() {
    try{return JSON.parse(sessionStorage.getItem('examTimingPreset')||'"document"');}catch{return 'document';}
  }
  function timingSettings() {
    const fields=[['readingModuleSeconds','Reading · 每模块'],['listeningQuestionSeconds','Listening · 每题'],['sentenceTaskSeconds','Build a Sentence · 整个任务'],['repeatSeconds','Listen and Repeat · 每题回答'],['interviewSeconds','Interview · 每题回答']];
    const preset=readPreset(),custom=preset&&typeof preset==='object';
    const backdrop=document.createElement('div');backdrop.className='exam-modal-backdrop';
    backdrop.innerHTML=`<div class="exam-modal" role="dialog" aria-modal="true" aria-label="计时设置"><h2>计时设置</h2><p>Reading 每模块默认 12:00，Build a Sentence 整个任务默认 6:50。其他题型优先采用材料中的有效时限，缺失时使用练习默认值。</p><label class="field"><span>新一轮使用</span><select id="exam-preset"><option value="document">当前默认时限</option><option value="custom">自定义练习时限</option></select></label><div id="exam-custom-times">${fields.map(([key,label])=>`<label class="field"><span>${label}（秒）</span><input type="number" min="1" max="${key==='interviewSeconds'?45:7200}" data-time-key="${key}" value="${custom?esc(preset[key]??''):''}" placeholder="${key==='repeatSeconds'?'默认按题序 8 / 10 / 12 秒':`默认 ${PRACTICE_TIME_DEFAULTS[key]} 秒`}"></label>`).join('')}</div><p class="hint">跟读默认按任务内题序：第 1–2 题 8 秒，第 3–5 题 10 秒，第 6–7 题 12 秒；自定义跟读秒数适用于每题。邮件默认 7 分钟，讨论默认 10 分钟，面谈每题最多 45 秒，可提前结束。自定义设置只用于之后开始的新一轮。</p><div class="exam-modal-actions"><button class="exam-action" id="cancel-timing">Cancel</button><button class="exam-action primary" id="save-timing">Save</button></div></div>`;
    document.body.append(backdrop);const select=$('#exam-preset',backdrop);select.value=custom?'custom':'document';const update=()=>$('#exam-custom-times',backdrop).hidden=select.value!=='custom';select.onchange=update;update();
    $('#cancel-timing',backdrop).onclick=()=>backdrop.remove();
    $('#save-timing',backdrop).onclick=()=>{
      let value=select.value;
      if(value==='custom'){value={};for(const input of $$('[data-time-key]',backdrop)){if(!input.value)continue;const n=Number(input.value);if(!Number.isInteger(n)||n<1||n>Number(input.max)){notify(input.dataset.timeKey==='interviewSeconds'?'面谈限时必须在 1–45 秒之间。':'请输入 1–7200 之间的整数秒。',true);return;}value[input.dataset.timeKey]=n;}}
      sessionStorage.setItem('examTimingPreset',JSON.stringify(value));backdrop.remove();notify('新练习将使用这份计时设置。');
    };
  }
  $('#exam-library-search',container).oninput=renderRows;
  $$('[data-library-mode]',container).forEach(button=>button.onclick=()=>{mode=button.dataset.libraryMode;$$('[data-library-mode]',container).forEach(item=>item.classList.toggle('active',item===button));$('#exam-mode-description',container).textContent=mode==='practice'?'按科目进入练习，作答过程中可主动打开学习辅助。':'一次开始整套试卷，按顺序完成全部科目；整套结束后再查看答案和反馈。各科题数仅用于查看试卷组成。';renderRows();});
  $('#exam-timing-settings',container).onclick=timingSettings;
  $('#format-guide',container)?.addEventListener('click',showGuide);
  if(libraryId){
    const library=libraries[0];$('#export-pack',container).onclick=()=>download(`/api/library/${libraryId}/export`,`${library.id}-${library.version}.zip`).catch(error=>notify(error.message,true));
    const sessions=state.sessions.filter(session=>session.libraryId===libraryId), resumeGroups=resumableSessionGroups(sessions,[library]);
    $('#exam-task-list',container).innerHTML=resumeGroups.map(group=>renderResumeGroup(group,{showLibrary:false})).join('')+renderCompletedResumeSources(sessions,[library])+`<table><thead><tr><th>Task</th><th>Questions</th><th></th></tr></thead><tbody>${library.groups.map(group=>`<tr><td>${esc(group.title)}</td><td>${group.questions.length}</td><td><a href="#practice/${libraryId}/${group.id}/practice">练习此任务</a></td></tr>`).join('')}</tbody></table>`;

  }
  renderRows();
}
