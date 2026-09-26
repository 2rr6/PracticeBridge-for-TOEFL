import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStore } from '../src/store.mjs';
import { canonicalJSON, contentHash, validatePackage } from '../src/package.mjs';
import { createExamSession, restoreExamSession } from '../src/exam-session.mjs';
import { startServer } from '../src/server.mjs';

// A real pre-policy shared clock and an authored recording. This exercises the
// migration cover and its two exits without touching learner data or a model.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(project, 'test-results'), { recursive: true });
const output = await fs.mkdtemp(path.join(project, 'test-results', 'exam-timing-interruption-'));
const dataDir = path.join(output, 'synthetic-data'), start = Date.now() - 180000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const hashes = async () => Object.fromEntries(await Promise.all(['public/exam-practice.mjs', 'public/exam-timing.mjs', 'src/exam-session.mjs'].map(async name => [name, digest(await fs.readFile(path.join(project, name)))])));
const report = { sourceBefore: await hashes(), checks: [], pageErrors: [], externalRequests: [], failedApiRequests: [], realModelCalls: 0 };
const pass = text => { report.checks.push(text); console.log('PASS ' + text); };
const bytes = Buffer.alloc(3244);
bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
for (let i = 0; i < 1600; i++) bytes.writeInt16LE(Math.round(Math.sin(i / 8000 * 2 * Math.PI * 440) * 1600), 44 + i * 2);
const source = 'Original legacy-clock browser fixture.';
const pack = validatePackage({ schemaVersion: 1, id: 'original-legacy-clock-ui', version: '1', title: 'Original saved Repeat', groups: [{
  id: 'repeat', section: 'speaking', taskKind: 'listen_repeat', title: 'Original two-item Repeat', passage: '',
  timing: { scope: 'task', durationSeconds: 80, prepareSeconds: 0, basis: 'document', source },
  questions: ['r1', 'r2'].map(id => ({ id, type: 'listen_repeat', prompt: 'Repeat the original sentence.', answer: 'The gate opens at nine.', audio: 'tone.wav', source })),
}] }).pack;
let instance, browser, page, original, seedId, library;
try {
  const store = await createStore({ dataDir }), blob = await store.writeBlob(bytes, 'audio/wav'), recordingId = crypto.randomUUID();
  library = { libraryId: crypto.randomUUID(), importedAt: new Date(start).toISOString(), originalPack: pack, mediaMap: { 'tone.wav': blob.id }, contentHash: contentHash(pack, { 'tone.wav': blob.id }) };
  await store.transact(state => {
    state.libraries.push(library); state.blobs[blob.id] = blob;
    state.recordings[recordingId] = { id: recordingId, mediaId: blob.id, name: 'original-saved.wav', createdAt: new Date(start).toISOString() };
    const run = createExamSession({ sessionVersion: 2, libraryId: library.libraryId, groupId: 'repeat', mode: 'practice', preset: 'untimed' }, state, { nowMs: start });
    seedId = run.id; delete run.timePolicyVersion; delete run.timePolicyUpgrade; delete run.lastUserActivityAt;
    const { moduleId, taskId } = run.cursor, timerId = `response:task:${taskId}`;
    assert.equal(run.planSnapshot.sections[0].modules[0].tasks[0].timing.scope, 'task');
    run.cursor.phase = 'response'; run.cursor.questionId = 'r1'; run.paused = true; run.updatedAt = new Date(start + 20000).toISOString();
    run.timers = { [timerId]: { id: timerId, scope: 'task', phase: 'response', ownerId: taskId, moduleId, taskId, questionId: null, durationSeconds: null, basis: 'user', source: '本轮选择不限时练习。', consumedMs: 20000, startedAt: new Date(start).toISOString(), runningSince: null, deadlineAt: null, expiredAt: null, paused: true, pausedAt: run.updatedAt, completed: false, completedAt: null } };
    run.activeTimerId = timerId;
    run.answers.r1 = { answer: '', recordingId, recordingUrl: `/api/media/${blob.id}`, transcript: '', transcriptConfirmed: false, attemptId: null };
    assert.doesNotThrow(() => restoreExamSession(run, state, { snapshotTime: new Date().toISOString() }));
    original = structuredClone(run);
  });
  await store.close();
  instance = await startServer({ dataDir, models: { publicSettings: () => ({ provider: 'none', capabilities: {} }), chat: () => { throw new Error('No model allowed'); }, feedback: () => { throw new Error('No model allowed'); } } });
  const api = async route => { const response = await fetch(instance.url + '/api' + route); assert.equal(response.status, 200); return response.json(); };
  const disk = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const readRun = async () => (await api(`/sessions/${seedId}`)).session;
  const url = `${instance.url}/#exam/${library.libraryId}/${original.planSnapshot.id}/all/practice/${seedId}`;
  browser = await chromium.launch({ channel: process.env.PRACTICEBRIDGE_BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, serviceWorkers: 'block' });
  await context.route('**/*', route => { const target = new URL(route.request().url()); if (['http:', 'https:'].includes(target.protocol) && target.origin !== instance.url) { report.externalRequests.push(target.href); return route.abort(); } return route.continue(); });
  await context.addInitScript(() => { window.__unexpectedMicrophoneCalls = 0; navigator.mediaDevices.getUserMedia = async () => { window.__unexpectedMicrophoneCalls++; throw new Error('A saved run must not open the microphone'); }; });
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) report.failedApiRequests.push({ url: response.url(), status: response.status() }); });
  await page.goto(url); await page.locator('#exam-new-round').waitFor();
  assert.match(await page.locator('.exam-pause-cover').innerText(), /草稿|录音/);
  assert.equal(await page.locator('#exam-resume').count(), 0);
  assert.equal(await page.locator('#exam-time').innerText(), '计时中断');
  assert.equal(await page.locator('#exam-pause').isDisabled(), true);
  for (const id of ['#exam-next', '#exam-back', '#exam-review']) if (await page.locator(id).count()) assert.equal(await page.locator(id).isDisabled(), true);
  assert.equal(await page.locator('#exam-coach-pill').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__unexpectedMicrophoneCalls), 0);
  const interrupted = await readRun();
  assert.equal(interrupted.timingInterruption.reason, 'shared_speaking_timer');
  assert.equal(canonicalJSON(interrupted.timingInterruption.previousTimers), canonicalJSON(original.timers));
  assert.equal(canonicalJSON(interrupted.answers), canonicalJSON(original.answers));
  assert.equal(canonicalJSON(interrupted.planSnapshot), canonicalJSON(original.planSnapshot));
  assert.equal(interrupted.activeTimerId, null); assert.equal(interrupted.timers['response:question:r1'], undefined);
  await page.screenshot({ path: path.join(output, '01-preserved-old-clock.png'), fullPage: true });
  pass('Opening a saved shared speaking clock shows its interruption cover, disables continuation and AI, and preserves answers and the complete old timer');

  await page.locator('#exam-paused-exit').click(); await page.locator('.exam-library-table').waitFor();
  assert.equal((await api('/state')).sessions.length, 1);
  await page.goto(url); await page.locator('#exam-new-round').waitFor();
  assert.equal(canonicalJSON((await readRun()).timingInterruption), canonicalJSON(interrupted.timingInterruption));
  assert.equal(await page.evaluate(() => window.__unexpectedMicrophoneCalls), 0);
  pass('Save and exit, then reopen, retains the same interruption evidence and creates no extra session or microphone request');

  await page.locator('#exam-new-round').click();
  await page.waitForFunction(oldId => { const shell = document.querySelector('.exam-shell'); return shell?.dataset.sessionId && shell.dataset.sessionId !== oldId && shell.dataset.phase === 'instructions'; }, seedId);
  const nextId = await page.locator('.exam-shell').getAttribute('data-session-id'), next = (await api(`/sessions/${nextId}`)).session;
  const after = await disk(), savedOld = after.sessions.find(run => run.id === seedId);
  assert.equal(after.sessions.length, 2); assert.equal(next.timePolicyVersion, 2); assert.equal(next.timingInterruption, undefined);
  assert.deepEqual(next.answers, {}); assert.equal(next.paused, false);
  assert.equal(canonicalJSON(savedOld.answers), canonicalJSON(original.answers));
  assert.equal(canonicalJSON(savedOld.timingInterruption), canonicalJSON(interrupted.timingInterruption));
  assert.equal(canonicalJSON(after.libraries[0]), canonicalJSON(library));
  assert.equal(after.attempts.length, 0); assert.equal(Object.keys(after.recordings).length, 1);
  assert.deepEqual(Buffer.from(await (await fetch(instance.url + savedOld.answers.r1.recordingUrl)).arrayBuffer()), bytes);
  assert.equal(await page.evaluate(() => window.__unexpectedMicrophoneCalls), 0);
  await page.screenshot({ path: path.join(output, '02-new-round-old-recording-retained.png'), fullPage: true });
  pass('New round opens fresh instructions while the old session, recording bytes and source library remain intact, without fabricating attempts');
  report.details = { originalSessionId: seedId, newSessionId: nextId, recordingId, recordingSha256: digest(bytes), interruption: savedOld.timingInterruption };
  report.sourceAfter = await hashes(); assert.deepEqual(report.sourceAfter, report.sourceBefore);
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.failedApiRequests, []);
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close(); await instance?.close();
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log('RESULT_DIR ' + output); if (!report.ok) console.error(report.failure);
}
