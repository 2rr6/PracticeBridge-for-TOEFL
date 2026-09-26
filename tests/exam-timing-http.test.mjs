import {appFetch} from './auth-client.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ZipFixture from './helpers/zip-fixture.mjs';
import { createStore } from '../src/store.mjs';
import { canonicalJSON, contentHash, readZip, validatePackage } from '../src/package.mjs';
import { createExamSession, patchExamSession, commitExamModule } from '../src/exam-session.mjs';
import { startServer } from '../src/server.mjs';
import { TIME_POLICY_VERSION } from '../public/exam-timing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-results/exam-timing-http');
const upload = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });
function wave(seed = 1) {
  const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  bytes.writeInt16LE(seed, 44); bytes.writeInt16LE(-seed, 46); return bytes;
}
const stripPolicy = session => {
  delete session.timePolicyVersion; delete session.timePolicyUpgrade; delete session.lastUserActivityAt;
  for (const progress of Object.values(session.moduleStates)) if (progress.submission) delete progress.submission.timePolicyVersion;
  for (const timer of Object.values(session.timers)) {
    for (const key of ['policyVersion', 'policyReason', 'hardCapSeconds', 'requestedDurationSeconds', 'recordingStartedAt', 'recordingFinalization']) delete timer[key];
    timer.durationSeconds = null; timer.basis = 'user'; timer.source = '本轮选择不限时练习。';
  }
};

async function harness(t, { legacy = false, finished = false, consumedMs = 70000, existingRecording = true } = {}) {
  await fs.mkdir(ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(ROOT, 'run-')), start = Date.now() - 180000, store = await createStore({ dataDir });
  const pack = validatePackage({ schemaVersion: 1, id: 'original-http-countdown', version: '1', title: 'Original HTTP timing fixture', groups: [{ id: 'interview', section: 'speaking', title: 'Original interview', passage: '', questions: ['i1', 'i2'].map(id => ({ id, type: 'interview', prompt: 'Describe an original garden.', source: 'Original synthetic text.' })) }] }).pack;
  const library = { libraryId: crypto.randomUUID(), importedAt: new Date(start).toISOString(), originalPack: pack, mediaMap: {}, contentHash: contentHash(pack, {}) };
  const info = await store.writeBlob(wave(), 'audio/wav'), recordingId = crypto.randomUUID();
  let seedId;
  await store.transact(state => {
    state.libraries.push(library); state.blobs[info.id] = info;
    state.recordings[recordingId] = { id: recordingId, mediaId: info.id, name: 'original.wav', createdAt: new Date(start).toISOString() };
    if (!legacy && !finished) return;
    let session = createExamSession({ sessionVersion: 2, libraryId: library.libraryId, groupId: 'interview', mode: 'practice', preset: 'untimed' }, state, { nowMs: start });
    seedId = session.id;
    session = patchExamSession({ expectedRevision: session.revision, cursor: { phase: 'response' } }, state, session, { nowMs: start });
    if (finished) {
      session = commitExamModule({ expectedRevision: session.revision, moduleId: session.cursor.moduleId, submissionId: 'original-pre-policy-finished' }, state, session, { nowMs: start + 5000 }).session;
      stripPolicy(session); return;
    }
    stripPolicy(session);
    const timer = session.timers[session.activeTimerId];
    timer.consumedMs = consumedMs; timer.runningSince = null; timer.deadlineAt = null; timer.expiredAt = null; timer.paused = true; timer.pausedAt = new Date(start + consumedMs).toISOString();
    session.paused = true; session.updatedAt = timer.pausedAt;
    if (existingRecording) session.answers.i1 = { answer: '', recordingId, recordingUrl: `/api/media/${info.id}`, transcript: '', transcriptConfirmed: false, attemptId: null };
  });
  await store.close();
  const models = { publicSettings: () => ({ provider: 'none', capabilities: {} }), feedback: () => { throw new Error('This test cannot call a model'); } };
  const h = { dataDir, start, library, seedId, recordingId, mediaId: info.id, instance: await startServer({ dataDir, models }) };
  h.api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await appFetch(h.instance.url + route, { method, headers: { 'X-PracticeBridge': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  h.session = async id => (await h.api(`/api/sessions/${id || seedId}`)).body.session;
  h.patch = (session, body) => h.api(`/api/sessions/${session.id}`, { writerToken: session.writerToken, expectedRevision: session.revision, ...body }, 'PATCH');
  h.commit = session => h.api(`/api/sessions/${session.id}/commit-module`, { writerToken: session.writerToken, expectedRevision: session.revision, moduleId: session.cursor.moduleId, submissionId: crypto.randomUUID() });
  h.backup = async () => Buffer.from(await (await appFetch(h.instance.url + '/api/backup')).arrayBuffer());
  h.disk = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  t.after(async () => { await h.instance.close(); const checked = path.resolve(dataDir); assert.ok(checked.startsWith(ROOT + path.sep)); await fs.rm(checked, { recursive: true, force: true }); });
  return h;
}

test('HTTP entry upgrades an old null clock, keeps its saved audio and cannot regain time through restore', async t => {
  const h = await harness(t, { legacy: true });
  let session = await h.session();
  assert.equal(session.timePolicyVersion, undefined); assert.equal(session.timers[session.activeTimerId].durationSeconds, null);
  const originalPlan = canonicalJSON(session.planSnapshot), originalLibrary = canonicalJSON((await h.disk()).libraries[0]), oldUpdatedAt = session.updatedAt, oldBackup = await h.backup();
  let result = await h.patch(session, { timer: { action: 'pause' } }); assert.equal(result.status, 200, JSON.stringify(result.body)); session = result.body.session;
  const timer = session.timers[session.activeTimerId];
  assert.equal(session.timePolicyVersion, TIME_POLICY_VERSION); assert.equal(timer.durationSeconds, 45); assert.equal(timer.remainingSeconds, 0);
  assert.equal(session.cursor.questionId, 'i1'); assert.equal(session.lastUserActivityAt, oldUpdatedAt);
  assert.equal(session.answers.i1.recordingId, h.recordingId); assert.equal(canonicalJSON(session.planSnapshot), originalPlan);
  assert.equal(canonicalJSON((await h.disk()).libraries[0]), originalLibrary);
  assert.deepEqual(Buffer.from(await (await appFetch(h.instance.url + session.answers.i1.recordingUrl)).arrayBuffer()), wave());
  assert.equal((await h.patch(session, { answers: { i1: 'Late answer.' } })).status, 409);
  result = await h.patch(session, { timer: { action: 'resume' } }); assert.equal(result.status, 200); session = result.body.session;
  assert.equal(session.timers[session.activeTimerId].running, false); assert.equal(session.timers[session.activeTimerId].remainingSeconds, 0);
  assert.equal((await h.patch(session, { cursor: { phase: 'response' } })).status, 409);
  const upgradedBackup = await h.backup();
  let restored = await h.api('/api/restore', { file: upload('original-legacy.zip', oldBackup) }); assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const restoredOld = await h.session(); assert.notEqual(restoredOld.writerToken, session.writerToken);
  result = await h.patch(restoredOld, { timer: { action: 'pause' } }); assert.equal(result.status, 200); assert.equal(result.body.session.timers[result.body.session.activeTimerId].remainingSeconds, 0);
  restored = await h.api('/api/restore', { file: upload('upgraded.zip', upgradedBackup) }); assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const restoredNew = await h.session(); assert.equal(restoredNew.timePolicyVersion, TIME_POLICY_VERSION);
  assert.equal(restoredNew.timePolicyUpgrade.previousRecordings.i1.recordingId, h.recordingId);
  const committed = await h.commit(restoredNew); assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(committed.body.attempts[0].recordingId, h.recordingId); assert.equal(committed.body.attempts[0].runContext.timerScope, 'question');
});

test('HTTP deadlines expire without a client expiry message and reject late changed answers', async t => {
  const h = await harness(t);
  const created = await h.api('/api/sessions', { sessionVersion: 2, libraryId: h.library.libraryId, groupId: 'interview', mode: 'practice', preset: { interviewSeconds: 1 } });
  assert.equal(created.status, 200);
  let result = await h.patch(created.body.session, { cursor: { phase: 'response' } }); assert.equal(result.status, 200);
  const session = result.body.session, cutoff = Date.parse(session.timers[session.activeTimerId].deadlineAt);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, cutoff + 80 - Date.now())));
  const read = await h.session(session.id); assert.equal(read.timers[read.activeTimerId].remainingSeconds, 0);
  assert.equal((await h.patch(read, { answers: { i1: 'This arrived after the server deadline.' } })).status, 409);
  assert.equal((await h.patch(read, { cursor: { phase: 'response' } })).status, 409);
  assert.deepEqual((await h.session(session.id)).answers, {});
});

test('HTTP delayed finalization binds one recording, survives backup and preserves previous audio hashes', async t => {
  const h = await harness(t, { legacy: true, consumedMs: 70000 });
  let result = await h.patch(await h.session(), { timer: { action: 'pause' } }); assert.equal(result.status, 200); let session = result.body.session;
  result = await h.patch(session, { cursor: { phase: 'saving' }, capturedAt: new Date().toISOString() }); assert.equal(result.status, 200, JSON.stringify(result.body)); session = result.body.session;
  const windowBefore = session.timers['response:question:i1'].recordingFinalization;
  assert.equal(windowBefore.initialRecordingId, h.recordingId);
  const saved = await h.api('/api/recordings', upload('finalized.wav', wave(2))); assert.equal(saved.status, 200);
  result = await h.patch(session, { answers: { i1: { recordingId: saved.body.recordingId } }, cursor: { phase: 'recorded' } }); assert.equal(result.status, 200, JSON.stringify(result.body)); session = result.body.session;
  const second = await h.api('/api/recordings', upload('another.wav', wave(3))); assert.equal(second.status, 200);
  assert.equal((await h.patch(session, { answers: { i1: { recordingId: second.body.recordingId } } })).status, 409);
  assert.equal((await h.patch(session, { cursor: { phase: 'response' } })).status, 409);
  assert.equal(session.timePolicyUpgrade.previousRecordings.i1.recordingId, h.recordingId);
  const beforeBlob = await fs.readFile(path.join(h.dataDir, 'blobs', h.mediaId)); assert.deepEqual(beforeBlob, wave());
  const backup = await h.backup(), restored = await h.api('/api/restore', { file: upload('finalized.zip', backup) }); assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const current = await h.session(); assert.equal(current.answers.i1.recordingId, saved.body.recordingId);
  assert.equal(current.timers['response:question:i1'].recordingFinalization.recordingId, saved.body.recordingId);
  assert.deepEqual(await fs.readFile(path.join(h.dataDir, 'blobs', h.mediaId)), beforeBlob);
});

test('HTTP restores reject modified policy caps or finalization windows before changing current state', async t => {
  const h = await harness(t, { legacy: true });
  let result = await h.patch(await h.session(), { timer: { action: 'pause' } }); assert.equal(result.status, 200);
  result = await h.patch(result.body.session, { cursor: { phase: 'saving' }, capturedAt: new Date().toISOString() }); assert.equal(result.status, 200);
  const backup = await h.backup(), before = canonicalJSON(await h.disk());
  for (const mutate of [
    timer => { timer.durationSeconds = 90; },
    timer => { timer.recordingFinalization.expiresAt = new Date(Date.parse(timer.recordingFinalization.expiresAt) + 60000).toISOString(); },
  ]) {
    const zip = await ZipFixture.from(backup), manifest = JSON.parse(zip.getEntry('practicebridge-backup.json').getData());
    mutate(manifest.state.sessions[0].timers['response:question:i1']);
    zip.updateFile('practicebridge-backup.json', Buffer.from(JSON.stringify(manifest)));
    const refused = await h.api('/api/restore', { file: upload('changed.zip', zip.toBuffer()) }); assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(canonicalJSON(await h.disk()), before);
  }
});

test('completed pre-policy v2 records and their original attempts remain unchanged through HTTP restore', async t => {
  const h = await harness(t, { finished: true }), before = await h.disk(), saved = before.sessions[0];
  assert.equal(saved.finished, true); assert.equal(saved.timePolicyVersion, undefined);
  const backup = await h.backup(), restored = await h.api('/api/restore', { file: upload('old-completed.zip', backup) }); assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const after = await h.disk(); assert.equal(canonicalJSON(after.sessions), canonicalJSON(before.sessions)); assert.equal(canonicalJSON(after.attempts), canonicalJSON(before.attempts));
  assert.equal((await h.patch(await h.session(), { timer: { action: 'resume' } })).status, 409);
  assert.equal(canonicalJSON((await h.disk()).sessions), canonicalJSON(before.sessions));
  assert.equal(JSON.parse((await readZip(backup)).get('practicebridge-backup.json')).state.sessions[0].timePolicyVersion, undefined);
});
