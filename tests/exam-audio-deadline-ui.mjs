import {appFetch} from './auth-client.mjs';
// Run browser: node tests/exam-audio-deadline-ui.mjs
// Run package: node tests/exam-audio-deadline-ui.mjs --packaged <directory-or-exe>
// Two actual 45-second Interview runs. Web Audio generates every input sample;
// this test never opens the user's microphone or calls a model service.
import { chromium, _electron as electron } from 'playwright';
import { startServer } from '../src/server.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8')).version;
assert.match(expectedVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'The checked-out build must declare an explicit version');
const args = process.argv.slice(2), packaged = args[0] === '--packaged';
assert.ok(args.length === 0 || (packaged && args.length === 2 && args[1]), 'Usage: node tests/exam-audio-deadline-ui.mjs [--packaged <directory-or-exe>]');
const testRoot = path.join(project, 'test-results'); await fs.mkdir(testRoot, { recursive: true });
const run = await fs.mkdtemp(path.join(testRoot, `exam-audio-deadline-${packaged ? 'packaged' : 'browser'}-`));
const dataDir = path.join(run, 'data');
assert.ok(path.resolve(dataDir).startsWith(testRoot + path.sep));
const checks = [], cases = [], errors = [], externalRequests = [], uploads = [];
const pass = label => { checks.push(label); console.log('PASS ' + label); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const poll = async (check, message, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(message);
};
const sourceHashes = async () => Object.fromEntries(await Promise.all(['public/exam-audio.mjs', 'public/exam-practice.mjs', 'public/exam-timing.mjs', 'src/exam-session.mjs'].map(async name => [name, hash(await fs.readFile(path.join(project, name)))])));
const sourceBefore = await sourceHashes();
let instance, browser, context, app, page, origin, sessionId, executablePath, runtime, currentCase = 'initialization';

function tone() {
  const rate = 16000, frames = 4800, bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 330 * i / rate) * 2500), 44 + i * 2);
  return bytes;
}
const fixture = {
  schemaVersion: 1, examContractVersion: 1, minReaderVersion: '0.3.0', id: 'original-audio-deadline', version: '1', title: 'Original audio deadline verification', description: '', rights: '',
  groups: [{
    id: 'interview-task', taskKind: 'interview', section: 'speaking', title: 'Synthetic Interview', passage: '', audio: null, image: null,
    presentation: { screen: 'one_question', passageVisibility: 'review', questionPromptVisibility: 'review' },
    timing: { scope: 'question', durationSeconds: 120, prepareSeconds: 0, basis: 'user', source: 'Independently authored test; the 45-second Interview maximum must override this longer value.' },
    directions: [],
    questions: ['normal', 'blocked'].map((name, i) => ({ id: `deadline-${name}`, type: 'interview', prompt: `Describe an original ${name} example.`, options: [], answer: null, explanation: '', audio: 'stimulus.wav', image: null, timeLimitSeconds: 120, prepareSeconds: 0, source: 'Independent synthetic fixture.', localNumber: i + 1, ordinalInTask: i + 1 })),
  }],
  examSets: [{ id: 'deadline-set', title: 'Audio deadlines', sections: [{ id: 'speaking-section', section: 'speaking', title: 'Speaking', modules: [{ id: 'speaking-module', title: 'Speaking module', sourceNumber: 1, taskIds: ['interview-task'], instructions: { text: 'Check the synthetic microphone and begin.', audio: null, source: 'Independent test instructions.', basis: 'user', verifiedContent: true }, navigation: { back: 'none', review: 'none', lockOnAdvance: true } }] }] }],
};
const api = async (route, body, method = body === undefined ? 'GET' : 'POST', status = 200) => {
  const response = await appFetch(origin + '/api' + route, { method, headers: { 'X-PracticeBridge': '1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
};
const session = async () => (await api(`/sessions/${sessionId}`)).session;
const waitPhase = (qid, phase, timeout = 15000) => page.waitForFunction(({ qid, phase }) => { const shell = document.querySelector('.exam-shell'); return shell?.dataset.questionId === qid && shell.dataset.phase === phase; }, { qid, phase }, { timeout });

try {
  if (packaged) {
    executablePath = path.resolve(args[1]);
    if ((await fs.stat(executablePath)).isDirectory()) executablePath = path.join(executablePath, 'PracticeBridge.exe');
    await fs.access(executablePath);
    const env = { ...process.env, PRACTICEBRIDGE_DATA_DIR: dataDir, PRACTICEBRIDGE_TEST_HIDDEN: '1' }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'], env, timeout: 30000 });
    context = app.context(); page = await app.firstWindow(); await page.locator('.hero').waitFor(); origin = new URL(page.url()).origin;
    runtime = await app.evaluate(({ app, BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0], preferences = window.webContents.getLastWebPreferences(); return { packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData'), appPath: app.getAppPath(), fakeMedia: app.commandLine.hasSwitch('use-fake-device-for-media-stream'), nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, backgroundThrottling: window.webContents.getBackgroundThrottling() }; });
    assert.equal(runtime.packaged, true); assert.equal(runtime.version, expectedVersion, 'The running app must match the checked-out build version'); assert.equal(runtime.fakeMedia, true);
    assert.equal(path.resolve(runtime.profile), path.join(dataDir, 'desktop-profile')); assert.equal(runtime.nodeIntegration, false); assert.equal(runtime.contextIsolation, true); assert.equal(runtime.sandbox, true); assert.equal(runtime.backgroundThrottling, false);
  } else {
    instance = await startServer({ dataDir, models: { publicSettings: () => ({ provider: 'none', capabilities: { chat: false, feedback: false, structure: false, assessMaterials: false } }), chat: () => { throw new Error('The audio deadline test cannot call any model'); }, feedback: () => { throw new Error('The audio deadline test cannot call any model'); } } });
    origin = instance.url;
    browser = await chromium.launch({ channel: process.env.PRACTICEBRIDGE_BROWSER_CHANNEL || 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
    context = await browser.newContext({ permissions: ['microphone'], serviceWorkers: 'block', viewport: { width: 1180, height: 820 } });
    runtime = { packaged: false, browser: await browser.version(), microphone: 'Web Audio generated MediaStream only' };
  }
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) { externalRequests.push(url.href); return route.abort('blockedbyclient'); }
    if (url.pathname === '/api/recordings' && route.request().method() === 'POST') uploads.push(route.request().postDataJSON());
    return route.continue();
  });
  await context.addInitScript(() => {
    const NativeRecorder = window.MediaRecorder;
    const harness = window.__audioDeadline = { scenario: 'normal', inputs: [], recorders: [], blocks: [], getUserMediaCalls: 0, realMicrophoneCalls: 0 };
    navigator.mediaDevices.getUserMedia = async () => {
      harness.getUserMediaCalls++;
      const context = new AudioContext(), destination = context.createMediaStreamDestination(), oscillator = context.createOscillator(), level = context.createGain();
      level.gain.value = .2; oscillator.frequency.value = 440; oscillator.connect(level); level.connect(destination); oscillator.start(); await context.resume();
      const input = { context, stream: destination.stream, oscillator, level }; harness.inputs.push(input); return input.stream;
    };
    window.MediaRecorder = class {
      static isTypeSupported(type) { return NativeRecorder.isTypeSupported(type); }
      constructor(stream, options) {
        this.native = new NativeRecorder(stream, options); this.stream = stream;
        this.input = harness.inputs.findLast(input => input.stream.active); if (!this.input) throw new Error('No generated audio source exists');
        // This parallel recorder witnesses what the input audio thread produces
        // after the deadline, before the application's scheduled gain gate.
        this.control = new NativeRecorder(this.input.stream, options);
        this.parts = []; this.controlParts = []; this.ondataavailable = null; this.onstop = null; this.onerror = null;
        this.scenario = harness.scenario; harness.recorders.push(this);
        this.native.ondataavailable = event => { if (event.data.size) this.parts.push(event.data); this.ondataavailable?.(event); };
        this.control.ondataavailable = event => { if (event.data.size) this.controlParts.push(event.data); };
        this.native.onstop = () => { this.stopEventAt = performance.now(); this.nativeStopped = true; this.onstop?.(new Event('stop')); };
        this.control.onstop = () => { this.controlStopped = true; };
        this.native.onerror = event => this.onerror?.(event);
      }
      get state() { return this.native.state; }
      get mimeType() { return this.native.mimeType; }
      start(timeslice) {
        const audioStart = this.input.context.currentTime;
        this.input.oscillator.frequency.cancelScheduledValues(audioStart);
        this.input.oscillator.frequency.setValueAtTime(440, audioStart);
        this.input.oscillator.frequency.setValueAtTime(880, audioStart + 43);
        this.input.oscillator.frequency.setValueAtTime(1760, audioStart + 46);
        this.audioStartedAt = audioStart; this.startedAt = performance.now();
        this.control.start(timeslice); this.native.start(timeslice);
        if (this.scenario === 'blocked') setTimeout(() => {
          const startedAt = performance.now(), until = this.startedAt + 47200;
          while (performance.now() < until) { /* Intentional main-thread stall. */ }
          harness.blocks.push({ startedAt, endedAt: performance.now(), relativeStartSeconds: (startedAt - this.startedAt) / 1000, relativeEndSeconds: (performance.now() - this.startedAt) / 1000 });
        }, 44000);
      }
      stop() {
        this.stoppedAt ??= performance.now();
        if (this.native.state === 'recording') this.native.stop();
        if (this.control.state === 'recording') this.control.stop();
      }
    };
  });
  if (!page) page = await context.newPage();
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('.hero').waitFor();
  const empty = await api('/state'); assert.equal(empty.libraries.length, 0); assert.equal(empty.settings.provider, 'none');
  const file = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });
  const preview = await api('/import/preview', { files: [file('practicebridge.json', JSON.stringify(fixture)), file('stimulus.wav', tone())] });
  assert.deepEqual(preview.issues.filter(issue => issue.severity === 'error'), []);
  const { library } = await api('/import/commit', { draftId: preview.draftId, pack: preview.pack, acknowledged: true });
  await page.evaluate(id => { location.hash = `#exam/${id}/deadline-set/speaking-section/practice`; }, library.libraryId);
  await waitPhase('deadline-normal', 'instructions'); sessionId = await page.locator('.exam-shell').getAttribute('data-session-id');
  await page.locator('#check-microphone').click(); await page.waitForFunction(() => document.querySelector('#microphone-status')?.textContent === 'Microphone is ready.');
  pass('the isolated app uses a generated audio stream and applies the 45-second maximum to an original 120-second Interview fixture');

  for (const [index, scenario] of ['normal', 'blocked'].entries()) {
    currentCase = `${scenario} real-time 45-second recording`;
    console.log(`RUNNING ${scenario}: actual wall-clock recording; ${scenario === 'blocked' ? 'the main thread will stall from 44 to 47.2 seconds' : 'no early stop or accelerated clock'}`);
    await page.evaluate(scenario => { window.__audioDeadline.scenario = scenario; }, scenario);
    await page.locator('#exam-next').click();
    await waitPhase(`deadline-${scenario}`, 'response'); await page.locator('.exam-recorder.recording').waitFor();
    const started = Date.now();
    await page.waitForFunction(index => window.__audioDeadline.recorders[index]?.state === 'recording', index);
    const timer = (await session()).timers[`response:question:deadline-${scenario}`]; assert.equal(timer.durationSeconds, 45);
    const firstCountdown = await page.locator('#record-duration').innerText(); assert.match(firstCountdown, /^00:4[0-5]$/);
    await page.waitForTimeout(1200);
    const secondCountdown = await page.locator('#record-duration').innerText(); assert.notEqual(firstCountdown, secondCountdown, 'The displayed answer clock must count down while recording');
    let minimized = null;
    if(app&&scenario==='normal'){
      minimized=await app.evaluate(async({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.showInactive();await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Test window did not minimize')),5000);window.once('minimize',()=>{clearTimeout(timeout);resolve();});window.minimize();});return {beforeDeadline:window.isMinimized()};});
      assert.equal(minimized.beforeDeadline,true);
      await poll(async()=> (await session()).cursor.phase==='recorded','The minimized test window did not finalize its timed recording',60000);
      minimized.afterDeadline=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized());assert.equal(minimized.afterDeadline,true);
      await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.restore();window.hide();});
    }else await waitPhase(`deadline-${scenario}`, 'recorded', 60000);
    await page.waitForFunction(index => window.__audioDeadline.recorders[index]?.controlStopped, index);
    const entry = (await session()).answers[`deadline-${scenario}`]; assert.ok(entry.recordingId); assert.ok(entry.recordingUrl);
    const response = await appFetch(origin + entry.recordingUrl); assert.equal(response.status, 200);
    const saved = Buffer.from(await response.arrayBuffer());
    assert.equal(saved.toString('ascii', 0, 4), 'RIFF'); assert.equal(saved.toString('ascii', 8, 12), 'WAVE'); assert.equal(saved.readUInt16LE(20), 1); assert.equal(saved.readUInt16LE(22), 1); assert.equal(saved.readUInt16LE(34), 16);
    const frames = saved.readUInt32LE(40) / 2, rate = saved.readUInt32LE(24), savedSeconds = frames / rate;
    assert.equal(saved.length, 44 + frames * 2); assert.ok(savedSeconds > 44.5 && savedSeconds <= 45, `Saved duration ${savedSeconds} must remain within the real Interview limit`);
    const analysis = await page.evaluate(async ({ index, url, sampleRate }) => {
      const capture = window.__audioDeadline.recorders[index], decoder = new OfflineAudioContext(1, 1, sampleRate);
      const gatedBlob = new Blob(capture.parts, { type: capture.mimeType }), controlBlob = new Blob(capture.controlParts, { type: capture.mimeType });
      const gated = await decoder.decodeAudioData(await gatedBlob.arrayBuffer()), control = await decoder.decodeAudioData(await controlBlob.arrayBuffer()), accepted = await decoder.decodeAudioData(await (await fetch(url)).arrayBuffer());
      const inspect = (buffer, start, end) => {
        const data = buffer.getChannelData(0), from = Math.floor(start * buffer.sampleRate), to = Math.min(data.length, Math.floor(end * buffer.sampleRate));
        if (to <= from) return { frames: 0, rms: null, tone880: null, tone1760: null };
        let energy = 0; for (let i = from; i < to; i++) energy += data[i] ** 2;
        const amplitude = frequency => { let real = 0, imaginary = 0; for (let i = from; i < to; i++) { const phase = 2 * Math.PI * frequency * i / buffer.sampleRate; real += data[i] * Math.cos(phase); imaginary += data[i] * Math.sin(phase); } return 2 * Math.hypot(real, imaginary) / (to - from); };
        return { frames: to - from, rms: Math.sqrt(energy / (to - from)), tone880: amplitude(880), tone1760: amplitude(1760) };
      };
      const base64 = async blob => { const bytes = new Uint8Array(await blob.arrayBuffer()); let encoded = ''; for (const byte of bytes) encoded += String.fromCharCode(byte); return btoa(encoded); };
      let maxPrefixError = 0; const channel = accepted.getChannelData(0);
      for (let i = 0; i < channel.length; i++) { let expected = 0; for (let c = 0; c < gated.numberOfChannels; c++) expected += gated.getChannelData(c)[i] / gated.numberOfChannels; maxPrefixError = Math.max(maxPrefixError, Math.abs(channel[i] - Math.max(-1, Math.min(1, expected)))); }
      return {
        scenario: capture.scenario, nativeSeconds: (capture.stoppedAt - capture.startedAt) / 1000, stopEventSeconds: (capture.stopEventAt - capture.startedAt) / 1000,
        rawGatedSeconds: gated.duration, rawControlSeconds: control.duration, acceptedSeconds: accepted.duration, maxPrefixError,
        gatedBefore: inspect(gated, 43.4, 44), controlBefore: inspect(control, 43.4, 44), acceptedBefore: inspect(accepted, 43.4, 44),
        gatedAfter: inspect(gated, 46.3, 46.8), controlAfter: inspect(control, 46.3, 46.8),
        block: window.__audioDeadline.blocks[index - 1] || null,
        rawGated: await base64(gatedBlob), rawControl: await base64(controlBlob),
      };
    }, { index, url: entry.recordingUrl, sampleRate: rate });
    const rawGated = Buffer.from(analysis.rawGated, 'base64'), rawControl = Buffer.from(analysis.rawControl, 'base64'); delete analysis.rawGated; delete analysis.rawControl;
    assert.ok(analysis.gatedBefore.rms > .05, JSON.stringify(analysis)); assert.ok(analysis.acceptedBefore.tone880 > .05, JSON.stringify(analysis));
    assert.ok(analysis.maxPrefixError <= 2 / 32768, JSON.stringify(analysis)); assert.ok(analysis.acceptedSeconds <= 45, JSON.stringify(analysis));
    if (scenario === 'normal') {
      assert.ok(analysis.nativeSeconds > 44.5 && analysis.nativeSeconds < 45.7, JSON.stringify(analysis)); assert.equal(analysis.block, null);
      pass('a real Interview counts down, automatically stops around 45 seconds and saves a frame-bounded PCM WAV with the original audible prefix');
    } else {
      assert.ok(analysis.block?.relativeStartSeconds >= 43.9 && analysis.block.relativeStartSeconds < 45, JSON.stringify(analysis));
      assert.ok(analysis.block.relativeEndSeconds >= 47.2 && analysis.nativeSeconds >= 47.1, JSON.stringify(analysis));
      assert.ok(analysis.rawGatedSeconds >= 46.8 && analysis.rawControlSeconds >= 46.8, JSON.stringify(analysis));
      assert.ok(analysis.controlAfter.rms > .05 && analysis.controlAfter.tone1760 > .05, JSON.stringify(analysis));
      assert.ok(analysis.gatedAfter.rms < .003 && analysis.gatedAfter.tone1760 < .001, JSON.stringify(analysis));
      pass('when the main thread cannot stop recording until 47.2 seconds, the audio thread removes the after-46-second marker and the saved WAV still contains at most 45 seconds');
    }
    const recordedCountdown = await page.locator('#record-duration').innerText(), recordAgainDisabled = await page.locator('#record-toggle').isDisabled();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.exam-shell').getAttribute('data-question-id'), `deadline-${scenario}`); assert.equal(await page.evaluate(() => window.__audioDeadline.recorders.length), index + 1);
    const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')), record = disk.recordings[entry.recordingId]; assert.ok(record);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'blobs', record.mediaId)), saved); assert.deepEqual(Buffer.from(uploads[index].data, 'base64'), saved);
    await fs.writeFile(path.join(run, `${scenario}-saved.wav`), saved); await fs.writeFile(path.join(run, `${scenario}-raw-gated.webm`), rawGated); await fs.writeFile(path.join(run, `${scenario}-raw-control.webm`), rawControl);
    cases.push({ ...analysis, minimized, sessionId, questionId: `deadline-${scenario}`, recordingId: entry.recordingId, savedFrames: frames, savedRate: rate, savedSeconds, savedBytes: saved.length, savedSha256: hash(saved), wallElapsedSeconds: (Date.now() - started) / 1000, firstCountdown, secondCountdown, recordedCountdown, recordAgainDisabled });
    console.log(JSON.stringify(cases.at(-1)));
  }
  currentCase = 'finish and verify preserved recordings';
  for (const item of cases) { assert.equal(item.recordedCountdown, '00:00', `${item.scenario}: a consumed clock must stay at zero after saving`); assert.equal(item.recordAgainDisabled, true, `${item.scenario}: zero budget must disable re-recording`); }
  assert.equal(uploads.length, 2); assert.notEqual(cases[0].recordingId, cases[1].recordingId);
  await page.locator('#exam-next').click(); await page.getByRole('dialog', { name: 'Finish this module?' }).waitFor(); await page.getByRole('button', { name: 'Finish Module', exact: true }).click(); await page.locator('.exam-completed').waitFor();
  const finalState = await api('/state'); assert.equal(finalState.attempts.length, 2); assert.equal(finalState.jobs.length, 0); assert.equal(finalState.settings.provider, 'none');
  for (const item of cases) assert.equal(finalState.attempts.find(attempt => attempt.questionId === item.questionId)?.recordingId, item.recordingId);
  const inputSummary = await page.evaluate(async () => { const harness = window.__audioDeadline; const result = { getUserMediaCalls: harness.getUserMediaCalls, realMicrophoneCalls: harness.realMicrophoneCalls, activeInputTracks: harness.inputs.flatMap(input => input.stream.getTracks()).filter(track => track.readyState === 'live').length }; await Promise.all(harness.inputs.map(input => input.context.close().catch(() => {}))); return result; });
  assert.equal(inputSummary.realMicrophoneCalls, 0); assert.equal(inputSummary.activeInputTracks, 0); assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  pass('zero-budget questions stay recorded until explicit Next, and two separate recordings remain bound to the correct submitted attempts');
  const sourceAfter = await sourceHashes();
  const summary = { ok: true, packaged, expectedVersion, executablePath, runtime, checks, cases, inputSummary, realModelCalls: 0, errors, externalRequests, sourceBefore, sourceAfter, sourceStable: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter) };
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('RESULT_DIR ' + run);
} catch (error) {
  console.error(`FAIL during ${currentCase}: ${error.stack || error.message}`); process.exitCode = 1;
  await page?.screenshot({ path: path.join(run, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(run, 'failure.json'), JSON.stringify({ currentCase, error: error.stack || error.message, expectedVersion, checks, cases, runtime, errors, externalRequests, sourceBefore, sourceAfter: await sourceHashes() }, null, 2) + '\n');
  console.log('RESULT_DIR ' + run);
} finally {
  if (app) await app.close();
  else { await context?.close(); await browser?.close(); }
  await instance?.close();
}
