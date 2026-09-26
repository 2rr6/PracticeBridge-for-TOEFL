import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { emptyState } from '../src/store.mjs';
import { canonicalJSON, contentHash, validatePackage } from '../src/package.mjs';
import { buildExamPlan } from '../src/exam-plan.mjs';
import { createExamSession, patchExamSession, commitExamModule, examSessionView, pauseExamSession, restoreExamSession, validateExamRunContexts, snapshotForAttempt } from '../src/exam-session.mjs';
import { TIME_POLICY_VERSION, PRACTICE_TIME_DEFAULTS } from '../public/exam-timing.mjs';

// Original synthetic content and an injected clock. No provider calls or user
// documents are needed to test deadlines, immutable history or atomic batches.
const START = Date.parse('2026-09-10T12:00:00.000Z');
const hash = value => crypto.createHash('sha256').update(canonicalJSON(value)).digest('hex');
const timing = (scope, durationSeconds = null, prepareSeconds = null) => ({ scope, durationSeconds, prepareSeconds, basis: durationSeconds === null ? 'unknown' : 'document', source: 'Original synthetic exercise.' });
const fixture = () => ({
  schemaVersion: 1, id: 'session-original', version: '1', title: 'Original practice', description: '', rights: 'Original synthetic text',
  groups: [
    { id: 'r', section: 'reading', title: 'Ten blanks', passage: 'An original paragraph with ten response positions.', questions: Array.from({ length: 10 }, (_, i) => ({ id: `r${i + 1}`, type: 'fill_blank', prompt: `Original blank ${i + 1}.`, answer: `word${i + 1}`, timeLimitSeconds: 60 })) },
    { id: 'l', section: 'listening', title: 'A conversation', passage: 'Private study transcript.', questions: [1, 2].map(i => ({ id: `l${i}`, type: 'single_choice', prompt: `Original listening question ${i}.`, options: [{ id: 'A', text: 'The first choice.' }, { id: 'B', text: 'The second choice.' }], answer: 'A' })) },
    { id: 'w', section: 'writing', title: 'Build sentences', passage: '', questions: [1, 2].map(i => ({ id: `w${i}`, type: 'sentence_order', prompt: 'Complete the original sentence.', sentenceFrame: 'I ____ ____ .', answerSlots: 2, options: [{ id: 'A', text: 'like' }, { id: 'B', text: 'gardens' }, { id: 'C', text: 'likes' }], answer: ['A', 'B'] })) },
    { id: 'email', section: 'writing', title: 'Write an email', passage: '', questions: [{ id: 'e1', type: 'email', prompt: 'Invite your friend to an original garden event.' }] },
    { id: 's', section: 'speaking', title: 'Repeat sentences', passage: '', questions: [1, 2].map(i => ({ id: `s${i}`, type: 'listen_repeat', prompt: `Repeat original sentence ${i}.`, answer: 'The garden opens today.' })) },
  ],
});

function plan(sections = ['reading', 'listening', 'writing', 'speaking']) {
  const task = (id, kind, groupId, questionIds, clock, screen = 'one_question') => ({ id, kind, groupId, questionIds, timing: clock, screen, numberStart: 1, numberEnd: questionIds.length, directions: [{ id: `${id}-d1`, text: 'First original direction.' }, { id: `${id}-d2`, text: 'Second original direction.' }], inlineBlanks: null, presentation: { passageVisibility: kind.startsWith('listen_') ? 'review' : 'attempt', questionPromptVisibility: 'attempt' } });
  const module = (id, tasks, clock, back = 'module') => ({ id, title: id, sourceNumber: 1, timing: clock, navigation: { back, review: back, lockOnAdvance: true }, instructions: { text: 'Original instructions.', audio: null }, tasks });
  const all = [
    { id: 'reading', section: 'reading', title: 'Reading', modules: [module('rm', [task('rt', 'complete_words', 'r', Array.from({ length: 10 }, (_, i) => `r${i + 1}`), timing('module', 60), 'all_questions')], timing('module', 60))] },
    { id: 'listening', section: 'listening', title: 'Listening', modules: [module('lm', [task('lt', 'listen_conversation', 'l', ['l1', 'l2'], timing('question', 10))], timing('question'), 'none')] },
    { id: 'writing', section: 'writing', title: 'Writing', modules: [module('wm', [task('wt', 'build_sentence', 'w', ['w1', 'w2'], timing('task', 15)), task('et', 'write_email', 'email', ['e1'], timing('task', 20))], timing('none'), 'task')] },
    { id: 'speaking', section: 'speaking', title: 'Speaking', modules: [module('sm', [task('st', 'listen_repeat', 's', ['s1', 's2'], timing('question', 8, 3))], timing('question'), 'none')] },
  ];
  return { version: 1, id: 'original-plan', title: 'Original synthetic plan', sections: all.filter(section => sections.includes(section.section)) };
}

function harness({ sections, preset, mode = 'practice', planBuilder } = {}) {
  const state = emptyState(), pack = validatePackage(fixture()).pack;
  const library = { libraryId: crypto.randomUUID(), importedAt: new Date(START).toISOString(), originalPack: pack, mediaMap: {}, contentHash: contentHash(pack, {}) };
  state.libraries.push(library);
  const context = { state, library, time: START };
  context.create = extras => createExamSession({ sessionVersion: 2, libraryId: library.libraryId, mode, ...(preset === undefined ? {} : { preset }), ...extras }, state, { nowMs: context.time, planBuilder: planBuilder || (() => plan(sections)) });
  const created = context.create();
  Object.defineProperty(context, 'session', { get: () => state.sessions.find(item => item.id === created.id) });
  context.patch = body => patchExamSession({ expectedRevision: context.session.revision, ...body }, state, context.session, { nowMs: context.time });
  context.commit = (body = {}) => commitExamModule({ submissionId: crypto.randomUUID(), expectedRevision: context.session.revision, moduleId: context.session.cursor.moduleId, ...body }, state, context.session, { nowMs: context.time });
  context.view = () => examSessionView(context.session, { nowMs: context.time });
  return context;
}

function addRecording(h) {
  const recordingId = crypto.randomUUID(), mediaId = 'a'.repeat(64);
  h.state.blobs[mediaId] = { id: mediaId, mime: 'audio/wav', size: 48 };
  h.state.recordings[recordingId] = { id: recordingId, mediaId, name: 'original-recording.wav', createdAt: new Date(h.time).toISOString() };
  return recordingId;
}

test('unknown source timing uses a marked software countdown without summing legacy question defaults', () => {
  const h = harness({ planBuilder: pack => buildExamPlan(pack, { groupId: 'r' }) });
  const original = canonicalJSON(h.library);
  h.patch({ cursor: { phase: 'response' } });
  const timer = h.view().timers[h.session.activeTimerId];
  assert.equal(h.session.preset, 'document');
  assert.equal(timer.scope, 'module');
  assert.equal(timer.durationSeconds, PRACTICE_TIME_DEFAULTS.readingModuleSeconds);
  assert.equal(timer.remainingSeconds, PRACTICE_TIME_DEFAULTS.readingModuleSeconds);
  assert.equal(Date.parse(timer.deadlineAt) - START, PRACTICE_TIME_DEFAULTS.readingModuleSeconds * 1000);
  assert.equal(timer.basis, 'user');
  assert.equal(timer.policyReason, 'user_standard');
  assert.equal(h.session.timePolicyVersion, TIME_POLICY_VERSION);
  assert.equal(h.session.planSnapshot.sections[0].modules[0].timing.durationSeconds, null);
  assert.equal(canonicalJSON(h.library), original);
  assert.equal(h.state.attempts.length, 0);
});

test('positive custom durations override sources while a legacy zero no longer removes the countdown', () => {
  const h = harness({ sections: ['reading'], preset: { readingModuleSeconds: 12 } });
  h.patch({ cursor: { phase: 'response' } });
  assert.equal(h.view().timers[h.session.activeTimerId].remainingSeconds, 12);
  assert.equal(h.session.timers[h.session.activeTimerId].basis, 'user');
  assert.equal(h.session.planSnapshot.sections[0].modules[0].timing.durationSeconds, 60);
  const untimed = harness({ sections: ['reading'], preset: { readingModuleSeconds: 0 } });
  untimed.patch({ cursor: { phase: 'response' } });
  assert.equal(untimed.view().timers[untimed.session.activeTimerId].remainingSeconds, PRACTICE_TIME_DEFAULTS.readingModuleSeconds);
  assert.equal(untimed.session.preset.readingModuleSeconds, 0, 'Original preset metadata is retained');
  assert.throws(() => h.create({ preset: { readingModuleSeconds: -1 } }), /练习时长/);
});

test('ten inline answers share one clock and are committed atomically including unanswered blanks', () => {
  const h = harness({ sections: ['reading'] });
  h.patch({ cursor: { phase: 'response' }, answers: { r1: 'word1', r2: 'wrong' } });
  const key = h.session.activeTimerId, deadline = h.session.timers[key].deadlineAt;
  h.time += 5000;
  h.patch({ cursor: { questionId: 'r10' } });
  h.time += 3000;
  h.patch({ cursor: { questionId: 'r1', phase: 'review' }, marked: { r3: true } });
  assert.equal(h.session.activeTimerId, key);
  assert.equal(h.session.timers[key].deadlineAt, deadline);
  assert.equal(h.view().timers[key].remainingSeconds, PRACTICE_TIME_DEFAULTS.readingModuleSeconds - 8);
  assert.deepEqual(h.session.moduleStates.rm.lockedQuestionIds, []);
  assert.equal(Object.keys(h.session.visited).length, 10);
  assert.equal(h.state.attempts.length, 0);
  h.time += 2000;
  const result = h.commit();
  assert.equal(result.attempts.length, 10);
  assert.equal(result.attempts[0].objective.status, 'correct');
  assert.equal(result.attempts[1].objective.status, 'incorrect');
  assert.equal(result.attempts[2].objective.status, 'unanswered');
  assert.equal(result.attempts.reduce((sum, attempt) => sum + attempt.durationSeconds, 0), 0);
  assert.equal(result.session.moduleStates.rm.submission.elapsedMs, 10000);
  assert.equal(h.view().elapsedSeconds, 10);
  assert.equal(result.finished, true);
  validateExamRunContexts(h.state);
});

test('one sealed receipt per module survives retry with the same or a new submission id', () => {
  const h = harness({ sections: ['reading', 'listening'] });
  const request = { submissionId: 'original-batch', expectedRevision: h.session.revision, moduleId: 'rm', answers: { r1: 'word1' } };
  const first = h.commit(request);
  assert.equal(first.session.cursor.moduleId, 'lm');
  assert.equal(first.finished, false);
  const replay = h.commit(request);
  assert.deepEqual(replay.attempts.map(attempt => attempt.id), first.attempts.map(attempt => attempt.id));
  const differentId = h.commit({ ...request, submissionId: 'another-network-retry' });
  assert.equal(differentId.replayed, true);
  assert.equal(h.state.attempts.length, 10);
  assert.throws(() => h.commit({ ...request, answers: { r1: 'changed' } }), /不同答案|覆盖/);
  assert.throws(() => h.commit({ ...request, submissionId: 'third-id', answers: { r1: 'changed' } }), /封存/);
  assert.throws(() => h.commit({ submissionId: 'original-batch', moduleId: 'lm' }), /另一个模块/);
  assert.equal(h.state.attempts.length, 10);
});

test('invalid recording reference rolls back the complete batch before any attempt is created', () => {
  const h = harness({ sections: ['speaking'] });
  const before = canonicalJSON(h.state);
  assert.throws(() => h.commit({ answers: { s1: { transcript: 'Actual original words.' }, s2: { recordingId: crypto.randomUUID() } } }), /录音尚未保存/);
  assert.equal(canonicalJSON(h.state), before);
  const result = h.commit({ reason: 'timeout' });
  assert.equal(result.attempts.length, 2);
  assert.ok(result.attempts.every(attempt => attempt.recordingId === null && attempt.objective.status === 'unscored'));
});

test('partial word ordering never blocks module timeout submission', () => {
  const h = harness({ sections: ['writing'] });
  h.patch({ answers: { w1: ['A'] }, cursor: { phase: 'response' } });
  h.time += 16000;
  const result = h.commit({ reason: 'timeout' });
  assert.equal(result.attempts.length, 3);
  assert.deepEqual(result.attempts[0].answer, ['A']);
  assert.equal(result.attempts[0].objective.status, 'incorrect');
  assert.equal(result.attempts[1].objective.status, 'unanswered');
  assert.equal(result.attempts[2].objective.status, 'unscored');
});

test('listening clocks run only during response and advancing persistently closes earlier questions', () => {
  const h = harness({ sections: ['listening'] });
  h.patch({ cursor: { phase: 'stimulus' } });
  h.time += 5000;
  assert.equal(h.session.activeTimerId, null);
  h.patch({ cursor: { phase: 'response' }, answers: { l1: 'A' } });
  const firstKey = h.session.activeTimerId;
  h.time += 3000;
  h.patch({ cursor: { questionId: 'l2', phase: 'stimulus' } });
  assert.equal(h.session.activeTimerId, null);
  assert.equal(h.session.timers[firstKey].consumedMs, 3000);
  assert.equal(h.session.timers[firstKey].completed, true);
  assert.deepEqual(h.session.moduleStates.lm.lockedQuestionIds, ['l1']);
  assert.throws(() => h.patch({ answers: { l1: 'B' }, capturedAt: new Date(h.time - 1).toISOString() }), /不能覆盖/);
  assert.throws(() => h.patch({ cursor: { questionId: 'l1', phase: 'response' } }), /不能返回/);
  h.time += 4000;
  h.patch({ cursor: { phase: 'response' } });
  assert.notEqual(h.session.activeTimerId, firstKey);
  assert.equal(h.view().timers[h.session.activeTimerId].remainingSeconds, 10);
});

test('writing shares time within a task and prevents later patches from changing a completed task', () => {
  const h = harness({ sections: ['writing'] });
  h.patch({ cursor: { phase: 'response' }, answers: { w1: ['A'] } });
  const key = h.session.activeTimerId, deadline = h.session.timers[key].deadlineAt;
  h.time += 3000;
  h.patch({ cursor: { questionId: 'w2' } });
  h.patch({ cursor: { questionId: 'w1', phase: 'review' } });
  assert.equal(h.session.timers[key].deadlineAt, deadline);
  h.patch({ cursor: { taskId: 'et', questionId: 'e1', phase: 'directions' } });
  assert.deepEqual(h.session.moduleStates.wm.lockedTaskIds, ['wt']);
  assert.equal(h.session.activeTimerId, null);
  assert.throws(() => h.patch({ answers: { w1: ['A', 'B'] } }), /不能覆盖/);
  assert.throws(() => h.patch({ cursor: { taskId: 'wt', questionId: 'w1', phase: 'response' } }), /不能返回/);
  h.patch({ cursor: { phase: 'response' } });
  assert.equal(h.view().timers[h.session.activeTimerId].remainingSeconds, 20);
});

test('speaking preparation and response clocks are separate; saving consumes no response budget', () => {
  const h = harness({ sections: ['speaking'] });
  h.patch({ cursor: { phase: 'prepare' } });
  const preparation = h.session.activeTimerId;
  assert.equal(h.view().timers[preparation].remainingSeconds, 3);
  h.time += 2000;
  h.patch({ cursor: { phase: 'response' } });
  const response = h.session.activeTimerId;
  assert.notEqual(response, preparation);
  assert.equal(h.session.timers[preparation].completed, true);
  assert.equal(h.view().timers[response].remainingSeconds, 8);
  h.time += 4000;
  h.patch({ cursor: { phase: 'saving' } });
  assert.equal(h.session.activeTimerId, null);
  assert.equal(h.session.timers[response].completed, false);
  h.time += 20000;
  h.patch({ answers: { s1: { recordingId: addRecording(h) } }, cursor: { phase: 'recorded' } });
  assert.equal(h.view().timers[response].remainingSeconds, 4);
  assert.equal(h.view().elapsedSeconds, 6);
  h.patch({ cursor: { phase: 'response' } });
  assert.equal(h.session.assisted, true);
  assert.equal(h.view().timers[response].remainingSeconds, 4);
  h.time += 1000;
  h.patch({ cursor: { questionId: 's2', phase: 'prepare' } });
  assert.equal(h.session.timers[response].completed, true);
  assert.equal(h.view().timers[h.session.activeTimerId].remainingSeconds, 3);
});

test('exam mode rejects recording again after the saved take', () => {
  const h = harness({ sections: ['speaking'], mode: 'exam' });
  h.patch({ cursor: { phase: 'response' } });
  h.time += 1000;
  h.patch({ cursor: { phase: 'saving' } });
  h.patch({ answers: { s1: { recordingId: addRecording(h) } }, cursor: { phase: 'recorded' } });
  assert.throws(() => h.patch({ cursor: { phase: 'response' } }), /不能在同一题重新录音/);
});

test('timely stopped recordings may finish saving after deadline but late text changes cannot', () => {
  const h = harness({ sections: ['speaking'] });
  h.patch({ cursor: { phase: 'response' } });
  h.time += 8100;
  h.patch({ cursor: { phase: 'saving' } });
  h.time += 20000;
  assert.throws(() => h.patch({ answers: { s1: { answer: 'Late invented words.' } } }), /作答时间已到/);
  const recordingId = addRecording(h);
  h.patch({ answers: { s1: { recordingId } }, cursor: { phase: 'recorded' } });
  assert.equal(h.session.answers.s1.recordingId, recordingId);
  const result = h.commit({ reason: 'timeout' });
  assert.equal(result.attempts[0].recordingId, recordingId);
});

test('exam deadline enforcement accepts only a bounded pre-deadline input snapshot after expiry', () => {
  const h = harness({ sections: ['reading'], mode: 'exam', preset: { readingModuleSeconds: 10 } });
  h.patch({ cursor: { phase: 'response' }, answers: { r1: 'word1' } });
  h.time += 10200;
  assert.throws(() => h.patch({ answers: { r2: 'word2' } }), /作答时间已到/);
  h.patch({ answers: { r2: 'word2' }, capturedAt: new Date(START + 9900).toISOString() });
  h.time = START + 11100;
  assert.throws(() => h.patch({ answers: { r3: 'word3' }, capturedAt: new Date(START + 9900).toISOString() }), /作答时间已到/);
  const result = h.commit({ reason: 'timeout' });
  assert.equal(result.attempts[1].answer, 'word2');
  assert.equal(result.attempts[2].answer, '');
  assert.equal(result.session.moduleStates.rm.submission.elapsedMs, 10000);
});

test('pause and resume preserve remaining budget and cannot rewrite it', () => {
  const h = harness({ sections: ['reading'] });
  h.patch({ cursor: { phase: 'response' } });
  h.time += 7000;
  h.patch({ timer: { action: 'pause' } });
  const key = h.session.activeTimerId;
  h.time += 100000;
  assert.equal(h.view().timers[key].remainingSeconds, PRACTICE_TIME_DEFAULTS.readingModuleSeconds - 7);
  assert.equal(h.session.timers[key].deadlineAt, null);
  h.patch({ timer: { action: 'resume' } });
  assert.equal(h.view().timers[key].remainingSeconds, PRACTICE_TIME_DEFAULTS.readingModuleSeconds - 7);
  h.time += 2000;
  assert.equal(h.view().timers[key].remainingSeconds, PRACTICE_TIME_DEFAULTS.readingModuleSeconds - 9);
  assert.throws(() => h.patch({ timer: { action: 'resume', remainingSeconds: 999 } }), /不支持的字段/);
});

test('phase position is resumable and resets when moving to a different phase', () => {
  const h = harness({ sections: ['listening'] });
  h.patch({ cursor: { phase: 'directions', phaseIndex: 1 } });
  const saved = restoreExamSession(h.session, h.state, { snapshotTime: new Date(h.time).toISOString() });
  assert.equal(saved.cursor.phaseIndex, 1);
  h.patch({ cursor: { phase: 'stimulus' } });
  assert.equal(h.session.cursor.phaseIndex, 0);
  assert.throws(() => h.patch({ cursor: { phase: 'directions', phaseIndex: 2 } }), /说明范围/);
});

test('stale revisions never replace a newer draft', () => {
  const h = harness({ sections: ['reading'] });
  const stale = h.session.revision;
  h.patch({ answers: { r1: 'word1' } });
  const after = canonicalJSON(h.state);
  assert.throws(() => h.patch({ expectedRevision: stale, answers: { r1: 'changed' } }), /较新的保存/);
  assert.equal(canonicalJSON(h.state), after);
});

test('legacy projection preserves old timer semantics and reuses immutable submitted attempts', () => {
  const h = harness({ sections: ['reading'] });
  h.state.sessions.length = 0;
  const submitted = { libraryId: h.library.libraryId, questionId: 'r1', answer: 'word1', recordingId: null, transcript: '', transcriptConfirmed: false, mode: 'practice', assisted: false, durationSeconds: 17, submissionId: 'old-original-submit' };
  const original = { ...submitted, id: crypto.randomUUID(), sourceHash: h.library.contentHash, questionSnapshot: snapshotForAttempt(h.library, 'r1'), recordingUrl: null, kind: 'first', createdAt: new Date(START - 50000).toISOString(), objective: { status: 'correct', correct: 1, total: 1 }, evaluations: [], reviewed: false, submissionHash: hash(submitted) };
  h.state.attempts.push(original);
  const legacy = { id: crypto.randomUUID(), libraryId: h.library.libraryId, groupId: 'r', mode: 'practice', answers: { r1: { answer: 'word1', attemptId: original.id }, r2: { answer: 'unfinished' } }, currentIndex: 1, startedAt: new Date(START - 50000).toISOString(), remainingSeconds: 11, assisted: false, updatedAt: new Date(START - 10000).toISOString() };
  h.state.sessions.push(legacy);
  const legacyBefore = canonicalJSON(legacy), attemptBefore = canonicalJSON(original);
  const created = createExamSession({ sessionVersion: 2, libraryId: h.library.libraryId, legacySessionId: legacy.id, mode: 'practice' }, h.state, { nowMs: START, planBuilder: () => plan(['reading']) });
  assert.equal(created.cursor.questionId, 'r2');
  assert.equal(created.priorTimingSnapshot.remainingSeconds, 11);
  assert.equal(created.priorTimingSnapshot.scope, 'question');
  assert.equal(created.activeTimerId, null);
  assert.equal(createExamSession({ sessionVersion: 2, libraryId: h.library.libraryId, legacySessionId: legacy.id }, h.state).id, created.id);
  assert.throws(() => patchExamSession({ expectedRevision: created.revision, answers: { r1: 'changed' } }, h.state, created), /不能覆盖/);
  const completed = commitExamModule({ expectedRevision: created.revision, submissionId: 'projection-batch', moduleId: created.cursor.moduleId }, h.state, created, { nowMs: START + 1000 });
  assert.equal(completed.attempts[0].id, original.id);
  assert.equal(h.state.attempts.length, 10);
  assert.equal(canonicalJSON(h.state.attempts[0]), attemptBefore);
  assert.equal(canonicalJSON(h.state.sessions[0]), legacyBefore);
  validateExamRunContexts(h.state);
});

test('restoring a running v2 session pauses at backup time and validates its complete batch history', () => {
  const h = harness({ sections: ['reading', 'listening'] });
  h.patch({ cursor: { phase: 'response' }, answers: { r1: 'word1' } });
  h.time += 4000;
  h.commit();
  h.patch({ cursor: { phase: 'response' } });
  h.time += 3000;
  const restored = restoreExamSession(h.session, h.state, { snapshotTime: new Date(h.time).toISOString() });
  assert.equal(restored.paused, true);
  assert.equal(examSessionView(restored, { nowMs: h.time + 500000 }).timers[restored.activeTimerId].remainingSeconds, 7);
  h.state.sessions[0] = restored;
  validateExamRunContexts(h.state);
  const context = h.state.attempts[0].runContext;
  context.taskId = 'not-the-original-task';
  assert.throws(() => validateExamRunContexts(h.state), /冻结的模块计划/);
});

test('backup validation rejects altered plan references and invented timer extensions', () => {
  const h = harness({ sections: ['reading'] });
  h.patch({ cursor: { phase: 'response' } });
  const badPlan = structuredClone(h.session);
  badPlan.planSnapshot.sections[0].modules[0].tasks[0].questionIds[0] = 'unknown';
  assert.throws(() => restoreExamSession(badPlan, h.state), /不存在|重复/);
  const badClock = structuredClone(h.session);
  badClock.timers[badClock.activeTimerId].deadlineAt = new Date(START + 90000).toISOString();
  assert.throws(() => restoreExamSession(badClock, h.state), /截止时间/);
});

test('shutdown pause retains answers and transcript snapshots are only extended when actually supplied', () => {
  const h = harness({ sections: ['reading'] });
  const before = snapshotForAttempt(h.library, 'r1');
  assert.equal('groupTranscript' in before, false);
  h.patch({ answers: { r1: 'word1' }, cursor: { phase: 'response' } });
  const paused = pauseExamSession(h.session, { nowMs: START + 2500 });
  assert.equal(paused.answers.r1.answer, 'word1');
  assert.equal(paused.paused, true);
  assert.equal(examSessionView(paused, { nowMs: START + 80000 }).timers[paused.activeTimerId].remainingSeconds, PRACTICE_TIME_DEFAULTS.readingModuleSeconds - 2);
  h.library.originalPack.groups[0].transcript = 'An explicitly supplied transcript.';
  assert.equal(snapshotForAttempt(h.library, 'r1').groupTranscript, 'An explicitly supplied transcript.');
});
