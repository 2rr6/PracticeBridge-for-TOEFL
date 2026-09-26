// Shared by the browser and the local server. These are execution settings,
// never edits to a source package's declared timing or content identity.
export const TIME_POLICY_VERSION = 2;
export const INTERVIEW_HARD_CAP_SECONDS = 45;
export const REPEAT_DEFAULT_SECONDS = Object.freeze([8, 8, 10, 10, 10, 12, 12]);
export const PRACTICE_TIME_DEFAULTS = Object.freeze({
  readingModuleSeconds: 720,
  listeningQuestionSeconds: 20,
  listeningTalkQuestionSeconds: 30,
  sentenceTaskSeconds: 410,
  emailTaskSeconds: 420,
  discussionTaskSeconds: 600,
  repeatSeconds: 12,
  interviewSeconds: INTERVIEW_HARD_CAP_SECONDS,
});
const POLICY_1_DEFAULTS = Object.freeze({ ...PRACTICE_TIME_DEFAULTS, readingModuleSeconds: 900, sentenceTaskSeconds: 360 });

const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const positive = value => Number.isInteger(value) && value > 0 && value <= 7200;
const nonnegative = value => Number.isInteger(value) && value >= 0 && value <= 7200;
const reading = new Set(['complete_words', 'read_daily', 'read_academic']);
const listening = new Set(['listen_response', 'listen_conversation', 'listen_announcement', 'listen_talk']);
const spoken = new Set(['listen_repeat', 'interview']);
const responseScope = kind => reading.has(kind) ? 'module' : listening.has(kind) || spoken.has(kind) ? 'question' : 'task';

export function timingPresetKey(task) {
  return reading.has(task.kind) ? 'readingModuleSeconds' : listening.has(task.kind) ? 'listeningQuestionSeconds' : task.kind === 'build_sentence' ? 'sentenceTaskSeconds' : task.kind === 'listen_repeat' ? 'repeatSeconds' : task.kind === 'interview' ? 'interviewSeconds' : null;
}

function defaultTiming(task, questionId, policyVersion) {
  const kind = task.kind, defaults = policyVersion === 1 ? POLICY_1_DEFAULTS : PRACTICE_TIME_DEFAULTS;
  if (reading.has(kind)) return { seconds: defaults.readingModuleSeconds, fixed: false, label: policyVersion === 1 ? '阅读每模块 15 分钟' : '阅读每模块 12 分钟' };
  if (listening.has(kind)) return { seconds: kind === 'listen_talk' ? defaults.listeningTalkQuestionSeconds : defaults.listeningQuestionSeconds, fixed: false, label: kind === 'listen_talk' ? '听力讲座每题 30 秒' : '听力每题 20 秒' };
  if (kind === 'build_sentence') return { seconds: defaults.sentenceTaskSeconds, fixed: false, label: policyVersion === 1 ? '组句任务 6 分钟' : '组句任务 6 分 50 秒' };
  if (kind === 'write_email') return { seconds: defaults.emailTaskSeconds, fixed: true, label: '邮件任务 7 分钟' };
  if (kind === 'academic_discussion') return { seconds: defaults.discussionTaskSeconds, fixed: true, label: '学术讨论任务 10 分钟' };
  if (kind === 'listen_repeat') {
    const original=task.sourcePositionsV1?.[questionId]?.originalOrdinalInTask;
    const index = own(task,'sourcePositionsV1') ? Number.isInteger(original)?original-1:-1 : typeof questionId === 'string' && Array.isArray(task.questionIds) ? task.questionIds.indexOf(questionId) : -1;
    const seconds = policyVersion === 1 || index < 0 ? defaults.repeatSeconds : REPEAT_DEFAULT_SECONDS[index] ?? defaults.repeatSeconds;
    return { seconds, fixed: false, label: policyVersion === 2 && index >= 0 ? `跟读本任务第 ${index + 1} 题 ${seconds} 秒；按任务内题序设置` : '跟读每题 12 秒；不按文字长度推算时限' };
  }
  if (kind === 'interview') return { seconds: defaults.interviewSeconds, fixed: true, label: '面谈每题最多 45 秒，可提前结束' };
  throw new TypeError(`Unsupported timing task kind: ${kind}`);
}

/** Return effective timing without modifying the source task, module or preset.
 * Every response receives a finite budget. Legacy "untimed" and zero-valued
 * presets no longer remove the countdown. Interview is always per question,
 * capped at 45 seconds even when a source or custom setting is longer.
 */
export function resolveTimingForPolicy(policyVersion, task, module = {}, preset = 'document', { phase = 'response', questionId = null } = {}) {
  if (![1, TIME_POLICY_VERSION].includes(policyVersion)) throw new TypeError('Unsupported timing policy version.');
  if (!task || typeof task.kind !== 'string' || !['response', 'prepare'].includes(phase)) throw new TypeError('A task and response/prepare phase are required.');
  const fallback = defaultTiming(task, questionId, policyVersion);
  const declaredScope = task.timing?.scope === 'inherit_module' ? module.timing?.scope : task.timing?.scope;
  const declared = declaredScope === 'module' || task.timing?.scope === 'inherit_module' ? module.timing || {} : task.timing || {};
  const prepareSeconds = nonnegative(declared.prepareSeconds) ? declared.prepareSeconds : 0;
  if (phase === 'prepare') return {
    scope: 'question', durationSeconds: prepareSeconds, prepareSeconds,
    basis: nonnegative(declared.prepareSeconds) ? declared.basis || 'user' : 'preset',
    source: nonnegative(declared.prepareSeconds) ? declared.source || '' : '未另设准备时长，直接进入回答；不增加推测的准备时间。',
    policyVersion, policyReason: 'preparation', hardCapSeconds: null,
    requestedDurationSeconds: nonnegative(declared.prepareSeconds) ? declared.prepareSeconds : null,
  };
  const scope = spoken.has(task.kind) ? 'question' : ['module', 'task', 'question'].includes(declaredScope) ? declaredScope : responseScope(task.kind);
  const repeatNeedsQuestionTiming = task.kind === 'listen_repeat' && declaredScope !== 'question';
  const key = timingPresetKey(task), supplied = key && own(preset, key) ? preset[key] : undefined;
  let durationSeconds, basis, source, policyReason;
  if (positive(supplied)) {
    durationSeconds = supplied; basis = 'user'; source = '本轮开始前设置的练习时长。'; policyReason = 'custom';
  } else if (policyVersion >= 2 && (reading.has(task.kind) || task.kind === 'build_sentence')) {
    durationSeconds = fallback.seconds; basis = 'user'; policyReason = 'user_standard';
    source = `按用户设置，${fallback.label}（${durationSeconds} 秒）。原材料时限保留为来源记录，不改写题包。`;
  } else if (positive(declared.durationSeconds) && !repeatNeedsQuestionTiming) {
    durationSeconds = declared.durationSeconds; basis = declared.basis || 'user'; source = declared.source || ''; policyReason = 'source';
  } else {
    durationSeconds = fallback.seconds; basis = 'preset';
    source = repeatNeedsQuestionTiming ? `PracticeBridge 软件练习默认：${fallback.label}。原材料未提供可信的逐题回答时限；任务或模块总时长不能作为每题时长。` : `PracticeBridge 软件练习默认：${fallback.label}。原材料未提供对应可执行时限。`;
    policyReason = repeatNeedsQuestionTiming ? 'source_scope_fallback' : fallback.fixed ? 'fixed_default' : 'practice_default';
  }
  const requestedDurationSeconds = positive(supplied) ? supplied : positive(declared.durationSeconds) ? declared.durationSeconds : null;
  const hardCapSeconds = task.kind === 'interview' ? INTERVIEW_HARD_CAP_SECONDS : null;
  if (hardCapSeconds !== null && durationSeconds > hardCapSeconds) {
    durationSeconds = hardCapSeconds; basis = 'user'; policyReason = 'hard_cap';
    source = '按用户设定，Interview 每题累计回答最多 45 秒；较长题包或自定义时限不能延长上限。';
  }
  return { scope, durationSeconds, prepareSeconds, basis, source, policyVersion, policyReason, hardCapSeconds, requestedDurationSeconds };
}

export function resolveTiming(task, module = {}, preset = 'document', options = {}) {
  return resolveTimingForPolicy(TIME_POLICY_VERSION, task, module, preset, options);
}
