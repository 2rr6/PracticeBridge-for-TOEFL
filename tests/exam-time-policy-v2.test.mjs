import {appFetch} from './auth-client.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, emptyState } from '../src/store.mjs';
import { canonicalJSON, contentHash, validatePackage } from '../src/package.mjs';
import { createExamSession, patchExamSession, commitExamModule, examSessionView, restoreExamSession, validateExamRunContexts } from '../src/exam-session.mjs';
import { resolveTiming, resolveTimingForPolicy, REPEAT_DEFAULT_SECONDS, TIME_POLICY_VERSION } from '../public/exam-timing.mjs';
import { startServer } from '../src/server.mjs';

const START = Date.parse('2026-09-10T12:00:00Z');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-results/exam-time-policy-v2');
const POLICY_FIELDS = ['policyVersion', 'policyReason', 'hardCapSeconds', 'requestedDurationSeconds', 'recordingStartedAt', 'recordingFinalization'];
const timing = (scope, seconds) => ({ scope, durationSeconds: seconds, prepareSeconds: 0, basis: seconds === null ? 'unknown' : 'document', source: 'Independent timing source.' });
const wave = seed => { const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40); bytes.writeInt16LE(seed, 44); bytes.writeInt16LE(-seed, 46); return bytes; };

function fixture({ kind = 'read_academic', sourceSeconds = null, preset = 'document', mode = 'practice', count = 2, splitModules = false, start = START } = {}) {
  const sectionName = kind.startsWith('read_') ? 'reading' : kind === 'listen_conversation' ? 'listening' : ['build_sentence', 'write_email', 'academic_discussion'].includes(kind) ? 'writing' : 'speaking';
  const scope = sectionName === 'reading' ? 'module' : sectionName === 'writing' ? 'task' : 'question';
  const type = { read_academic: 'single_choice', listen_conversation: 'single_choice', build_sentence: 'sentence_order', write_email: 'email', academic_discussion: 'discussion', listen_repeat: 'listen_repeat', interview: 'interview' }[kind];
  const questions = Array.from({ length: count }, (_, i) => ({ id: `q${i + 1}`, type, prompt: 'An independently authored practice question.', ...(['single_choice', 'sentence_order'].includes(type) ? { options: [{ id: 'A', text: 'quiet' }, { id: 'B', text: 'gardens' }], answer: type === 'single_choice' ? 'A' : ['A', 'B'] } : type === 'listen_repeat' ? { answer: 'The garden opens at nine.' } : {}), ...(type === 'sentence_order' ? { sentenceFrame: 'I like ____ ____ .', answerSlots: 2 } : {}) }));
  const state = emptyState(), pack = validatePackage({ schemaVersion: 1, id: `original-v2-${kind}`, version: '1', title: 'Original versioned timing fixture', groups: [{ id: 'group', section: sectionName, title: 'Original questions', passage: '', questions }] }).pack;
  const library = { libraryId: crypto.randomUUID(), importedAt: new Date(start).toISOString(), originalPack: pack, mediaMap: {}, contentHash: contentHash(pack, {}) }; state.libraries.push(library);
  const task = (id, ids) => ({ id, kind, groupId: 'group', questionIds: ids, timing: timing(scope, sourceSeconds), screen: 'one_question', numberStart: 1, numberEnd: ids.length, directions: [], inlineBlanks: null, presentation: {} });
  const module = (id, item) => ({ id, title: id, sourceNumber: null, timing: timing(scope, sourceSeconds), navigation: { back: sectionName === 'reading' ? 'module' : sectionName === 'writing' ? 'task' : 'none', review: sectionName === 'reading' ? 'module' : sectionName === 'writing' ? 'task' : 'none', lockOnAdvance: true }, instructions: { text: '', audio: null }, tasks: [item] });
  const modules = splitModules ? questions.map((q, i) => module(`module${i + 1}`, task(`task${i + 1}`, [q.id]))) : [module('module', task('task', questions.map(q => q.id)))];
  const plan = { version: 1, id: 'timing-v2-plan', title: pack.title, sections: [{ id: sectionName, section: sectionName, title: sectionName, modules }] };
  const h = { state, library, plan, time: start, start, blobBytes: new Map() };
  const created = createExamSession({ sessionVersion: 2, libraryId: library.libraryId, mode, preset }, state, { nowMs: start, planBuilder: () => structuredClone(plan) });
  Object.defineProperty(h, 'session', { get: () => state.sessions.find(session => session.id === created.id) });
  h.ref = qid => { for (const section of h.session.planSnapshot.sections) for (const module of section.modules) for (const task of module.tasks) if (task.questionIds.includes(qid)) return { section, module, task, questionId: qid }; throw new Error('Unknown fixture question'); };
  h.definition = (qid, version, phase = 'response') => {
    const ref = h.ref(qid), result = resolveTimingForPolicy(version, ref.task, ref.module, h.session.preset, { questionId: qid, phase });
    const { scope, durationSeconds, basis, source, policyVersion, policyReason, hardCapSeconds, requestedDurationSeconds } = result, ownerId = scope === 'module' ? ref.module.id : scope === 'task' ? ref.task.id : qid;
    return { id: `${phase}:${scope}:${ownerId}`, scope, phase, ownerId, moduleId: ref.module.id, taskId: scope === 'module' ? null : ref.task.id, questionId: scope === 'question' ? qid : null, durationSeconds, basis, source, policyVersion, policyReason, hardCapSeconds, requestedDurationSeconds };
  };
  h.patch = body => patchExamSession({ expectedRevision: h.session.revision, ...body }, state, h.session, { nowMs: h.time });
  h.commit = (body = {}) => commitExamModule({ expectedRevision: h.session.revision, moduleId: h.session.cursor.moduleId, submissionId: crypto.randomUUID(), ...body }, state, h.session, { nowMs: h.time });
  h.view = () => examSessionView(h.session, { nowMs: h.time });
  h.recording = () => { const bytes = wave(h.blobBytes.size + 1), mediaId = crypto.createHash('sha256').update(bytes).digest('hex'), id = crypto.randomUUID(); h.blobBytes.set(mediaId, bytes); state.blobs[mediaId] = { id: mediaId, mime: 'audio/wav', size: bytes.length }; state.recordings[id] = { id, mediaId, name: 'original.wav', createdAt: new Date(h.time).toISOString() }; return id; };
  h.seedV1 = ({ qid = 'q1', elapsedMs = 0, running = false, recording = false } = {}) => {
    const current = h.session, ref = h.ref(qid), definition = h.definition(qid, 1), stamp = new Date(start + elapsedMs).toISOString(), deadline = new Date(start + definition.durationSeconds * 1000).toISOString();
    current.timePolicyVersion = 1; current.timePolicyUpgrade = null; current.paused = !running; current.cursor = { sectionId: ref.section.id, moduleId: ref.module.id, taskId: ref.task.id, questionId: qid, phase: recording ? 'recorded' : 'response', phaseIndex: 0 };
    const timer = { ...definition, consumedMs: elapsedMs, startedAt: new Date(start).toISOString(), runningSince: running ? stamp : null, deadlineAt: running ? deadline : null, expiredAt: elapsedMs >= definition.durationSeconds * 1000 ? deadline : null, paused: !running, pausedAt: running ? null : stamp, completed: false, completedAt: null, ...(sectionName === 'speaking' ? { recordingStartedAt: new Date(start).toISOString(), recordingFinalization: null } : {}) };
    current.timers = { [timer.id]: timer }; current.activeTimerId = recording ? null : timer.id; current.updatedAt = stamp; current.lastUserActivityAt = stamp; current.visited[qid] = true; h.time = start + elapsedMs;
    if (recording) {
      assert.equal(running, false); const id = h.recording(); current.answers[qid] = { answer: '', recordingId: id, recordingUrl: `/api/media/${state.recordings[id].mediaId}`, transcript: 'Original transcript.', transcriptConfirmed: true, attemptId: null };
      timer.recordingFinalization = { questionId: qid, startedAt: timer.recordingStartedAt, stoppedAt: stamp, receivedAt: stamp, expiresAt: new Date(start + elapsedMs + 120000).toISOString(), responseDeadlineAt: deadline, initialRecordingId: null, recordingId: id, savedAt: stamp };
    }
  };
  h.freezeSubmittedAsV1 = () => { h.session.timePolicyVersion = 1; h.session.timePolicyUpgrade = null; for (const timer of Object.values(h.session.timers)) Object.assign(timer, h.definition(timer.questionId || questions.find(q => h.ref(q.id).module.id === timer.moduleId && (!timer.taskId || h.ref(q.id).task.id === timer.taskId)).id, 1, timer.phase)); for (const progress of Object.values(h.session.moduleStates)) if (progress.submission) progress.submission.timePolicyVersion = 1; };
  return h;
}

test('new user standards override source Reading and sentence totals but explicit custom values remain authoritative', () => {
  for (const [kind, scope, sourceSeconds, standard, key] of [['read_academic', 'module', 900, 720, 'readingModuleSeconds'], ['build_sentence', 'task', 360, 410, 'sentenceTaskSeconds']]) {
    const task = { kind, timing: timing(scope, sourceSeconds), questionIds: ['a'] }, module = { timing: timing(scope, sourceSeconds) }, before = canonicalJSON({ task, module });
    for (const preset of ['document', 'untimed', { [key]: 0 }]) { const result = resolveTiming(task, module, preset, { questionId: 'a' }); assert.equal(result.durationSeconds, standard); assert.equal(result.requestedDurationSeconds, sourceSeconds); assert.equal(result.basis, 'user'); assert.equal(result.policyReason, 'user_standard'); assert.match(result.source, /按用户设置/); }
    assert.equal(resolveTiming(task, module, { [key]: 37 }, { questionId: 'a' }).durationSeconds, 37);
    assert.equal(resolveTimingForPolicy(1, task, module).durationSeconds, sourceSeconds); assert.equal(resolveTimingForPolicy(1, task, module).basis, 'document');
    assert.equal(canonicalJSON({ task, module }), before);
  }
});

test('Repeat defaults use task membership order, restart in each task and preserve explicit source/custom timing', () => {
  const ids = ['q90', 'q2', 'q44', 'q3', 'q71', 'q1', 'q28'], task = { kind: 'listen_repeat', timing: timing('question', null), questionIds: ids };
  assert.deepEqual(REPEAT_DEFAULT_SECONDS, [8, 8, 10, 10, 10, 12, 12]);
  assert.deepEqual(ids.map(questionId => resolveTiming(task, {}, 'document', { questionId }).durationSeconds), [8, 8, 10, 10, 10, 12, 12]);
  assert.equal(resolveTiming({ ...task, questionIds: ['q28', 'q90'] }, {}, 'document', { questionId: 'q28' }).durationSeconds, 8);
  assert.equal(resolveTiming(task).durationSeconds, 12); assert.equal(resolveTiming(task, {}, 'document', { questionId: 'missing' }).durationSeconds, 12);
  assert.equal(resolveTiming({ ...task, timing: timing('question', 9) }, {}, 'document', { questionId: 'q90' }).durationSeconds, 9);
  assert.equal(resolveTiming(task, {}, { repeatSeconds: 6 }, { questionId: 'q28' }).durationSeconds, 6);
  assert.equal(resolveTimingForPolicy(1, task, {}, 'document', { questionId: 'q90' }).durationSeconds, 12);
});

test('the server starts each of seven Repeat response clocks with the same ordered defaults', () => {
  const h = fixture({ kind: 'listen_repeat', count: 7 });
  for (let i = 1; i <= 7; i++) { h.patch({ cursor: { questionId: `q${i}`, phase: 'response' } }); assert.equal(h.view().timers[h.session.activeTimerId].durationSeconds, REPEAT_DEFAULT_SECONDS[i - 1]); h.time += 1000; }
});

test('policy1 Reading and source360 sentence clocks migrate budgets without resetting measured elapsed time', () => {
  for (const options of [{ kind: 'read_academic', sourceSeconds: null, elapsedMs: 170000, expected: 550 }, { kind: 'build_sentence', sourceSeconds: 360, elapsedMs: 170000, expected: 240 }, { kind: 'build_sentence', sourceSeconds: 360, elapsedMs: 360000, expected: 50 }, { kind: 'read_academic', sourceSeconds: 900, elapsedMs: 800000, expected: 0 }]) {
    const h = fixture(options); h.seedV1(options); const old = canonicalJSON(h.session.timers), source = canonicalJSON(h.library), plan = canonicalJSON(h.session.planSnapshot), activity = h.session.lastUserActivityAt;
    assert.doesNotThrow(() => restoreExamSession(h.session, h.state)); h.time += 90000; h.patch({ timer: { action: 'pause' } });
    const timer = h.view().timers[h.session.activeTimerId]; assert.equal(h.session.timePolicyVersion, 2); assert.equal(timer.remainingSeconds, options.expected); assert.equal(h.session.timePolicyUpgrade.changes[0].observedElapsedMs, options.elapsedMs);
    assert.equal(canonicalJSON(h.session.timePolicyUpgrade.previousTimers), old); assert.equal(canonicalJSON(h.library), source); assert.equal(canonicalJSON(h.session.planSnapshot), plan); assert.equal(h.session.lastUserActivityAt, activity);
    const snapshot = canonicalJSON(h.session.timePolicyUpgrade); h.time += 10000; h.patch({ timer: { action: 'pause' } }); assert.equal(canonicalJSON(h.session.timePolicyUpgrade), snapshot);
    assert.doesNotThrow(() => restoreExamSession(h.session, h.state));
  }
  const running = fixture({ kind: 'build_sentence', sourceSeconds: 360 }); running.seedV1({ elapsedMs: 100000, running: true }); running.time += 70000; running.patch({ timer: { action: 'pause' } });
  assert.equal(running.view().timers[running.session.activeTimerId].remainingSeconds, 240); assert.equal(running.session.timePolicyUpgrade.changes[0].observedElapsedMs, 170000);
  const stale = fixture({ kind: 'build_sentence', sourceSeconds: 360 }); stale.seedV1({ elapsedMs: 100000, running: true }); stale.time = START + 900000; stale.patch({ timer: { action: 'pause' } });
  assert.equal(stale.view().timers[stale.session.activeTimerId].remainingSeconds, 50, 'Time after an old finite deadline is not additional answer time');
  assert.equal(stale.session.timePolicyUpgrade.changes[0].observedElapsedMs, 900000); assert.equal(stale.session.timePolicyUpgrade.changes[0].appliedElapsedMs, 360000); assert.doesNotThrow(() => restoreExamSession(stale.session, stale.state));
});

test('saved Repeat recordings and finalization windows remain unchanged while the new question budget uses prior elapsed time', () => {
  for (const [qid, elapsedMs, expected] of [['q1', 3000, 5], ['q1', 9000, 0], ['q3', 3000, 7], ['q7', 3000, 9]]) {
    const h = fixture({ kind: 'listen_repeat', count: 7 }); h.seedV1({ qid, elapsedMs, recording: true });
    const oldAnswer = canonicalJSON(h.session.answers[qid]), oldTimer = h.session.timers[`response:question:${qid}`], window = canonicalJSON(oldTimer.recordingFinalization), bytes = canonicalJSON(h.state.recordings);
    h.time += 5000; h.patch({ timer: { action: 'pause' } }); const timer = h.view().timers[`response:question:${qid}`];
    assert.equal(timer.remainingSeconds, expected); assert.equal(canonicalJSON(h.session.answers[qid]), oldAnswer); assert.equal(canonicalJSON(timer.recordingFinalization), window); assert.equal(canonicalJSON(h.state.recordings), bytes);
    assert.equal(canonicalJSON(h.session.timePolicyUpgrade.previousRecordings[qid]), oldAnswer); assert.doesNotThrow(() => restoreExamSession(h.session, h.state));
  }
});

test('earlier migration evidence and already submitted policy1 modules survive a policy2 continuation', () => {
  const h = fixture(); h.seedV1({ elapsedMs: 20000 }); const id = h.session.activeTimerId, legacy = structuredClone(h.session.timers[id]);
  for (const key of POLICY_FIELDS) delete legacy[key]; legacy.durationSeconds = null; legacy.basis = 'unknown'; legacy.source = 'Independent timing source.';
  h.session.timePolicyUpgrade = { fromVersion: 0, toVersion: 1, appliedAt: new Date(h.time).toISOString(), previousPreset: 'document', previousTimers: { [id]: legacy }, previousRecordings: {}, previousActiveTimerId: id, previousPaused: true, changes: [{ previousId: id, currentId: id, observedElapsedMs: 20000 }], expiredQuestionIds: [] };
  const previous = canonicalJSON(h.session.timePolicyUpgrade); assert.doesNotThrow(() => restoreExamSession(h.session, h.state)); h.time += 10000; h.patch({ timer: { action: 'pause' } });
  assert.equal(canonicalJSON(h.session.timePolicyUpgrade.previousUpgrade), previous); assert.doesNotThrow(() => restoreExamSession(h.session, h.state));
  const mixed = fixture({ splitModules: true }); mixed.patch({ cursor: { phase: 'response' } }); mixed.time += 10000; mixed.commit(); mixed.freezeSubmittedAsV1();
  const clock = canonicalJSON(mixed.session.timers), receipt = canonicalJSON(mixed.session.moduleStates.module1.submission), attempt = canonicalJSON(mixed.state.attempts[0]);
  mixed.patch({ timer: { action: 'pause' } }); assert.equal(canonicalJSON(mixed.session.timers), clock); assert.equal(canonicalJSON(mixed.session.moduleStates.module1.submission), receipt); assert.equal(canonicalJSON(mixed.state.attempts[0]), attempt);
  mixed.patch({ timer: { action: 'resume' }, cursor: { phase: 'response' } }); mixed.time += 1000; mixed.commit(); validateExamRunContexts(mixed.state); assert.doesNotThrow(() => restoreExamSession(mixed.session, mixed.state));
  assert.equal(canonicalJSON(mixed.state.attempts[0]), attempt);
});

test('finished policy1 sessions restore byte-for-byte under their original defaults', () => {
  for (const kind of ['read_academic', 'build_sentence', 'listen_repeat']) {
    const h = fixture({ kind, sourceSeconds: kind === 'build_sentence' ? 360 : null }); h.patch({ cursor: { phase: 'response' } }); h.time += 1000; h.commit(); h.freezeSubmittedAsV1();
    const before = canonicalJSON(h.session), attempts = canonicalJSON(h.state.attempts); const restored = restoreExamSession(h.session, h.state, { snapshotTime: new Date(h.time + 86400000).toISOString() });
    assert.equal(canonicalJSON(restored), before); assert.equal(canonicalJSON(h.state.attempts), attempts); validateExamRunContexts(h.state);
  }
});

test('practice may keep editing five non-speaking task types at zero, while exam and completed-answer locks remain strict', () => {
  for (const kind of ['read_academic', 'listen_conversation', 'build_sentence', 'write_email', 'academic_discussion']) {
    const preset = kind === 'read_academic' ? { readingModuleSeconds: 1 } : kind === 'build_sentence' ? { sentenceTaskSeconds: 1 } : kind === 'listen_conversation' ? { listeningQuestionSeconds: 1 } : 'document';
    const answer = kind === 'build_sentence' ? ['A', 'B'] : ['write_email', 'academic_discussion'].includes(kind) ? 'An original practice answer after the timer.' : 'A';
    const h = fixture({ kind, sourceSeconds: 1, preset }); h.patch({ cursor: { phase: 'response' } }); h.time += 3000; h.patch({ answers: { q1: answer } });
    assert.equal(h.session.cursor.questionId, 'q1'); assert.equal(h.session.cursor.phase, 'response'); assert.equal(h.view().timers[h.session.activeTimerId].remainingSeconds, 0); assert.equal(h.state.attempts.length, 0);
    h.patch({ cursor: { questionId: 'q2', phase: 'response' } }); h.time += 3000; h.patch({ answers: { q2: answer } }); h.commit(); assert.throws(() => h.patch({ answers: { q1: answer } }), /结束|提交/);
    const strict = fixture({ kind, sourceSeconds: 1, preset, mode: 'exam' }); strict.patch({ cursor: { phase: 'response' } }); strict.time += 3000; assert.throws(() => strict.patch({ answers: { q1: answer } }), /作答时间已到/); assert.equal(strict.state.attempts.length, 0);
  }
});

test('versioned migration backups reject altered old budgets, elapsed evidence and recording windows', () => {
  const h = fixture({ kind: 'listen_repeat', count: 7 }); h.seedV1({ elapsedMs: 3000, recording: true }); h.patch({ timer: { action: 'pause' } });
  for (const change of [copy => { copy.timePolicyUpgrade.previousTimers['response:question:q1'].durationSeconds = 99; }, copy => { copy.timePolicyUpgrade.changes[0].observedElapsedMs++; }, copy => { copy.timePolicyUpgrade.previousTimers['response:question:q1'].recordingFinalization.expiresAt = new Date(START + 999999).toISOString(); }, copy => { copy.timers['response:question:q1'].durationSeconds = 12; }]) {
    const bad = structuredClone(h.session); change(bad); assert.throws(() => restoreExamSession(bad, h.state), /计时|时钟|收尾/);
  }
});

async function http(t, h) {
  await fs.mkdir(ROOT, { recursive: true }); const dataDir = await fs.mkdtemp(path.join(ROOT, 'http-')), store = await createStore({ dataDir });
  for (const [id, bytes] of h.blobBytes) { const info = await store.writeBlob(bytes, 'audio/wav'); assert.equal(info.id, id); }
  await store.transact(state => Object.assign(state, structuredClone(h.state))); await store.close();
  const instance = await startServer({ dataDir, models: { publicSettings: () => ({ provider: 'none', capabilities: {} }), feedback: () => { throw new Error('No model service is allowed'); } } });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await appFetch(instance.url + '/api' + route, { method, headers: { 'X-PracticeBridge': '1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
  t.after(async () => { await instance.close(); assert.ok(path.resolve(dataDir).startsWith(ROOT + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { instance, api, disk: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')), read: async () => (await api(`/sessions/${h.session.id}`)).body.session, patch: (session, body) => api(`/sessions/${session.id}`, { writerToken: session.writerToken, expectedRevision: session.revision, ...body }, 'PATCH'), backup: async () => Buffer.from(await (await appFetch(instance.url + '/api/backup')).arrayBuffer()) };
}

test('HTTP policy1 source360 and Repeat recordings upgrade and survive a complete backup/restore round trip', async t => {
  for (const kind of ['build_sentence', 'listen_repeat']) {
    const h = fixture({ kind, sourceSeconds: kind === 'build_sentence' ? 360 : null, count: kind === 'listen_repeat' ? 7 : 2, start: Date.now() - 200000 });
    h.seedV1({ elapsedMs: kind === 'build_sentence' ? 170000 : 3000, recording: kind === 'listen_repeat' }); const original = canonicalJSON(h.library), api = await http(t, h);
    const before = await api.read(), result = await api.patch(before, { timer: { action: 'pause' } }); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.session.timePolicyVersion, TIME_POLICY_VERSION);
    const timer = Object.values(result.body.session.timers).find(item => item.phase === 'response'); assert.equal(timer.remainingSeconds, kind === 'build_sentence' ? 240 : 5);
    const blobHashes = [];
    for (const entry of Object.values(before.answers)) if (entry.recordingUrl) blobHashes.push(crypto.createHash('sha256').update(Buffer.from(await (await appFetch(api.instance.url + entry.recordingUrl)).arrayBuffer())).digest('hex'));
    const bytes = await api.backup(), restored = await api.api('/restore', { file: { name: 'versioned-backup.zip', data: bytes.toString('base64') } }); assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const after = await api.read(); assert.equal(canonicalJSON(after.timePolicyUpgrade), canonicalJSON(result.body.session.timePolicyUpgrade)); assert.equal(canonicalJSON(after.answers), canonicalJSON(before.answers));
    for (const [i, entry] of Object.values(after.answers).filter(entry => entry.recordingUrl).entries()) assert.equal(crypto.createHash('sha256').update(Buffer.from(await (await appFetch(api.instance.url + entry.recordingUrl)).arrayBuffer())).digest('hex'), blobHashes[i]);
    assert.equal(canonicalJSON((await api.disk()).libraries[0]), original);
  }
});

test('HTTP non-speaking practice accepts real post-deadline edits and exam rejects the same timing', async t => {
  const instances = [];
  for (const mode of ['practice', 'exam']) { const h = fixture({ kind: 'read_academic', preset: { readingModuleSeconds: 1 }, mode, start: Date.now() }); const server = await http(t, h); let current = await server.read(); const result = await server.patch(current, { cursor: { phase: 'response' } }); assert.equal(result.status, 200); current = result.body.session; instances.push({ mode, server, current }); }
  await new Promise(resolve => setTimeout(resolve, 1150));
  for (const { mode, server, current } of instances) { const result = await server.patch(current, { answers: { q1: 'A' } }); assert.equal(result.status, mode === 'practice' ? 200 : 409, JSON.stringify(result.body)); const saved = await server.read(); assert.equal(saved.timers[saved.activeTimerId].remainingSeconds, 0); assert.equal(saved.cursor.questionId, 'q1'); assert.equal(saved.finished, false); if (mode === 'practice') assert.equal(saved.answers.q1.answer, 'A'); }
});
