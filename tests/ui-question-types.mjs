import {appFetch} from './auth-client.mjs';
// Optional browser coverage using the shipped, independently authored example.
// Run: node tests/ui-question-types.mjs
// An installed Edge is used by default. No real microphone or model is accessed.
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(projectDir, 'test-results');
await fs.mkdir(testRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(testRoot, 'question-types-data-'));
let instance;
let browser;
let context;
let currentCase = 'initialization';
const externalRequests = [];
const pageErrors = [];
const passed = [];
const pass = label => { passed.push(label); console.log(`PASS: ${label}`); };

try {
  instance = await startServer({ dataDir });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await appFetch(`${instance.url}/api${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-PracticeBridge': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const waitForState = async (predicate, message, timeout = 6000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const state = await api('/state');
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(message);
  };
  browser = await chromium.launch({
    channel: process.env.PRACTICEBRIDGE_BROWSER_CHANNEL || 'msedge',
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  context = await browser.newContext({ permissions: ['microphone'], serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== instance.url) {
      externalRequests.push(url.href);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  const navigate = async (hash, readySelector) => {
    await page.evaluate(value => { location.hash = value; }, hash);
    if (readySelector) await page.locator(readySelector).waitFor();
  };

  currentCase = 'offline first launch';
  await page.goto(instance.url);
  await page.locator('.hero').waitFor();
  const initial = await api('/state');
  assert.equal(initial.libraries.length, 0);
  assert.equal(initial.attempts.length, 0);
  assert.equal(initial.settings.provider, 'none');
  assert.equal(Boolean(initial.settings.capabilities?.chat), false);
  await navigate('#assistant', '#chat-form');
  assert.equal(await page.locator('#chat-form button').isDisabled(), true);
  await navigate('#import', '#save-material');
  assert.equal(await page.locator('#save-material').isDisabled(), false);
  await page.locator('details').filter({has:page.locator('#import-text')}).locator('summary').click();
  await page.locator('#import-text').fill('Original local receipt fixture.');
  await page.locator('#save-material').click();
  await page.locator('#process-material-ai').waitFor();
  assert.equal(await page.locator('#process-material-ai').isDisabled(), true);
  assert.deepEqual(externalRequests, []);
  pass('empty first launch keeps AI disabled and makes no external frontend request');

  currentCase = 'shipped original example import';
  const zip = await fs.readFile(path.join(projectDir, 'public/examples/getting-started.zip'));
  const preview = await api('/import/preview', { files: [{ name: 'getting-started.zip', data: zip.toString('base64') }] });
  assert.equal(preview.issues.some(issue => issue.severity === 'error'), false);
  const { library } = await api('/import/commit', { draftId: preview.draftId, pack: preview.pack, acknowledged: true });
  const groupFor = type => library.groups.find(group => group.questions.some(question => question.type === type));
  const questionFor = type => groupFor(type).questions.find(question => question.type === type);
  const writing = groupFor('sentence_order');
  const order = questionFor('sentence_order');
  const email = questionFor('email');
  const discussion = questionFor('discussion');
  const listening = library.groups.find(group => group.section === 'listening');
  const listeningQuestion = listening.questions[0];
  const repeatGroup = groupFor('listen_repeat');
  const repeat = questionFor('listen_repeat');
  const reading = library.groups.find(group => group.section === 'reading');
  assert.ok(library.rights.includes('自编'));
  assert.ok(typeof repeat.answer === 'string' && repeat.answer.length > 10);
  pass('the current shipped original ZIP imports with its declared audio and all requested types');

  currentCase = 'sentence ordering and removal';
  await navigate(`#practice/${library.libraryId}/${writing.id}/practice`, '#available-tokens');
  const wrongFirst = order.answer.at(-1);
  await page.locator(`[data-token="${wrongFirst}"]`).click();
  assert.equal(await page.locator('#ordered-tokens [data-remove]').count(), 1);
  await page.locator('#ordered-tokens [data-remove="0"]').click();
  assert.equal(await page.locator('#ordered-tokens [data-remove]').count(), 0);
  assert.equal(await page.locator(`[data-token="${wrongFirst}"]`).count(), 1, 'Removed fragment is available again');
  for (const id of order.answer) await page.locator(`[data-token="${id}"]`).click();
  assert.equal(await page.locator('#available-tokens [data-token]').count(), 0);
  const arranged = (await page.locator('#ordered-tokens [data-remove]').allTextContents()).map(value => value.replace(/\s*×\s*$/, ''));
  assert.deepEqual(arranged, order.answer.map(id => order.options.find(option => option.id === id).text));
  await page.locator('#submit-answer').click();
  await page.locator('#next-question').waitFor();
  const orderState = await waitForState(state => state.attempts.some(attempt => attempt.questionId === order.id), 'Ordered answer was not persisted');
  const orderAttempt = orderState.attempts.find(attempt => attempt.questionId === order.id);
  assert.deepEqual(orderAttempt.answer, order.answer);
  assert.deepEqual(orderAttempt.objective, { status: 'correct', correct: 1, total: 1 });
  assert.equal(await page.locator('#ordered-tokens button').first().isDisabled(), true);
  pass('sentence fragments can be removed and reordered, then persist the correct objective result');

  currentCase = 'email draft clearing, autosave and resume';
  await page.locator('#next-question').click();
  await page.locator('#answer-input').waitFor();
  const oldDraft = 'Temporary draft that the learner intends to remove.';
  await page.locator('#answer-input').fill(oldDraft);
  await waitForState(state => state.sessions.some(session => session.answers[email.id]?.answer === oldDraft), 'Email first draft did not autosave');
  await page.locator('#answer-input').fill('');
  await waitForState(state => state.sessions.some(session => session.groupId === writing.id && session.currentIndex === writing.questions.findIndex(question => question.id === email.id) && session.answers[email.id]?.answer === ''), 'Clearing the email kept an old answer in saved state');
  const emailText = 'Hi Maya,\nCould I keep your book until Friday at 3 p.m.? I am finishing the final chapter for our seminar. If you need it earlier, I can bring it to class tomorrow and borrow it again afterward.\nThanks,\nAlex';
  await page.locator('#answer-input').fill(emailText);
  const savedEmail = await waitForState(state => state.sessions.some(session => session.answers[email.id]?.answer === emailText), 'Email text did not autosave');
  const writingSession = savedEmail.sessions.find(session => session.groupId === writing.id && session.answers[email.id]?.answer === emailText);
  await navigate('#dashboard', '.hero');
  await navigate(`#practice/${library.libraryId}/${writing.id}/practice/${writingSession.id}`, '#answer-input');
  assert.equal(await page.locator('#answer-input').inputValue(), emailText);
  await page.locator('#submit-answer').click();
  await page.locator('#next-question').waitFor();
  const emailState = await waitForState(state => state.attempts.some(attempt => attempt.questionId === email.id), 'Email attempt did not save');
  const emailAttempt = emailState.attempts.find(attempt => attempt.questionId === email.id);
  assert.equal(emailAttempt.answer, emailText);
  assert.deepEqual(emailAttempt.objective, { status: 'unscored', correct: null, total: null });
  pass('email can be cleared, autosaves and resumes exactly, then submits without an invented score');

  currentCase = 'discussion autosave, reload and submission';
  await page.locator('#next-question').click();
  await page.locator('#answer-input').waitFor();
  const discussionText = 'I would prioritize quiet individual rooms because students often need sustained concentration. For example, a small room lets a student rehearse a presentation without distracting others. Shared spaces still matter, so universities could reserve one area for discussion while protecting the quiet rooms.';
  await page.locator('#answer-input').fill(discussionText);
  await waitForState(state => state.sessions.some(session => session.answers[discussion.id]?.answer === discussionText), 'Discussion did not autosave');
  await page.reload();
  await page.locator('#answer-input').waitFor();
  assert.equal(await page.locator('#answer-input').inputValue(), discussionText);
  await page.locator('#submit-answer').click();
  await page.locator('#next-question').waitFor();
  const discussionState = await waitForState(state => state.attempts.some(attempt => attempt.questionId === discussion.id), 'Discussion attempt did not save');
  const discussionAttempt = discussionState.attempts.find(attempt => attempt.questionId === discussion.id);
  assert.equal(discussionAttempt.answer, discussionText);
  assert.deepEqual(discussionAttempt.objective, { status: 'unscored', correct: null, total: null });
  await page.locator('#next-question').click();
  await page.locator('[data-attempt]').first().waitFor();
  pass('discussion text survives a reload and submits as unscored');

  currentCase = 'listening audio playback and grading';
  await navigate(`#practice/${library.libraryId}/${listening.id}/practice`, '#prompt-audio');
  const playback = await page.locator('#prompt-audio').evaluate(async audio => {
    await audio.play();
    const deadline = Date.now() + 5000;
    while (audio.currentTime <= 0.1 && !audio.error && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = { currentTime: audio.currentTime, duration: audio.duration, readyState: audio.readyState, paused: audio.paused, error: audio.error?.message || null };
    audio.pause();
    return result;
  });
  assert.ok(playback.currentTime > 0.1, JSON.stringify(playback));
  assert.ok(Number.isFinite(playback.duration) && playback.duration > 1);
  assert.ok(playback.readyState >= 2);
  assert.equal(playback.paused, false);
  assert.equal(playback.error, null);
  await page.locator(`input[name="answer"][value="${listeningQuestion.answer}"]`).check();
  await page.locator('#submit-answer').click();
  await page.locator('#next-question').waitFor();
  const listeningState = await waitForState(state => state.attempts.some(attempt => attempt.questionId === listeningQuestion.id), 'Listening answer did not save');
  const listeningAttempt = listeningState.attempts.find(attempt => attempt.questionId === listeningQuestion.id);
  assert.equal(listeningAttempt.objective.status, 'correct');
  assert.equal(listeningAttempt.questionSnapshot.groupAudio, listening.audio);
  pass('listening audio decodes and advances playback, and the answer grades against its source');

  currentCase = 'repeat target hiding and microphone denial';
  await navigate(`#practice/${library.libraryId}/${repeatGroup.id}/practice`, '#record-toggle');
  assert.equal((await page.locator('#main').textContent()).includes(repeat.answer), false, 'Repeat target is not rendered before submitting');
  const attemptsBeforeRecording = (await api('/state')).attempts.length;
  await page.evaluate(() => {
    window.__practiceBridgeTestGetUserMedia = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Synthetic denied microphone for regression test', 'NotAllowedError'); };
  });
  await page.locator('#record-toggle').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('无法开始录音'));
  assert.equal((await api('/state')).attempts.length, attemptsBeforeRecording);
  assert.equal(await page.locator('#own-recording audio').count(), 0);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = window.__practiceBridgeTestGetUserMedia;
    delete window.__practiceBridgeTestGetUserMedia;
  });
  pass('listen-repeat hides the target before submission and microphone denial creates no false recording');

  currentCase = 'recording upload failure, retained bytes and retry';
  let rejectOneRecording = true;
  await page.route('**/api/recordings', async route => {
    if (rejectOneRecording) {
      rejectOneRecording = false;
      return route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic local-save failure for regression test' }) });
    }
    return route.continue();
  });
  await page.locator('#record-toggle').click();
  await page.waitForFunction(() => document.querySelector('#recorder').classList.contains('recording'));
  await page.waitForTimeout(1200);
  await page.locator('#record-toggle').click();
  await page.locator('#record-save-retry').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#submit-answer').isDisabled(), true, 'Unsaved recording cannot be submitted');
  assert.equal((await api('/state')).attempts.length, attemptsBeforeRecording);
  assert.equal(await page.locator('#own-recording audio').count(), 0);
  await page.locator('a[data-nav="dashboard"]').click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => location.hash), `#practice/${library.libraryId}/${repeatGroup.id}/practice`, 'Unsaved bytes retain ownership of their practice page');
  await page.locator('#record-save-retry').click();
  await page.locator('#own-recording audio').waitFor();
  assert.equal(await page.locator('#record-save-retry').isHidden(), true);
  assert.equal(await page.locator('#submit-answer').isDisabled(), false);
  const recordingUrl = await page.locator('#own-recording audio').getAttribute('src');
  assert.match(recordingUrl, /^\/api\/media\/[a-f0-9]{64}$/);
  const recordingResponse = await appFetch(instance.url + recordingUrl);
  assert.equal(recordingResponse.status, 200);
  assert.match(recordingResponse.headers.get('content-type'), /^audio\//);
  assert.ok((await recordingResponse.arrayBuffer()).byteLength > 128, 'Retry saved the captured audio bytes');
  await page.locator('#submit-answer').click();
  await page.locator('#view-saved-report').waitFor();
  const repeatState = await waitForState(state => state.attempts.some(attempt => attempt.questionId === repeat.id), 'Repeat recording attempt did not save');
  const repeatAttempt = repeatState.attempts.find(attempt => attempt.questionId === repeat.id);
  assert.ok(repeatAttempt.recordingId);
  assert.equal(repeatAttempt.recordingUrl, recordingUrl);
  assert.equal(repeatAttempt.questionSnapshot.answer, repeat.answer);
  assert.deepEqual(repeatAttempt.objective, { status: 'unscored', correct: null, total: null });
  await page.locator('#view-saved-report').click();
  await page.locator('.modal').waitFor();
  await page.locator('.modal summary').filter({ hasText: '查看题目材料与答案' }).click();
  assert.ok((await page.locator('.modal').innerText()).includes(repeat.answer));
  assert.equal(await page.locator('#request-feedback').isDisabled(), true, 'No automatic AI request is enabled without model capability');
  await page.locator('.modal .close').click();
  pass('failed recording save retains audio, blocks submit/navigation, retries successfully, and exposes target only in submitted review');

  currentCase = 'exam mode feedback boundary';
  await navigate(`#practice/${library.libraryId}/${reading.id}/exam`, '#submit-answer');
  assert.equal(await page.locator('#help-details').count(), 0);
  const examIds = [];
  for (const question of reading.questions) {
    if (question.type === 'single_choice') await page.locator(`input[name="answer"][value="${question.answer}"]`).check();
    else if (question.type === 'fill_blank') await page.locator('#answer-input').fill(Array.isArray(question.answer) ? question.answer[0] : question.answer);
    else throw new Error('Shipped reading fixture introduced an unhandled exam question type');
    await page.locator('#submit-answer').click();
    await page.locator('#next-question').waitFor();
    assert.equal(await page.locator('#submission-result').innerText(), '');
    assert.equal(await page.locator('#view-saved-report,#request-feedback').count(), 0);
    assert.equal((await page.locator('#main').innerText()).includes('参考答案：'), false);
    const examState = await waitForState(state => state.attempts.some(attempt => attempt.mode === 'exam' && attempt.questionId === question.id), 'Exam answer did not persist');
    const attempt = examState.attempts.find(item => item.mode === 'exam' && item.questionId === question.id);
    examIds.push(attempt.id);
    assert.equal(attempt.assisted, false);
    await page.locator('#next-question').click();
    if (question !== reading.questions.at(-1)) await page.locator('#submit-answer').waitFor();
  }
  await page.locator('[data-attempt]').first().waitFor();
  assert.equal(await page.locator('[data-attempt]').count(), reading.questions.length);
  const afterExam = await api('/state');
  assert.equal(afterExam.sessions.some(session => session.groupId === reading.id && session.mode === 'exam'), false);
  await page.locator(`[data-attempt="${examIds[0]}"]`).click();
  await page.locator('.modal').waitFor();
  await page.locator('.modal summary').filter({ hasText: '查看题目材料与答案' }).click();
  assert.ok((await page.locator('.modal').innerText()).includes(`参考答案：${reading.questions[0].answer}`));
  await page.locator('.modal .close').click();
  pass('exam flow hides answers and feedback until the group is completed, then opens source-bound review');

  currentCase = 'final offline and browser error audit';
  const finalState = await api('/state');
  assert.equal(finalState.settings.provider, 'none');
  assert.equal(finalState.jobs.length, 0, 'No feedback jobs started automatically');
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(pageErrors, []);
  pass('all covered question flows finish without an external frontend request, automatic AI job or page error');
  console.log(JSON.stringify({ passed: passed.length, attempts: finalState.attempts.length, externalFrontendRequests: externalRequests.length, pageErrors: pageErrors.length, microphone: 'fake browser device only' }));
} catch (error) {
  console.error(`FAIL during ${currentCase}: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  if (instance) await instance.close();
  const checked = path.resolve(dataDir);
  if (!checked.startsWith(`${testRoot}${path.sep}`) || !path.basename(checked).startsWith('question-types-data-')) throw new Error('Unexpected test cleanup path');
  await fs.rm(checked, { recursive: true, force: true });
}
