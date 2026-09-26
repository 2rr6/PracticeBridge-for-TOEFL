import {appFetch} from './auth-client.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import ZipFixture from './helpers/zip-fixture.mjs';
import { startServer } from '../src/server.mjs';
import { validatePackage, parseNativeImport, decodeUpload, readZip, identifyMedia, createPackageZip } from '../src/package.mjs';
import { atomicWrite, createStore, gradeAnswer } from '../src/store.mjs';

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/.core-tests');
const wav = () => {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  return bytes;
};
const upload = (name, bytes) => ({ name, data: (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).toString('base64') });
const fixture = () => ({
  schemaVersion: 1, id: 'original-fixture', version: '1', title: 'Original synthetic test fixture', description: 'Written solely for automated integrity tests.', rights: 'Original test material.',
  groups: [{ id: 'reading', section: 'reading', title: 'A small garden', passage: 'The garden opens at nine.', audio: null, image: null, questions: [
    { id: 'choice', type: 'single_choice', prompt: 'When does it open?', options: [{ id: 'A', text: 'At nine.' }, { id: 'B', text: 'At ten.' }], answer: 'A', explanation: 'The passage states nine.', source: 'The garden opens at nine.' },
    { id: 'blank', type: 'fill_blank', prompt: 'Write the time.', answer: ['nine', '9'], source: 'nine' },
    { id: 'unknown', type: 'single_choice', prompt: 'No answer was supplied.', options: [{ id: 'A', text: 'One' }, { id: 'B', text: 'Two' }], answer: null },
  ] }, { id: 'writing', section: 'writing', title: 'A short email', passage: '', questions: [
    { id: 'email', type: 'email', prompt: 'Invite a friend to the garden.', source: 'Original synthetic prompt.' },
  ] }, { id: 'speaking', section: 'speaking', title: 'Repeat a sentence', passage: '', questions: [
    { id: 'repeat', type: 'listen_repeat', prompt: 'Repeat the sentence.', answer: 'The garden opens at nine.', source: 'Original synthetic test fixture, speaking group.' },
  ] }],
});
const mockModels = (feedback = async () => ({ summary: 'A source-bound test response.', strengths: [], corrections: [], revisedAnswer: '', modelAnswer: '', nextSteps: [], limitations: [], provider: 'mock', model: 'local-fixture' })) => ({
  publicSettings: () => ({ provider: 'none', hasApiKey: false }),
  updateSettings: () => ({ provider: 'none', hasApiKey: false }),
  feedback,
  test: async () => ({ ok: false, detail: 'No live request in tests.' }),
  chat: async () => ({ reply: 'Local test response.', provider: 'mock', model: 'local-fixture' }),
});
async function temporaryDirectory(t) {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, 'run-'));
  t.after(async () => {
    const checked = path.resolve(directory);
    assert.ok(checked.startsWith(`${TEST_ROOT}${path.sep}`), 'Only remove an explicitly verified test directory');
    await fs.rm(checked, { recursive: true, force: true });
  });
  return directory;
}
async function harness(t, models = mockModels()) {
  // The cleanup is one hook so the listener and state writer finish before removing files.
  await fs.mkdir(TEST_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(TEST_ROOT, 'http-'));
  const h = { dataDir, instance: await startServer({ dataDir, models }) };
  h.api = async (route, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const response = await appFetch(`${h.instance.url}${route}`, {
      method, headers: { 'X-PracticeBridge': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  h.import = async pack => {
    const preview = await h.api('/api/import/preview', { files: [upload('practicebridge.json', JSON.stringify(pack))] });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const commit = await h.api('/api/import/commit', { draftId: preview.body.draftId, pack: preview.body.pack, acknowledged: true });
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    return commit.body.library;
  };
  h.submit = (libraryId, questionId, answer, extras = {}) => h.api('/api/attempts', { libraryId, questionId, answer, mode: 'practice', assisted: false, durationSeconds: 12, submissionId: crypto.randomUUID(), ...extras });
  t.after(async () => {
    await h.instance.close();
    const checked = path.resolve(dataDir);
    assert.ok(checked.startsWith(`${TEST_ROOT}${path.sep}`));
    await fs.rm(checked, { recursive: true, force: true });
  });
  return h;
}
async function waitFor(h, predicate, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await h.api('/api/state');
    if (predicate(result.body)) return result.body;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for local test state');
}

test('objective grading is conservative, including missing keys and punctuation', () => {
  const result = validatePackage(fixture());
  assert.equal(result.issues.filter(item => item.severity === 'error').length, 0);
  const [choice, blank, unknown] = result.pack.groups[0].questions;
  assert.equal(gradeAnswer(choice, 'A').status, 'correct');
  assert.equal(gradeAnswer(choice, '').status, 'unanswered');
  assert.equal(gradeAnswer(blank, '  NINE\n').status, 'correct');
  assert.equal(gradeAnswer(blank, 'nine.').status, 'incorrect');
  assert.deepEqual(gradeAnswer(unknown, 'A'), { status: 'unscored', correct: null, total: null });
  const order = { type: 'sentence_order', answer: ['a', 'b'] };
  assert.equal(gradeAnswer(order, ['a', 'b']).status, 'correct');
  assert.equal(gradeAnswer(order, ['b', 'a']).status, 'incorrect');
  assert.equal(gradeAnswer(result.pack.groups[1].questions[0], 'A clear email.').status, 'unscored');
});

test('package validation rejects broken media references, duplicate IDs and disguised files', () => {
  const pack = fixture();
  pack.groups[0].audio = 'audio/passage.wav';
  pack.groups[0].questions[1].id = 'choice';
  let result = validatePackage(pack);
  assert.ok(result.issues.some(item => item.message.includes('找不到明确引用')));
  assert.ok(result.issues.some(item => item.message.includes('必须唯一')));
  result = validatePackage(pack, new Map([['audio/passage.wav', Buffer.from('<html>not audio</html>')]]));
  assert.ok(result.issues.some(item => item.message.includes('媒体内容与文件类型不符')));
  assert.equal(identifyMedia('passage.wav', wav()).mime, 'audio/wav');
  assert.equal(identifyMedia('passage.html', wav()), null);
  assert.throws(() => decodeUpload({ name: 'x.wav', data: '%%%%' }), /编码/);
  assert.throws(() => decodeUpload(upload('../x.wav', wav())), /路径/);
});

test('ZIP intake never extracts to a filesystem and rejects traversal, symlinks and duplicate names', async () => {
  const archive = new ZipFixture();
  archive.addFile('xx/escape.txt', Buffer.from('inert'));
  const unsafe = archive.toBuffer();
  let offset = 0;
  while ((offset = unsafe.indexOf('xx/escape.txt', offset)) >= 0) {
    unsafe.write('../escape.txt', offset); offset += 13;
  }
  await assert.rejects(async () => (await readZip(unsafe)), /路径/);
  const linked = new ZipFixture();
  linked.addFile('link.wav', wav());
  linked.getEntry('link.wav').header.attr = (0xa1ff << 16) >>> 0;
  await assert.rejects(async () => (await readZip(linked.toBuffer())), /符号链接/);
  const duplicates = new ZipFixture();
  duplicates.addFile('audio.wav', wav()); duplicates.addFile('AUDIO.wav', wav());
  await assert.rejects(async () => (await readZip(duplicates.toBuffer())), /重复/);
  const source = await fs.readFile(new URL('../src/package.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.extract(?:AllTo|EntryTo)\s*\(/, 'Archive intake must never invoke filesystem extraction');
});

test('atomic store transactions serialize and failed mutations preserve the committed state', async t => {
  const dataDir = await temporaryDirectory(t);
  const store = await createStore({ dataDir });
  await Promise.all(Array.from({ length: 10 }, (_, index) => store.transact(state => { state.sessions.push({ id: String(index) }); })));
  assert.equal(store.read().sessions.length, 10);
  await assert.rejects(store.transact(state => { state.sessions = []; throw new Error('planned rollback'); }), /planned rollback/);
  assert.equal(store.read().sessions.length, 10);
  const reopened = await createStore({ dataDir });
  assert.equal(reopened.read().sessions.length, 10);
  const snapshot = reopened.read(); snapshot.sessions.length = 0;
  assert.equal(reopened.read().sessions.length, 10);
  await store.close(); await reopened.close();
});

test('Windows sharing errors retry the same prepared rename without replaying a store mutation', async t => {
  const dataDir = await temporaryDirectory(t);
  const destination = path.join(dataDir, 'state.json');
  let injecting = false;
  let oldBytes;
  let preparedBytes;
  const renames = [];
  const delays = [];
  const errors = ['EPERM', 'EACCES', 'EBUSY'];
  const injectedErrors = [];
  const actualErrors = [];
  let successfulRenames = 0;
  const store = await createStore({
    dataDir,
    atomicWriter: (filename, bytes) => atomicWrite(filename, bytes, {
      platform: 'win32',
      rename: async (from, to) => {
        if (!injecting) return fs.rename(from, to);
        renames.push({ from, to });
        assert.equal(to, destination);
        assert.deepEqual(await fs.readFile(to), oldBytes, 'The committed destination remains readable and unchanged until rename succeeds');
        const staged = await fs.readFile(from);
        preparedBytes ??= staged;
        assert.deepEqual(staged, preparedBytes, 'Every retry uses the exact same prepared bytes');
        assert.equal(from, renames[0].from, 'Every retry uses the exact same temporary path');
        if (injectedErrors.length < errors.length) {
          const code = errors[injectedErrors.length]; injectedErrors.push(code);
          throw Object.assign(new Error('Synthetic Windows sharing conflict'), { code });
        }
        try { await fs.rename(from, to); successfulRenames += 1; }
        catch (error) { actualErrors.push(error.code); throw error; }
      },
      sleep: async delay => {
        delays.push(delay);
        assert.deepEqual(await fs.readFile(destination), oldBytes, 'The old target is never unlinked during backoff');
      },
    }),
  });
  oldBytes = await fs.readFile(destination);
  injecting = true;
  let mutations = 0;
  await store.transact(state => { mutations += 1; state.sessions.push({ id: 'recovered-write' }); });
  assert.equal(mutations, 1);
  assert.deepEqual(injectedErrors, errors, 'Exactly the three intended sharing errors were injected');
  assert.equal(successfulRenames, 1, 'The prepared write ultimately completed once');
  assert.ok(actualErrors.every(code => errors.includes(code)), 'Only real retryable sharing errors may add attempts');
  assert.equal(renames.length, injectedErrors.length + actualErrors.length + successfulRenames);
  assert.ok(renames.length >= 4 && renames.length <= 6, 'Actual filesystem retries remain within the existing five-backoff bound');
  assert.deepEqual(delays, [20, 40, 80, 160, 320].slice(0, renames.length - 1));
  assert.equal(store.read().sessions[0].id, 'recovered-write');
  assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).sessions[0].id, 'recovered-write');
  assert.deepEqual(await fs.readFile(destination), preparedBytes, 'The final file contains every byte of the prepared write');
  assert.equal((await fs.readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
  await store.close();
});

test('permanent Windows rename failure is bounded, removes only its temp and leaves disk and memory unchanged', async t => {
  const dataDir = await temporaryDirectory(t);
  const destination = path.join(dataDir, 'state.json');
  let injecting = false;
  let oldBytes;
  const renames = [];
  const delays = [];
  const store = await createStore({
    dataDir,
    atomicWriter: (filename, bytes) => atomicWrite(filename, bytes, {
      platform: 'win32',
      rename: async (from, to) => {
        if (!injecting) return fs.rename(from, to);
        renames.push({ from, to });
        assert.equal(from, renames[0].from);
        assert.equal(to, destination);
        assert.deepEqual(await fs.readFile(to), oldBytes);
        throw Object.assign(new Error('Synthetic persistent sharing failure'), { code: 'EPERM' });
      },
      sleep: async delay => { delays.push(delay); assert.deepEqual(await fs.readFile(destination), oldBytes); },
    }),
  });
  oldBytes = await fs.readFile(destination);
  const oldState = store.read();
  injecting = true;
  let mutations = 0;
  await assert.rejects(store.transact(state => { mutations += 1; state.sessions.push({ id: 'must-not-commit' }); }), { code: 'EPERM' });
  assert.equal(mutations, 1);
  assert.equal(renames.length, 6);
  assert.deepEqual(delays, [20, 40, 80, 160, 320]);
  assert.ok(delays.reduce((total, delay) => total + delay, 0) < 1000);
  assert.deepEqual(store.read(), oldState);
  assert.deepEqual(await fs.readFile(destination), oldBytes);
  assert.equal((await fs.readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
  injecting = false;
  await store.transact(state => { state.sessions.push({ id: 'later-successful-write' }); });
  assert.deepEqual(store.read().sessions, [{ id: 'later-successful-write' }], 'A failed write does not poison later transactions or leak its uncommitted mutation');
  await store.close();
});

test('atomic rename does not retry unrelated errors or non-Windows permission failures', async t => {
  const dataDir = await temporaryDirectory(t);
  for (const [index, scenario] of [{ platform: 'win32', code: 'ENOSPC' }, { platform: 'linux', code: 'EPERM' }].entries()) {
    const destination = path.join(dataDir, `unchanged-${index}.json`);
    await fs.writeFile(destination, 'original committed data');
    let calls = 0;
    let sleeps = 0;
    await assert.rejects(atomicWrite(destination, 'uncommitted replacement', {
      platform: scenario.platform,
      rename: async () => { calls += 1; throw Object.assign(new Error('Synthetic nonretryable failure'), { code: scenario.code }); },
      sleep: async () => { sleeps += 1; },
    }), { code: scenario.code });
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
    assert.equal(await fs.readFile(destination, 'utf8'), 'original committed data');
  }
  assert.equal((await fs.readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
});

test('loopback API rejects foreign Host, Origin and missing write marker', async t => {
  const h = await harness(t);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${h.instance.url}/api/state`, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  const foreignOrigin = await h.api('/api/state', undefined, 'GET', { Origin: 'https://attacker.example' });
  assert.equal(foreignOrigin.status, 403);
  const missingMarker = await h.api('/api/import/preview', {}, 'POST', { 'X-PracticeBridge': '' });
  assert.equal(missingMarker.status, 403);
  const state = await h.api('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('access-control-allow-origin'), null);
  assert.ok(state.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  await assert.rejects(startServer({ dataDir: h.dataDir, host: '0.0.0.0' }), /127\.0\.0\.1/);
});

test('native media package import is explicit, atomic, idempotent and exportable', async t => {
  const h = await harness(t);
  const pack = fixture(); pack.groups[0].audio = 'audio/garden.wav';
  const files = new Map([['audio/garden.wav', wav()], ['audio/unused.wav', wav()]]);
  const zip = await ZipFixture.from((await createPackageZip(validatePackage(pack, files).pack, files)));
  zip.addFile('notes-private.txt', Buffer.from('not referenced; must not enter library export'));
  const preview = await h.api('/api/import/preview', { files: [upload('garden.zip', zip.toBuffer())] });
  assert.equal(preview.status, 200);
  assert.equal((await h.api('/api/state')).body.libraries.length, 0);
  const invalid = structuredClone(preview.body.pack); invalid.groups[0].audio = 'missing.wav';
  assert.equal((await h.api('/api/import/commit', { draftId: preview.body.draftId, pack: invalid, acknowledged: true })).status, 400);
  assert.equal((await h.api('/api/state')).body.libraries.length, 0);
  const request = { draftId: preview.body.draftId, pack: preview.body.pack, acknowledged: true };
  const first = await h.api('/api/import/commit', request);
  const again = await h.api('/api/import/commit', request);
  assert.equal(first.body.library.libraryId, again.body.library.libraryId);
  assert.match(first.body.library.groups[0].audio, /^\/api\/media\/[a-f0-9]{64}$/);
  const media = await appFetch(h.instance.url + first.body.library.groups[0].audio, { headers: { Range: 'bytes=0-3' } });
  assert.equal(media.status, 206); assert.equal(await media.text(), 'RIFF');
  const exported = await appFetch(`${h.instance.url}/api/library/${first.body.library.libraryId}/export`);
  const exportedBytes = Buffer.from(await exported.arrayBuffer());
  const contents = (await readZip(exportedBytes));
  assert.deepEqual([...contents.keys()].sort(), ['audio/garden.wav', 'practicebridge.json']);
  assert.equal(JSON.parse(contents.get('practicebridge.json')).groups[0].audio, 'audio/garden.wav');
  assert.equal((await parseNativeImport([upload('export.zip', exportedBytes)])).pack.groups[0].audio, 'audio/garden.wav');
});

test('submissions are immutable, source-bound, deduplicated and identify repeat attempts', async t => {
  const h = await harness(t);
  const library = await h.import(fixture());
  const extras = { submissionId: 'repeat-safe-submission' };
  const first = await h.submit(library.libraryId, 'choice', 'A', extras);
  assert.equal(first.body.attempt.kind, 'first');
  assert.equal(first.body.attempt.objective.status, 'correct');
  const duplicate = await h.submit(library.libraryId, 'choice', 'A', extras);
  assert.equal(duplicate.body.attempt.id, first.body.attempt.id);
  const conflict = await h.submit(library.libraryId, 'choice', 'B', extras);
  assert.equal(conflict.status, 409);
  const retry = await h.submit(library.libraryId, 'choice', 'B');
  assert.equal(retry.body.attempt.kind, 'retry');
  assert.equal((await h.api(`/api/attempts/${first.body.attempt.id}`, { answer: 'B' }, 'PATCH')).status, 400);
  assert.equal((await h.api(`/api/attempts/${first.body.attempt.id}`, { reviewed: true }, 'PATCH')).body.attempt.reviewed, true);
  const revisedPack = fixture(); revisedPack.groups[0].passage = 'A changed source, imported separately.';
  const other = await h.import(revisedPack);
  assert.notEqual(other.libraryId, library.libraryId);
  const original = (await h.api('/api/state')).body.attempts.find(item => item.id === first.body.attempt.id);
  assert.equal(original.questionSnapshot.passage, 'The garden opens at nine.');
  assert.equal(original.sourceHash, library.contentHash);
  const unknown = await h.submit(library.libraryId, 'unknown', 'A');
  assert.equal(unknown.body.attempt.objective.status, 'unscored');
});

test('recordings must be saved first and sessions resume with their own timer and sources', async t => {
  const h = await harness(t);
  const library = await h.import(fixture());
  const bad = await h.submit(library.libraryId, 'repeat', '', { recordingId: crypto.randomUUID() });
  assert.equal(bad.status, 400); assert.equal((await h.api('/api/state')).body.attempts.length, 0);
  assert.equal((await h.api('/api/recordings', upload('record.wav', '<script>not recording</script>'))).status, 400);
  const recording = (await h.api('/api/recordings', upload('record.wav', wav()))).body;
  const submitted = await h.submit(library.libraryId, 'repeat', '', { recordingId: recording.recordingId, transcript: 'The garden opens at nine.', transcriptConfirmed: true });
  assert.equal(submitted.status, 200);
  const session = await h.api('/api/sessions', { libraryId: library.libraryId, groupId: 'speaking', mode: 'exam', answers: { repeat: { answer: '', recordingId: recording.recordingId, recordingUrl: 'https://untrusted.invalid', transcript: 'The garden opens at nine.', transcriptConfirmed: true, attemptId: submitted.body.attempt.id } }, currentIndex: 0, remainingSeconds: 11, assisted: false });
  assert.equal(session.status, 200);
  assert.equal(session.body.session.answers.repeat.recordingUrl, recording.url);
  await h.instance.close();
  h.instance = await startServer({ dataDir: h.dataDir, models: mockModels() });
  const resumed = (await h.api('/api/state')).body.sessions[0];
  assert.equal(resumed.remainingSeconds, 11); assert.equal(resumed.mode, 'exam');
  const audio = await appFetch(h.instance.url + recording.url);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav());
  assert.equal((await h.api(`/api/sessions/${resumed.id}`, { finished: true }, 'PATCH')).status, 200);
  assert.equal((await h.api('/api/state')).body.sessions.length, 0);
});

test('feedback jobs run serially and append only to their captured attempt; failure leaves grading intact', async t => {
  let active = 0; let maximum = 0; const calls = [];
  const h = await harness(t, mockModels(async ({ attempt }) => {
    active += 1; maximum = Math.max(maximum, active); calls.push(attempt.id);
    await new Promise(resolve => setTimeout(resolve, 30));
    active -= 1;
    if (attempt.answer === 'B') throw new Error('Deliberate provider failure');
    return { summary: `Feedback for ${attempt.id}`, strengths: [], corrections: [{ quote: 'invented quote', issue: 'Not grounded', suggestion: 'Remove', category: 'error' }], revisedAnswer: '', modelAnswer: '', nextSteps: [], limitations: [], provider: 'mock', model: 'test' };
  }));
  const library = await h.import(fixture());
  const a = (await h.submit(library.libraryId, 'choice', 'A')).body.attempt;
  const b = (await h.submit(library.libraryId, 'choice', 'B')).body.attempt;
  const first = await h.api(`/api/attempts/${a.id}/feedback`, { consent: true });
  const repeated = await h.api(`/api/attempts/${a.id}/feedback`, { consent: true });
  assert.equal(first.body.job.id, repeated.body.job.id);
  await h.api(`/api/attempts/${b.id}/feedback`, { consent: true });
  const state = await waitFor(h, state => state.jobs.length === 2 && state.jobs.every(job => ['completed', 'failed'].includes(job.status)));
  assert.equal(maximum, 1); assert.deepEqual(calls, [a.id, b.id]);
  const savedA = state.attempts.find(item => item.id === a.id);
  const savedB = state.attempts.find(item => item.id === b.id);
  assert.equal(savedA.evaluations.length, 1); assert.equal(savedB.evaluations.length, 0);
  assert.equal(savedA.evaluations[0].corrections.length, 0);
  assert.ok(savedA.evaluations[0].summary.includes(a.id));
  assert.equal(savedB.objective.status, 'incorrect');
  assert.ok(state.jobs.find(job => job.attemptId === b.id).error.includes('Deliberate'));
});

test('speaking feedback needs confirmed text and preserves source repeat constraints and attempt text', async t => {
  const h = await harness(t, mockModels(async () => ({ summary: 'Text comparison.', strengths: [], corrections: [], revisedAnswer: 'Invented change', modelAnswer: 'Invented model answer', nextSteps: [], limitations: [], provider: 'mock', model: 'test' })));
  const library = await h.import(fixture());
  const attempt = (await h.submit(library.libraryId, 'repeat', '', { transcript: 'Initial transcript', transcriptConfirmed: false })).body.attempt;
  assert.equal((await h.api(`/api/attempts/${attempt.id}/feedback`, { consent: true })).status, 400);
  assert.equal((await h.api(`/api/attempts/${attempt.id}/feedback`, { consent: true, transcript: 'The garden opens at nine.', transcriptConfirmed: true })).status, 200);
  const state = await waitFor(h, state => state.jobs[0]?.status === 'completed');
  const saved = state.attempts[0];
  assert.equal(saved.transcript, 'Initial transcript'); assert.equal(saved.transcriptConfirmed, false);
  assert.equal(saved.evaluations[0].inputTranscript, 'The garden opens at nine.');
  assert.equal(saved.evaluations[0].revisedAnswer, 'The garden opens at nine.');
  assert.equal(saved.evaluations[0].modelAnswer, '');
  assert.ok(saved.evaluations[0].limitations.some(item => item.includes('不能判断发音')));
  const missingTarget = fixture(); missingTarget.id = 'missing-target'; missingTarget.groups[2].questions[0].answer = null;
  const other = await h.import(missingTarget);
  const unverified = (await h.submit(other.libraryId, 'repeat', '', { transcript: 'The garden opens at nine.', transcriptConfirmed: true })).body.attempt;
  assert.equal((await h.api(`/api/attempts/${unverified.id}/feedback`, { consent: true })).status, 400, 'Provenance and task instructions must not substitute for the missing target sentence');
});

test('queued feedback refuses a provider change instead of reusing earlier consent', async t => {
  let selectedModel = 'model-a';
  let release;
  let calls = 0;
  const models = mockModels(async () => {
    calls += 1;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return { summary: 'Feedback already started under the original settings.', strengths: [], corrections: [], revisedAnswer: '', modelAnswer: '', nextSteps: [], limitations: [], provider: 'mock', model: 'model-a' };
  });
  models.publicSettings = () => ({ provider: 'compatible', baseUrl: 'https://test.invalid/v1', model: selectedModel });
  models.updateSettings = input => { selectedModel = input.model; return models.publicSettings(); };
  const h = await harness(t, models);
  const library = await h.import(fixture());
  const first = (await h.submit(library.libraryId, 'choice', 'A')).body.attempt;
  const second = (await h.submit(library.libraryId, 'blank', 'nine')).body.attempt;
  await h.api(`/api/attempts/${first.id}/feedback`, { consent: true });
  await waitFor(h, state => state.jobs[0]?.status === 'running' && release);
  await h.api(`/api/attempts/${second.id}/feedback`, { consent: true });
  await h.api('/api/settings', { model: 'model-b' });
  release();
  const state = await waitFor(h, state => state.jobs.length === 2 && state.jobs.every(job => ['completed', 'failed'].includes(job.status)));
  assert.equal(calls, 1);
  assert.equal(state.jobs.find(job => job.attemptId === second.id).status, 'failed');
  assert.ok(state.jobs.find(job => job.attemptId === second.id).error.includes('此请求未发送'));
});

test('backup restore validates everything before replacing state and preserves a snapshot', async t => {
  const h = await harness(t);
  const library = await h.import(fixture());
  await h.submit(library.libraryId, 'choice', 'A');
  const recording = (await h.api('/api/recordings', upload('take.wav', wav()))).body;
  await h.submit(library.libraryId, 'repeat', '', { recordingId: recording.recordingId, transcript: 'The garden opens at nine.', transcriptConfirmed: true });
  await h.api(`/api/attempts/${(await h.api('/api/state')).body.attempts[1].id}/feedback`, { consent: true });
  await waitFor(h, state => state.jobs[0]?.status === 'completed');
  const response = await appFetch(`${h.instance.url}/api/backup`);
  assert.equal(response.status, 200);
  const backup = Buffer.from(await response.arrayBuffer());
  const contents = (await readZip(backup));
  const manifest = JSON.parse(contents.get('practicebridge-backup.json'));
  assert.equal(manifest.state.settings, undefined); assert.equal(manifest.state.apiKey, undefined);
  assert.ok(![...contents.keys()].some(name => /settings|auth|key/i.test(name)));
  await h.submit(library.libraryId, 'choice', 'B');
  const tampered = await ZipFixture.from(backup);
  const changed = structuredClone(manifest); changed.state.attempts[0].answer = 'B';
  tampered.updateFile('practicebridge-backup.json', Buffer.from(JSON.stringify(changed)));
  const invalid = await h.api('/api/restore', { file: upload('tampered.zip', tampered.toBuffer()) });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal((await h.api('/api/state')).body.attempts.length, 3);
  // ZIP32/deflate with sizes in local headers, matching the former writer's
  // container convention; the manifest remains the existing v1 backup contract.
  const legacyContainer = new ZipFixture();
  for (const [name, bytes] of contents) legacyContainer.addFile(name, bytes);
  assert.deepEqual(await readZip(legacyContainer.toBuffer()), contents);
  const restored = await h.api('/api/restore', { file: upload('backup.zip', legacyContainer.toBuffer()) });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal((await h.api('/api/state')).body.attempts.length, 2);
  const roundTrip = JSON.parse((await readZip(Buffer.from(await (await fetch(h.instance.url + '/api/backup')).arrayBuffer()))).get('practicebridge-backup.json'));
  assert.deepEqual(roundTrip.state.libraries.map(item => [item.libraryId, item.contentHash, item.mediaMap]), manifest.state.libraries.map(item => [item.libraryId, item.contentHash, item.mediaMap]));
  assert.deepEqual(roundTrip.state.attempts, manifest.state.attempts);
  assert.deepEqual(roundTrip.state.recordings, manifest.state.recordings);
  const snapshots = await fs.readdir(path.join(h.dataDir, 'backups'));
  assert.equal(snapshots.length, 1);
  const before = (await readZip(await fs.readFile(path.join(h.dataDir, 'backups', snapshots[0]))));
  assert.equal(JSON.parse(before.get('practicebridge-backup.json')).state.attempts.length, 3);
});

test('restore interrupts an outstanding feedback request and keeps its unknown late reply out of restored data',async t=>{
  let release,entered;const held=new Promise(resolve=>release=resolve),arrived=new Promise(resolve=>entered=resolve);let calls=0;
  const h=await harness(t,mockModels(async()=>{calls++;entered();return held;}));
  t.after(()=>release({summary:'Late synthetic reply',strengths:[],corrections:[],revisedAnswer:'',modelAnswer:'',nextSteps:[],limitations:[],provider:'mock',model:'local-fixture'}));
  const library=await h.import(fixture()),attempt=(await h.submit(library.libraryId,'choice','A')).body.attempt;
  await h.api(`/api/attempts/${attempt.id}/feedback`,{consent:true});await arrived;
  const backup=Buffer.from(await(await fetch(h.instance.url+'/api/backup')).arrayBuffer());
  const result=await h.api('/api/restore',{file:upload('self-authored-backup.zip',backup)});assert.equal(result.status,200,JSON.stringify(result.body));
  release({summary:'Late synthetic reply',strengths:[],corrections:[],revisedAnswer:'',modelAnswer:'',nextSteps:[],limitations:[],provider:'mock',model:'local-fixture'});
  await new Promise(setImmediate);const state=(await h.api('/api/state')).body;assert.equal(state.attempts[0].evaluations.length,0);assert.equal(state.jobs[0].status,'interrupted');assert.equal(calls,1);
});

test('an asynchronous ZIP preview cannot publish a stale draft after backup restoration', { timeout: 4000 }, async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const models = mockModels();
  models.structure = async () => { entered(); await held; return { pack: fixture() }; };
  const h = await harness(t, models);
  const backup = Buffer.from(await (await fetch(h.instance.url + '/api/backup')).arrayBuffer());
  const zip = new ZipFixture(); zip.addFile('source.txt', Buffer.from('Original question evidence for the local model stub.'));
  const pending = h.api('/api/import/preview', { files: [upload('source.zip', zip.toBuffer())], useAI: true, consent: true });
  await started;
  try { assert.equal((await h.api('/api/restore', { file: upload('backup.zip', backup) })).status, 200); }
  finally { release(); }
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.draftId, undefined);
});

test('unfinished feedback jobs are marked interrupted on restart and never resent automatically', async t => {
  let calls = 0;
  const h = await harness(t, mockModels(async () => { calls += 1; throw new Error('Should not run'); }));
  const library = await h.import(fixture());
  const attempt = (await h.submit(library.libraryId, 'choice', 'A')).body.attempt;
  await h.instance.close();
  const filename = path.join(h.dataDir, 'state.json');
  const state = JSON.parse(await fs.readFile(filename, 'utf8'));
  state.jobs.push({ id: crypto.randomUUID(), attemptId: attempt.id, status: 'running', createdAt: new Date().toISOString(), request: { transcript: '', transcriptConfirmed: false } });
  await fs.writeFile(filename, JSON.stringify(state));
  h.instance = await startServer({ dataDir: h.dataDir, models: mockModels(async () => { calls += 1; throw new Error('Should not run'); }) });
  assert.equal((await h.api('/api/state')).body.jobs[0].status, 'interrupted');
  assert.equal(calls, 0);
});
