import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolveTiming, TIME_POLICY_VERSION, PRACTICE_TIME_DEFAULTS, INTERVIEW_HARD_CAP_SECONDS } from '../public/exam-timing.mjs';
import { emptyState } from '../src/store.mjs';
import { canonicalJSON, contentHash, validatePackage } from '../src/package.mjs';
import { createExamSession, patchExamSession, commitExamModule, examSessionView, restoreExamSession, validateExamRunContexts } from '../src/exam-session.mjs';

const START = Date.parse('2026-09-10T12:00:00.000Z');
const timing = (scope = 'question', seconds = null, prepareSeconds = null) => ({ scope, durationSeconds: seconds, prepareSeconds, basis: seconds === null && prepareSeconds === null ? 'unknown' : 'document', source: 'Original synthetic source.' });
const kinds = ['complete_words', 'read_daily', 'read_academic', 'listen_response', 'listen_conversation', 'listen_announcement', 'listen_talk', 'build_sentence', 'write_email', 'academic_discussion', 'listen_repeat', 'interview'];
const stripTimerPolicy = timer => { for (const key of ['policyVersion', 'policyReason', 'hardCapSeconds', 'requestedDurationSeconds', 'recordingStartedAt', 'recordingFinalization']) delete timer[key]; return timer; };

function harness({ seconds = null, scope = 'question', preset = 'document', mode = 'practice', splitModules = false, kind = 'interview' } = {}) {
  const originalQuestions = ['i1', 'i2'].map(id => ({ id, type: kind, prompt: 'Describe an original garden.', ...(kind === 'listen_repeat' ? { answer: 'The garden opens at nine.' } : {}), source: 'Original synthetic source.' }));
  const groups = splitModules ? originalQuestions.map((question, i) => ({ id: `interview-${i + 1}`, section: 'speaking', title: 'Original interview', passage: '', questions: [question] })) : [{ id: 'interview', section: 'speaking', title: 'Original interview', passage: '', questions: originalQuestions }];
  const state = emptyState(), pack = validatePackage({ schemaVersion: 1, id: 'original-timing-policy', version: '1', title: 'Original timing policy fixture', groups }).pack;
  const library = { libraryId: crypto.randomUUID(), importedAt: new Date(START).toISOString(), originalPack: pack, mediaMap: {}, contentHash: contentHash(pack, {}) };
  state.libraries.push(library);
  const task = { id: 'it', kind, groupId: 'interview', questionIds: ['i1', 'i2'], timing: timing(scope, seconds, 0), screen: 'one_question', numberStart: 1, numberEnd: 2, directions: [], inlineBlanks: null, presentation: {} };
  const module = { id: 'im', title: 'Original interview module', sourceNumber: null, timing: timing(scope, seconds, 0), navigation: { back: 'none', review: 'none', lockOnAdvance: true }, instructions: { text: '', audio: null }, tasks: [task] };
  const modules = splitModules ? originalQuestions.map((question, i) => ({ ...structuredClone(module), id: `im${i + 1}`, tasks: [{ ...structuredClone(task), id: `it${i + 1}`, groupId: `interview-${i + 1}`, questionIds: [question.id] }] })) : [module];
  const plan = { version: 1, id: 'original-interview-plan', title: pack.title, sections: [{ id: 'speaking', section: 'speaking', title: 'Speaking', modules }] };
  const h = { state, library, time: START };
  const created = createExamSession({ sessionVersion: 2, libraryId: library.libraryId, mode, preset }, state, { nowMs: h.time, planBuilder: () => structuredClone(plan) });
  Object.defineProperty(h, 'session', { get: () => state.sessions.find(session => session.id === created.id) });
  h.patch = input => patchExamSession({ expectedRevision: h.session.revision, ...input }, state, h.session, { nowMs: h.time });
  h.commit = (input = {}) => commitExamModule({ expectedRevision: h.session.revision, moduleId: h.session.cursor.moduleId, submissionId: crypto.randomUUID(), ...input }, state, h.session, { nowMs: h.time });
  h.view = () => examSessionView(h.session, { nowMs: h.time });
  h.recording = () => { const id = crypto.randomUUID(), mediaId = crypto.createHash('sha256').update(id).digest('hex'); state.blobs[mediaId] = { id: mediaId, mime: 'audio/wav', size: 48 }; state.recordings[id] = { id, mediaId, name: 'original.wav', createdAt: new Date(h.time).toISOString() }; return id; };
  return h;
}

function makeLegacy(h, { consumedMs = 0, running = false, recordingId = null } = {}) {
  const session = h.session;
  delete session.timePolicyVersion; delete session.timePolicyUpgrade;
  session.cursor.phase = 'response'; session.cursor.questionId = 'i1'; session.paused = !running;
  const scope = session.planSnapshot.sections[0].modules[0].tasks[0].timing.scope;
  const ownerId = scope === 'module' ? 'im' : scope === 'task' ? 'it' : 'i1';
  const id = `response:${scope}:${ownerId}`;
  const source = timing(scope, null, 0);
  // This fixture represents the actual pre-policy unlimited clock format.
  session.timers = { [id]: { id, scope, phase: 'response', ownerId, moduleId: 'im', taskId: scope === 'module' ? null : 'it', questionId: ['question', 'none'].includes(scope) ? 'i1' : null, durationSeconds: null, basis: session.preset === 'untimed' ? 'user' : source.basis, source: session.preset === 'untimed' ? '本轮选择不限时练习。' : source.source, consumedMs, startedAt: new Date(START).toISOString(), runningSince: running ? new Date(START + consumedMs).toISOString() : null, deadlineAt: null, expiredAt: null, paused: !running, pausedAt: running ? null : new Date(START + consumedMs).toISOString(), completed: false, completedAt: null } };
  session.activeTimerId = id; session.updatedAt = new Date(START + consumedMs).toISOString();
  if (recordingId) session.answers.i1 = { answer: '', recordingId, recordingUrl: `/api/media/${h.state.recordings[recordingId].mediaId}`, transcript: '', transcriptConfirmed: false, attemptId: null };
}

test('all twelve response task kinds have finite countdowns and source objects remain unchanged', () => {
  for (const kind of kinds) for (const preset of ['document', 'untimed', {}, { readingModuleSeconds: 0, listeningQuestionSeconds: 0, sentenceTaskSeconds: 0, repeatSeconds: 0, interviewSeconds: 0 }]) {
    const task = { kind, timing: timing('none') }, module = { timing: timing('none') }, before = canonicalJSON({ task, module, preset });
    const result = resolveTiming(task, module, preset);
    assert.ok(Number.isInteger(result.durationSeconds) && result.durationSeconds > 0);
    assert.notEqual(result.scope, 'none'); assert.equal(result.policyVersion, TIME_POLICY_VERSION);
    const userStandard = ['complete_words', 'read_daily', 'read_academic', 'build_sentence'].includes(kind);
    assert.equal(result.basis, userStandard ? 'user' : 'preset'); assert.match(result.source, userStandard ? /按用户设置/ : /软件练习默认/);
    assert.equal(canonicalJSON({ task, module, preset }), before);
  }
  assert.equal(PRACTICE_TIME_DEFAULTS.readingModuleSeconds, 720);
  assert.equal(PRACTICE_TIME_DEFAULTS.sentenceTaskSeconds, 410);
  assert.equal(resolveTiming({ kind: 'listen_talk', timing: timing() }).durationSeconds, 30);
  assert.equal(resolveTiming({ kind: 'write_email', timing: timing() }).durationSeconds, 420);
  assert.equal(resolveTiming({ kind: 'academic_discussion', timing: timing() }).durationSeconds, 600);
  assert.equal(resolveTiming({ kind: 'listen_repeat', timing: timing() }).durationSeconds, 12);
});

test('interview hard cap overrides unlimited, zero, long source and long custom settings with a per-question clock', () => {
  for (const seconds of [null, 45, 60, 7200]) for (const preset of ['document', 'untimed', { interviewSeconds: 0 }, { interviewSeconds: 999 }]) {
    const h = harness({ seconds, preset, scope: 'task' });
    const original = canonicalJSON(h.library), sourcePlan = canonicalJSON(h.session.planSnapshot);
    h.patch({ cursor: { phase: 'response' } });
    const timer = h.view().timers[h.session.activeTimerId];
    assert.equal(timer.durationSeconds, INTERVIEW_HARD_CAP_SECONDS); assert.equal(timer.scope, 'question');
    assert.equal(timer.questionId, 'i1'); assert.equal(timer.deadlineAt, new Date(START + 45000).toISOString());
    assert.equal(canonicalJSON(h.library), original); assert.equal(canonicalJSON(h.session.planSnapshot), sourcePlan);
  }
  const short = harness({ seconds: 60, preset: { interviewSeconds: 10 } }); short.patch({ cursor: { phase: 'response' } });
  assert.equal(short.view().timers[short.session.activeTimerId].durationSeconds, 10);
});

test('explicit preparation remains separate and missing preparation does not add a guessed delay', () => {
  const task = { kind: 'interview', timing: timing('question', 90, 0) };
  assert.equal(resolveTiming(task).prepareSeconds, 0);
  assert.equal(resolveTiming(task, {}, 'untimed', { phase: 'prepare' }).durationSeconds, 0);
  assert.equal(resolveTiming({ kind: 'listen_repeat', timing: timing('question', null, 3) }, {}, 'document', { phase: 'prepare' }).durationSeconds, 3);
  assert.equal(resolveTiming({ kind: 'interview', timing: timing() }, {}, 'document', { phase: 'prepare' }).durationSeconds, 0);
});

test('Repeat runs per question and never reuses a declared task or module total as the answer limit', () => {
  for (const scope of ['task', 'module', 'inherit_module', 'none']) {
    const task = { kind: 'listen_repeat', timing: timing(scope, 80, 0) }, module = { timing: timing('module', 120, 0) };
    const before = canonicalJSON({ task, module });
    for (const preset of ['document', 'untimed', { repeatSeconds: 0 }]) {
      const result = resolveTiming(task, module, preset);
      assert.equal(result.scope, 'question'); assert.equal(result.durationSeconds, 12); assert.equal(result.basis, 'preset');
      assert.equal(result.requestedDurationSeconds, ['module', 'inherit_module'].includes(scope) ? 120 : 80);
      assert.equal(result.policyReason, 'source_scope_fallback'); assert.match(result.source, /任务或模块总时长不能作为每题时长/);
    }
    const custom = resolveTiming(task, module, { repeatSeconds: 7 });
    assert.equal(custom.scope, 'question'); assert.equal(custom.durationSeconds, 7); assert.equal(custom.basis, 'user'); assert.equal(custom.policyReason, 'custom'); assert.equal(custom.requestedDurationSeconds, 7);
    assert.equal(canonicalJSON({ task, module }), before);
  }
  const question = resolveTiming({ kind: 'listen_repeat', timing: timing('question', 8, 2) });
  assert.equal(question.scope, 'question'); assert.equal(question.durationSeconds, 8); assert.equal(question.prepareSeconds, 2); assert.equal(question.basis, 'document'); assert.equal(question.policyReason, 'source');
});

test('server expiry rejects late answers and recording restarts while timely stopped uploads may finish', () => {
  const h = harness({ preset: 'untimed' }); h.patch({ cursor: { phase: 'response' } });
  h.time = START + 45000; h.patch({ cursor: { phase: 'saving' } });
  const recordingId = h.recording(); h.time += 5000;
  h.patch({ answers: { i1: { recordingId } }, cursor: { phase: 'recorded' } });
  assert.equal(h.session.answers.i1.recordingId, recordingId);
  assert.throws(() => h.patch({ answers: { i1: { answer: 'A late answer.' } } }), /时间已到/);
  assert.throws(() => h.patch({ cursor: { phase: 'response' } }), /时间已用完/);
  h.patch({ timer: { action: 'pause' } }); h.time += 100000; h.patch({ timer: { action: 'resume' } });
  assert.equal(h.view().timers['response:question:i1'].remainingSeconds, 0);
  assert.equal(h.view().timers['response:question:i1'].running, false);
  assert.equal(h.session.cursor.questionId, 'i1');
});

test('record-again consumes only the same remaining cumulative interview budget', () => {
  const h = harness(); h.patch({ cursor: { phase: 'response' } });
  h.time += 10000; h.patch({ cursor: { phase: 'saving' } });
  h.patch({ answers: { i1: { recordingId: h.recording() } }, cursor: { phase: 'recorded' } });
  h.time += 20000; h.patch({ cursor: { phase: 'response' } });
  const timer = h.view().timers[h.session.activeTimerId];
  assert.equal(timer.remainingSeconds, 35); assert.equal(timer.consumedMs, 10000); assert.equal(h.session.assisted, true);
  assert.equal(Date.parse(timer.deadlineAt), h.time + 35000);
  h.time += 35001;
  assert.equal(h.view().timers[h.session.activeTimerId].remainingSeconds, 0);
  assert.throws(() => h.patch({ cursor: { phase: 'response' } }), /时间已用完/);
});

test('a paused old unlimited session upgrades without resetting its consumed time or source plan', () => {
  const h = harness(); makeLegacy(h, { consumedMs: 30000 }); h.time = START + 120000;
  const source = canonicalJSON(h.library), plan = canonicalJSON(h.session.planSnapshot), oldTimers = canonicalJSON(h.session.timers);
  h.patch({ timer: { action: 'pause' } });
  assert.equal(h.session.timePolicyVersion, TIME_POLICY_VERSION);
  assert.equal(h.view().timers[h.session.activeTimerId].remainingSeconds, 15);
  assert.equal(canonicalJSON(h.session.timePolicyUpgrade.previousTimers), oldTimers);
  assert.equal(h.session.timePolicyUpgrade.changes[0].observedElapsedMs, 30000);
  assert.equal(canonicalJSON(h.library), source); assert.equal(canonicalJSON(h.session.planSnapshot), plan);
  h.time += 500000; h.patch({ timer: { action: 'resume' } });
  assert.equal(h.view().timers[h.session.activeTimerId].remainingSeconds, 15);
  const upgraded = canonicalJSON(h.session.timePolicyUpgrade); h.patch({ timer: { action: 'pause' } });
  assert.equal(canonicalJSON(h.session.timePolicyUpgrade), upgraded, 'The old clock is captured only once');
  assert.doesNotThrow(() => restoreExamSession(h.session, h.state, { snapshotTime: new Date(h.time).toISOString() }));
});

test('a running old null clock carries live elapsed time into its new deadline', () => {
  const h = harness(); makeLegacy(h, { consumedMs: 10000, running: true }); h.time = START + 35000;
  h.patch({ timer: { action: 'resume' } });
  const timer = h.view().timers[h.session.activeTimerId];
  assert.equal(timer.consumedMs, 35000); assert.equal(timer.remainingSeconds, 10);
  assert.equal(timer.deadlineAt, new Date(START + 45000).toISOString());
  assert.equal(h.session.timePolicyUpgrade.changes[0].observedElapsedMs, 35000);
});

test('an already-over-limit legacy interview preserves saved audio, stays on the current question and cannot reopen', () => {
  const h = harness({ preset: 'untimed' }), recordingId = h.recording(); makeLegacy(h, { consumedMs: 70000, recordingId }); h.time = START + 90000;
  const oldAnswer = canonicalJSON(h.session.answers.i1), oldLibrary = canonicalJSON(h.library);
  h.patch({ timer: { action: 'pause' } });
  assert.equal(h.view().timers[h.session.activeTimerId].remainingSeconds, 0);
  assert.equal(h.session.timePolicyUpgrade.previousTimers['response:question:i1'].consumedMs, 70000);
  assert.deepEqual(h.session.timePolicyUpgrade.expiredQuestionIds, ['i1']);
  assert.equal(canonicalJSON(h.session.answers.i1), oldAnswer); assert.equal(canonicalJSON(h.library), oldLibrary);
  h.patch({ timer: { action: 'resume' } });
  assert.equal(h.view().timers[h.session.activeTimerId].running, false); assert.equal(h.session.cursor.questionId, 'i1');
  assert.throws(() => h.patch({ cursor: { phase: 'response' } }), /时间已用完/);
  assert.throws(() => h.patch({ answers: { i1: { recordingId: h.recording() } } }), /时间已到/);
  const result = h.commit({ reason: 'timeout' });
  assert.equal(result.attempts.find(attempt => attempt.questionId === 'i1').recordingId, recordingId);
  validateExamRunContexts(h.state);
  assert.doesNotThrow(() => restoreExamSession(h.session, h.state, { snapshotTime: new Date(h.time).toISOString() }));
});

test('an old shared speaking clock interrupts without inventing a current question budget', () => {
  for (const kind of ['listen_repeat', 'interview']) for (const scope of ['task', 'module']) for (const running of [false, true]) {
    const h = harness({ kind, scope, preset: 'untimed' }), recordingId = h.recording();
    makeLegacy(h, { consumedMs: 20000, running, recordingId }); h.time = START + 30000;
    const timers = canonicalJSON(h.session.timers), answers = canonicalJSON(h.session.answers), original = canonicalJSON(h.library), activity = h.session.lastUserActivityAt;
    h.patch({ timer: { action: 'pause' } });
    assert.equal(h.session.activeTimerId, null); assert.equal(h.session.paused, true); assert.equal(h.session.timePolicyVersion, undefined);
    assert.equal(h.session.timingInterruption.reason, 'shared_speaking_timer'); assert.equal(h.session.timingInterruption.questionId, 'i1');
    assert.equal(canonicalJSON(h.session.timingInterruption.previousTimers), timers); assert.equal(canonicalJSON(h.session.answers), answers);
    assert.equal(canonicalJSON(h.library), original); assert.equal(h.session.lastUserActivityAt, activity);
    assert.equal(h.session.timers['response:question:i1'], undefined); assert.equal(Object.values(h.session.timers).some(timer => timer.runningSince !== null), false);
    const interrupted = canonicalJSON(h.session), snapshot = canonicalJSON(h.session.timingInterruption);
    for (const change of [{ answers: { i1: { answer: 'A replacement.' } } }, { cursor: { phase: 'response' } }, { timer: { action: 'resume' } }, { marked: { i1: true } }]) assert.throws(() => h.patch(change), /新开一轮/);
    assert.throws(() => h.commit(), /新开一轮/); assert.equal(canonicalJSON(h.session), interrupted);
    h.time += 100000; h.patch({ timer: { action: 'pause' } }); assert.equal(canonicalJSON(h.session.timingInterruption), snapshot);
    const restored = restoreExamSession(h.session, h.state, { snapshotTime: new Date(h.time + 100000).toISOString() });
    assert.equal(canonicalJSON(restored), canonicalJSON(h.session));
  }
});

test('interruption backup validation rejects altered evidence or a fabricated per-question clock', () => {
  const h = harness({ kind: 'listen_repeat', scope: 'task', preset: 'untimed' }); makeLegacy(h, { consumedMs: 20000 }); h.time = START + 30000; h.patch({ timer: { action: 'pause' } });
  for (const change of [
    copy => { copy.timingInterruption.previousTimers['response:task:it'].consumedMs += 1; },
    copy => { copy.timingInterruption.questionId = 'i2'; },
    copy => { copy.timingInterruption.previousTimers['response:task:it'].startedAt = null; },
    copy => { copy.activeTimerId = 'response:task:it'; },
    copy => { copy.timers['response:task:it'].consumedMs = 0; },
    copy => { copy.timers['response:question:i1'] = { ...copy.timers['response:task:it'], id: 'response:question:i1', scope: 'question', ownerId: 'i1', questionId: 'i1', consumedMs: 0 }; },
  ]) {
    const altered = structuredClone(h.session); change(altered); assert.throws(() => restoreExamSession(altered, h.state), /计时|时钟|快照/);
  }
});

test('a completed old shared Repeat module retains its clocks, receipt and immutable attempts', () => {
  const h = harness({ kind: 'listen_repeat', scope: 'task', preset: 'untimed' }); h.patch({ cursor: { phase: 'response' } }); h.time += 5000; h.commit();
  const originalClock = h.session.timers['response:question:i1'];
  delete h.session.timePolicyVersion; delete h.session.timePolicyUpgrade; delete h.session.moduleStates.im.submission.timePolicyVersion;
  h.session.timers = { 'response:task:it': { ...stripTimerPolicy(structuredClone(originalClock)), id: 'response:task:it', scope: 'task', ownerId: 'it', taskId: 'it', questionId: null, durationSeconds: null, basis: 'user', source: '本轮选择不限时练习。' } };
  for (const attempt of h.state.attempts) attempt.runContext.timerScope = 'task';
  const before = canonicalJSON(h.session), attempts = canonicalJSON(h.state.attempts);
  const restored = restoreExamSession(h.session, h.state, { snapshotTime: new Date(h.time + 1000000).toISOString() });
  assert.equal(canonicalJSON(restored), before); assert.equal(canonicalJSON(h.state.attempts), attempts); validateExamRunContexts(h.state);
});

test('finished pre-policy sessions and immutable attempts restore without retroactive limits', () => {
  const h = harness(); h.patch({ cursor: { phase: 'response' } }); h.time += 5000; h.commit();
  delete h.session.timePolicyVersion; delete h.session.timePolicyUpgrade;
  delete h.session.lastUserActivityAt;
  delete h.session.moduleStates.im.submission.timePolicyVersion;
  for (const timer of Object.values(h.session.timers)) { stripTimerPolicy(timer); timer.durationSeconds = null; timer.basis = 'document'; timer.source = 'Original synthetic source.'; }
  const before = canonicalJSON(h.session), attempts = canonicalJSON(h.state.attempts);
  const restored = restoreExamSession(h.session, h.state, { snapshotTime: new Date(h.time + 1000000).toISOString() });
  assert.equal(canonicalJSON(restored), before); assert.equal(canonicalJSON(h.state.attempts), attempts);
  assert.equal(restored.timePolicyVersion, undefined); assert.equal(restored.timers['response:question:i1'].durationSeconds, null);
});

test('restore rejects invented hard-cap extensions and altered migration elapsed evidence', () => {
  const h = harness(); makeLegacy(h, { consumedMs: 20000 }); h.time += 25000; h.patch({ timer: { action: 'pause' } });
  for (const mutate of [
    session => { session.timers[session.activeTimerId].durationSeconds = 46; },
    session => { session.timePolicyVersion = TIME_POLICY_VERSION + 1; },
    session => { session.timePolicyUpgrade.changes[0].observedElapsedMs = 0; },
    session => { session.timers[session.activeTimerId].hardCapSeconds = 60; },
  ]) {
    const altered = structuredClone(h.session); mutate(altered);
    assert.throws(() => restoreExamSession(altered, h.state, { snapshotTime: new Date(h.time).toISOString() }));
  }
});

test('a delayed stop request keeps the original stop time and permits only one final recording binding', () => {
  const h = harness(); h.patch({ cursor: { phase: 'response' } });
  h.time = START + 90000;
  h.patch({ cursor: { phase: 'saving' }, capturedAt: new Date(START + 45000).toISOString() });
  const timer = h.session.timers['response:question:i1'];
  assert.equal(timer.consumedMs, 45000); assert.equal(timer.recordingFinalization.stoppedAt, new Date(START + 45000).toISOString());
  assert.equal(timer.recordingFinalization.expiresAt, new Date(START + 165000).toISOString());
  h.time = START + 130000;
  const recordingId = h.recording(); h.patch({ answers: { i1: { recordingId } }, cursor: { phase: 'recorded' } });
  assert.equal(h.session.answers.i1.recordingId, recordingId);
  assert.throws(() => h.patch({ answers: { i1: { recordingId: h.recording() } } }), /已经绑定保存结果/);
  assert.throws(() => h.patch({ cursor: { phase: 'response' } }), /时间已用完/);
  assert.throws(() => h.patch({ answers: { i1: { answer: 'Late changed words.' } } }), /时间已到/);
  assert.doesNotThrow(() => restoreExamSession(h.session, h.state, { snapshotTime: new Date(h.time).toISOString() }));
});

test('an in-progress old take may finalize once after upgrade while its old saved recording remains in the upgrade snapshot', () => {
  const h = harness({ preset: 'untimed' }), oldRecording = h.recording(); makeLegacy(h, { consumedMs: 70000, recordingId: oldRecording }); h.time = START + 90000;
  h.patch({ timer: { action: 'pause' } });
  assert.equal(h.session.answers.i1.recordingId, oldRecording);
  h.patch({ cursor: { phase: 'saving' }, capturedAt: new Date(h.time).toISOString() });
  h.time += 10000;
  const finalized = h.recording(); h.patch({ answers: { i1: { recordingId: finalized } }, cursor: { phase: 'recorded' } });
  assert.equal(h.session.answers.i1.recordingId, finalized);
  assert.equal(h.session.timePolicyUpgrade.previousRecordings.i1.recordingId, oldRecording);
  assert.ok(h.state.recordings[oldRecording]);
  assert.throws(() => h.patch({ answers: { i1: { recordingId: h.recording() } } }), /已经绑定保存结果/);
  assert.equal(h.session.cursor.questionId, 'i1');
  assert.doesNotThrow(() => restoreExamSession(h.session, h.state, { snapshotTime: new Date(h.time).toISOString() }));
});

test('the finalization window cannot be extended by a retry or by changing the stop timestamp', () => {
  const h = harness(); h.patch({ cursor: { phase: 'response' } });
  h.time = START + 10000; h.patch({ cursor: { phase: 'saving' }, capturedAt: new Date(h.time).toISOString() });
  const before = canonicalJSON(h.session.timers['response:question:i1'].recordingFinalization);
  h.time = START + 130001; h.patch({ cursor: { phase: 'saving' }, capturedAt: new Date(h.time).toISOString() });
  assert.equal(canonicalJSON(h.session.timers['response:question:i1'].recordingFinalization), before);
  assert.throws(() => h.patch({ answers: { i1: { recordingId: h.recording() } } }), /保存窗口已经结束/);
});

test('a policy-only upgrade never makes an empty old session look recently practised', () => {
  const h = harness(); delete h.session.timePolicyVersion; delete h.session.timePolicyUpgrade; delete h.session.lastUserActivityAt;
  h.session.updatedAt = new Date(START + 60000).toISOString(); h.time = START + 1000000;
  const oldStart = h.session.startedAt;
  h.patch({ timer: { action: 'pause' } });
  assert.equal(h.session.lastUserActivityAt, oldStart); assert.equal(h.session.updatedAt, new Date(h.time).toISOString());
  h.time += 300000; h.patch({ timer: { action: 'pause' } }); assert.equal(h.session.lastUserActivityAt, oldStart);
  h.patch({ timer: { action: 'resume' } }); assert.equal(h.session.lastUserActivityAt, new Date(h.time).toISOString());
});

test('upgrading the remaining modules preserves an already sealed legacy module clock, receipt and attempt', () => {
  const h = harness({ preset: 'untimed', splitModules: true });
  h.patch({ cursor: { phase: 'response' } }); h.time += 10000; h.commit();
  delete h.session.timePolicyVersion; delete h.session.timePolicyUpgrade; delete h.session.lastUserActivityAt;
  delete h.session.moduleStates.im1.submission.timePolicyVersion;
  const firstTimer = h.session.timers['response:question:i1']; stripTimerPolicy(firstTimer);
  firstTimer.durationSeconds = null; firstTimer.basis = 'user'; firstTimer.source = '本轮选择不限时练习。';
  const clockBefore = canonicalJSON(firstTimer), receiptBefore = canonicalJSON(h.session.moduleStates.im1.submission), attemptBefore = canonicalJSON(h.state.attempts[0]);
  h.time += 10000; h.patch({ timer: { action: 'pause' } });
  assert.equal(canonicalJSON(h.session.timers['response:question:i1']), clockBefore);
  assert.equal(canonicalJSON(h.session.moduleStates.im1.submission), receiptBefore);
  assert.equal(canonicalJSON(h.state.attempts[0]), attemptBefore);
  h.patch({ timer: { action: 'resume' }, cursor: { phase: 'response' } });
  assert.equal(h.view().timers[h.session.activeTimerId].remainingSeconds, 45);
  h.time += 5000; h.commit();
  assert.equal(canonicalJSON(h.session.timers['response:question:i1']), clockBefore);
  assert.equal(canonicalJSON(h.state.attempts[0]), attemptBefore);
  validateExamRunContexts(h.state);
  assert.doesNotThrow(() => restoreExamSession(h.session, h.state, { snapshotTime: new Date(h.time).toISOString() }));
});
