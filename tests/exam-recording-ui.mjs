import {appFetch} from './auth-client.mjs';
// Run: node tests/exam-recording-ui.mjs
// Uses a real browser MediaRecorder with its synthetic audio input, generated
// tones and an isolated local server. No user microphone or model is accessed.
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(projectDir, 'test-results');
const artifactDir = path.join(testRoot, 'exam-recording-ui');
await fs.mkdir(artifactDir, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(testRoot, 'exam-recording-data-'));
const passed = [], externalRequests = [], pageErrors = [], uploads = [], waveformChecks = [];
const pass = label => { passed.push(label); console.log(`PASS: ${label}`); };
let currentCase = 'initialization', instance, browser, context, page, sessionId;
let uploadMode = 'normal', heldUpload, releaseUpload;

const tone = (frequency = 440, seconds = .6) => {
  const rate = 16000, samples = Math.round(rate * seconds), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * frequency / rate) * 1500), 44 + i * 2);
  return bytes;
};
const question = (id, type, audio, prompt, answer = null, number = 1) => ({ id, type, prompt, options: [], answer, explanation: '', audio, image: null, timeLimitSeconds: 120, prepareSeconds: 0, source: 'Independently authored browser fixture.', localNumber: number, ordinalInTask: number, transcript: type === 'listen_repeat' ? answer : prompt });
const timing = prepareSeconds => ({ scope: 'question', durationSeconds: 120, prepareSeconds, basis: 'user', source: 'Synthetic browser test timing.' });
const fixture = {
  schemaVersion: 1, examContractVersion: 1, minReaderVersion: '0.3.0', id: 'original-recording-ui', version: '1', title: 'Original recording regression', description: '', rights: '',
  groups: [
    { id: 'repeat-task', taskKind: 'listen_repeat', section: 'speaking', title: 'Original repeat task', passage: '', audio: null, image: null,
      presentation: { screen: 'one_question', passageVisibility: 'review', questionPromptVisibility: 'review' }, timing: timing(0),
      directions: [
        { id: 'repeat-audio-directions', text: 'Listen to the synthetic directions tone.', audio: 'directions.wav', source: 'Synthetic directions fixture.', basis: 'user', verifiedContent: true },
        { id: 'repeat-text-directions', text: 'The directions have ended. Continue to the first original item.', audio: null, source: 'Synthetic directions fixture.', basis: 'user', verifiedContent: true },
      ],
      questions: [question('repeat-1', 'listen_repeat', 'stimulus-1.wav', 'Repeat the original sentence.', 'The park gate opens at nine.', 1), question('repeat-2', 'listen_repeat', 'stimulus-2.wav', 'Repeat the next original sentence.', 'A quiet path leads to the pond.', 2)],
    },
    { id: 'interview-task', taskKind: 'interview', section: 'speaking', title: 'Original interview task', passage: '', audio: null, image: null,
      presentation: { screen: 'one_question', passageVisibility: 'review', questionPromptVisibility: 'review' }, timing: timing(1),
      directions: [{ id: 'interview-directions', text: 'Answer the original interview question after its tone.', audio: null, source: 'Synthetic interview fixture.', basis: 'user', verifiedContent: true }],
      questions: [{ ...question('interview-1', 'interview', 'stimulus-3.wav', 'Describe an activity you enjoy outdoors.', null, 3), ordinalInTask: 1 }],
    },
  ],
  examSets: [{ id: 'recording-set', title: 'Original recording regression', sections: [{ id: 'speaking-section', section: 'speaking', title: 'Speaking', modules: [{ id: 'speaking-module', title: 'Speaking module', sourceNumber: 1, taskIds: ['repeat-task', 'interview-task'], instructions: { text: 'Check your microphone before the synthetic speaking practice.', audio: null, source: 'Synthetic test instructions.', basis: 'user', verifiedContent: true }, navigation: { back: 'none', review: 'none', lockOnAdvance: true } }] }] }],
};
const upload = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });
const hashSource = async () => Object.fromEntries(await Promise.all(['public/exam-practice.mjs', 'public/exam-views.mjs', 'public/exam-audio.mjs', 'public/exam-timing.mjs', 'src/exam-session.mjs'].map(async name => [name, crypto.createHash('sha256').update(await fs.readFile(path.join(projectDir, name))).digest('hex')])));
const sourceBefore = await hashSource();

try {
  const models = {
    publicSettings: () => ({ provider: 'none', capabilities: { chat: false, feedback: false, structure: false, assessMaterials: false } }),
    chat: () => { throw new Error('No model service may run in this recording test'); },
    feedback: () => { throw new Error('No feedback or real model may be called by this test'); },
  };
  instance = await startServer({ dataDir, models });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST', expectedStatus = 200) => {
    const response = await appFetch(`${instance.url}/api${route}`, { method, headers: { 'X-PracticeBridge': '1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(result)); return result;
  };
  const poll = async (check, message, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(message);
  };
  const session = async () => (await api(`/sessions/${sessionId}`)).session;
  const stateOnDisk = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const preview = await api('/import/preview', { files: [upload('practicebridge.json', JSON.stringify(fixture)), upload('directions.wav', tone(300)), ...[1, 2, 3].map(i => upload(`stimulus-${i}.wav`, tone(350 + i * 80)))] });
  assert.deepEqual(preview.issues.filter(issue => issue.severity === 'error'), []);
  const { library } = await api('/import/commit', { draftId: preview.draftId, pack: preview.pack, acknowledged: true });
  browser = await chromium.launch({ channel: process.env.PRACTICEBRIDGE_BROWSER_CHANNEL || 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  context = await browser.newContext({ permissions: ['microphone'], serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1180, height: 820 } });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== instance.url) { externalRequests.push(url.href); return route.abort('blockedbyclient'); }
    if (url.pathname === '/api/recordings' && route.request().method() === 'POST') {
      uploads.push(route.request().postDataJSON());
      if (uploadMode === 'fail') return route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic local recording save failure.' }) });
      if (uploadMode === 'hold') { heldUpload = uploads.at(-1); await new Promise(resolve => { releaseUpload = resolve; }); }
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    const nativeGet = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), NativeRecorder = window.MediaRecorder;
    const harness = window.__examMedia = { denyMicrophone: false, getUserMediaCalls: 0, recorders: [], phases: [], streams: [] };
    navigator.mediaDevices.getUserMedia = async constraints => {
      harness.getUserMediaCalls++;
      if (harness.denyMicrophone) throw new DOMException('Synthetic denied microphone.', 'NotAllowedError');
      const stream = await nativeGet(constraints); harness.streams.push(stream); return stream;
    };
    window.MediaRecorder = class {
      static isTypeSupported(type) { return NativeRecorder.isTypeSupported(type); }
      constructor(stream, options) {
        this.native = new NativeRecorder(stream, options); this.stream = stream; this.parts = []; this.held = []; this.holdStop = false; this.nativeStopped = false; this.stopping = false;
        this.ondataavailable = null; this.onstop = null; this.onerror = null;
        harness.recorders.push(this);
        this.native.ondataavailable = event => { this.parts.push(event.data); if (this.stopping && this.holdStop) this.held.push(event.data); else this.ondataavailable?.(event); };
        this.native.onstop = () => { this.nativeStopped = true; if (!this.holdStop) this.onstop?.(new Event('stop')); };
        this.native.onerror = event => this.onerror?.(event);
      }
      get state() { return this.native.state; }
      get mimeType() { return this.native.mimeType; }
      start(timeslice) { this.startedAt = performance.now(); this.native.start(timeslice); }
      stop() { this.stoppedAt ??= performance.now(); this.stopping = true; this.native.stop(); }
      async releaseFinal() { this.holdStop = false; for (const data of this.held.splice(0)) this.ondataavailable?.({ data }); if (this.nativeStopped) await this.onstop?.(new Event('stop')); }
      async duplicateStop() { await this.onstop?.(new Event('stop')); }
      async expectedBase64() { const bytes = new Uint8Array(await new Blob(this.parts).arrayBuffer()); let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); }
    };
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const shell = document.querySelector('.exam-shell'), phase = shell?.dataset.phase, questionId = shell?.dataset.questionId;
        if (!phase) return;
        const last = harness.phases.at(-1); if (!last || last.phase !== phase || last.questionId !== questionId) harness.phases.push({ phase, questionId });
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase', 'data-question-id'] });
    });
  });
  page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push(error.message));
  const waitPhase = async (qid, phase) => page.waitForFunction(({ qid, phase }) => { const shell = document.querySelector('.exam-shell'); return shell?.dataset.questionId === qid && shell.dataset.phase === phase; }, { qid, phase });
  const beforeUnloadPrevented = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  const verifiedRecordedWav = async (index, url) => {
    const response = await appFetch(instance.url + url); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^audio\//);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length > 128);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    assert.equal(bytes.readUInt16LE(20), 1); assert.equal(bytes.readUInt16LE(22), 1); assert.equal(bytes.readUInt16LE(34), 16);
    const frames = bytes.readUInt32LE(40) / 2, sampleRate = bytes.readUInt32LE(24);
    assert.equal(bytes.length, 44 + frames * 2);
    const comparison = await page.evaluate(async ({ index, url, frames, sampleRate }) => {
      const recording = window.__examMedia.recorders[index], decoder = new OfflineAudioContext(1, 1, sampleRate);
      const raw = await decoder.decodeAudioData(await new Blob(recording.parts).arrayBuffer());
      const saved = await decoder.decodeAudioData(await (await fetch(url)).arrayBuffer());
      const channels = Array.from({ length: raw.numberOfChannels }, (_, i) => raw.getChannelData(i)), actual = saved.getChannelData(0);
      let maxError = 0, energy = 0;
      for (let i = 0; i < frames; i++) { const expected = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length)); maxError = Math.max(maxError, Math.abs(actual[i] - expected)); energy += actual[i] ** 2; }
      return { rawFrames: raw.length, savedFrames: saved.length, maxError, rms: Math.sqrt(energy / frames), captureSeconds: (recording.stoppedAt - recording.startedAt) / 1000 };
    }, { index, url, frames, sampleRate });
    assert.equal(comparison.savedFrames, frames);
    assert.ok(frames <= comparison.rawFrames, JSON.stringify(comparison));
    assert.ok(Math.abs(frames / sampleRate - Math.min(comparison.rawFrames / sampleRate, comparison.captureSeconds)) < .1, JSON.stringify(comparison));
    assert.ok(comparison.maxError <= 2 / 32768, JSON.stringify(comparison));
    waveformChecks.push({ index, frames, sampleRate, durationSeconds: frames / sampleRate, ...comparison });
    return bytes;
  };

  currentCase = 'microphone gate and denial';
  await page.goto(`${instance.url}/#exam/${library.libraryId}/recording-set/speaking-section/practice`);
  await waitPhase('repeat-1', 'instructions'); sessionId = await page.locator('.exam-shell').getAttribute('data-session-id');
  await page.locator('#exam-next').click(); await waitPhase('repeat-1', 'instructions');
  assert.equal(await page.evaluate(() => window.__examMedia.recorders.length), 0);
  await page.evaluate(() => { window.__examMedia.denyMicrophone = true; }); await page.locator('#check-microphone').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('无法使用麦克风'));
  assert.equal((await session()).cursor.phase, 'instructions'); assert.equal((await api('/state')).attempts.length, 0);
  await page.evaluate(() => { window.__examMedia.denyMicrophone = false; }); await page.locator('#check-microphone').click();
  await page.waitForFunction(() => document.querySelector('#microphone-status')?.textContent === 'Microphone is ready.');
  assert.equal(await page.evaluate(() => window.__examMedia.streams.at(-1).active), true);
  pass('microphone denial leaves instructions and attempts unchanged, then a synthetic microphone can pass the check');

  currentCase = 'directions, real stimulus ended and zero preparation auto-recording';
  await page.locator('#exam-next').click(); await waitPhase('repeat-1', 'directions');
  await poll(async () => { const current = await session(); return current.cursor.phase === 'directions' && current.cursor.phaseIndex === 1; }, 'The directions audio did not end into its text-only phase');
  await page.locator('.exam-direction').filter({ hasText: 'The directions have ended.' }).waitFor(); assert.equal(await page.locator('#prompt-audio').count(), 0);
  await page.locator('#exam-next').click(); await waitPhase('repeat-1', 'stimulus');
  await waitPhase('repeat-1', 'response'); await page.locator('.exam-recorder.recording').waitFor();
  assert.equal(await page.evaluate(() => window.__examMedia.recorders[0].state), 'recording');
  assert.equal((await page.locator('#main').innerText()).includes(fixture.groups[0].questions[0].answer), false);
  assert.equal(await page.locator('#exam-next').isDisabled(), true);
  assert.equal(await beforeUnloadPrevented(), true);
  pass('audio directions and stimulus play to ended, then zero preparation starts capture without revealing the repeat target');

  currentCase = 'last data chunk and delayed local upload';
  await page.waitForTimeout(900); await page.evaluate(() => { window.__examMedia.recorders[0].holdStop = true; }); uploadMode = 'hold';
  await page.locator('#record-toggle').click(); await page.waitForFunction(() => window.__examMedia.recorders[0].nativeStopped);
  assert.ok(await page.evaluate(() => window.__examMedia.recorders[0].held.reduce((sum, blob) => sum + blob.size, 0)));
  assert.equal((await session()).answers['repeat-1']?.recordingId ?? null, null);
  assert.equal(await page.evaluate(() => window.practiceBridgeBeforeClose()), false);
  assert.equal(await page.locator('#exam-next').isDisabled(), true);
  const releasedFinal = page.evaluate(() => window.__examMedia.recorders[0].releaseFinal());
  await poll(() => heldUpload, 'The completed recording did not reach the upload gate');
  assert.equal((await session()).cursor.phase, 'saving'); assert.equal(await beforeUnloadPrevented(), true);
  assert.equal(await page.evaluate(() => window.practiceBridgeBeforeClose()), false);
  assert.equal((await session()).answers['repeat-1']?.recordingId ?? null, null);
  uploadMode = 'normal'; releaseUpload(); releaseUpload = null; await releasedFinal;
  await waitPhase('repeat-1', 'recorded'); await page.locator('.exam-own-recording audio').waitFor();
  const first = (await session()).answers['repeat-1']; assert.ok(first.recordingId); await verifiedRecordedWav(0, first.recordingUrl);
  const playback = await page.locator('.exam-own-recording audio').evaluate(async audio => {
    await audio.play(); const deadline = performance.now() + 4000;
    while (audio.currentTime < .05 && !audio.error && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const result = { currentTime: audio.currentTime, readyState: audio.readyState, error: audio.error?.message || null }; audio.pause(); return result;
  });
  assert.ok(playback.currentTime >= .05, JSON.stringify(playback)); assert.ok(playback.readyState >= 2, JSON.stringify(playback)); assert.equal(playback.error, null);
  assert.equal(await page.locator('#exam-next').isDisabled(), false);
  await page.screenshot({ path: path.join(artifactDir, 'saved-response.png'), fullPage: true });
  pass('stopping waits for the last chunk and local upload; the saved PCM WAV preserves the decoded captured waveform within quantization and the actual stop-frame boundary, and plays back');

  currentCase = 'explicit transcript assistance preserves the saved recording';
  await page.locator('#exam-transcript').click(); await page.locator('.exam-help-panel h2').filter({ hasText: 'Transcript' }).waitFor();
  assert.equal(await page.locator('.exam-help-panel h2').innerText(), 'Transcript');
  assert.equal((await session()).answers['repeat-1'].recordingId, first.recordingId);
  assert.equal((await session()).assisted, true);
  pass('opening source transcript assistance is explicit and does not change the saved recording');

  currentCase = 'next question lock and old recorder callbacks';
  await page.locator('#exam-next').click(); await waitPhase('repeat-2', 'stimulus'); await waitPhase('repeat-2', 'response');
  await page.locator('.exam-recorder.recording').waitFor(); assert.equal(await page.locator('#exam-back').count(), 0);
  assert.equal(await page.evaluate(() => window.__examMedia.recorders.length), 2);
  await page.evaluate(() => window.__examMedia.recorders[0].duplicateStop()); await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => window.__examMedia.recorders[1].stream.active), true, 'Old recorder callback must not stop the current microphone stream');
  assert.equal(await page.evaluate(() => window.__examMedia.recorders[1].state), 'recording');
  const secondRun = await session(); assert.equal(secondRun.cursor.questionId, 'repeat-2'); assert.equal(secondRun.cursor.phase, 'response'); assert.equal(secondRun.answers['repeat-1'].recordingId, first.recordingId);
  await api(`/sessions/${sessionId}`, { writerToken: secondRun.writerToken, expectedRevision: secondRun.revision, cursor: { questionId: 'repeat-1', phase: 'recorded' } }, 'PATCH', 409);
  pass('Next locks the prior question, and a duplicate old stop callback leaves the new question recording intact');

  currentCase = 'failed save retains pending bytes and protects close/navigation';
  uploadMode = 'fail'; await page.waitForTimeout(850); await page.locator('#record-toggle').click();
  await page.locator('#record-save-retry').waitFor({ state: 'visible' }); await page.locator('#export-pending-recording').waitFor();
  assert.equal((await session()).answers['repeat-2']?.recordingId ?? null, null);
  assert.equal(await page.locator('#record-toggle').isDisabled(), true, 'Pending bytes cannot be overwritten by another recording');
  assert.equal(await page.locator('.exam-recorder.recording').count(), 0, 'A stopped capture must no longer look active');
  assert.equal(await beforeUnloadPrevented(), true); assert.equal(await page.evaluate(() => window.practiceBridgeBeforeClose()), false);
  const currentHash = await page.evaluate(() => location.hash);
  await page.evaluate(() => { location.hash = '#dashboard'; }); await poll(async () => await page.evaluate(() => location.hash) === currentHash, 'Unsaved recording lost its owning practice route');
  assert.equal((await session()).cursor.questionId, 'repeat-2');
  await page.screenshot({ path: path.join(artifactDir, 'save-recovery.png'), fullPage: true });
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export-pending-recording').click(); const downloaded = await downloadPromise;
  const exportedPath = path.join(artifactDir, 'pending-response.wav'); await downloaded.saveAs(exportedPath);
  const pendingBytes = await fs.readFile(exportedPath);
  assert.equal(pendingBytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(pendingBytes.toString('base64'), uploads.at(-1).data, 'Export preserves the exact already-bounded upload bytes');
  const pendingUploadId = uploads.at(-1).uploadId;
  uploadMode = 'normal'; await page.locator('#record-save-retry').click(); await waitPhase('repeat-2', 'recorded');
  const second = (await session()).answers['repeat-2']; assert.ok(second.recordingId); assert.notEqual(second.recordingId, first.recordingId);
  assert.deepEqual(await verifiedRecordedWav(1, second.recordingUrl), pendingBytes);
  assert.equal(uploads.at(-1).uploadId, pendingUploadId, 'Save retry keeps the same capture identity');
  assert.equal(Object.keys((await stateOnDisk()).recordings).length, 2, 'Failed upload attempts create no false recordings');
  pass('failed saves preserve exact exportable audio, block close/navigation and replacement, then retry into the original question');

  currentCase = 'new task and preparation timer';
  await page.locator('#exam-next').click(); await waitPhase('interview-1', 'directions');
  assert.equal(await page.locator('.exam-help-panel').count(), 0);
  await page.locator('#exam-next').click(); await waitPhase('interview-1', 'stimulus'); await waitPhase('interview-1', 'prepare'); await waitPhase('interview-1', 'response');
  await page.locator('.exam-recorder.recording').waitFor(); assert.equal(await page.locator('#exam-back').count(), 0);
  assert.equal(await page.evaluate(() => window.__examMedia.recorders.length), 3);
  await page.waitForTimeout(850); await page.locator('#record-toggle').click(); await waitPhase('interview-1', 'recorded');
  const third = (await session()).answers['interview-1']; await verifiedRecordedWav(2, third.recordingUrl);
  assert.equal((await session()).timers['response:question:interview-1'].durationSeconds, 45);
  pass('the next task starts only after explicit Next, honors its preparation phase, and saves an independent recording under the interview cap');

  currentCase = 'module submission preserves three distinct source-owned recordings';
  await page.locator('#exam-next').click(); await page.getByRole('dialog', { name: 'Finish this module?' }).waitFor();
  await page.getByRole('button', { name: 'Finish Module', exact: true }).click(); await page.locator('.exam-completed').waitFor();
  const finalState = await api('/state');
  assert.equal(finalState.attempts.length, 3); assert.equal(finalState.jobs.length, 0);
  const expectedRecords = { 'repeat-1': first.recordingId, 'repeat-2': second.recordingId, 'interview-1': third.recordingId };
  for (const attempt of finalState.attempts) { assert.equal(attempt.recordingId, expectedRecords[attempt.questionId]); assert.equal(attempt.objective.status, 'unscored'); assert.equal(attempt.questionSnapshot.id, attempt.questionId); }
  assert.equal(new Set(finalState.attempts.map(attempt => attempt.recordingId)).size, 3); assert.equal(Object.keys((await stateOnDisk()).recordings).length, 3);
  assert.equal(await page.evaluate(() => window.practiceBridgeBeforeClose()), true);
  assert.equal(await page.evaluate(() => window.__examMedia.streams.some(stream => stream.active)), false);
  assert.deepEqual(externalRequests, []); assert.deepEqual(pageErrors, []);
  pass('module submission stores one unscored attempt per original question, releases all streams and creates no automatic model jobs');
  const sourceAfter = await hashSource(); assert.deepEqual(sourceAfter, sourceBefore, 'Application source changed during the recording check');
  const summary = { passed: passed.length, cases: passed, attempts: finalState.attempts.length, recordings: 3, waveformChecks, requestedLocalModelDoubles: 0, realModelCalls: 0, externalRequests, pageErrors, microphone: 'browser synthetic device only', sourceBefore, sourceAfter, phases: await page.evaluate(() => window.__examMedia.phases) };
  await fs.writeFile(path.join(artifactDir, 'report.json'), JSON.stringify(summary, null, 2) + '\n'); console.log(JSON.stringify(summary));
  for (const name of ['failure.json', 'failure.png']) {
    const staleFailure = path.resolve(artifactDir, name); if (!staleFailure.startsWith(artifactDir + path.sep)) throw new Error('Unexpected failure artifact path');
    await fs.rm(staleFailure, { force: true });
  }
  console.log('RESULT_DIR ' + artifactDir);
} catch (error) {
  console.error(`FAIL during ${currentCase}: ${error.stack || error.message}`); process.exitCode = 1;
  await page?.screenshot({ path: path.join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(artifactDir, 'failure.json'), JSON.stringify({ currentCase, error: error.stack || error.message, passed, externalRequests, pageErrors, sourceBefore, sourceAfter: await hashSource() }, null, 2) + '\n');
  console.log('RESULT_DIR ' + artifactDir);
} finally {
  releaseUpload?.();
  await context?.close(); await browser?.close(); await instance?.close();
  const checked = path.resolve(dataDir); if (!checked.startsWith(testRoot + path.sep) || !path.basename(checked).startsWith('exam-recording-data-')) throw new Error('Unexpected test cleanup path');
  await fs.rm(checked, { recursive: true, force: true });
}
