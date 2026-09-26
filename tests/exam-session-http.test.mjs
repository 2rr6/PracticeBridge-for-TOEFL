import {appFetch} from './auth-client.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ZipFixture from './helpers/zip-fixture.mjs';
import { startServer } from '../src/server.mjs';
import { canonicalJSON, readZip } from '../src/package.mjs';

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-results/exam-session-http');
const upload = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });
const fixture = () => ({ schemaVersion: 1, id: 'original-exam-http', version: '1', title: 'Original session HTTP material', description: '', rights: 'Original synthetic exercises.', groups: [
  { id: 'reading', section: 'reading', title: 'Original blanks', passage: 'A ca_ sat on a ma_.', questions: [{ id: 'r1', type: 'fill_blank', prompt: 'Complete original word one.', answer: 'cat' }, { id: 'r2', type: 'fill_blank', prompt: 'Complete original word two.', answer: 'mat' }] },
  { id: 'listening', section: 'listening', title: 'Original conversation', passage: 'A source transcript.', questions: [1, 2].map(i => ({ id: `l${i}`, type: 'single_choice', prompt: `Original question ${i}.`, options: [{ id: 'A', text: 'One' }, { id: 'B', text: 'Two' }], answer: 'A' })) },
  { id: 'speaking', section: 'speaking', title: 'Original repeat', passage: '', questions: [{ id: 's1', type: 'listen_repeat', prompt: 'Repeat the original sentence.', answer: 'The garden opens today.' }] },
] });
const wave = () => {
  const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  return bytes;
};

async function harness(t) {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(TEST_ROOT, 'run-'));
  const models = { publicSettings: () => ({ provider: 'none', capabilities: {} }), feedback: () => { throw new Error('No model service may run in this test'); } };
  const h = { dataDir, instance: await startServer({ dataDir, models }) };
  h.api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await appFetch(h.instance.url + route, { method, headers: { 'X-PracticeBridge': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  h.import = async () => {
    const preview = await h.api('/api/import/preview', { files: [upload('practicebridge.json', JSON.stringify(fixture()))] });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const result = await h.api('/api/import/commit', { draftId: preview.body.draftId, pack: preview.body.pack, acknowledged: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    h.library = result.body.library;
    return h.library;
  };
  h.create = async (input = {}) => {
    const result = await h.api('/api/sessions', { sessionVersion: 2, libraryId: h.library.libraryId, groupId: 'reading', mode: 'practice', ...input });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.session;
  };
  h.patch = (session, input) => h.api(`/api/sessions/${session.id}`, { writerToken: session.writerToken, expectedRevision: session.revision, ...input }, 'PATCH');
  h.commit = (session, input = {}) => h.api(`/api/sessions/${session.id}/commit-module`, { writerToken: session.writerToken, expectedRevision: session.revision, moduleId: session.cursor.moduleId, submissionId: crypto.randomUUID(), ...input });
  h.backup = async () => Buffer.from(await (await appFetch(h.instance.url + '/api/backup')).arrayBuffer());
  t.after(async () => {
    await h.instance.close();
    const checked = path.resolve(dataDir);
    assert.ok(checked.startsWith(`${TEST_ROOT}${path.sep}`), 'Only the newly created test directory can be removed');
    await fs.rm(checked, { recursive: true, force: true });
  });
  return h;
}

test('runtime exam plans and media URLs do not enter exported source packages', async t => {
  const h = await harness(t), library = await h.import();
  assert.equal(library.examPlan.version, 1);
  assert.deepEqual(library.mediaUrls, {});
  const state = (await h.api('/api/state')).body;
  assert.equal(state.libraries[0].contentHash, library.contentHash);
  assert.ok(state.workspaceEpoch);
  const bytes = Buffer.from(await (await appFetch(`${h.instance.url}/api/library/${library.libraryId}/export`)).arrayBuffer());
  const pack = JSON.parse((await readZip(bytes)).get('practicebridge.json'));
  assert.equal('examPlan' in pack, false);
  assert.equal('mediaUrls' in pack, false);
});

test('concurrent stale patches cannot overwrite the single accepted draft revision', async t => {
  const h = await harness(t); await h.import();
  const session = await h.create();
  const results = await Promise.all([h.patch(session, { answers: { r1: 'cat' } }), h.patch(session, { answers: { r1: 'other' } })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const accepted = results.find(result => result.status === 200).body.session;
  const latest = (await h.api(`/api/sessions/${session.id}`)).body.session;
  assert.equal(latest.answers.r1.answer, accepted.answers.r1.answer);
  assert.equal(latest.revision, session.revision + 1);
  assert.equal((await h.api('/api/state')).body.attempts.length, 0);
});

test('module submission is atomic and idempotent even with concurrent requests and new retry ids', async t => {
  const h = await harness(t); await h.import();
  let session = await h.create();
  session = (await h.patch(session, { answers: { r1: 'cat' } })).body.session;
  const request = { submissionId: 'same-network-operation' };
  const [first, repeated] = await Promise.all([h.commit(session, request), h.commit(session, request)]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.deepEqual(first.body.attempts.map(attempt => attempt.id), repeated.body.attempts.map(attempt => attempt.id));
  const newIdRetry = await h.commit(session, { submissionId: 'retry-with-new-client-id' });
  assert.equal(newIdRetry.status, 200, JSON.stringify(newIdRetry.body));
  assert.equal(newIdRetry.body.replayed, true);
  assert.equal((await h.api('/api/state')).body.attempts.length, 2);
  const changed = await h.commit(session, { submissionId: 'changed-client-id', answers: { r1: 'changed' } });
  assert.equal(changed.status, 409);
  assert.equal((await h.api('/api/state')).body.attempts.length, 2);
});

test('invalid media reference rejects all answers in a batch and leaves the draft revision intact', async t => {
  const h = await harness(t); await h.import();
  const session = await h.create();
  const result = await h.commit(session, { answers: { r1: 'cat', r2: { recordingId: crypto.randomUUID() } } });
  assert.equal(result.status, 400);
  const state = (await h.api('/api/state')).body;
  assert.equal(state.attempts.length, 0);
  assert.equal(state.sessions[0].revision, session.revision);
  assert.deepEqual(state.sessions[0].answers, {});
});

test('listening Next closes the previous answer against delayed patches using the newest revision', async t => {
  const h = await harness(t); await h.import();
  let session = await h.create({ groupId: 'listening' });
  session = (await h.patch(session, { cursor: { phase: 'response' }, answers: { l1: 'A' } })).body.session;
  const next = await h.patch(session, { cursor: { questionId: 'l2', phase: 'stimulus' } });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  session = next.body.session;
  const delayed = await h.patch(session, { answers: { l1: 'B' } });
  assert.equal(delayed.status, 409);
  assert.equal((await h.api(`/api/sessions/${session.id}`)).body.session.answers.l1.answer, 'A');
});

test('restore changes writer tokens even when session id and revision remain identical', async t => {
  const h = await harness(t); await h.import();
  let session = await h.create();
  session = (await h.patch(session, { answers: { r1: 'cat' }, timer: { action: 'pause' } })).body.session;
  const bytes = await h.backup();
  const restored = await h.api('/api/restore', { file: upload('original-backup.zip', bytes) });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const current = (await h.api(`/api/sessions/${session.id}`)).body.session;
  assert.equal(current.id, session.id);
  assert.equal(current.revision, session.revision);
  assert.notEqual(current.writerToken, session.writerToken);
  assert.equal((await h.patch(session, { answers: { r1: 'stale-page' } })).status, 409);
  assert.equal((await h.commit(session)).status, 409);
  const valid = await h.patch(current, { answers: { r2: 'mat' } });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
});

test('old and new backups restore together with immutable attempts, reusable legacy projections and recording bytes', async t => {
  const h = await harness(t); await h.import();
  const oldAttempt = await h.api('/api/attempts', { libraryId: h.library.libraryId, questionId: 'r1', answer: 'cat', mode: 'practice', assisted: false, durationSeconds: 7, submissionId: 'legacy-submission' });
  assert.equal(oldAttempt.status, 200);
  const legacy = await h.api('/api/sessions', { libraryId: h.library.libraryId, groupId: 'reading', mode: 'practice', answers: { r1: { answer: 'cat', attemptId: oldAttempt.body.attempt.id }, r2: { answer: 'mat' } }, currentIndex: 1, remainingSeconds: 11 });
  assert.equal(legacy.status, 200);
  const oldBackup = await h.backup();
  const oldCanonical = canonicalJSON(oldAttempt.body.attempt);
  let projection = await h.create({ legacySessionId: legacy.body.session.id });
  assert.equal(projection.priorTimingSnapshot.remainingSeconds, 11);
  assert.equal((await h.create({ legacySessionId: legacy.body.session.id })).id, projection.id);
  const submitted = await h.commit(projection);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.attempts[0].id, oldAttempt.body.attempt.id);
  assert.equal(canonicalJSON(submitted.body.attempts[0]), oldCanonical);
  let speaking = await h.create({ groupId: 'speaking' });
  speaking = (await h.patch(speaking, { cursor: { phase: 'response' } })).body.session;
  speaking = (await h.patch(speaking, { cursor: { phase: 'saving' } })).body.session;
  const recording = await h.api('/api/recordings', upload('original.wav', wave()));
  assert.equal(recording.status, 200);
  speaking = (await h.patch(speaking, { answers: { s1: { recordingId: recording.body.recordingId } }, cursor: { phase: 'recorded' } })).body.session;
  const speakingDone = await h.commit(speaking);
  assert.equal(speakingDone.status, 200, JSON.stringify(speakingDone.body));
  const newBackup = await h.backup();
  const manifest = JSON.parse((await readZip(newBackup)).get('practicebridge-backup.json'));
  assert.equal(JSON.stringify(manifest).includes('writerToken'), false);
  assert.equal(manifest.state.workspaceEpoch,(await h.api('/api/state')).body.workspaceEpoch,'backup records the public workspace generation for provenance, never boot authentication');
  const restoredOld = await h.api('/api/restore', { file: upload('old.zip', oldBackup) });
  assert.equal(restoredOld.status, 200, JSON.stringify(restoredOld.body));
  const oldState = (await h.api('/api/state')).body;
  assert.equal(oldState.attempts.length, 1);
  assert.equal(canonicalJSON(oldState.attempts[0]), oldCanonical);
  assert.equal(oldState.sessions[0].remainingSeconds, 11);
  const restoredNew = await h.api('/api/restore', { file: upload('new.zip', newBackup) });
  assert.equal(restoredNew.status, 200, JSON.stringify(restoredNew.body));
  const state = (await h.api('/api/state')).body;
  assert.notEqual(state.workspaceEpoch,manifest.state.workspaceEpoch,'restoring a generation never reauthorizes its old commands');
  assert.equal(state.attempts.length, 3);
  assert.equal(canonicalJSON(state.attempts.find(attempt => attempt.id === oldAttempt.body.attempt.id)), oldCanonical);
  const restoredRecording = state.attempts.find(attempt => attempt.questionId === 's1');
  const audio = Buffer.from(await (await appFetch(h.instance.url + restoredRecording.recordingUrl)).arrayBuffer());
  assert.deepEqual(audio, wave());
});

test('tampered v2 timing and attempt context fail restore before replacing the workspace', async t => {
  const h = await harness(t); await h.import();
  let session = await h.create({ preset: { readingModuleSeconds: 60 } });
  session = (await h.patch(session, { cursor: { phase: 'response' } })).body.session;
  const runningBackup = await h.backup();
  const alteredClock = await ZipFixture.from(runningBackup);
  const clockManifest = JSON.parse(alteredClock.getEntry('practicebridge-backup.json').getData());
  const saved = clockManifest.state.sessions[0], clock = saved.timers[saved.activeTimerId];
  clock.deadlineAt = new Date(Date.parse(clock.deadlineAt) + 5000).toISOString();
  alteredClock.updateFile('practicebridge-backup.json', Buffer.from(JSON.stringify(clockManifest)));
  const refusedClock = await h.api('/api/restore', { file: upload('bad-clock.zip', alteredClock.toBuffer()) });
  assert.equal(refusedClock.status, 400);
  assert.equal((await h.api('/api/state')).body.sessions[0].id, session.id);
  const done = await h.commit(session);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const goodBackup = await h.backup(), alteredContext = await ZipFixture.from(goodBackup);
  const contextManifest = JSON.parse(alteredContext.getEntry('practicebridge-backup.json').getData());
  contextManifest.state.attempts[0].runContext.taskId = 'another-task';
  alteredContext.updateFile('practicebridge-backup.json', Buffer.from(JSON.stringify(contextManifest)));
  const before = (await h.api('/api/state')).body.attempts;
  const refusedContext = await h.api('/api/restore', { file: upload('bad-context.zip', alteredContext.toBuffer()) });
  assert.equal(refusedContext.status, 400);
  assert.equal(canonicalJSON((await h.api('/api/state')).body.attempts), canonicalJSON(before));
});
