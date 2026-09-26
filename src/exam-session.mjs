import crypto from 'node:crypto';
import { InputError, canonicalJSON, safeRelativeName } from './package.mjs';
import { buildExamPlan } from './exam-plan.mjs';
import { runtimeLibrary, questionSnapshot as legacyQuestionSnapshot, normalizedAnswer, gradeAnswer, newId } from './store.mjs';
import { TIME_POLICY_VERSION, resolveTimingForPolicy } from '../public/exam-timing.mjs';

const PHASES = new Set(['instructions', 'directions', 'stimulus', 'prepare', 'response', 'saving', 'recorded', 'review', 'completed']);
const SECTIONS = new Set(['reading', 'listening', 'writing', 'speaking']);
const KINDS = new Set(['complete_words', 'read_daily', 'read_academic', 'listen_response', 'listen_conversation', 'listen_announcement', 'listen_talk', 'build_sentence', 'write_email', 'academic_discussion', 'listen_repeat', 'interview']);
const SCOPES = new Set(['module', 'task', 'question', 'none']);
const BASES = new Set(['document', 'user', 'preset', 'unknown']);
const PRESET_KEYS = new Set(['readingModuleSeconds', 'listeningQuestionSeconds', 'sentenceTaskSeconds', 'repeatSeconds', 'interviewSeconds']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ELAPSED_MS = 864000 * 1000;
const DEADLINE_GRACE_MS = 1000;
const RECORDING_FINALIZE_MS = 120000;
const TIMER_FIELDS = ['id', 'scope', 'phase', 'ownerId', 'moduleId', 'taskId', 'questionId', 'durationSeconds', 'basis', 'source', 'consumedMs', 'startedAt', 'runningSince', 'deadlineAt', 'expiredAt', 'paused', 'pausedAt', 'completed', 'completedAt'];
const POLICY_TIMER_FIELDS = ['policyVersion', 'policyReason', 'hardCapSeconds', 'requestedDurationSeconds', 'recordingStartedAt', 'recordingFinalization'];
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, status = 400) => { throw new InputError(message, status); };
const iso = milliseconds => new Date(milliseconds).toISOString();
const digest = value => crypto.createHash('sha256').update(canonicalJSON(value)).digest('hex');
const copy = value => structuredClone(value);

function boundedJSON(value, label, maxBytes = MAX_JSON_BYTES) {
  let count = 0;
  const visit = (item, depth = 0) => {
    if (++count > 200000 || depth > 35) fail(`${label}过大或层级过深。`);
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (typeof item === 'string') { if (item.length > maxBytes) fail(`${label}文字过长。`); return; }
    if (!plain(item) && !Array.isArray(item)) fail(`${label}不是可保存的数据。`);
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label}含有无效字段。`);
      visit(child, depth + 1);
    }
  };
  visit(value);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) fail(`${label}超过保存容量。`);
  return copy(value);
}

function string(value, label, max = 128, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label}格式无效。`);
  return value;
}

function number(value, label, { min = 0, max = 7200, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label}应为 ${min} 至 ${max} 的整数。`);
  return value;
}

function date(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) fail(`${label}日期无效。`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label}应为 true 或 false。`);
  return value;
}

function allowKeys(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}包含不支持的字段。`);
}

function libraryFor(state, libraryId) {
  const library = state.libraries.find(item => item.libraryId === libraryId);
  if (!library) fail('找不到此练习包。', 404);
  return library;
}

export const isExamSession = session => session?.sessionVersion === 2;

// Keep the exact old shape when the source has no transcript extension.
export function snapshotForAttempt(library, questionId) {
  const snapshot = legacyQuestionSnapshot(library, questionId);
  const group = library.originalPack.groups.find(item => item.id === snapshot.groupId);
  if (own(group, 'transcript')) snapshot.groupTranscript = group.transcript;
  return snapshot;
}

function checkedPreset(value = 'document') {
  if (['document', 'untimed'].includes(value)) return value;
  if (!plain(value) || Object.keys(value).some(key => !PRESET_KEYS.has(key))) fail('练习计时预设无效。');
  const result = {};
  for (const [key, seconds] of Object.entries(value)) result[key] = number(seconds, '自定义练习时长');
  return result;
}

function checkedTiming(timing) {
  if (!plain(timing) || !SCOPES.has(timing.scope) || !BASES.has(timing.basis)) fail('练习计划的计时设置无效。');
  number(timing.durationSeconds, '计划时长', { nullable: true });
  number(timing.prepareSeconds, '计划准备时长', { nullable: true });
  string(timing.source, '计时来源', 2000, { empty: true });
}

function planIndex(plan, library) {
  if (!plain(plan) || plan.version !== 1 || !Array.isArray(plan.sections) || !plan.sections.length || plan.sections.length > 100) fail('模块练习计划无效。');
  string(plan.id, '练习计划标识', 300);
  string(plan.title, '练习计划名称', 1000);
  const modules = [], moduleById = new Map(), taskById = new Map(), questionById = new Map(), sectionIds = new Set();
  for (const section of plan.sections) {
    string(section?.id, '科目标识', 300);
    if (sectionIds.has(section.id) || !SECTIONS.has(section.section) || !Array.isArray(section.modules) || !section.modules.length) fail('练习计划的科目结构无效。');
    sectionIds.add(section.id);
    for (const module of section.modules) {
      string(module?.id, '模块标识', 300);
      if (moduleById.has(module.id) || !Array.isArray(module.tasks) || !module.tasks.length || module.tasks.length > 1000) fail('练习计划的模块结构无效。');
      checkedTiming(module.timing);
      if (!plain(module.navigation) || !['module', 'task', 'none'].includes(module.navigation.back) || !['module', 'task', 'none'].includes(module.navigation.review) || typeof module.navigation.lockOnAdvance !== 'boolean') fail('模块导航规则无效。');
      const indexed = { section, module, index: modules.length, tasks: [], questions: [] };
      modules.push(indexed); moduleById.set(module.id, indexed);
      for (const [taskIndex, task] of module.tasks.entries()) {
        string(task?.id, '任务标识', 300);
        if (taskById.has(task.id) || !KINDS.has(task.kind) || !['all_questions', 'one_question'].includes(task.screen) || !Array.isArray(task.questionIds) || !task.questionIds.length) fail('练习计划的任务结构无效。');
        const group = library.originalPack.groups.find(item => item.id === task.groupId);
        if (!group || group.section !== section.section) fail('练习任务引用了不匹配的原题组。');
        checkedTiming(task.timing);
        const indexedTask = { ...indexed, task, taskIndex, group, questions: [] };
        indexed.tasks.push(indexedTask); taskById.set(task.id, indexedTask);
        for (const questionId of task.questionIds) {
          const question = group.questions.find(item => item.id === questionId);
          if (!question || questionById.has(questionId)) fail('练习计划包含不存在或重复的题目。');
          if(library.originalPack.schemaVersion===2&&JSON.stringify(task.sourcePositionsV1?.[questionId])!==JSON.stringify(question.sourcePositionV1))fail('冻结计划的原题位置与不可变题库不一致。');
          const indexedQuestion = { ...indexedTask, question, questionIndex: indexed.questions.length };
          indexed.questions.push(indexedQuestion); indexedTask.questions.push(indexedQuestion); questionById.set(questionId, indexedQuestion);
        }
        if (Array.isArray(task.inlineBlanks)) for (const blank of task.inlineBlanks) {
          if (blank?.questionId && !task.questionIds.includes(blank.questionId)) fail('同屏填空引用了任务外的题目。');
        }
      }
    }
  }
  if (modules.length > 100 || questionById.size > 1000) fail('练习计划包含过多模块或题目。');
  const knownMedia = new Set(Object.values(library.mediaMap));
  const checkMedia = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['audio', 'image'].includes(key) && typeof child === 'string' && child) {
        if (child.startsWith('/api/media/')) {
          const id = child.slice('/api/media/'.length);
          if (!HASH.test(id) || !knownMedia.has(id)) fail('冻结练习计划引用了未声明的媒体。');
        } else if (/^\/(?:api|assets|examples)\//.test(child)) safeRelativeName(child.slice(1));
        else {
          const name = safeRelativeName(child);
          if (!own(library.mediaMap, name)) fail('冻结练习计划引用了未声明的相对媒体。');
        }
      } else if (child && typeof child === 'object') checkMedia(child);
    }
  };
  checkMedia(plan);
  return { modules, moduleById, taskById, questionById };
}

function currentPosition(session, index) {
  const module = index.moduleById.get(session.cursor.moduleId);
  const task = index.taskById.get(session.cursor.taskId);
  if (!module || module.section.id !== session.cursor.sectionId || !task || task.module.id !== module.module.id) fail('练习位置与冻结计划不一致。');
  const questionId = session.cursor.questionId ?? task.task.questionIds[0];
  const question = index.questionById.get(questionId);
  if (!question || question.task.id !== task.task.id) fail('当前题目与练习任务不一致。');
  return { module, task, question };
}

const initialCursor = module => ({ sectionId: module.section.id, moduleId: module.module.id, taskId: module.tasks[0].task.id, questionId: module.questions[0].question.id, phase: 'instructions', phaseIndex: 0 });
const emptyAnswer = question => ({ answer: question.type === 'sentence_order' ? [] : '', recordingId: null, recordingUrl: null, transcript: '', transcriptConfirmed: false, attemptId: null });

function normalizeAnswerEntry(value, question, state, previous = emptyAnswer(question)) {
  if (typeof value === 'string' || Array.isArray(value) || value === null) value = { answer: value };
  allowKeys(value, ['answer', 'recordingId', 'recordingUrl', 'transcript', 'transcriptConfirmed', 'attemptId'], '续做答案');
  if (own(value, 'attemptId') && (value.attemptId || null) !== previous.attemptId) fail('已提交作答关联不能由草稿请求更改。');
  const recordingId = own(value, 'recordingId') ? value.recordingId || null : previous.recordingId;
  if (recordingId !== null) string(recordingId, '录音标识');
  const recording = recordingId ? state.recordings[recordingId] : null;
  if (recordingId && (!recording || !state.blobs[recording.mediaId]?.mime?.startsWith('audio/'))) fail('录音尚未保存成功，未保存此次答案。');
  const transcript = own(value, 'transcript') ? value.transcript : previous.transcript;
  if (typeof transcript !== 'string' || transcript.length > 200000) fail('转写文字过长或格式无效。');
  return {
    answer: own(value, 'answer') ? normalizedAnswer(value.answer) : copy(previous.answer), recordingId,
    recordingUrl: recording ? `/api/media/${recording.mediaId}` : null, transcript,
    transcriptConfirmed: own(value, 'transcriptConfirmed') ? boolean(value.transcriptConfirmed, '转写确认') : previous.transcriptConfirmed,
    attemptId: previous.attemptId,
  };
}

function answerPatch(value, session, index, state) {
  if (value === undefined) return null;
  if (!plain(value)) fail('续做答案应按题目标识保存。');
  boundedJSON(value, '续做答案', 2 * 1024 * 1024);
  const result = {};
  for (const [questionId, raw] of Object.entries(value)) {
    const ref = index.questionById.get(questionId);
    if (!ref) fail('答案引用了本轮练习以外的题目。');
    result[questionId] = normalizeAnswerEntry(raw, ref.question, state, session.answers[questionId] || emptyAnswer(ref.question));
  }
  return result;
}

function applyAnswers(session, patch, index, { nowMs, capturedAt } = {}) {
  for (const [questionId, entry] of Object.entries(patch || {})) {
    const previous = session.answers[questionId] || emptyAnswer(index.questionById.get(questionId).question);
    if (canonicalJSON(previous) === canonicalJSON(entry)) continue;
    const ref = index.questionById.get(questionId), progress = session.moduleStates[ref.module.id];
    if (previous.attemptId || progress.status === 'submitted' || progress.lockedTaskIds.includes(ref.task.id) || progress.lockedQuestionIds.includes(questionId)) fail('这道题已经完成或提交，不能覆盖原有作答。', 409);
    if (ref.module.id !== session.cursor.moduleId) fail('请在当前模块内保存答案。');
    const timer = session.timers[timerDefinition(session, ref).id];
    const finalization = timer?.recordingFinalization;
    if (entry.recordingId !== previous.recordingId && finalization?.questionId === questionId && finalization.recordingId && finalization.recordingId !== entry.recordingId) fail('这次录音已经绑定保存结果，不能用另一份录音覆盖；请在剩余时间内明确开始重录。', 409);
    const overtimePractice = session.mode === 'practice' && ref.section.section !== 'speaking';
    if (!overtimePractice && timer?.startedAt && timer.durationSeconds !== null && elapsedAt(timer, nowMs) >= timer.durationSeconds * 1000) {
      const cutoff = Date.parse(timer.expiredAt || timer.deadlineAt);
      const capture = capturedAt ? Date.parse(capturedAt) : nowMs;
      const buffered = capturedAt && Number.isFinite(cutoff) && capture <= cutoff && capture >= cutoff - DEADLINE_GRACE_MS && capture <= nowMs && nowMs <= cutoff + DEADLINE_GRACE_MS;
      const recordingOnly = ref.section.section === 'speaking' && session.cursor.phase === 'saving' && (session.cursor.questionId ?? ref.task.questionIds[0]) === questionId &&
        entry.recordingId && canonicalJSON(entry.answer) === canonicalJSON(previous.answer) &&
        (entry.transcript === previous.transcript || entry.transcript === '') && (entry.transcriptConfirmed === previous.transcriptConfirmed || entry.transcriptConfirmed === false);
      const stoppedAt = timer.pausedAt ? Date.parse(timer.pausedAt) : NaN;
      const finalizingRecording = recordingOnly && (finalization ?
        finalization.questionId === questionId && nowMs <= Date.parse(finalization.expiresAt) && (!finalization.recordingId || finalization.recordingId === entry.recordingId) :
        Number.isFinite(cutoff) && stoppedAt <= cutoff + DEADLINE_GRACE_MS && nowMs <= stoppedAt + RECORDING_FINALIZE_MS);
      if (!buffered && !finalizingRecording) fail('作答时间已到，已保留截止前保存的答案；可以提交现有草稿。', 409);
    }
    if (entry.recordingId && entry.recordingId !== previous.recordingId && finalization?.questionId === questionId && session.cursor.phase === 'saving') {
      if (nowMs > Date.parse(finalization.expiresAt)) fail('本次录音的保存窗口已经结束；已有录音保留，请另存本地文件。', 409);
      finalization.recordingId = entry.recordingId; finalization.savedAt = iso(nowMs);
    }
    session.answers[questionId] = entry;
  }
}

function customDuration(session, ref) {
  const preset = session.preset;
  if (!plain(preset)) return undefined;
  const key = ref.section.section === 'reading' ? 'readingModuleSeconds' : ref.section.section === 'listening' ? 'listeningQuestionSeconds' : ref.task.kind === 'build_sentence' ? 'sentenceTaskSeconds' : ref.task.kind === 'listen_repeat' ? 'repeatSeconds' : ref.task.kind === 'interview' ? 'interviewSeconds' : null;
  return key && own(preset, key) ? preset[key] : undefined;
}

function legacyTimerDefinition(session, ref, phase = 'response') {
  const preparation = phase === 'prepare';
  const scope = preparation ? 'question' : ref.task.timing.scope;
  const ownerId = scope === 'module' ? ref.module.id : scope === 'task' ? ref.task.id : ref.question.id;
  const timing = scope === 'module' ? ref.module.timing : ref.task.timing;
  let durationSeconds = preparation ? timing.prepareSeconds ?? 0 : timing.durationSeconds;
  let basis = timing.basis, source = timing.source;
  const userDuration = preparation ? undefined : customDuration(session, ref);
  if (userDuration !== undefined) { durationSeconds = userDuration || null; basis = 'user'; source = '本轮开始前设置的练习时长。'; }
  if (session.preset === 'untimed') { durationSeconds = null; basis = 'user'; source = '本轮选择不限时练习。'; }
  if (!preparation && durationSeconds === 0) durationSeconds = null;
  return { id: `${phase}:${scope}:${ownerId}`, scope, phase, ownerId, moduleId: ref.module.id, taskId: scope === 'module' ? null : ref.task.id, questionId: scope === 'question' || scope === 'none' ? ref.question.id : null, durationSeconds, basis, source };
}

function timerDefinition(session, ref, phase = 'response') {
  if (!session.timePolicyVersion) return legacyTimerDefinition(session, ref, phase);
  if (![1, TIME_POLICY_VERSION].includes(session.timePolicyVersion)) fail('当前软件不支持此会话的计时策略版本。');
  const timing = resolveTimingForPolicy(session.timePolicyVersion, ref.task, ref.module, session.preset, { phase, questionId: ref.question.id });
  return definitionFromTiming(ref, phase, timing);
}

function definitionFromTiming(ref, phase, timing) {
  const { scope, durationSeconds, basis, source, policyVersion, policyReason, hardCapSeconds, requestedDurationSeconds } = timing;
  const ownerId = scope === 'module' ? ref.module.id : scope === 'task' ? ref.task.id : ref.question.id;
  return { id: `${phase}:${scope}:${ownerId}`, scope, phase, ownerId, moduleId: ref.module.id, taskId: scope === 'module' ? null : ref.task.id, questionId: scope === 'question' ? ref.question.id : null, durationSeconds, basis, source, policyVersion, policyReason, hardCapSeconds, requestedDurationSeconds };
}

const rawElapsedAt = (timer, at) => Math.min(MAX_ELAPSED_MS, timer.consumedMs + (timer.runningSince === null ? 0 : Math.max(0, at - Date.parse(timer.runningSince))));
function timerIsClosed(timer, session) {
  const progress = session.moduleStates[timer.moduleId];
  return timer.completed || progress?.status === 'submitted' || (timer.questionId && progress?.lockedQuestionIds.includes(timer.questionId)) || (timer.taskId && progress?.lockedTaskIds.includes(timer.taskId));
}

function sharedSpeakingClockConflict(session) {
  if (session.finished) return null;
  const section = session.planSnapshot.sections.find(item => item.id === session.cursor.sectionId);
  const module = section?.modules.find(item => item.id === session.cursor.moduleId);
  const task = module?.tasks.find(item => item.id === session.cursor.taskId);
  if (section?.section !== 'speaking' || !['listen_repeat', 'interview'].includes(task?.kind)) return null;
  const questionId = session.cursor.questionId || task.questionIds[0];
  const independent = session.timers[`response:question:${questionId}`];
  if (independent?.phase === 'response' && independent.scope === 'question' && independent.questionId === questionId && independent.taskId === task.id && independent.moduleId === module.id && independent.startedAt) return null;
  const sharedTimerIds = Object.entries(session.timers).filter(([, timer]) => timer.phase === 'response' && ['task', 'module'].includes(timer.scope) && timer.startedAt && !timerIsClosed(timer, session) && timer.moduleId === module.id && (timer.scope === 'module' || timer.taskId === task.id)).map(([id]) => id);
  return sharedTimerIds.length ? { questionId, taskId: task.id, moduleId: module.id, sharedTimerIds } : null;
}

function interruptSharedSpeakingClock(session, at) {
  if (session.timingInterruption) return session.timingInterruption;
  const conflict = sharedSpeakingClockConflict(session);
  if (!conflict) return null;
  session.timingInterruption = {
    reason: 'shared_speaking_timer',
    message: '旧会话只有共享任务或模块计时，无法可靠确定本题已用回答时间。旧草稿与录音已保留，请新开一轮继续。',
    ...conflict, interruptedAt: iso(at), previousTimers: copy(session.timers),
    previousActiveTimerId: session.activeTimerId, previousPaused: session.paused,
  };
  for (const timer of Object.values(session.timers)) if (timer.runningSince !== null && !timerIsClosed(timer, session)) stopTimer(timer, at);
  session.paused = true; session.activeTimerId = null;
  return session.timingInterruption;
}

function assertNoTimingInterruption(session) {
  if (session.timingInterruption || sharedSpeakingClockConflict(session)) fail(session.timingInterruption?.message || '旧口语会话无法可靠恢复逐题计时，旧草稿与录音已保留，请新开一轮。', 409);
}

function openRecordingFinalization(timer, session, questionId, at, capturedAt) {
  if (timer.recordingFinalization) return;
  if (!timer.startedAt) fail('本题尚未开始回答，不能保存结束录音。');
  const startedAt = timer.recordingStartedAt || timer.startedAt;
  const requestedStop = capturedAt ? Date.parse(capturedAt) : at;
  if (!Number.isFinite(requestedStop) || requestedStop > at + DEADLINE_GRACE_MS || requestedStop < Date.parse(startedAt) - DEADLINE_GRACE_MS) fail('录音停止时间不属于当前回答阶段。');
  const stoppedAt = Math.min(at, Math.max(Date.parse(startedAt), requestedStop));
  if (at > stoppedAt + RECORDING_FINALIZE_MS) fail('录音停止已超过保存窗口；已有录音保留，请另存本地文件。', 409);
  timer.recordingStartedAt = startedAt;
  timer.recordingFinalization = {
    questionId, startedAt, stoppedAt: iso(stoppedAt), receivedAt: iso(at), expiresAt: iso(stoppedAt + RECORDING_FINALIZE_MS),
    responseDeadlineAt: timer.expiredAt || timer.deadlineAt, initialRecordingId: session.answers[questionId]?.recordingId || null,
    recordingId: null, savedAt: null,
  };
}

/** Upgrade only unfinished execution state. Source plans, old attempts and
 * already closed clocks remain byte-for-byte unchanged by this operation.
 * Prior clock snapshots retain historical overrun time without granting it to
 * the new budget. Called before accepting any draft change or new submission.
 */
function upgradeTimePolicy(session, index, at) {
  if (session.finished || session.timePolicyVersion === TIME_POLICY_VERSION) return;
  const fromVersion = session.timePolicyVersion === undefined ? 0 : session.timePolicyVersion;
  if (![0, 1].includes(fromVersion)) fail('当前软件不支持此会话的计时策略版本。');
  const previousTimers = copy(session.timers), previousActiveTimerId = session.activeTimerId;
  const previousRecordings = Object.fromEntries(Object.entries(session.answers).filter(([, entry]) => entry.recordingId).map(([id, entry]) => [id, copy(entry)]));
  const record = { fromVersion, toVersion: TIME_POLICY_VERSION, appliedAt: iso(at), previousPreset: copy(session.preset), previousTimers, previousRecordings, previousActiveTimerId, previousPaused: session.paused, changes: [], expiredQuestionIds: [] };
  if (session.timePolicyUpgrade) record.previousUpgrade = copy(session.timePolicyUpgrade);
  session.lastUserActivityAt ||= Object.keys(session.answers).length || Object.values(session.visited).some(Boolean) ? session.updatedAt : session.startedAt;
  session.timePolicyVersion = TIME_POLICY_VERSION;
  const current = currentPosition(session, index).question;
  for (const [id, timer] of Object.entries(previousTimers)) {
    if (timerIsClosed(timer, session)) continue;
    const ref = timer.scope === 'module' ? (current.module.id === timer.moduleId ? current : index.moduleById.get(timer.moduleId)?.questions[0]) : timer.scope === 'task' ? (current.task.id === timer.taskId ? current : index.taskById.get(timer.taskId)?.questions[0]) : index.questionById.get(timer.questionId);
    if (!ref) fail('旧计时引用了不存在的任务，不能升级。');
    const definition = timerDefinition(session, ref, timer.phase), observed = rawElapsedAt(timer, at), elapsed = elapsedAt(timer, at), cap = definition.durationSeconds * 1000;
    if (ref.section.section === 'speaking' && timer.phase === 'response' && ['task', 'module'].includes(timer.scope) && timer.startedAt) {
      // An independently timed current question owns its own elapsed time.
      // Preserve the shared clock as history instead of mapping its age to it.
      const independent = session.timers[definition.id];
      if (independent?.scope === 'question' && independent.questionId === ref.question.id && independent.startedAt) {
        stopTimer(session.timers[id], at, true);
        continue;
      }
    }
    const next = { ...copy(timer), ...definition, consumedMs: Math.min(cap, elapsed) };
    const expired = Boolean(timer.startedAt && elapsed >= cap);
    if (expired) {
      const cutoff = timer.runningSince !== null && timer.consumedMs < cap ? Date.parse(timer.runningSince) + cap - timer.consumedMs : Math.min(at, Date.parse(timer.startedAt) + cap);
      next.runningSince = null; next.deadlineAt = null; next.paused = true;
      next.expiredAt = iso(Math.min(at, cutoff)); next.pausedAt = timer.pausedAt || iso(at);
      if (timer.phase === 'response' && definition.scope === 'question' && !record.expiredQuestionIds.includes(ref.question.id)) record.expiredQuestionIds.push(ref.question.id);
    } else if (timer.runningSince !== null) {
      next.runningSince = iso(at); next.deadlineAt = iso(at + cap - elapsed); next.paused = false; next.expiredAt = null;
    } else { next.deadlineAt = null; next.expiredAt = null; }
    if (fromVersion === 0 && ref.section.section === 'speaking' && timer.phase === 'response') {
      next.recordingStartedAt = timer.runningSince || timer.startedAt;
      next.recordingFinalization = null;
      if (session.cursor.phase === 'saving' && session.cursor.questionId === ref.question.id && next.startedAt && timer.pausedAt && at <= Date.parse(timer.pausedAt) + RECORDING_FINALIZE_MS) openRecordingFinalization(next, session, ref.question.id, at, timer.pausedAt);
    }
    if (id !== definition.id && session.timers[definition.id]) fail('旧计时作用域存在冲突，未覆盖已有时钟。');
    delete session.timers[id]; session.timers[definition.id] = next;
    if (previousActiveTimerId === id) session.activeTimerId = definition.id;
    record.changes.push({ previousId: id, currentId: definition.id, observedElapsedMs: observed, appliedElapsedMs: elapsed });
  }
  session.timePolicyUpgrade = record;
}

function elapsedAt(timer, at) {
  const extra = timer.runningSince === null ? 0 : Math.max(0, at - Date.parse(timer.runningSince));
  const cap = timer.durationSeconds === null ? MAX_ELAPSED_MS : timer.durationSeconds * 1000;
  return Math.min(cap, timer.consumedMs + extra);
}

function settleTimer(timer, at) {
  if (timer.durationSeconds !== null && timer.runningSince !== null && elapsedAt(timer, at) >= timer.durationSeconds * 1000) timer.expiredAt ||= timer.deadlineAt;
  timer.consumedMs = elapsedAt(timer, at);
  if (timer.runningSince !== null) timer.runningSince = iso(at);
}

function stopTimer(timer, at, completed = false) {
  const wasRunning = timer.runningSince !== null;
  settleTimer(timer, at);
  timer.runningSince = null; timer.deadlineAt = null; timer.paused = true;
  if (wasRunning) timer.pausedAt = iso(at);
  if (completed) { timer.completed = true; timer.completedAt = iso(at); }
}

function synchronizeTimers(session, index, at) {
  const { question: ref } = currentPosition(session, index);
  let definition = null;
  if (session.cursor.phase === 'prepare' && ref.section.section === 'speaking') definition = timerDefinition(session, ref, 'prepare');
  else {
    const candidate = timerDefinition(session, ref);
    const prior = session.timers[candidate.id];
    if (session.cursor.phase === 'response' || (['module', 'task'].includes(candidate.scope) && prior?.startedAt && !prior.completed)) definition = candidate;
  }
  if (session.finished) definition = null;
  for (const timer of Object.values(session.timers)) {
    if (timer.runningSince !== null) settleTimer(timer, at);
    if (timer.id !== definition?.id && !timer.completed && timer.startedAt) {
      const recordingSave = ref.section.section === 'speaking' && timer.phase === 'response' && timer.questionId === ref.question.id && ['saving', 'recorded'].includes(session.cursor.phase);
      stopTimer(timer, at, !recordingSave);
    }
  }
  session.activeTimerId = definition?.id || null;
  if (definition) {
    let timer = session.timers[definition.id];
    if (!timer) timer = session.timers[definition.id] = { ...definition, consumedMs: 0, startedAt: null, runningSince: null, deadlineAt: null, expiredAt: null, paused: true, pausedAt: null, completed: false, completedAt: null, ...(ref.section.section === 'speaking' && definition.phase === 'response' ? { recordingStartedAt: null, recordingFinalization: null } : {}) };
    if (session.paused || timer.completed) {
      if (timer.runningSince !== null) stopTimer(timer, at);
    } else if (timer.durationSeconds !== null && elapsedAt(timer, at) >= timer.durationSeconds * 1000 && timer.startedAt !== null) {
      timer.expiredAt ||= timer.deadlineAt || iso(at);
      if (timer.runningSince !== null) stopTimer(timer, at);
    } else if (timer.runningSince === null) {
      timer.startedAt ||= iso(at); timer.runningSince = iso(at); timer.paused = false; timer.pausedAt = null;
      if (ref.section.section === 'speaking' && timer.phase === 'response') timer.recordingStartedAt ||= iso(at);
      timer.deadlineAt = timer.durationSeconds === null ? null : iso(at + Math.max(0, timer.durationSeconds * 1000 - timer.consumedMs));
    }
  }
}

function moduleElapsed(session, moduleId, at) {
  return Object.values(session.timers).filter(timer => timer.moduleId === moduleId).reduce((total, timer) => total + elapsedAt(timer, at), 0);
}

function applyCursor(session, value, index, at, capturedAt) {
  if (value === undefined) return;
  allowKeys(value, ['sectionId', 'moduleId', 'taskId', 'questionId', 'phase', 'phaseIndex'], '练习位置');
  const before = currentPosition(session, index);
  const next = { ...session.cursor, ...value };
  if (!own(value, 'phaseIndex') && ['sectionId', 'moduleId', 'taskId', 'questionId', 'phase'].some(key => next[key] !== session.cursor[key])) next.phaseIndex = 0;
  number(next.phaseIndex ?? 0, '播放阶段位置', { max: 1000 });
  if (!['directions', 'stimulus'].includes(next.phase) && (next.phaseIndex ?? 0) !== 0) fail('当前阶段不支持播放序号。');
  if (!PHASES.has(next.phase) || next.phase === 'completed') fail('不能直接设置完成状态，请提交当前模块。');
  if (next.moduleId !== before.module.module.id || next.sectionId !== before.module.section.id) fail('请先提交当前模块，再进入下一模块。', 409);
  if (next.taskId !== session.cursor.taskId && !own(value, 'questionId')) next.questionId = index.taskById.get(next.taskId)?.task.questionIds[0];
  const temporary = { ...session, cursor: next }, after = currentPosition(temporary, index);
  if (['saving', 'recorded'].includes(next.phase) && after.module.section.section !== 'speaking') fail('只有口语录音任务有录音保存阶段。');
  if (next.phase === 'saving' && (!['response', 'saving'].includes(session.cursor.phase) || after.question.question.id !== before.question.question.id)) fail('请先开始并停止本题录音，再保存录音。');
  if (next.phase === 'recorded' && !session.answers[after.question.question.id]?.recordingId) fail('请先保存本次录音，再进入录音完成阶段。');
  if (next.phase === 'response' && session.cursor.phase === 'saving' && after.question.question.id === before.question.question.id) fail('请先完成本次录音保存，再决定是否重录。', 409);
  if (next.phase === 'response' && session.cursor.phase === 'recorded' && after.question.question.id === before.question.question.id) {
    if (session.mode === 'exam') fail('模拟模式不能在同一题重新录音，请新建一轮练习。', 409);
    session.assisted = true;
  }
  if (next.phase === 'directions' && Array.isArray(after.task.task.directions) && after.task.task.directions.length && next.phaseIndex >= after.task.task.directions.length) fail('播放位置超出了本任务的说明范围。');
  if (next.questionId === null && after.task.task.screen !== 'all_questions') fail('当前任务需要明确的题目标识。');
  const progress = session.moduleStates[next.moduleId], navigation = before.module.module.navigation;
  if (progress.lockedTaskIds.includes(next.taskId) || progress.lockedQuestionIds.includes(after.question.question.id)) fail('已经离开的任务不能返回修改。', 409);
  if ((navigation.back === 'none' && after.question.questionIndex < before.question.questionIndex) || (navigation.back === 'task' && after.task.taskIndex < before.task.taskIndex)) fail('当前模块不能返回先前任务。', 409);
  if (next.phase === 'review' && navigation.review === 'none') fail('当前模块没有返回检查步骤。');
  const responseTimer = session.timers[timerDefinition(session, after.question).id];
  if (next.phase === 'response' && after.module.section.section === 'speaking' && responseTimer?.startedAt && responseTimer.durationSeconds !== null && elapsedAt(responseTimer, at) >= responseTimer.durationSeconds * 1000) fail('本题累计回答时间已用完；已有录音保留，请继续下一题。', 409);
  if (after.module.section.section === 'speaking' && responseTimer) {
    if (next.phase === 'response' && (session.cursor.phase === 'recorded' || before.question.question.id !== after.question.question.id)) { responseTimer.recordingStartedAt = iso(at); responseTimer.recordingFinalization = null; }
    if (next.phase === 'saving') openRecordingFinalization(responseTimer, session, after.question.question.id, at, capturedAt);
  }
  if (['listening', 'speaking'].includes(after.module.section.section) && responseTimer?.startedAt && ['instructions', 'directions', 'stimulus', 'prepare'].includes(next.phase)) fail('已经开始作答，不能重新启动听题或准备阶段。', 409);
  if (after.module.section.section === 'writing' && after.task.taskIndex > before.task.taskIndex) {
    for (const task of before.module.tasks.slice(before.task.taskIndex, after.task.taskIndex)) if (!progress.lockedTaskIds.includes(task.task.id)) progress.lockedTaskIds.push(task.task.id);
  } else if (['listening', 'speaking'].includes(after.module.section.section) && navigation.lockOnAdvance && after.question.questionIndex > before.question.questionIndex) {
    for (const question of before.module.questions.slice(before.question.questionIndex, after.question.questionIndex)) if (!progress.lockedQuestionIds.includes(question.question.id)) progress.lockedQuestionIds.push(question.question.id);
  }
  session.cursor = next;
  if (['response', 'review', 'prepare', 'stimulus'].includes(next.phase)) {
    const visited = after.task.task.screen === 'all_questions' ? after.task.task.questionIds : [after.question.question.id];
    for (const id of visited) session.visited[id] = true;
  }
}

function assertSessionSource(session, state) {
  const library = libraryFor(state, session.libraryId);
  if (session.sourceHash !== library.contentHash) fail('练习来源版本不一致，未改变当前草稿。', 409);
  return library;
}

function assertRevision(body, session) {
  number(body.expectedRevision, '草稿版本', { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (body.expectedRevision !== session.revision) fail('这轮练习已有较新的保存，请刷新后继续，旧页面不能覆盖新答案。', 409);
}

export function createExamSession(body, state, { nowMs = Date.now(), planBuilder = buildExamPlan } = {}) {
  allowKeys(body, ['sessionVersion', 'libraryId', 'setId', 'sectionId', 'groupId', 'mode', 'preset', 'legacySessionId'], '新模块练习');
  if (body.sessionVersion !== 2) fail('模块练习版本无效。');
  const library = libraryFor(state, string(body.libraryId, '练习包标识'));
  const legacy = body.legacySessionId ? state.sessions.find(item => item.id === body.legacySessionId && !isExamSession(item)) : null;
  if (body.legacySessionId && (!legacy || legacy.libraryId !== library.libraryId)) fail('找不到可恢复的旧版续做记录。', 404);
  if (legacy) {
    const existing = state.sessions.find(item => isExamSession(item) && item.legacySessionId === legacy.id && !item.finished);
    if (existing) return existing;
  }
  if (state.sessions.length >= 1000) fail('续做记录已达到当前保存容量。');
  const mode = body.mode ?? legacy?.mode ?? 'practice';
  if (!['practice', 'exam'].includes(mode)) fail('练习模式无效。');
  if (legacy && mode !== legacy.mode) fail('恢复旧草稿时不能改变原模式。');
  const selectors = {};
  for (const key of ['setId', 'sectionId', 'groupId']) if (body[key] !== undefined) selectors[key] = string(body[key], '练习范围标识', 300);
  if (legacy) {
    if (selectors.groupId && selectors.groupId !== legacy.groupId) fail('恢复旧草稿时不能更换原题组。');
    selectors.groupId = legacy.groupId;
  }
  const planSnapshot = boundedJSON(planBuilder(runtimeLibrary(library), selectors), '练习计划');
  const index = planIndex(planSnapshot, library), preset = checkedPreset(body.preset);
  const session = {
    sessionVersion: 2, id: newId(), libraryId: library.libraryId, sourceHash: library.contentHash, mode, preset,
    selection: selectors, planSnapshot, cursor: initialCursor(index.modules[0]), answers: {}, visited: {}, marked: {},
    moduleStates: Object.fromEntries(index.modules.map((ref, i) => [ref.module.id, { sectionId: ref.section.id, status: i === 0 ? 'active' : 'pending', lockedTaskIds: [], lockedQuestionIds: [], submission: null }])),
    timers: {}, activeTimerId: null, paused: false, assisted: false, revision: 1, finished: false,
    startedAt: iso(nowMs), updatedAt: iso(nowMs), legacySessionId: legacy?.id || null, priorTimingSnapshot: null,
    timePolicyVersion: TIME_POLICY_VERSION, timePolicyUpgrade: null, lastUserActivityAt: iso(nowMs),
  };
  if (legacy) {
    for (const [questionId, oldValue] of Object.entries(legacy.answers || {})) {
      const ref = index.questionById.get(questionId);
      if (!ref) continue;
      const old = typeof oldValue === 'string' || Array.isArray(oldValue) ? { answer: oldValue } : oldValue;
      const saved = old.attemptId ? state.attempts.find(attempt => attempt.id === old.attemptId) : old.submissionId ? state.attempts.find(attempt => attempt.submissionId === old.submissionId) : null;
      if (saved && (saved.libraryId !== library.libraryId || saved.questionId !== questionId || saved.sourceHash !== library.contentHash)) fail('旧续做中的作答关联不一致。');
      const source = saved || old;
      session.answers[questionId] = normalizeAnswerEntry({ answer: source.answer, recordingId: source.recordingId || null, transcript: source.transcript || '', transcriptConfirmed: source.transcriptConfirmed === true }, ref.question, state);
      if (saved) session.answers[questionId].attemptId = saved.id;
    }
    const oldGroup = library.originalPack.groups.find(group => group.id === legacy.groupId);
    const oldQuestion = oldGroup?.questions[legacy.currentIndex || 0], position = index.questionById.get(oldQuestion?.id);
    if (position) {
      for (const progress of Object.values(session.moduleStates)) progress.status = 'pending';
      session.moduleStates[position.module.id].status = 'active';
      session.cursor = { sectionId: position.section.id, moduleId: position.module.id, taskId: position.task.id, questionId: position.question.id, phase: 'instructions', phaseIndex: 0 };
    }
    session.assisted = legacy.assisted === true;
    session.priorTimingSnapshot = { scope: 'question', questionId: oldQuestion?.id || null, remainingSeconds: legacy.remainingSeconds, startedAt: legacy.startedAt };
  }
  state.sessions.push(session);
  return session;
}

export function patchExamSession(body, state, previous, { nowMs = Date.now() } = {}) {
  allowKeys(body, ['expectedRevision', 'answers', 'cursor', 'marked', 'visited', 'timer', 'assisted', 'capturedAt'], '模块草稿更新');
  assertRevision(body, previous);
  if (previous.finished) fail('这轮练习已经结束，不能覆盖已提交答案。', 409);
  const library = assertSessionSource(previous, state), session = copy(previous), index = planIndex(session.planSnapshot, library);
  if (session.timingInterruption || sharedSpeakingClockConflict(session)) {
    const pauseOnly = Object.keys(body).every(key => ['expectedRevision', 'timer'].includes(key)) && plain(body.timer) && Object.keys(body.timer).length === 1 && body.timer.action === 'pause';
    if (!pauseOnly) assertNoTimingInterruption(session);
    interruptSharedSpeakingClock(session, nowMs);
    session.lastUserActivityAt ||= previous.lastUserActivityAt || previous.updatedAt;
    session.updatedAt = iso(nowMs); session.revision += 1;
    boundedJSON(session, '模块续做记录');
    state.sessions[state.sessions.findIndex(item => item.id === session.id)] = session;
    return session;
  }
  upgradeTimePolicy(session, index, nowMs);
  const patch = answerPatch(body.answers, session, index, state);
  if (body.capturedAt !== undefined) date(body.capturedAt, '输入捕获时间');
  applyAnswers(session, patch, index, { nowMs, capturedAt: body.capturedAt });
  if (body.assisted !== undefined) session.assisted = boolean(body.assisted, '辅助标记') || session.assisted;
  for (const field of ['marked', 'visited']) if (body[field] !== undefined) {
    if (!plain(body[field]) || Object.keys(body[field]).length > 1000) fail('题目检查标记无效。');
    for (const [questionId, value] of Object.entries(body[field])) {
      if (!index.questionById.has(questionId)) fail('检查标记引用了本轮以外的题目。');
      boolean(value, '题目检查标记');
      if (field === 'visited') session.visited[questionId] ||= value;
      else session.marked[questionId] = value;
    }
  }
  applyCursor(session, body.cursor, index, nowMs, body.capturedAt);
  if (body.timer !== undefined) {
    allowKeys(body.timer, ['action'], '计时操作');
    if (!['pause', 'resume'].includes(body.timer.action)) fail('计时只接受暂停或继续，不能改写剩余时间。');
    session.paused = body.timer.action === 'pause';
  }
  synchronizeTimers(session, index, nowMs);
  session.lastUserActivityAt ||= previous.lastUserActivityAt || previous.updatedAt;
  if (canonicalJSON(session.answers) !== canonicalJSON(previous.answers) || canonicalJSON(session.cursor) !== canonicalJSON(previous.cursor) || canonicalJSON(session.marked) !== canonicalJSON(previous.marked) || session.assisted !== previous.assisted || body.timer?.action === 'resume') session.lastUserActivityAt = iso(nowMs);
  session.updatedAt = iso(nowMs); session.revision += 1;
  boundedJSON(session, '模块续做记录');
  state.sessions[state.sessions.findIndex(item => item.id === session.id)] = session;
  return session;
}

function commitRequest(body, session, ref, patch) {
  const questionIds = new Set(ref.questions.map(item => item.question.id));
  return {
    sessionId: session.id, sectionId: ref.section.id, moduleId: ref.module.id,
    reason: body.reason ?? 'manual',
    answers: patch === null ? null : Object.fromEntries(Object.entries(patch).filter(([id]) => questionIds.has(id)).map(([id, entry]) => [id, { answer: entry.answer, recordingId: entry.recordingId, transcript: entry.transcript, transcriptConfirmed: entry.transcriptConfirmed }])),
  };
}

export function commitExamModule(body, state, previous, { nowMs = Date.now() } = {}) {
  allowKeys(body, ['submissionId', 'expectedRevision', 'answers', 'reason', 'sectionId', 'moduleId', 'capturedAt'], '模块提交');
  const submissionId = string(body.submissionId, '模块提交标识');
  const requestedModuleId = string(body.moduleId, '提交模块标识', 300);
  if (!/^[A-Za-z0-9_.:-]+$/.test(submissionId) || !['manual', 'timeout'].includes(body.reason ?? 'manual')) fail('模块提交标识或提交原因无效。');
  number(body.expectedRevision, '草稿版本', { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (body.capturedAt !== undefined) date(body.capturedAt, '输入捕获时间');
  const library = assertSessionSource(previous, state), index = planIndex(previous.planSnapshot, library);
  assertNoTimingInterruption(previous);
  const requestedModule = index.moduleById.get(requestedModuleId);
  if (!requestedModule || (body.sectionId !== undefined && body.sectionId !== requestedModule.section.id)) fail('提交目标不在本轮练习中。');
  const patch = answerPatch(body.answers, previous, index, state);
  let replay;
  for (const session of state.sessions.filter(isExamSession)) for (const [moduleId, progress] of Object.entries(session.moduleStates)) {
    if (progress.submission?.submissionId === submissionId) replay = { session, moduleId, submission: progress.submission };
  }
  if (replay) {
    if (replay.session.id !== previous.id) fail('相同模块提交标识已经用于另一轮练习。', 409);
    const ref = index.moduleById.get(replay.moduleId);
    if ((body.moduleId !== undefined && body.moduleId !== ref.module.id) || (body.sectionId !== undefined && body.sectionId !== ref.section.id)) fail('相同提交标识已经用于另一个模块。', 409);
    if (digest(commitRequest(body, previous, ref, patch)) !== replay.submission.submissionHash) fail('相同提交标识已用于不同答案，未重复创建作答。', 409);
    return { session: previous, attempts: replay.submission.attemptIds.map(id => state.attempts.find(attempt => attempt.id === id)), finished: previous.finished, replayed: true };
  }
  const sealed = previous.moduleStates[requestedModuleId].submission;
  if (sealed) {
    if (digest(commitRequest(body, previous, requestedModule, patch)) !== sealed.submissionHash) fail('该模块已经封存，新的提交不能覆盖其答案。', 409);
    return { session: previous, attempts: sealed.attemptIds.map(id => state.attempts.find(attempt => attempt.id === id)), finished: previous.finished, replayed: true };
  }
  assertRevision(body, previous);
  if (previous.finished) fail('这轮练习已经结束。', 409);
  const session = copy(previous);
  upgradeTimePolicy(session, index, nowMs);
  const ref = currentPosition(session, index).module;
  if ((body.moduleId !== undefined && body.moduleId !== ref.module.id) || (body.sectionId !== undefined && body.sectionId !== ref.section.id)) fail('提交目标不是当前模块。', 409);
  applyAnswers(session, patch, index, { nowMs, capturedAt: body.capturedAt });
  const request = commitRequest(body, session, ref, patch), prepared = [];
  // Validate the whole batch, including recording references, before appending
  // any attempt. Unanswered and partially ordered answers remain valid records.
  for (const questionRef of ref.questions) {
    const questionId = questionRef.question.id;
    const entry = normalizeAnswerEntry(session.answers[questionId] || {}, questionRef.question, state, session.answers[questionId] || emptyAnswer(questionRef.question));
    const snapshot = snapshotForAttempt(library, questionId);
    if (entry.attemptId) {
      const saved = state.attempts.find(attempt => attempt.id === entry.attemptId);
      if (!saved || saved.libraryId !== session.libraryId || saved.questionId !== questionId || saved.sourceHash !== session.sourceHash || canonicalJSON(saved.questionSnapshot) !== canonicalJSON(snapshot)) fail('恢复的历史作答与本题来源不一致。');
      for (const key of ['answer', 'recordingId', 'transcript', 'transcriptConfirmed']) if (canonicalJSON(entry[key]) !== canonicalJSON(saved[key])) fail('不能以新草稿覆盖已经提交的历史作答。', 409);
      prepared.push({ questionId, entry, saved, questionRef });
      continue;
    }
    const submitted = {
      libraryId: session.libraryId, questionId, answer: entry.answer, recordingId: entry.recordingId,
      transcript: entry.transcript, transcriptConfirmed: entry.transcriptConfirmed, mode: session.mode,
      assisted: session.assisted,
      // Shared paragraph/task clocks are recorded once on the session. Their
      // elapsed time must not be copied onto every atomic question attempt.
      durationSeconds: 0,
      submissionId: `exam:${digest({ sessionId: session.id, moduleId: ref.module.id, submissionId, questionId })}`,
    };
    if (state.attempts.some(attempt => attempt.submissionId === submitted.submissionId)) fail('模块提交状态不一致，未重复保存作答。', 409);
    prepared.push({ questionId, entry, snapshot, submitted, questionRef });
  }
  if (state.attempts.length + prepared.filter(item => !item.saved).length > 50000) fail('作答记录达到当前备份容量，未创建部分模块记录。');
  for (const timer of Object.values(session.timers)) if (timer.moduleId === ref.module.id) stopTimer(timer, nowMs, true);
  const attempts = [], reusedAttemptIds = [];
  for (const item of prepared) {
    let attempt = item.saved;
    if (attempt) reusedAttemptIds.push(attempt.id);
    else {
      attempt = {
        ...item.submitted, id: newId(), questionSnapshot: item.snapshot, sourceHash: library.contentHash,
        recordingUrl: item.entry.recordingUrl,
        kind: state.attempts.some(old => old.libraryId === session.libraryId && old.questionId === item.questionId) ? 'retry' : 'first',
        createdAt: iso(nowMs), objective: gradeAnswer(item.snapshot, item.entry.answer), evaluations: [], reviewed: false,
        submissionHash: digest(item.submitted),
        runContext: { sessionId: session.id, sectionId: ref.section.id, moduleId: ref.module.id, taskId: item.questionRef.task.id, batchId: submissionId, timerScope: timerDefinition(session, item.questionRef).scope },
      };
      state.attempts.push(attempt);
    }
    session.answers[item.questionId] = { ...item.entry, attemptId: attempt.id };
    attempts.push(attempt);
  }
  const progress = session.moduleStates[ref.module.id];
  progress.status = 'submitted';
  progress.submission = {
    submissionId, submissionHash: digest(request), request, reason: request.reason,
    questionIds: ref.questions.map(item => item.question.id), attemptIds: attempts.map(item => item.id), reusedAttemptIds,
    createdAt: iso(nowMs), capturedAt: body.capturedAt ?? null, elapsedMs: moduleElapsed(session, ref.module.id, nowMs),
    timePolicyVersion: session.timePolicyVersion,
  };
  const next = index.modules[ref.index + 1];
  session.activeTimerId = null;
  if (next) { session.cursor = initialCursor(next); session.moduleStates[next.module.id].status = 'active'; session.paused = false; }
  else { session.finished = true; session.cursor.phase = 'completed'; session.cursor.phaseIndex = 0; session.paused = true; }
  session.revision += 1; session.updatedAt = iso(nowMs);
  session.lastUserActivityAt = iso(nowMs);
  boundedJSON(session, '模块续做记录');
  state.sessions[state.sessions.findIndex(item => item.id === session.id)] = session;
  return { session, attempts, finished: session.finished, replayed: false };
}

export function examSessionView(session, { nowMs = Date.now(), writerToken } = {}) {
  const result = copy(session);
  if (writerToken) result.writerToken = writerToken;
  result.serverNow = iso(nowMs);
  result.elapsedSeconds = 0;
  for (const timer of Object.values(result.timers)) {
    const elapsed = elapsedAt(timer, nowMs);
    timer.elapsedSeconds = Math.round(elapsed / 1000);
    timer.remainingSeconds = timer.durationSeconds === null ? null : Math.max(0, Math.ceil((timer.durationSeconds * 1000 - elapsed) / 1000));
    timer.running = timer.runningSince !== null;
    timer.expired = timer.remainingSeconds === 0;
    result.elapsedSeconds += elapsed / 1000;
  }
  result.elapsedSeconds = Math.round(result.elapsedSeconds);
  for (const [moduleId, progress] of Object.entries(result.moduleStates)) progress.elapsedSeconds = Math.round(moduleElapsed(session, moduleId, nowMs) / 1000);
  return result;
}

export function pauseExamSession(session, { nowMs = Date.now() } = {}) {
  if (session.finished || (session.paused && !Object.values(session.timers).some(timer => timer.runningSince !== null))) return session;
  const paused = copy(session);
  for (const timer of Object.values(paused.timers)) if (timer.runningSince !== null) stopTimer(timer, nowMs);
  paused.paused = true; paused.revision += 1; paused.updatedAt = iso(nowMs);
  return paused;
}

export function normalizeRunContext(value) {
  allowKeys(value, ['sessionId', 'sectionId', 'moduleId', 'taskId', 'batchId', 'timerScope'], '模块作答关联');
  if (!UUID.test(value.sessionId) || !SCOPES.has(value.timerScope)) fail('模块作答关联无效。');
  return { sessionId: value.sessionId, sectionId: string(value.sectionId, '科目标识', 300), moduleId: string(value.moduleId, '模块标识', 300), taskId: string(value.taskId, '任务标识', 300), batchId: string(value.batchId, '模块提交标识'), timerScope: value.timerScope };
}

function validateFlags(flags, index, label) {
  if (!plain(flags) || Object.keys(flags).length > 1000) fail(`${label}格式无效。`);
  for (const [id, flag] of Object.entries(flags)) if (!index.questionById.has(id) || typeof flag !== 'boolean') fail(`${label}引用了无效题目。`);
}

function timerReference(timer, index) {
  return timer.scope === 'module' ? index.moduleById.get(timer.moduleId)?.questions[0] : timer.scope === 'task' ? index.taskById.get(timer.taskId)?.questions[0] : index.questionById.get(timer.questionId);
}

function validateRecordingFinalization(timer, ref, state, answers) {
  if (timer.recordingStartedAt === undefined && timer.recordingFinalization === undefined) return;
  if (ref.section.section !== 'speaking' || timer.phase !== 'response') fail('只有口语回答时钟可包含录音收尾状态。');
  date(timer.recordingStartedAt, '本次录音开始时间', { nullable: true });
  if (timer.recordingFinalization === null) return;
  const saved = timer.recordingFinalization;
  allowKeys(saved, ['questionId', 'startedAt', 'stoppedAt', 'receivedAt', 'expiresAt', 'responseDeadlineAt', 'initialRecordingId', 'recordingId', 'savedAt'], '录音收尾记录');
  if (!ref.task.questionIds.includes(saved.questionId) || (timer.questionId && timer.questionId !== saved.questionId) || saved.startedAt !== timer.recordingStartedAt) fail('录音收尾引用了错误的题目或录制阶段。');
  for (const key of ['startedAt', 'stoppedAt', 'receivedAt', 'expiresAt']) date(saved[key], key);
  date(saved.responseDeadlineAt, '录音收尾时回答截止时间', { nullable: true }); date(saved.savedAt, '录音保存时间', { nullable: true });
  if (Date.parse(saved.stoppedAt) < Date.parse(saved.startedAt) || Date.parse(saved.receivedAt) < Date.parse(saved.stoppedAt) || Date.parse(saved.expiresAt) !== Date.parse(saved.stoppedAt) + RECORDING_FINALIZE_MS) fail('录音收尾时间关系无效。');
  for (const key of ['initialRecordingId', 'recordingId']) if (saved[key] !== null && (!UUID.test(saved[key]) || !state.recordings[saved[key]])) fail('录音收尾引用了缺失录音。');
  if ((saved.recordingId === null) !== (saved.savedAt === null) || (saved.recordingId && answers[saved.questionId]?.recordingId !== saved.recordingId)) fail('录音收尾结果与当前回答不一致。');
}

function validateTimePolicy(session, index, state) {
  const version = session.timePolicyVersion ?? 0;
  number(version, '计时策略版本', { max: TIME_POLICY_VERSION });
  if (version === 0) { if (session.timePolicyUpgrade !== undefined && session.timePolicyUpgrade !== null) fail('旧计时策略不能包含升级记录。'); return; }
  const validateUpgrade = (upgrade, targetVersion, currentTimers) => {
    if (upgrade === null) return;
    allowKeys(upgrade, ['fromVersion', 'toVersion', 'appliedAt', 'previousPreset', 'previousTimers', 'previousRecordings', 'previousActiveTimerId', 'previousPaused', 'changes', 'expiredQuestionIds', 'previousUpgrade'], '计时策略升级记录');
    number(upgrade.fromVersion, '升级前计时策略版本', { max: targetVersion - 1 });
    if (upgrade.toVersion !== targetVersion) fail('计时策略升级版本不一致。');
    const appliedAt = Date.parse(date(upgrade.appliedAt, '计时策略升级时间'));
    checkedPreset(upgrade.previousPreset);
    if (canonicalJSON(upgrade.previousPreset) !== canonicalJSON(session.preset)) fail('计时策略升级不能改写原先预设。');
    boolean(upgrade.previousPaused, '升级前暂停状态');
    if (!plain(upgrade.previousRecordings) || Object.keys(upgrade.previousRecordings).length > 1000) fail('升级前录音关联快照无效。');
    for (const [id, entry] of Object.entries(upgrade.previousRecordings)) {
      const ref = index.questionById.get(id);
      if (!ref || !entry?.recordingId) fail('升级前录音关联引用无效。');
      const normalized = normalizeAnswerEntry(entry, ref.question, state, { ...emptyAnswer(ref.question), attemptId: entry.attemptId || null });
      if (canonicalJSON(normalized) !== canonicalJSON(entry)) fail('升级前录音关联与保存的媒体不一致。');
    }
    if (!plain(upgrade.previousTimers) || Object.keys(upgrade.previousTimers).length > 2000) fail('升级前计时快照无效。');
    for (const [id, timer] of Object.entries(upgrade.previousTimers)) {
      const timerVersion = timer.policyVersion || 0;
      number(timerVersion, '升级前时钟策略版本', { max: upgrade.fromVersion });
      allowKeys(timer, timerVersion ? [...TIMER_FIELDS, ...POLICY_TIMER_FIELDS] : TIMER_FIELDS, '升级前计时快照');
      const ref = timerReference(timer, index);
      if (!ref || !['response', 'prepare'].includes(timer.phase)) fail('升级前计时引用无效。');
      const definition = timerDefinition({ ...session, timePolicyVersion: timerVersion }, ref, timer.phase);
      if (id !== timer.id || Object.entries(definition).some(([key, value]) => canonicalJSON(timer[key]) !== canonicalJSON(value))) fail('升级前计时与原计划不一致。');
      number(timer.consumedMs, '升级前已用时间', { max: timer.durationSeconds === null ? MAX_ELAPSED_MS : timer.durationSeconds * 1000 });
      for (const key of ['startedAt', 'runningSince', 'deadlineAt', 'expiredAt', 'pausedAt', 'completedAt']) date(timer[key], key, { nullable: true });
      boolean(timer.paused, '升级前计时暂停'); boolean(timer.completed, '升级前计时完成');
      validateRecordingFinalization(timer, ref, state, upgrade.previousRecordings);
    }
    if (upgrade.previousActiveTimerId !== null && !upgrade.previousTimers[upgrade.previousActiveTimerId]) fail('升级前活动计时不存在。');
    if (!Array.isArray(upgrade.changes) || upgrade.changes.length > 2000 || !Array.isArray(upgrade.expiredQuestionIds) || new Set(upgrade.expiredQuestionIds).size !== upgrade.expiredQuestionIds.length || upgrade.expiredQuestionIds.some(id => !index.questionById.has(id))) fail('计时升级的变更或到期题目记录无效。');
    const changed = new Set();
    for (const item of upgrade.changes) {
      allowKeys(item, ['previousId', 'currentId', 'observedElapsedMs', ...(targetVersion >= 2 ? ['appliedElapsedMs'] : [])], '计时升级变更');
      if (changed.has(item.previousId) || !upgrade.previousTimers[item.previousId] || !currentTimers[item.currentId]) fail('计时升级变更引用了缺失或重复的时钟。');
      changed.add(item.previousId);
      number(item.observedElapsedMs, '升级时已用时间', { max: MAX_ELAPSED_MS });
      if (item.observedElapsedMs !== rawElapsedAt(upgrade.previousTimers[item.previousId], appliedAt)) fail('升级时已用时间与原时钟快照不一致。');
      if (targetVersion >= 2) {
        number(item.appliedElapsedMs, '迁移采用的已用时间', { max: MAX_ELAPSED_MS });
        if (item.appliedElapsedMs !== elapsedAt(upgrade.previousTimers[item.previousId], appliedAt)) fail('迁移采用的已用时间超出了原时钟的执行预算。');
      }
    }
    if (upgrade.previousUpgrade !== undefined) {
      if (upgrade.fromVersion === 0 || upgrade.previousUpgrade === null || Date.parse(upgrade.previousUpgrade.appliedAt) > appliedAt) fail('较早的计时升级记录无效。');
      validateUpgrade(upgrade.previousUpgrade, upgrade.fromVersion, upgrade.previousTimers);
    }
  };
  validateUpgrade(session.timePolicyUpgrade, version, session.timers);
}

function validateTimingInterruption(session, state) {
  const interruption = session.timingInterruption;
  if (interruption === undefined) return;
  allowKeys(interruption, ['reason', 'message', 'questionId', 'taskId', 'moduleId', 'sharedTimerIds', 'interruptedAt', 'previousTimers', 'previousActiveTimerId', 'previousPaused'], '口语计时中断记录');
  if (interruption.reason !== 'shared_speaking_timer' || session.finished || !session.paused || session.activeTimerId !== null) fail('口语计时中断状态无效。');
  string(interruption.message, '口语计时说明', 2000);
  const at = Date.parse(date(interruption.interruptedAt, '口语计时中断时间'));
  if (at > Date.parse(session.updatedAt) || at < Date.parse(session.startedAt)) fail('口语计时中断时间无效。');
  boolean(interruption.previousPaused, '中断前暂停状态');
  if (!plain(interruption.previousTimers) || Object.keys(interruption.previousTimers).length > 2000) fail('中断前计时快照无效。');
  if (interruption.previousActiveTimerId !== null && !interruption.previousTimers[interruption.previousActiveTimerId]) fail('中断前活动计时不存在。');
  const before = { ...copy(session), timers: copy(interruption.previousTimers), activeTimerId: interruption.previousActiveTimerId, paused: interruption.previousPaused, updatedAt: interruption.interruptedAt };
  delete before.timingInterruption;
  const conflict = sharedSpeakingClockConflict(before);
  if (!conflict || ['questionId', 'taskId', 'moduleId', 'sharedTimerIds'].some(key => canonicalJSON(conflict[key]) !== canonicalJSON(interruption[key]))) fail('口语计时中断没有对应的共享时钟证据。');
  // Reuse the full historical-clock and recording-reference checks, then compare
  // its ordinary pause projection. The untouched original clocks remain above.
  const pausedBefore = restoreExamSession(before, state, { snapshotTime: interruption.interruptedAt });
  if (canonicalJSON(pausedBefore.timers) !== canonicalJSON(session.timers)) fail('口语计时中断改写了原时钟，或凭空添加了逐题预算。');
}

export function restoreExamSession(raw, state, { snapshotTime } = {}) {
  allowKeys(raw, ['sessionVersion', 'id', 'libraryId', 'sourceHash', 'mode', 'preset', 'selection', 'planSnapshot', 'cursor', 'answers', 'visited', 'marked', 'moduleStates', 'timers', 'activeTimerId', 'paused', 'assisted', 'revision', 'finished', 'startedAt', 'updatedAt', 'legacySessionId', 'priorTimingSnapshot', 'timePolicyVersion', 'timePolicyUpgrade', 'lastUserActivityAt', 'timingInterruption'], '模块续做记录');
  if (!isExamSession(raw) || !UUID.test(raw.id) || !HASH.test(raw.sourceHash) || !['practice', 'exam'].includes(raw.mode)) fail('模块续做记录的版本或标识无效。');
  const session = boundedJSON(raw, '模块续做记录'), library = assertSessionSource(session, state), index = planIndex(session.planSnapshot, library);
  checkedPreset(session.preset);
  allowKeys(session.selection, ['setId', 'sectionId', 'groupId'], '练习范围');
  for (const value of Object.values(session.selection)) string(value, '练习范围标识', 300);
  allowKeys(session.cursor, ['sectionId', 'moduleId', 'taskId', 'questionId', 'phase', 'phaseIndex'], '练习位置');
  number(session.cursor.phaseIndex ?? 0, '播放阶段位置', { max: 1000 });
  if (!['directions', 'stimulus'].includes(session.cursor.phase) && (session.cursor.phaseIndex ?? 0) !== 0) fail('备份的播放阶段位置无效。');
  if (!PHASES.has(session.cursor.phase)) fail('备份中的练习阶段无效。');
  const current = currentPosition(session, index);
  if (session.cursor.questionId === null && current.task.task.screen !== 'all_questions') fail('备份中的当前题目标识无效。');
  for (const key of ['paused', 'assisted', 'finished']) boolean(session[key], key);
  if (session.finished !== (session.cursor.phase === 'completed')) fail('练习完成状态与当前阶段不一致。');
  number(session.revision, '续做版本', { min: 1, max: Number.MAX_SAFE_INTEGER });
  date(session.startedAt, '开始时间'); date(session.updatedAt, '保存时间');
  if (session.lastUserActivityAt !== undefined) date(session.lastUserActivityAt, '最近实际练习时间');
  if (!plain(session.answers)) fail('模块草稿答案无效。');
  for (const [questionId, entry] of Object.entries(session.answers)) {
    const ref = index.questionById.get(questionId);
    if (!ref || !plain(entry)) fail('模块草稿引用了无效题目。');
    if (entry.attemptId !== null && !UUID.test(entry.attemptId)) fail('模块草稿的历史作答关联无效。');
    const base = { ...emptyAnswer(ref.question), attemptId: entry.attemptId };
    const normalized = normalizeAnswerEntry(entry, ref.question, state, base);
    if (canonicalJSON(normalized) !== canonicalJSON(entry)) fail('模块草稿或录音链接未通过校验。');
    if (entry.attemptId) {
      const attempt = state.attempts.find(item => item.id === entry.attemptId);
      if (!attempt || attempt.libraryId !== session.libraryId || attempt.questionId !== questionId || attempt.sourceHash !== session.sourceHash) fail('模块草稿关联了不匹配的历史作答。');
      for (const key of ['answer', 'recordingId', 'transcript', 'transcriptConfirmed']) if (canonicalJSON(entry[key]) !== canonicalJSON(attempt[key])) fail('模块草稿改写了已提交的历史答案。');
    }
  }
  validateFlags(session.visited, index, '访问记录'); validateFlags(session.marked, index, '检查标记');
  if (!plain(session.moduleStates) || canonicalJSON(Object.keys(session.moduleStates).sort()) !== canonicalJSON([...index.moduleById.keys()].sort())) fail('备份中的模块进度不完整。');
  let activeCount = 0;
  for (const ref of index.modules) {
    const progress = session.moduleStates[ref.module.id];
    allowKeys(progress, ['sectionId', 'status', 'lockedTaskIds', 'lockedQuestionIds', 'submission'], '模块进度');
    if (progress.sectionId !== ref.section.id || !['pending', 'active', 'submitted'].includes(progress.status)) fail('模块进度无效。');
    for (const [key, available] of [['lockedTaskIds', ref.tasks.map(item => item.task.id)], ['lockedQuestionIds', ref.questions.map(item => item.question.id)]]) {
      if (!Array.isArray(progress[key]) || new Set(progress[key]).size !== progress[key].length || progress[key].some(id => !available.includes(id))) fail('已完成任务的锁定记录无效。');
    }
    if (progress.status === 'active') { activeCount += 1; if (session.cursor.moduleId !== ref.module.id) fail('当前模块与进度不一致。'); }
    if (progress.status !== 'submitted') { if (progress.submission !== null) fail('未完成模块不能包含提交结果。'); continue; }
    const submitted = progress.submission;
    allowKeys(submitted, ['submissionId', 'submissionHash', 'request', 'reason', 'questionIds', 'attemptIds', 'reusedAttemptIds', 'createdAt', 'capturedAt', 'elapsedMs', 'timePolicyVersion'], '模块提交记录');
    if (submitted.timePolicyVersion !== undefined) {
      number(submitted.timePolicyVersion, '提交时计时策略版本', { max: TIME_POLICY_VERSION });
      if (submitted.timePolicyVersion > (session.timePolicyVersion ?? 0)) fail('提交时计时策略超出当前会话版本。');
    }
    date(submitted.capturedAt, '提交输入捕获时间', { nullable: true });
    string(submitted.submissionId, '模块提交标识'); date(submitted.createdAt, '模块提交时间');
    if (!HASH.test(submitted.submissionHash) || submitted.submissionHash !== digest(submitted.request) || !['manual', 'timeout'].includes(submitted.reason)) fail('模块提交摘要不一致。');
    allowKeys(submitted.request, ['sessionId', 'sectionId', 'moduleId', 'reason', 'answers'], '模块提交请求');
    if (submitted.request.sessionId !== session.id || submitted.request.sectionId !== ref.section.id || submitted.request.moduleId !== ref.module.id || submitted.request.reason !== submitted.reason) fail('模块提交请求关联无效。');
    if (canonicalJSON(submitted.questionIds) !== canonicalJSON(ref.questions.map(item => item.question.id)) || !Array.isArray(submitted.attemptIds) || submitted.attemptIds.length !== submitted.questionIds.length || new Set(submitted.attemptIds).size !== submitted.attemptIds.length || !Array.isArray(submitted.reusedAttemptIds) || new Set(submitted.reusedAttemptIds).size !== submitted.reusedAttemptIds.length || submitted.reusedAttemptIds.some(id => !submitted.attemptIds.includes(id))) fail('模块提交没有完整对应本模块题目。');
    number(submitted.elapsedMs, '模块用时', { max: MAX_ELAPSED_MS * 2000 });
    if (submitted.request.answers !== null) {
      if (!plain(submitted.request.answers)) fail('模块提交答案格式无效。');
      for (const [id, entry] of Object.entries(submitted.request.answers)) {
        allowKeys(entry, ['answer', 'recordingId', 'transcript', 'transcriptConfirmed'], '模块提交答案');
        const saved = session.answers[id];
        if (!saved || !submitted.questionIds.includes(id) || Object.keys(entry).some(key => canonicalJSON(entry[key]) !== canonicalJSON(saved[key]))) fail('模块提交摘要中的答案与保存记录不一致。');
      }
    }
  }
  if (activeCount !== (session.finished ? 0 : 1) || (session.finished && Object.values(session.moduleStates).some(progress => progress.status !== 'submitted'))) fail('模块完成状态不一致。');
  if (!plain(session.timers) || Object.keys(session.timers).length > 2000) fail('计时记录过大或格式无效。');
  validateTimePolicy(session, index, state);
  let runningCount = 0;
  for (const [id, timer] of Object.entries(session.timers)) {
    allowKeys(timer, [...TIMER_FIELDS, ...POLICY_TIMER_FIELDS], '计时记录');
    if (!['response', 'prepare'].includes(timer.phase) || !index.moduleById.has(timer.moduleId)) fail('计时阶段或模块无效。');
    const ref = timerReference(timer, index);
    if (!ref) fail('计时记录引用了未知任务。');
    const timerVersion = timer.policyVersion || 0, sessionVersion = session.timePolicyVersion || 0;
    number(timerVersion, '时钟策略版本', { max: sessionVersion });
    if (timerVersion < sessionVersion && (!timerIsClosed(timer, session) || !session.timePolicyUpgrade?.previousTimers[id])) fail('未完成的时钟缺少当前计时策略。');
    const definition = timerDefinition({ ...session, timePolicyVersion: timerVersion }, ref, timer.phase);
    if (id !== timer.id || Object.entries(definition).some(([key, value]) => canonicalJSON(timer[key]) !== canonicalJSON(value))) fail('计时设置与冻结计划不一致。');
    number(timer.consumedMs, '已用时间', { max: timer.durationSeconds === null ? MAX_ELAPSED_MS : timer.durationSeconds * 1000 });
    for (const key of ['startedAt', 'runningSince', 'deadlineAt', 'expiredAt', 'pausedAt', 'completedAt']) date(timer[key], key, { nullable: true });
    boolean(timer.paused, '计时暂停'); boolean(timer.completed, '计时完成');
    validateRecordingFinalization(timer, ref, state, session.answers);
    if (timer.runningSince !== null) {
      runningCount += 1;
      if (session.paused || timer.paused || timer.completed || timer.startedAt === null || session.activeTimerId !== id) fail('计时运行状态不一致。');
      if (timer.durationSeconds === null ? timer.deadlineAt !== null : timer.deadlineAt === null) fail('计时截止时间无效。');
      if (timer.durationSeconds !== null) {
        const remaining = timer.durationSeconds * 1000 - timer.consumedMs;
        if (remaining > 0 ? Date.parse(timer.deadlineAt) !== Date.parse(timer.runningSince) + remaining : Date.parse(timer.deadlineAt) > Date.parse(timer.runningSince)) fail('计时截止时间与剩余时长不一致。');
      }
    } else if (timer.deadlineAt !== null || !timer.paused) fail('暂停计时记录无效。');
    if (timer.completed !== (timer.completedAt !== null)) fail('计时完成时间不一致。');
    if (session.moduleStates[timer.moduleId].status === 'submitted' && !timer.completed) fail('已提交模块仍有未关闭计时。');
  }
  if (runningCount > 1 || (session.activeTimerId !== null && !session.timers[session.activeTimerId])) fail('活动计时记录不一致。');
  validateTimingInterruption(session, state);
  for (const [moduleId, progress] of Object.entries(session.moduleStates)) if (progress.submission && progress.submission.elapsedMs !== moduleElapsed(session, moduleId, Date.parse(progress.submission.createdAt))) fail('模块用时与计时记录不一致。');
  if (session.legacySessionId !== null && !UUID.test(session.legacySessionId)) fail('旧续做来源标识无效。');
  if (session.legacySessionId) {
    allowKeys(session.priorTimingSnapshot, ['scope', 'questionId', 'remainingSeconds', 'startedAt'], '旧版计时快照');
    if (session.priorTimingSnapshot.scope !== 'question') fail('旧版计时语义无效。');
    number(session.priorTimingSnapshot.remainingSeconds, '旧版剩余时间', { max: 864000 });
    date(session.priorTimingSnapshot.startedAt, '旧版开始时间');
  } else if (session.priorTimingSnapshot !== null) fail('旧版计时快照缺少来源。');
  const exportedAt = snapshotTime ? Date.parse(date(snapshotTime, '备份时间')) : Date.parse(session.updatedAt);
  return pauseExamSession(session, { nowMs: Math.max(Date.parse(session.updatedAt), exportedAt) });
}

export function validateExamRunContexts(state) {
  const seenBatches = new Set();
  for (const session of state.sessions.filter(isExamSession)) {
    if (session.legacySessionId && !state.sessions.some(item => item.id === session.legacySessionId && !isExamSession(item) && item.libraryId === session.libraryId)) fail('恢复的模块练习缺少原旧版续做记录。');
    for (const [moduleId, progress] of Object.entries(session.moduleStates)) {
      const receipt = progress.submission;
      if (!receipt) continue;
      if (seenBatches.has(receipt.submissionId)) fail('备份包含重复模块提交标识。');
      seenBatches.add(receipt.submissionId);
      for (const [position, id] of receipt.attemptIds.entries()) {
        const attempt = state.attempts.find(item => item.id === id), questionId = receipt.questionIds[position];
        if (!attempt || attempt.libraryId !== session.libraryId || attempt.sourceHash !== session.sourceHash || attempt.questionId !== questionId || session.answers[questionId]?.attemptId !== id) fail('模块提交中的作答关联无效。');
        if (!receipt.reusedAttemptIds.includes(id) && (attempt.runContext?.sessionId !== session.id || attempt.runContext?.moduleId !== moduleId || attempt.runContext?.batchId !== receipt.submissionId)) fail('模块作答缺少正确的提交批次关联。');
      }
    }
  }
  for (const attempt of state.attempts) if (attempt.runContext !== undefined) {
    const context = normalizeRunContext(attempt.runContext), session = state.sessions.find(item => item.id === context.sessionId && isExamSession(item));
    if (!session || session.libraryId !== attempt.libraryId || session.sourceHash !== attempt.sourceHash) fail('作答记录引用了缺失或不匹配的模块练习。');
    const index = planIndex(session.planSnapshot, libraryFor(state, session.libraryId)), ref = index.questionById.get(attempt.questionId), receipt = session.moduleStates[context.moduleId]?.submission;
    const expectedScope = ref ? timerDefinition({ ...session, timePolicyVersion: receipt?.timePolicyVersion || 0 }, ref).scope : null;
    if (!ref || ref.task.id !== context.taskId || ref.module.id !== context.moduleId || ref.section.id !== context.sectionId || expectedScope !== context.timerScope || receipt?.submissionId !== context.batchId || !receipt.attemptIds.includes(attempt.id)) fail('作答记录与冻结的模块计划不一致。');
  }
}
