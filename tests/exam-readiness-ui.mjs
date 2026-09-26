import {appFetch} from './auth-client.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import { canonicalJSON, readZip } from '../src/package.mjs';

// Reproductions of the independent readiness review, using only authored text,
// a generated tone and the browser's synthetic microphone. No learner data,
// saved credentials or remote model services are accessed.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(project, 'test-results');
await fs.mkdir(artifactRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(artifactRoot, 'exam-readiness-ui-'));
const dataDir = path.join(output, 'synthetic-data');
const sourceNames = ['public/app.mjs', 'public/exam-practice.mjs', 'public/exam-library.mjs', 'public/exam-views.mjs', 'public/exam.css', 'src/exam-session.mjs', 'src/server.mjs'];
const sourceState = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => {
  const full = path.join(project, name), bytes = await fs.readFile(full), stat = await fs.stat(full);
  return [name, { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), modifiedUtc: stat.mtime.toISOString() }];
})));
const report = { startedUtc: new Date().toISOString(), sourceBefore: await sourceState(), checks: [], details: {}, pageErrors: [], failedApiRequests: [], externalRequests: [], realModelCalls: 0 };
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
let instance, browser, page;
const tone = () => {
  const rate = 16000, samples = 3200, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 500), 44 + i * 2);
  return bytes;
};
const source = 'Original independent browser fixture.';
const choice = (id, audio = null) => ({ id, type: 'single_choice', prompt: 'Which original item is described?', options: [{ id: 'A', text: 'A lamp.' }, { id: 'B', text: 'A cup.' }], answer: 'A', audio, source });
const repeat = (id, audio = null) => ({ id, type: 'listen_repeat', prompt: 'Repeat the original sentence.', answer: 'A lamp stands beside a small book.', audio, source });
const pack = { schemaVersion: 1, id: 'original-exam-readiness', version: '1', title: 'Original readiness regression', groups: [
  { id: 'reading', section: 'reading', title: 'Original reading', passage: 'A lamp stands on the desk.', questions: [choice('r1')] },
  { id: 'missing-listening', section: 'listening', title: 'Original incomplete listening', passage: 'This supplied transcript must remain hidden.', questions: [choice('missing-l1'), choice('missing-l2', 'tone.wav')] },
  { id: 'listening', section: 'listening', title: 'Original complete listening', passage: 'This other supplied transcript must remain hidden.', audio: 'tone.wav', questions: [choice('l1'), choice('l2')] },
  { id: 'missing-speaking', section: 'speaking', title: 'Original incomplete speaking', passage: '', questions: [repeat('missing-s1')] },
  { id: 'speaking', section: 'speaking', title: 'Original complete speaking', passage: '', questions: [repeat('s1', 'tone.wav'), repeat('s2', 'tone.wav')] },
] };
const upload = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });
const poll = async (read, predicate, message) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 35)); }
  assert.fail(message);
};

try {
  instance = await startServer({ dataDir, models: { publicSettings: () => ({ provider: 'none', capabilities: {} }), feedback: () => { throw new Error('No model call is allowed'); } } });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await appFetch(instance.url + '/api' + route, { method, headers: { 'X-PracticeBridge': '1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, 200, `${route}: ${JSON.stringify(result)}`); return result;
  };
  const preview = await api('/import/preview', { files: [upload('practicebridge.json', JSON.stringify(pack)), upload('tone.wav', tone())] });
  assert.deepEqual(preview.issues.filter(issue => issue.severity === 'error'), []);
  const { library } = await api('/import/commit', { draftId: preview.draftId, pack: preview.pack, acknowledged: true });
  browser = await chromium.launch({ channel: process.env.PRACTICEBRIDGE_BROWSER_CHANNEL || 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  const context = await browser.newContext({ permissions: ['microphone'], acceptDownloads: true, serviceWorkers: 'block', viewport: { width: 1180, height: 820 } });
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== instance.url) { report.externalRequests.push(url.href); return route.abort(); } return route.continue(); });
  await context.addInitScript(() => {
    const NativeRecorder = window.MediaRecorder, nativeGet = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const media = window.__readinessMedia = { recorders: [], streams: [], microphoneRequests: 0 };
    navigator.mediaDevices.getUserMedia = async constraints => { media.microphoneRequests++; const stream = await nativeGet(constraints); media.streams.push(stream); return stream; };
    window.MediaRecorder = class extends NativeRecorder { constructor(stream, options) { super(stream, options); media.recorders.push(this); } };
  });
  page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) report.failedApiRequests.push({ url: response.url(), status: response.status() }); });
  const waitPhase = value => page.waitForFunction(value => document.querySelector('.exam-shell')?.dataset.phase === value, value);
  const runId = () => page.locator('.exam-shell').getAttribute('data-session-id');
  const session = async id => (await api(`/sessions/${id || await runId()}`)).session;
  const openRun = async (groupId, preset = 'document', mode = 'exam') => {
    const { session: run } = await api('/sessions', { sessionVersion: 2, libraryId: library.libraryId, groupId, mode, preset });
    await page.goto(`${instance.url}/#exam/${library.libraryId}/${run.planSnapshot.id}/all/${mode}/${run.id}`);
    await page.waitForFunction(id => { const shell = document.querySelector('.exam-shell'); return shell?.dataset.sessionId === id && shell.dataset.phase === 'instructions'; }, run.id);
    return run;
  };

  for (const groupId of ['missing-listening', 'missing-speaking']) {
    await openRun(groupId);
    assert.equal(await page.locator('#exam-next').isDisabled(), true);
    assert.match(await page.locator('.exam-media-missing').innerText(), /1 道听说题缺少题目音频/);
    assert.equal(await page.locator('#prompt-audio').count(), 0);
    await page.locator('#exam-next').evaluate(button => button.click());
    const unchanged = await session();
    assert.equal(unchanged.cursor.phase, 'instructions'); assert.equal(unchanged.activeTimerId, null);
    assert.equal(await page.evaluate(() => window.__readinessMedia.microphoneRequests), 0);
    assert.equal(await page.locator('#check-microphone').count(), 0);
    assert.equal((await api('/state')).attempts.length, 0);
    await page.screenshot({ path: path.join(output, `01-${groupId}.png`), fullPage: true });
  }
  check('Missing listening or speaking stimuli show the exact missing count, block Begin, and start no clock, microphone or attempt');

  report.details.timings = [];
  for (const preset of [{}, { readingModuleSeconds: 30 }, { listeningQuestionSeconds: 30 }]) {
    const run = await openRun('listening', preset), custom = Object.hasOwn(preset, 'listeningQuestionSeconds');
    const instructions = await page.locator('#exam-task-host').innerText();
    if (custom) { assert.match(instructions, /00:30 · 自定义/); assert.doesNotMatch(instructions, /材料未给时限|本材料未提供部分限时/); }
    else { assert.match(instructions, /00:20 · 练习默认/); assert.match(instructions, /软件练习默认值/); assert.doesNotMatch(instructions, /· 自定义/); }
    assert.equal(await page.locator('#exam-next').isEnabled(), true, 'Shared group audio covers both listening questions');
    await page.locator('#exam-next').click(); await waitPhase('response');
    const response = await session(run.id), timer = response.timers[response.activeTimerId];
    assert.equal(timer.durationSeconds, custom ? 30 : 20);
    assert.equal(timer.scope, 'question');
    assert.equal(await page.locator('#exam-answers,#exam-transcript,#exam-ai').count(), 0);
    assert.doesNotMatch(await page.locator('#main').innerText(), /This other supplied transcript/);
    report.details.timings.push({ preset, instructions, timerDuration: timer.durationSeconds, timerScope: timer.scope });
  }
  await page.screenshot({ path: path.join(output, '02-custom-listening-clock.png'), fullPage: true });
  check('Empty and unrelated presets use the labeled default countdown; a matching preset displays the same 30 seconds as the server clock, with strict helpers and transcripts absent');

  await page.goto(`${instance.url}/#practice/${library.libraryId}/reading/practice`); await waitPhase('instructions');
  const firstId = await runId(); assert.match(page.url(), new RegExp(`/all/practice/${firstId}$`));
  await page.locator('#exam-next').click(); await waitPhase('response'); await page.locator('input[name=answer][value=A]').check();
  await poll(() => session(firstId), value => value.answers.r1?.answer === 'A', 'The alias answer did not reach persistent storage');
  const countBefore = (await api('/state')).sessions.length, beforeUrl = page.url();
  await page.reload(); await page.waitForSelector('.exam-shell');
  assert.equal(await runId(), firstId); assert.equal(page.url(), beforeUrl);
  assert.equal((await api('/state')).sessions.length, countBefore);
  assert.equal((await session(firstId)).answers.r1.answer, 'A');
  assert.equal(await page.locator('.exam-pause-cover').isVisible(), true);
  await page.locator('#exam-resume').click();
  assert.equal(await page.locator('input[name=answer][value=A]').isChecked(), true);
  report.details.freshAlias = { sessionId: firstId, canonicalUrl: beforeUrl, sessionCountBefore: countBefore, sessionCountAfter: (await api('/state')).sessions.length };
  await page.screenshot({ path: path.join(output, '03-alias-resume.png'), fullPage: true });
  check('A fresh legacy URL becomes canonical immediately; reloading resumes the same session, answer and pause state without creating a duplicate');

  const speaking = await openRun('speaking', { repeatSeconds: 60 });
  await page.locator('#check-microphone').click(); await page.waitForFunction(() => document.querySelector('#microphone-status')?.textContent.includes('ready'));
  await page.locator('#exam-next').click(); await waitPhase('response'); await page.waitForTimeout(400);
  await page.locator('#record-toggle').click(); await waitPhase('recorded');
  const firstTake = await session(speaking.id), firstRecording = firstTake.answers.s1.recordingId;
  assert.ok(firstRecording); assert.equal(await page.locator('#record-toggle').isVisible(), false);
  const recorderCount = await page.evaluate(() => window.__readinessMedia.recorders.length);
  // Exercise the public handler too: a stale or programmatic click cannot start
  // capture after TEST already has an accepted take, even if the button is hidden.
  await page.locator('#record-toggle').evaluate(button => button.click());
  assert.equal(await page.evaluate(() => window.__readinessMedia.recorders.length), recorderCount);
  assert.equal(await page.locator('#export-pending-recording').count(), 0);
  assert.equal((await session(speaking.id)).answers.s1.recordingId, firstRecording);
  await page.locator('#exam-next').click(); await waitPhase('response');
  assert.equal(await page.locator('.exam-shell').getAttribute('data-question-id'), 's2');
  await page.waitForTimeout(400); await page.locator('#record-toggle').click(); await waitPhase('recorded');
  const secondTake = await session(speaking.id), secondRecording = secondTake.answers.s2.recordingId;
  assert.ok(secondRecording); assert.notEqual(secondRecording, firstRecording); assert.equal(secondTake.answers.s1.recordingId, firstRecording);
  await page.screenshot({ path: path.join(output, '04-strict-saved-recording.png'), fullPage: true });
  await page.locator('#exam-exit').click(); await page.waitForURL(`**/#collection/${library.libraryId}`);
  assert.equal((await session(speaking.id)).paused, true);
  assert.equal(await page.evaluate(() => window.__readinessMedia.streams.flatMap(stream => stream.getTracks()).filter(track => track.readyState === 'live').length), 0);
  const beforeResumeRecorders = await page.evaluate(() => window.__readinessMedia.recorders.length);
  await page.goto(`${instance.url}/#exam/${library.libraryId}/${speaking.planSnapshot.id}/all/exam/${speaking.id}`); await waitPhase('recorded');
  await page.locator('#exam-resume').click();
  assert.equal(await page.locator('#record-toggle').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__readinessMedia.recorders.length), beforeResumeRecorders, 'Resume must not start a recorder');
  const resumed = await session(speaking.id);
  assert.equal(resumed.answers.s1.recordingId, firstRecording); assert.equal(resumed.answers.s2.recordingId, secondRecording);
  assert.equal(await page.locator('#export-pending-recording').count(), 0);
  await page.locator('#exam-exit').click(); await page.waitForURL(`**/#collection/${library.libraryId}`);
  report.details.strictRecordings = { firstRecording, secondRecording, priorAnswerUnchanged: true, resumedWithoutCapture: true, exitedNormally: true };
  check('TEST hides Record Again and rejects stale handler clicks; Next keeps both saved takes distinct, and exit/resume leaves recordings intact with all streams stopped');

  const downloadPromise = page.waitForEvent('download'); await page.locator('#export-pack').click();
  const download = await downloadPromise, exportedPath = path.join(output, 'original-export.zip'); await download.saveAs(exportedPath);
  assert.equal(await download.failure(), null);
  const contents = (await readZip(await fs.readFile(exportedPath)));
  assert.equal(canonicalJSON(JSON.parse(contents.get('practicebridge.json'))), canonicalJSON(preview.pack));
  assert.deepEqual(contents.get('tone.wav'), tone());
  assert.equal((await api('/state')).attempts.length, 0); assert.equal((await api('/state')).jobs.length, 0);
  check('The visible library export button downloads a valid native ZIP containing the exact original exercise and audio');

  const instructionPack={schemaVersion:1,examContractVersion:1,minReaderVersion:'0.3.0',id:'module-audio-fixture',version:'1',title:'Original module instructions',groups:[{id:'module-reading',section:'reading',title:'Original reading',passage:'An original lamp.',taskKind:'read_daily',questions:[choice('module-r1')]}],examSets:[{id:'module-set',title:'Module instructions',sections:[{id:'module-reading-section',section:'reading',title:'Reading',modules:[{id:'audio-module',title:'Module 1',sourceNumber:1,taskIds:['module-reading'],instructions:{text:'Listen to these module instructions.',audio:'tone.wav',source,basis:'user',verifiedContent:false},navigation:{back:'module',review:'module',lockOnAdvance:true}}]}]}]};
  const instructionDraft=await api('/import/preview',{files:[upload('practicebridge.json',JSON.stringify(instructionPack)),upload('tone.wav',tone())]});
  assert.deepEqual(instructionDraft.issues.filter(issue=>issue.severity==='error'),[]);
  const {library:instructionLibrary}=await api('/import/commit',{draftId:instructionDraft.draftId,pack:instructionDraft.pack,acknowledged:true});
  for(const mode of ['exam','practice']){
    const {session:run}=await api('/sessions',{sessionVersion:2,libraryId:instructionLibrary.libraryId,setId:'module-set',mode});
    await page.goto(`${instance.url}/#exam/${instructionLibrary.libraryId}/module-set/all/${mode}/${run.id}`);await waitPhase('instructions');
    const audio=page.locator('#prompt-audio');await audio.waitFor({state:'attached'});
    await page.locator('#exam-next').click();
    if(mode==='exam'){
      assert.equal((await session(run.id)).cursor.phase,'instructions');assert.equal((await session(run.id)).activeTimerId,null);
      await page.locator('#play-stimulus').click();
      await page.waitForFunction(()=>{const audio=document.querySelector('#prompt-audio');return audio.readyState>=2&&audio.currentTime>0;});
      await page.waitForFunction(()=>document.querySelector('#prompt-audio')?.ended);
      assert.equal((await session(run.id)).activeTimerId,null,'Instruction playback must not consume the response clock');
      await page.locator('#exam-next').click();await waitPhase('response');
    }else{
      await page.locator('[data-result=cancel]').click();assert.equal((await session(run.id)).assisted,false);
      await page.locator('#exam-next').click();await page.locator('[data-result=confirm]').click();await waitPhase('response');
      assert.equal((await session(run.id)).assisted,true);
    }
    await page.locator('#exam-exit').click();await page.locator('#exam-set-rows').waitFor();
  }
  check('Module instruction audio really plays before TEST Begin without starting its answer clock; PRACTICE skips only after confirmation and records assistance');

  const replay=await openRun('listening',{listeningQuestionSeconds:30},'practice');
  await page.locator('#exam-next').click();await waitPhase('response');
  const replayClock=await session(replay.id),replayDeadline=replayClock.timers[replayClock.activeTimerId].deadlineAt;
  await page.waitForFunction(()=>document.querySelector('#prompt-audio')?.readyState>=2);
  assert.equal(await page.locator('.exam-reply-side').count(),1);assert.equal(await page.locator('.exam-reply-choices input').count(),2);
  assert.doesNotMatch(await page.locator('#main').innerText(),/This other supplied transcript/);
  await page.locator('#audio-rate').selectOption('1.25');
  await page.waitForFunction(()=>document.querySelector('#prompt-audio')?.playbackRate===1.25);
  const seekBox=await page.locator('#audio-progress').boundingBox();await page.locator('#audio-progress').click({position:{x:seekBox.width/2,y:seekBox.height/2}});
  await page.waitForFunction(()=>document.querySelector('#prompt-audio')?.currentTime>=0.09);
  await page.locator('#play-stimulus').click();await page.waitForFunction(()=>document.querySelector('#prompt-audio')?.ended);
  const replayed=await session(replay.id);assert.equal(replayed.assisted,true);assert.equal(replayed.cursor.phase,'response');assert.equal(replayed.cursor.questionId,'l1');assert.equal(replayed.timers[replayed.activeTimerId].deadlineAt,replayDeadline);
  await page.screenshot({path:path.join(output,'05-listening-replay.png')});
  await page.locator('#exam-exit').click();await page.locator('#exam-set-rows').waitFor();
  check('Listening uses separate speaker and choice panes; replay, speed and seeking work as marked assistance without revealing the transcript or resetting the question clock');

  const legacyBlank={schemaVersion:1,id:'original-old-blank',version:'1',title:'Original old blank',groups:[{id:'old-blank-group',section:'reading',title:'Original fill blank',passage:'A lamp stands beside a book.',questions:[{id:'old-blank',type:'fill_blank',prompt:'Complete: A lamp stands beside a _____.',answer:'book'}]}]};
  const legacyDraft=await api('/import/preview',{files:[upload('practicebridge.json',JSON.stringify(legacyBlank))]});
  assert.deepEqual(legacyDraft.issues.filter(issue=>issue.severity==='error'),[]);
  const {library:legacyLibrary}=await api('/import/commit',{draftId:legacyDraft.draftId,pack:legacyDraft.pack,acknowledged:true});
  await page.goto(`${instance.url}/#practice/${legacyLibrary.libraryId}/old-blank-group/practice`);await waitPhase('instructions');await page.locator('#exam-next').click();await waitPhase('response');
  assert.equal(await page.locator('.exam-unavailable').count(),0);assert.equal(await page.locator('.exam-letter').count(),0);assert.equal(await page.locator('.exam-blank-sentence #answer-input').count(),1);
  await page.locator('#answer-input').fill('book');await page.locator('#exam-next').click();await waitPhase('review');await page.locator('#end-review-scope').click();await page.locator('[data-result=confirm]').click();await page.locator('.exam-completed').waitFor();
  const legacyState=await api('/state'),legacyAttempt=legacyState.attempts.find(attempt=>attempt.questionId==='old-blank');assert.equal(legacyAttempt.answer,'book');assert.equal(legacyAttempt.objective.status,'correct');
  const legacyExport=await readZip(Buffer.from(await (await appFetch(instance.url+`/api/library/${legacyLibrary.libraryId}/export`)).arrayBuffer()));
  assert.equal(canonicalJSON(JSON.parse(legacyExport.get('practicebridge.json'))),canonicalJSON(legacyDraft.pack));
  check('A valid v1 ordinary blank remains an inline word input, saves and grades its full-word answer, and preserves the original package');

  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.failedApiRequests, []); assert.deepEqual(report.externalRequests, []);
  check('No page errors, failed API requests, external requests or model calls occurred');
} catch (error) {
  report.error = error.stack || String(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close(); await instance?.close();
  report.sourceAfter = await sourceState(); report.finishedUtc = new Date().toISOString();
  report.sourcesUnchangedDuringRun = canonicalJSON(report.sourceBefore) === canonicalJSON(report.sourceAfter);
  if (!report.sourcesUnchangedDuringRun) { report.error ||= 'Application sources changed during the browser run; rerun against one fixed source revision.'; process.exitCode = 1; }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const checkedData = path.resolve(dataDir), checkedOutput = path.resolve(output);
  if (checkedData === path.join(checkedOutput, 'synthetic-data') && checkedOutput.startsWith(path.resolve(artifactRoot) + path.sep)) await fs.rm(checkedData, { recursive: true, force: true });
  console.log(JSON.stringify({ artifactDir: output, passed: report.checks.length, sourcesUnchangedDuringRun: report.sourcesUnchangedDuringRun, ...(report.error ? { error: report.error } : {}) }));
  console.log(`RESULT_DIR ${output}`);
}
