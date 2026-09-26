import {appFetch} from './auth-client.mjs';
// Run: node tests/exam-repeat-scope-ui.mjs
// Original two-question fixture; Chromium synthetic microphone; no real model.
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import { canonicalJSON } from '../src/package.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), testRoot = path.join(project, 'test-results');
await fs.mkdir(testRoot, { recursive: true });
const run = await fs.mkdtemp(path.join(testRoot, 'exam-repeat-scope-')), dataDir = path.join(run, 'data');
const checks = [], recordings = [], errors = [], externalRequests = [];
const pass = label => { checks.push(label); console.log('PASS ' + label); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceHashes = async () => Object.fromEntries(await Promise.all(['public/exam-timing.mjs', 'public/exam-practice.mjs', 'src/exam-session.mjs'].map(async name => [name, hash(await fs.readFile(path.join(project, name)))])));
const sourceBefore = await sourceHashes();
let instance, browser, context, page, sessionId, currentCase = 'initialization';

function tone() {
  const rate = 16000, frames = 4000, bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 330 * i / rate) * 2500), 44 + i * 2);
  return bytes;
}
const fixture = {
  schemaVersion: 1, examContractVersion: 1, minReaderVersion: '0.3.0', id: 'original-repeat-scope', version: '1', title: 'Original Repeat scope fixture', description: '', rights: '',
  groups: [{ id: 'repeat-task', taskKind: 'listen_repeat', section: 'speaking', title: 'Original two-item Repeat', passage: '', audio: null, image: null,
    timing: { scope: 'task', durationSeconds: 80, prepareSeconds: 0, basis: 'document', source: 'Independent test task total; it is not a per-question duration.' },
    presentation: { screen: 'one_question', passageVisibility: 'review', questionPromptVisibility: 'review' }, directions: [],
    questions: ['r1', 'r2'].map((id, i) => ({ id, type: 'listen_repeat', prompt: 'Repeat the original sentence.', answer: i ? 'A path leads to the pond.' : 'The gate opens at nine.', options: [], explanation: '', audio: 'stimulus.wav', image: null, timeLimitSeconds: 80, prepareSeconds: 0, source: 'Independent synthetic fixture.', localNumber: i + 1, ordinalInTask: i + 1 })),
  }],
  examSets: [{ id: 'repeat-set', title: 'Repeat scope', sections: [{ id: 'speaking-section', section: 'speaking', title: 'Speaking', modules: [{ id: 'speaking-module', title: 'Speaking module', sourceNumber: 1, taskIds: ['repeat-task'], instructions: { text: 'Check the synthetic microphone before beginning.', audio: null, source: 'Independent test instructions.', basis: 'user', verifiedContent: true }, navigation: { back: 'none', review: 'none', lockOnAdvance: true } }] }] }],
};
const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
  const response = await appFetch(instance.url + '/api' + route, { method, headers: { 'X-PracticeBridge': '1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
};
const session = async () => (await api(`/sessions/${sessionId}`)).session;
const disk = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
const waitPhase = (qid, phase) => page.waitForFunction(({ qid, phase }) => { const shell = document.querySelector('.exam-shell'); return shell?.dataset.questionId === qid && shell.dataset.phase === phase; }, { qid, phase });
const running = async qid => { await waitPhase(qid, 'response'); await page.locator('.exam-recorder.recording').waitFor(); };
const saved = async (qid, maxSeconds, label) => {
  await waitPhase(qid, 'recorded');
  const current = await session(), entry = current.answers[qid], timer = current.timers[`response:question:${qid}`];
  assert.ok(entry.recordingId); assert.equal(timer.scope, 'question'); assert.equal(timer.durationSeconds, maxSeconds); assert.equal(timer.running, false);
  const response = await appFetch(instance.url + entry.recordingUrl); assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  const frames = bytes.readUInt32LE(40) / 2, rate = bytes.readUInt32LE(24), seconds = frames / rate;
  assert.ok(seconds > .1 && seconds <= maxSeconds); assert.equal(bytes.length, 44 + frames * 2);
  const record = (await disk()).recordings[entry.recordingId]; assert.deepEqual(await fs.readFile(path.join(dataDir, 'blobs', record.mediaId)), bytes);
  await fs.writeFile(path.join(run, `${label}.wav`), bytes);
  recordings.push({ label, sessionId, questionId: qid, recordingId: entry.recordingId, frames, rate, seconds, sha256: hash(bytes), remainingSeconds: timer.remainingSeconds, consumedMs: timer.consumedMs });
  return { entry, timer, current };
};
const finish = async () => { await page.locator('#exam-next').click(); await page.getByRole('dialog', { name: 'Finish this module?' }).waitFor(); await page.getByRole('button', { name: 'Finish Module', exact: true }).click(); await page.locator('.exam-completed').waitFor(); };

try {
  instance = await startServer({ dataDir, models: { publicSettings: () => ({ provider: 'none', capabilities: {} }), feedback: () => { throw new Error('This Repeat test cannot call a model'); }, chat: () => { throw new Error('This Repeat test cannot call a model'); } } });
  const file = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });
  const preview = await api('/import/preview', { files: [file('practicebridge.json', JSON.stringify(fixture)), file('stimulus.wav', tone())] });
  assert.deepEqual(preview.issues.filter(issue => issue.severity === 'error'), []);
  const { library } = await api('/import/commit', { draftId: preview.draftId, pack: preview.pack, acknowledged: true });
  const originalLibrary = canonicalJSON((await disk()).libraries[0]);
  browser = await chromium.launch({ channel: process.env.PRACTICEBRIDGE_BROWSER_CHANNEL || 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  context = await browser.newContext({ permissions: ['microphone'], serviceWorkers: 'block', viewport: { width: 1180, height: 820 } });
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== instance.url) { externalRequests.push(url.href); return route.abort('blockedbyclient'); } return route.continue(); });
  await context.addInitScript(() => { const NativeRecorder = MediaRecorder; window.__repeatRecorders = []; window.MediaRecorder = class extends NativeRecorder { constructor(...args) { super(...args); window.__repeatRecorders.push(this); } start(...args) { this.startedAt = performance.now(); return super.start(...args); } stop(...args) { this.stoppedAt = performance.now(); return super.stop(...args); } }; });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const openNew = async preset => {
    const created = (await api('/sessions', { sessionVersion: 2, libraryId: library.libraryId, setId: 'repeat-set', sectionId: 'speaking-section', mode: 'practice', preset })).session;
    sessionId = created.id; assert.equal(created.planSnapshot.sections[0].modules[0].tasks[0].timing.scope, 'task');
    await page.goto(`${instance.url}/#exam/${library.libraryId}/${created.planSnapshot.id}/all/practice/${sessionId}`); await waitPhase('r1', 'instructions');
    await page.locator('#check-microphone').click(); await page.waitForFunction(() => document.querySelector('#microphone-status')?.textContent === 'Microphone is ready.');
    return created;
  };

  currentCase = 'source task total falls back to independent 8-second questions';
  const firstRun = await openNew('document'); assert.match(await page.locator('.exam-intro table').innerText(), /00:08.*练习默认/);
  await page.locator('#exam-next').click(); await running('r1'); await page.waitForTimeout(1200); await page.locator('#record-toggle').click();
  const first = await saved('r1', 8, 'default-q1-first');
  assert.equal(first.timer.basis, 'preset'); assert.equal(first.timer.policyReason, 'source_scope_fallback'); assert.equal(first.timer.requestedDurationSeconds, 80);
  assert.ok(first.timer.consumedMs >= 1000 && first.timer.consumedMs < 2500); assert.equal(await page.locator('#record-toggle').isDisabled(), false);
  assert.equal(await page.locator('#record-duration').innerText(), `00:${String(first.timer.remainingSeconds).padStart(2, '0')}`);
  const beforeRerecord = first.timer.consumedMs;
  await page.locator('#record-toggle').click(); await running('r1'); await page.waitForTimeout(1200); await page.locator('#record-toggle').click();
  const second = await saved('r1', 8, 'default-q1-again');
  assert.notEqual(second.entry.recordingId, first.entry.recordingId); assert.equal(second.timer.startedAt, first.timer.startedAt); assert.ok(second.timer.consumedMs >= beforeRerecord + 1000); assert.ok(second.timer.remainingSeconds < first.timer.remainingSeconds);
  pass('an 80-second task total remains in the frozen source while Repeat uses a 8-second question budget and Record Again spends its remaining time');
  await page.locator('#exam-next').click(); await running('r2');
  const next = await session(); assert.equal(next.timers['response:question:r2'].durationSeconds, 8); assert.equal(next.timers['response:question:r2'].consumedMs, 0); assert.equal(next.timers['response:question:r1'].completed, true);
  await page.waitForTimeout(500); await page.locator('#record-toggle').click(); await saved('r2', 8, 'default-q2'); await finish();
  assert.equal((await session()).planSnapshot.sections[0].modules[0].tasks[0].timing.durationSeconds, 80);
  pass('explicit Next plays the second stimulus, creates its own fresh clock and submits two separate question recordings');

  currentCase = 'custom per-question Repeat duration applies independently to both answers';
  const customRun = await openNew({ repeatSeconds: 2 });
  for (const qid of ['r1', 'r2']) {
    await page.locator('#exam-next').click(); await running(qid);
    const current = await session(), timer = current.timers[`response:question:${qid}`]; assert.equal(timer.durationSeconds, 2); assert.equal(timer.basis, 'user'); assert.equal(timer.consumedMs, 0);
    const result = await saved(qid, 2, `custom-${qid}`); assert.equal(result.timer.remainingSeconds, 0); assert.equal(await page.locator('#record-duration').innerText(), '00:00'); assert.equal(await page.locator('#record-toggle').isDisabled(), true);
    assert.equal(await page.locator('.exam-shell').getAttribute('data-question-id'), qid);
  }
  await finish(); pass('a custom two-second budget automatically stops each question independently and cannot reopen an exhausted answer');
  const final = await api('/state'); assert.equal(final.attempts.length, 4); assert.equal(final.jobs.length, 0); assert.equal(final.settings.provider, 'none');
  assert.ok(final.attempts.every(attempt => attempt.runContext.timerScope === 'question')); assert.equal(new Set(final.attempts.map(attempt => attempt.recordingId)).size, 4);
  assert.equal(canonicalJSON((await disk()).libraries[0]), originalLibrary); assert.equal(final.sessions.find(item => item.id === firstRun.id).finished, true); assert.equal(final.sessions.find(item => item.id === customRun.id).finished, true);
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  pass('both completed runs preserve the original library identity and retain four correctly bound attempts without model jobs');
  const sourceAfter = await sourceHashes();
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify({ ok: true, checks, recordings, errors, externalRequests, realModelCalls: 0, microphone: 'Chromium synthetic device only', sourceBefore, sourceAfter, sourceStable: canonicalJSON(sourceBefore) === canonicalJSON(sourceAfter) }, null, 2) + '\n');
  console.log('RESULT_DIR ' + run);
} catch (error) {
  console.error(`FAIL during ${currentCase}: ${error.stack || error.message}`); process.exitCode = 1;
  await page?.screenshot({ path: path.join(run, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(run, 'failure.json'), JSON.stringify({ currentCase, error: error.stack || error.message, checks, recordings, errors, externalRequests }, null, 2) + '\n');
  console.log('RESULT_DIR ' + run);
} finally { await context?.close(); await browser?.close(); await instance?.close(); }
