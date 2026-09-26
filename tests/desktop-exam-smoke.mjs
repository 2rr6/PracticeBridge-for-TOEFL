// Run source:   node tests/desktop-exam-smoke.mjs
// Run package:  node tests/desktop-exam-smoke.mjs --packaged <directory-or-exe>
// Always uses its own data/profile directories and Chromium's synthetic mic.
import { _electron as electron } from 'playwright';
import { saveAndProcessLocal } from './material-ui-helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8')).version;
assert.match(expectedVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'The checked-out build must declare an explicit version');
const args = process.argv.slice(2), packaged = args[0] === '--packaged';
assert.ok(args.length === 0 || (packaged && args.length === 2 && args[1]), 'Usage: node tests/desktop-exam-smoke.mjs [--packaged <directory-or-exe>]');
let executablePath = packaged ? path.resolve(args[1]) : path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe');
if ((await fs.stat(executablePath)).isDirectory()) executablePath = path.join(executablePath, 'PracticeBridge.exe');
await fs.access(executablePath);
const testRoot = path.join(project, 'test-results'); await fs.mkdir(testRoot, { recursive: true });
const run = await fs.mkdtemp(path.join(testRoot, `desktop-exam-${packaged ? 'packaged' : 'source'}-`));
const dataDir = path.join(run, 'data');
assert.ok(path.resolve(dataDir).startsWith(testRoot + path.sep));
const env = { ...process.env, PRACTICEBRIDGE_DATA_DIR: dataDir, PRACTICEBRIDGE_TEST_HIDDEN: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], externalRequests = [], uploads = [], exitCodes = [], runtimeInfo = [], captureParts = [], screenshots = [], stderr = [];
const pass = label => { checks.push(label); console.log('PASS ' + label); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const poll = async (check, message, timeout = 15000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(message); };
let app, page, currentCase = 'initialization', currentOrigin, stoppedCapture, closeRequestedAt;

async function launch() {
  const application = await electron.launch({ executablePath, args: [...(packaged ? [] : [project]), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'], env, timeout: 30000 });
  application.process().stderr?.on('data', data => { if (stderr.join('').length < 100000) stderr.push(data.toString()); });
  const browserContext = application.context();
  const window = await application.firstWindow(); window.setDefaultTimeout(15000); window.on('pageerror', error => errors.push(error.message));
  await window.locator('.hero').waitFor(); currentOrigin = new URL(window.url()).origin;
  await browserContext.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && (url.hostname !== '127.0.0.1' || (currentOrigin && url.origin !== currentOrigin))) { externalRequests.push(url.href); return route.abort('blockedbyclient'); }
    if (url.pathname === '/api/recordings' && route.request().method() === 'POST') uploads.push(route.request().postDataJSON());
    return route.continue();
  });
  const runtime = await application.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData'), appPath: app.getAppPath(), fakeMedia: app.commandLine.hasSwitch('use-fake-device-for-media-stream'), windowCount: BrowserWindow.getAllWindows().length, fullScreen: BrowserWindow.getAllWindows()[0].isFullScreen(), preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences() }));
  assert.equal(runtime.packaged, packaged); assert.equal(runtime.version, expectedVersion, 'The running app must match the checked-out build version'); assert.equal(runtime.fakeMedia, true); assert.equal(runtime.windowCount, 1);
  assert.equal(path.resolve(runtime.profile), path.join(dataDir, 'desktop-profile')); assert.equal(runtime.preferences.nodeIntegration, false); assert.equal(runtime.preferences.contextIsolation, true); assert.equal(runtime.preferences.sandbox, true);
  const { preferences, ...summary } = runtime; runtimeInfo.push({ ...summary, rendererIsolation: true });
  return { application, window };
}
async function screenshot(application, name) {
  const result = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], wasVisible = window.isVisible();
    try {
      if (!wasVisible) window.showInactive();
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await new Promise(resolve => setTimeout(resolve, 150));
      const image = await window.webContents.capturePage(), view = await window.webContents.executeJavaScript('({phase:document.querySelector(".exam-shell")?.dataset.phase||null,questionId:document.querySelector(".exam-shell")?.dataset.questionId||null,paused:!!document.querySelector("#exam-resume")})');
      return { png: image.toPNG().toString('base64'), size: image.getSize(), wasVisible, view };
    } finally { if (!wasVisible && !window.isDestroyed()) window.hide(); }
  });
  assert.ok(result.size.width > 600 && result.size.height > 400, JSON.stringify(result.size)); await fs.writeFile(path.join(run, name), Buffer.from(result.png, 'base64'));
  const { png, ...metadata } = result; screenshots.push({ name, ...metadata });
}
async function closeWindow(application) {
  const process = application.process(), closed = application.waitForEvent('close', { timeout: 20000 });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await closed;
  await poll(() => process.exitCode !== null, 'The Electron process did not finish after its window closed'); exitCodes.push(process.exitCode); assert.equal(process.exitCode, 0); currentOrigin = null;
}
const state = () => page.evaluate(() => fetch('/api/state').then(response => response.json()));
const waitPhase = (qid, phase) => page.waitForFunction(({ qid, phase }) => { const shell = document.querySelector('.exam-shell'); return shell?.dataset.questionId === qid && shell.dataset.phase === phase; }, { qid, phase });
const material = id => page.evaluate(id => fetch(`/api/materials/${id}`).then(response => response.json()).then(result => result.material), id);
const candidates = id => page.evaluate(async id => { const response = await fetch(`/api/materials/${id}/candidates?author=1`); if (!response.ok) throw Error(`Candidate inspection failed: ${response.status}`); return response.json(); }, id);
async function localProcess() { const button = page.locator('#process-material-local'); if (!await button.isVisible()) await page.locator('details').filter({ has: button }).locator('summary').click(); await button.click(); }
function originalPdf(lines) {
  const escape = text => text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 10 Tf 50 760 Td 16 TL ${lines.map((line, index) => `${index ? 'T* ' : ''}(${escape(line)}) Tj`).join('\n')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(text); text += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(text);
}

try {
  ({ application: app, window: page } = await launch()); assert.equal((await state()).libraries.length, 0); assert.equal((await state()).settings.provider, 'none');
  await screenshot(app, '01-empty-desktop.png'); pass('actual Electron starts with an isolated empty data/profile directory, a sandboxed renderer and no configured model');

  currentCase = 'bundled native example download and candidate compilation';
  const samplePath = path.join(run, 'bundled-getting-started.zip');
  // Electron owns native downloads. Pin the destination to this isolated run;
  // Playwright's browser download event is not used for the desktop session.
  await app.evaluate(({ session }, filename) => {
    globalThis.__desktopDownloads = [];
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSavePath(filename); const record = { filename: item.getFilename(), path: filename, state: 'pending' }; globalThis.__desktopDownloads.push(record);
      item.once('done', (_event, state) => { record.state = state; record.bytes = item.getReceivedBytes(); });
    });
  }, samplePath);
  await page.locator('#sample-guide').click(); await page.locator('#download-pack').waitFor(); await page.locator('#download-pack').click();
  const demo = await poll(() => app.evaluate(() => globalThis.__desktopDownloads.find(item => item.state !== 'pending')), 'The bundled desktop example did not finish its native download');
  assert.equal(demo.state, 'completed'); assert.equal(demo.path, samplePath); assert.ok(demo.bytes > 500); await page.locator('.modal .close').click();
  await page.evaluate(() => { location.hash = '#import'; }); await page.locator('#import-files').setInputFiles(samplePath); await saveAndProcessLocal(page);
  assert.equal(await page.locator('#candidate-author').isChecked(), false); assert.equal(await page.locator('#compile-candidates').isDisabled(), false);
  const received = await state(); assert.equal(received.libraries.length, 0); assert.equal(received.materials.length, 1);
  const bundledMaterialId = received.materials[0].id, bundledCandidates = await candidates(bundledMaterialId);
  assert.equal(bundledCandidates.candidates.length, 9); assert.equal(bundledCandidates.candidates.every(candidate => candidate.readiness.canAnswer), true); assert.equal(await page.locator('[data-candidate]').count(), 9);
  await page.locator('#select-answerable').click(); await page.locator('#compile-candidates').click(); await page.locator('#candidate-result .success').waitFor(); await page.locator('#candidate-result a').first().click(); await page.locator('.exam-library-table').waitFor();
  const library = (await state()).libraries[0], questions = library.groups.flatMap(group => group.questions), byKind = kind => library.groups.find(group => group.taskKind === kind);
  assert.equal(questions.length, 9); assert.equal(new Set(questions.map(question => question.type)).size, 7); assert.equal(library.examContractVersion, 1); assert.equal(library.groups.length, 8); assert.equal(library.examSets[0].sections.length, 4);
  const readingQuestions = byKind('read_academic').questions, inlineTask = byKind('complete_words'), inlineQuestion = inlineTask.questions[0], sentenceQuestion = byKind('build_sentence').questions[0], emailQuestion = byKind('write_email').questions[0], repeatTask = byKind('listen_repeat'), repeatQuestion = repeatTask.questions[0];
  assert.equal((await material(bundledMaterialId)).files[0].id, hash(await fs.readFile(samplePath)));
  pass('the running app downloads its own nine-question example, preserves its original hash and compiles real candidates with all four sections and explicit task metadata');

  currentCase = 'full-window exam shell and inline missing letters';
  await page.goto(currentOrigin+`/#exam/${library.libraryId}/${library.examPlan.id}/${library.examPlan.sections.find(section=>section.section==="reading").id}/exam`); await waitPhase(readingQuestions[0].id, 'instructions'); await page.locator('#exam-next').click(); await waitPhase(readingQuestions[0].id, 'response');
  const shell = await page.evaluate(() => { const box = document.querySelector('.exam-shell').getBoundingClientRect(); return { immersive: document.body.classList.contains('exam-mode'), sidebar: getComputedStyle(document.querySelector('#sidebar')).display, topbar: getComputedStyle(document.querySelector('#topbar')).display, width: box.width, left: box.left, innerWidth, height: box.height, innerHeight }; });
  assert.equal(shell.immersive, true); assert.equal(shell.sidebar, 'none'); assert.equal(shell.topbar, 'none'); assert.ok(Math.abs(shell.width - shell.innerWidth) <= 1 && Math.abs(shell.left) <= 1); assert.ok(shell.height >= shell.innerHeight - 2); assert.equal(await page.locator('#exam-answers,#exam-translate').count(), 0);
  for (const question of readingQuestions) { await waitPhase(question.id, 'response'); await page.locator(`input[name=answer][value="${question.answer}"]`).check(); await page.locator('#exam-next').click(); }
  await waitPhase(inlineQuestion.id, 'response'); const cells = page.locator(`[data-qid="${inlineQuestion.id}"][data-letter-index]`); assert.equal(await cells.count(), inlineTask.inlineBlanks.anchors[0].missingLetterCount);
  for (const [index, letter] of [...inlineQuestion.answer].entries()) await cells.nth(index).fill(letter);
  const readingId = await page.locator('.exam-shell').getAttribute('data-session-id'); await poll(async () => (await state()).sessions.find(session => session.id === readingId)?.answers[inlineQuestion.id]?.answer === inlineQuestion.answer, 'Inline answer was not saved as missing letters');
  assert.equal(await page.locator('.exam-word > span').first().innerText(), inlineTask.inlineBlanks.anchors[0].prefix); await screenshot(app, '02-inline-exam.png');
  await page.locator('#exam-next').click(); await page.locator('.exam-completed').waitFor();
  const readingAttempts = (await state()).attempts; assert.equal(readingAttempts.length, 3); assert.equal(readingAttempts.every(attempt => attempt.mode === 'exam' && attempt.objective.status === 'correct'), true); assert.equal(readingAttempts.find(attempt => attempt.questionId === inlineQuestion.id).answer, inlineQuestion.answer);
  pass('the exam fills Electron content, hides practice aids and stores only missing letters before scoring all three reading items');

  currentCase = 'window close flushes the current writing draft';
  await page.locator('#completed-exit').click(); await page.locator('[data-start-section=writing]').click(); await waitPhase(sentenceQuestion.id, 'instructions'); await page.locator('#exam-next').click(); await waitPhase(sentenceQuestion.id, 'response');
  for (const token of sentenceQuestion.answer) await page.locator(`[data-token="${token}"]`).click(); await page.locator('#exam-next').click(); await waitPhase(sentenceQuestion.id, 'review'); await page.locator('#exam-next').click(); await waitPhase(emailQuestion.id, 'response');
  const writingSessionId = await page.locator('.exam-shell').getAttribute('data-session-id'), writingDraft = 'Hi Maya, this original desktop draft asks for two more days. I will return your book on Friday morning.';
  await page.locator('#answer-input').fill(writingDraft); await closeWindow(app); app = null;
  let disk = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')), savedWriting = disk.sessions.find(session => session.id === writingSessionId);
  assert.equal(savedWriting.sessionVersion, 2); assert.equal(savedWriting.answers[emailQuestion.id].answer, writingDraft); assert.equal(savedWriting.cursor.questionId, emailQuestion.id); assert.equal(savedWriting.paused, true); assert.equal(Object.values(savedWriting.timers).some(timer => timer.runningSince), false);
  pass('closing the real window flushes a just-edited email and pauses its existing v2 session before process exit');

  currentCase = 'desktop restart resumes the same paused writing session';
  ({ application: app, window: page } = await launch()); await page.locator(`a[href$="/${writingSessionId}"]`).click(); await page.locator('#exam-resume').waitFor();
  assert.equal(await page.locator('.exam-shell').getAttribute('data-session-id'), writingSessionId); assert.equal(await page.locator('#answer-input').inputValue(), writingDraft); assert.equal((await state()).sessions.find(session => session.id === writingSessionId).paused, true);
  await screenshot(app, '03-paused-draft.png'); await page.locator('#exam-resume').click(); await waitPhase(emailQuestion.id, 'response'); assert.equal(await page.locator('#answer-input').inputValue(), writingDraft); await page.locator('#exam-exit').click(); await page.locator('.exam-library-table').waitFor();
  pass('after restart the same session and email return paused, with no duplicate session or automatic timer restart');

  currentCase = 'actual Electron PDF parser and missing-answer boundary';
  const pdfPath = path.join(run, 'original-desktop.pdf'); await fs.writeFile(pdfPath, originalPdf(['Title: Original desktop PDF', 'Reading: Opening time', 'Passage:', 'The garden opens at nine (local time).', 'Questions:', '1. When does the garden open?', 'A. At eight.', 'B. At nine.', '2. Which item has no supplied key?', 'A. A map.', 'B. A notebook.', 'Answer key: 1 B']));
  await page.evaluate(() => { location.hash = '#import'; }); await page.locator('#import-files').setInputFiles(pdfPath); await page.locator('#save-material').click(); await page.locator('#material-detail').waitFor(); const pdfMaterialId = await page.locator('#material-detail').getAttribute('data-material-id'); await localProcess(); await page.locator('#compile-candidates').waitFor(); const pdfMaterial = await material(pdfMaterialId), pdfCandidates = await candidates(pdfMaterialId);
  assert.equal(pdfMaterial.status, 'draft_ready'); assert.equal(pdfMaterial.draft.candidateReview, true); assert.equal(pdfMaterial.files[0].id, hash(await fs.readFile(pdfPath))); assert.equal(pdfCandidates.candidates.length, 2); assert.equal(pdfCandidates.candidates.every(candidate => candidate.readiness.canAnswer), true); assert.equal(pdfCandidates.candidates[0].fields.answer, 'B'); assert.equal(pdfCandidates.candidates[0].readiness.canScore, true); assert.equal(pdfCandidates.candidates[1].fields.answer, null); assert.equal(pdfCandidates.candidates[1].readiness.canScore, false); assert.equal(await page.locator('#compile-candidates').isDisabled(), false);
  await page.locator('#select-answerable').click(); await page.locator('#compile-candidates').click(); await page.locator('#candidate-result .success').waitFor();
  const afterPdf = await state(), pdfLibrary = afterPdf.libraries.find(item => item.libraryId !== library.libraryId); assert.equal(afterPdf.libraries.length, 2); assert.ok(pdfLibrary);
  const pdfQuestions = pdfLibrary.groups.flatMap(group => group.questions); assert.equal(pdfQuestions.length, 2); assert.equal(pdfQuestions[0].answer, 'B'); assert.equal(pdfQuestions[1].answer, null); assert.match(pdfQuestions[0].source, /original-desktop\.pdf.*第\s*1\s*页/); assert.ok(pdfLibrary.groups[0].passage.includes('nine (local time).'));
  await screenshot(app, '04-pdf-draft.png');
  const blankPdfPath = path.join(run, 'original-empty-text.pdf'); await fs.writeFile(blankPdfPath, originalPdf([])); await page.evaluate(() => { location.hash = '#import'; }); await page.locator('#import-files').setInputFiles(blankPdfPath); await page.locator('#save-material').click(); await page.locator('#material-detail').waitFor(); const blankId = await page.locator('#material-detail').getAttribute('data-material-id'); await localProcess();
  const emptyMaterial = await poll(async () => { const item = await material(blankId); return item.status === 'needs_information' ? item : null; }, 'An empty-text PDF did not remain an unconverted original');
  assert.equal(emptyMaterial.analysis.canCreateDraft, false); assert.equal(emptyMaterial.draft, null); assert.equal(emptyMaterial.files.length, 1); assert.equal(emptyMaterial.files[0].id, hash(await fs.readFile(blankPdfPath))); assert.equal((await state()).libraries.length, 2); await screenshot(app, '05-pdf-empty-boundary.png');
  pass('the Electron runtime extracts and compiles real PDF candidates with page evidence and a missing key, while an empty-text PDF remains preserved without invented questions');

  currentCase = 'native fake recording saves completely when the window closes';
  await page.exposeFunction('__desktopAudioPart', ({ index, data }) => { captureParts[index] = Buffer.from(data, 'base64'); });
  await page.exposeFunction('__desktopAudioStopped', value => { stoppedCapture = { ...value, receivedAt: Date.now() }; });
  await page.evaluate(() => {
    const NativeRecorder = MediaRecorder; window.__desktopRecorders = [];
    window.MediaRecorder = class {
      static isTypeSupported(type) { return NativeRecorder.isTypeSupported(type); }
      constructor(stream, options) {
        this.native = new NativeRecorder(stream, options); this.stream = stream; this.pendingParts = []; this.partCount = 0; this.ondataavailable = null; this.onstop = null; this.onerror = null; window.__desktopRecorders.push(this);
        this.native.ondataavailable = event => {
          const index = this.partCount++; this.ondataavailable?.(event);
          this.pendingParts.push((async () => { const bytes = new Uint8Array(await event.data.arrayBuffer()); let encoded = ''; for (const byte of bytes) encoded += String.fromCharCode(byte); await window.__desktopAudioPart({ index, data: btoa(encoded) }); })());
        };
        this.native.onstop = async () => { await Promise.all(this.pendingParts); await window.__desktopAudioStopped({ partCount: this.partCount, mimeType: this.mimeType }); await this.onstop?.(new Event('stop')); };
        this.native.onerror = event => this.onerror?.(event);
      }
      get state() { return this.native.state; } get mimeType() { return this.native.mimeType; }
      start(timeslice) { this.native.start(timeslice); } stop() { this.native.stop(); }
    };
  });
  await page.evaluate(id => { location.hash = `#collection/${id}`; }, library.libraryId); await page.locator('#exam-task-details > summary').click(); await page.locator(`a[href="#practice/${library.libraryId}/${repeatTask.id}/practice"]`).click(); await waitPhase(repeatQuestion.id, 'instructions');
  await page.locator('#check-microphone').click(); await page.waitForFunction(() => document.querySelector('#microphone-status')?.textContent === 'Microphone is ready.'); await page.locator('#exam-next').click(); await waitPhase(repeatQuestion.id, 'stimulus'); await waitPhase(repeatQuestion.id, 'response'); await page.locator('.exam-recorder.recording').waitFor();
  const speakingSessionId = await page.locator('.exam-shell').getAttribute('data-session-id'); assert.equal(await page.evaluate(() => window.__desktopRecorders.length), 1); await page.waitForTimeout(1150); await screenshot(app, '06-recording-before-close.png');
  assert.equal(await page.evaluate(() => window.__desktopRecorders[0].state), 'recording'); closeRequestedAt = Date.now(); await closeWindow(app); app = null;
  assert.ok(stoppedCapture?.receivedAt >= closeRequestedAt); assert.ok(stoppedCapture.partCount >= 2); assert.equal(captureParts.filter(Boolean).length, stoppedCapture.partCount); assert.equal(uploads.length, 1);
  disk = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')); const savedSpeaking = disk.sessions.find(session => session.id === speakingSessionId), entry = savedSpeaking.answers[repeatQuestion.id], recording = disk.recordings[entry.recordingId];
  assert.equal(savedSpeaking.sessionVersion, 2); assert.equal(savedSpeaking.paused, true); assert.equal(savedSpeaking.cursor.phase, 'recorded'); assert.equal(savedSpeaking.cursor.questionId, repeatQuestion.id); assert.ok(recording); assert.equal(Object.values(savedSpeaking.timers).some(timer => timer.runningSince), false);
  const recordedBytes = await fs.readFile(path.join(dataDir, 'blobs', recording.mediaId)), expectedBytes = Buffer.concat(captureParts); assert.ok(recordedBytes.length > 128); assert.equal(recordedBytes.subarray(0,4).toString(),'RIFF');assert.equal(recordedBytes.subarray(8,12).toString(),'WAVE');assert.deepEqual(recordedBytes, Buffer.from(uploads[0].data, 'base64'));const savedFrames=recordedBytes.readUInt32LE(40)/2,savedRate=recordedBytes.readUInt32LE(24);assert.ok(savedFrames/savedRate>=1&&savedFrames/savedRate<=12); assert.equal(disk.attempts.length, 3, 'Closing saves a response draft without submitting the speaking module');
  await fs.writeFile(path.join(run, 'saved-synthetic-response.wav'), recordedBytes);await fs.writeFile(path.join(run,'native-captured-response.webm'),expectedBytes);
  pass('window close stops native recording, receives all final chunks and saves a bounded WAV in the correct paused session before exiting');

  currentCase = 'saved recording survives another desktop restart and actually plays';
  ({ application: app, window: page } = await launch()); await page.locator(`a[href$="/${speakingSessionId}"]`).click(); await page.locator('#exam-resume').waitFor(); assert.equal(await page.locator('.exam-shell').getAttribute('data-session-id'), speakingSessionId); assert.equal((await state()).sessions.find(session => session.id === speakingSessionId).answers[repeatQuestion.id].recordingId, entry.recordingId); await page.locator('#exam-resume').click(); await waitPhase(repeatQuestion.id, 'recorded');
  const waveform = await page.evaluate(async ({raw,accepted})=>{
    const bytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0)).buffer;
    const decoder=new AudioContext(),before=await decoder.decodeAudioData(bytes(raw)),repeat=await decoder.decodeAudioData(bytes(raw)),after=await decoder.decodeAudioData(bytes(accepted));
    let squared=0,maxError=0,squaredError=0,repeatError=0,firstError=-1,lastError=-1,rawPeak=0,clippedFrames=0;for(let i=0;i<after.length;i++){const source=Array.from({length:before.numberOfChannels},(_,c)=>before.getChannelData(c)[i]||0).reduce((sum,v)=>sum+v,0)/before.numberOfChannels;rawPeak=Math.max(rawPeak,Math.abs(source));if(Math.abs(source)>1)clippedFrames++;const expected=Math.max(-1,Math.min(1,source));const error=Math.abs(expected-after.getChannelData(0)[i]);maxError=Math.max(maxError,error);squaredError+=error**2;repeatError=Math.max(repeatError,Math.abs(before.getChannelData(0)[i]-repeat.getChannelData(0)[i]));if(error>.0001){if(firstError<0)firstError=i;lastError=i;}squared+=after.getChannelData(0)[i]**2;}
    await decoder.close();return {rawFrames:before.length,acceptedFrames:after.length,rawChannels:before.numberOfChannels,rawRate:before.sampleRate,rate:after.sampleRate,maxError,repeatError,firstError,lastError,rawPeak,clippedFrames,rmse:Math.sqrt(squaredError/after.length),rms:Math.sqrt(squared/after.length)};
  },{raw:expectedBytes.toString('base64'),accepted:recordedBytes.toString('base64')});
  await fs.writeFile(path.join(run,'waveform-check.json'),JSON.stringify(waveform,null,2));
  assert.ok(waveform.acceptedFrames<=waveform.rawFrames);assert.ok(waveform.maxError<.0001,JSON.stringify(waveform));assert.ok(waveform.rms>0.00001,JSON.stringify(waveform));
  const playback = await page.locator('.exam-own-recording audio').evaluate(async audio => { await audio.play(); const deadline = performance.now() + 5000; while (audio.currentTime < .05 && !audio.error && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25)); const result = { time: audio.currentTime, readyState: audio.readyState, error: audio.error?.message || null }; audio.pause(); return result; });
  assert.ok(playback.time >= .05, JSON.stringify(playback)); assert.ok(playback.readyState >= 2); assert.equal(playback.error, null); await screenshot(app, '07-restored-recording.png');
  const finalState = await state(); assert.equal(finalState.settings.provider, 'none'); assert.equal(finalState.jobs.length, 0); assert.equal(finalState.sessions.filter(session => session.id === writingSessionId).length, 1); assert.equal(finalState.sessions.filter(session => session.id === speakingSessionId).length, 1); assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  await closeWindow(app); app = null; pass('the same recorded session reopens paused after restart and its saved audio decodes and advances playback');
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify({ ok: true, packaged, expectedVersion, executablePath, checks, errors, externalRequests, exitCodes, runtimeInfo, screenshots, sampleHash: hash(await fs.readFile(samplePath)), bundledMaterialId, writingSessionId, speakingSessionId, recording: { parts: stoppedCapture.partCount, bytes: recordedBytes.length, sha256: hash(recordedBytes), completeBeforeProcessExit: true }, pdf: { materialId: pdfMaterialId, libraryId: pdfLibrary.libraryId, questions: 2, candidatesCompiled: true, missingKeyPreserved: true, emptyTextOriginalPreserved: true }, microphone: 'Chromium synthetic device; native MediaRecorder', examShell: 'fills Electron content area; does not claim OS full-screen mode' }, null, 2) + '\n');
  console.log('RESULT_DIR ' + run);
} catch (error) {
  console.error(`FAIL during ${currentCase}: ${error.stack || error.message}`); process.exitCode = 1;
  if (app) await screenshot(app, 'failure.png').catch(() => {});
  await fs.writeFile(path.join(run, 'failure.json'), JSON.stringify({ currentCase, error: error.stack || error.message, packaged, expectedVersion, executablePath, checks, errors, externalRequests, runtimeInfo }, null, 2) + '\n'); console.log('RESULT_DIR ' + run);
} finally {
  if (app) {
    // Failed test cleanup is separate from the close-handshake assertions. The
    // only owned process here uses this run's isolated data/profile directory.
    const ownedProcess = app.process(); await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
    if (ownedProcess.exitCode === null) await poll(() => ownedProcess.exitCode !== null, 'Owned Electron cleanup did not finish', 5000).catch(() => ownedProcess.kill());
  }
  await fs.writeFile(path.join(run, 'electron-stderr.txt'), stderr.join(''));
}
