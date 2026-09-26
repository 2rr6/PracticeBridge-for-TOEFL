import {appFetch} from './auth-client.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';

// Original three-word cloze and two-question passage. Every AI reply is a local
// double; held requests exercise the real browser, persistence and chat routes.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(project, 'test-results'), { recursive: true });
const output = await fs.mkdtemp(path.join(project, 'test-results', 'exam-followup-ui-'));
const dataDir = path.join(output, 'synthetic-data');
const sourceNames = ['public/exam-letters.mjs', 'public/exam-coach.mjs', 'public/exam-practice.mjs', 'public/exam-views.mjs', 'src/exam-chat-context.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, crypto.createHash('sha256').update(await fs.readFile(path.join(project, name))).digest('hex')])));
const report = { startedUtc: new Date().toISOString(), sourceBefore: await hashes(), checks: [], assertionFailures: [], pageErrors: [], failedApiRequests: [], externalRequests: [], realModelCalls: 0, details: {} };
const pass = message => { report.checks.push(message); console.log('PASS ' + message); };
const source = 'Original follow-up browser fixture';
const timing = { scope: 'module', durationSeconds: 600, prepareSeconds: null, basis: 'user', source };
const inherited = { scope: 'inherit_module', durationSeconds: null, prepareSeconds: null, basis: 'unknown', source: '' };
const passage = 'I left a bo__ in the gar___ beside a pa__.';
const words = [['bo', '__', 'ok'], ['gar', '___', 'den'], ['pa', '__', 'th']];
const questions = words.map(([, , answer], index) => ({ id: `word-${index + 1}`, type: 'fill_blank', prompt: 'Fill in the missing letters in the paragraph.', answer, localNumber: index + 1, explanation: `HIDDEN_REFERENCE_WORD_${index + 1}`, source }));
const anchors = words.map(([prefix, rawGap], index) => { const prefixStart = passage.indexOf(prefix + rawGap), start = prefixStart + prefix.length; return { questionId: questions[index].id, localNumber: index + 1, prefixStart, prefixEnd: start, start, end: start + rawGap.length, missingLetterCount: rawGap.length, prefix, rawGap, source }; });
const choice = (id, number) => ({ id, type: 'single_choice', prompt: `VISIBLE_CHOICE_${number}: Which location is named in the original notice?`, localNumber: number, options: [{ id: 'A', text: 'A small library.' }, { id: 'B', text: 'A green park.' }], answer: 'B', explanation: `HIDDEN_REFERENCE_CHOICE_${number}`, transcript: `HIDDEN_TRANSCRIPT_CHOICE_${number}`, source });
const pack = { schemaVersion: 1, examContractVersion: 1, minReaderVersion: '0.3.0', id: 'original-followup-ui', version: '1', title: 'Original keyboard and AI practice', groups: [
  { id: 'words', section: 'reading', title: 'Three original words', taskKind: 'complete_words', passage, questions, timing: inherited, presentation: { screen: 'all_questions', passageVisibility: 'attempt', questionPromptVisibility: 'attempt' }, inlineBlanks: { textField: 'passage', offsetUnit: 'utf16', answerMode: 'missing_letters', anchors } },
  { id: 'choices', section: 'reading', title: 'Two original notice questions', taskKind: 'read_daily', passage: 'The reading group meets in a green park every Friday. Members share a book and a short story.', transcript: 'HIDDEN_GROUP_TRANSCRIPT', questions: [choice('choice-1', 4), choice('choice-2', 5)], timing: inherited, presentation: { screen: 'one_question', passageVisibility: 'attempt', questionPromptVisibility: 'attempt' } },
], examSets: [{ id: 'followup-set', title: 'Original keyboard and AI practice', sections: [{ id: 'reading', section: 'reading', title: 'Reading', modules: [{ id: 'reading-main', title: 'Reading · Module 1', sourceNumber: 1, taskIds: ['words', 'choices'], timing, navigation: { back: 'module', review: 'module', lockOnAdvance: true } }] }] }] };
const calls = [], gates = new Map(), writes = [];
const gateFor = message => { let release; const gate = { promise: new Promise(resolve => { release = resolve; }), release: reply => { if (!gate.released) { gate.released = true; release({ reply, provider: 'mock', model: 'Original fixture AI' }); } } }; gates.set(message, gate); return gate; };
const models = { publicSettings: () => ({ provider: 'compatible', model: 'Original fixture AI', baseUrl: 'https://models.example.invalid', capabilities: { chat: true } }), chat: async input => {
  calls.push({ ...structuredClone(input), calledAt: Date.now() });
  const gate = gates.get(input.message); if (gate) return gate.promise;
  return { reply: input.context?.page.openReferencePanel ? `HIDDEN_REFERENCE_REPLY: ${input.message}` : `REPLY: ${input.message}`, provider: 'mock', model: 'Original fixture AI' };
}, feedback: () => { throw new Error('Feedback is outside this fixture'); } };
const poll = async (read, accept, message) => { const deadline = Date.now() + 12000; let value; do { value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now() < deadline); assert.fail(message); };
let instance, browser, context, page, currentCase;
try {
  instance = await startServer({ dataDir, models });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await appFetch(instance.url + '/api' + route, { method, headers: { 'X-PracticeBridge': '1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.equal(response.status, 200, `${route}: ${JSON.stringify(result)}`); return result; };
  const preview = await api('/import/preview', { files: [{ name: 'practicebridge.json', data: Buffer.from(JSON.stringify(pack)).toString('base64') }] });
  assert.deepEqual(preview.issues.filter(issue => issue.severity === 'error'), []);
  const { library } = await api('/import/commit', { draftId: preview.draftId, pack: preview.pack, acknowledged: true });
  browser = await chromium.launch({ channel: process.env.PRACTICEBRIDGE_BROWSER_CHANNEL || 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1180, height: 850 }, permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' });
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== instance.url) { report.externalRequests.push(url.href); return route.abort(); } return route.continue(); });
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) report.failedApiRequests.push({ url: response.url(), status: response.status() }); });
  page.on('request', request => { const pathname = new URL(request.url()).pathname; if (pathname.startsWith('/api/') && request.method() !== 'GET') writes.push({ path: pathname, method: request.method(), body: request.postDataJSON(), at: Date.now() }); });
  const at = (qid, phase = 'response') => page.locator(`.exam-shell[data-question-id="${qid}"][data-phase="${phase}"]`).waitFor();
  const run = id => api(`/sessions/${id}`).then(result => result.session);
  const values = qid => page.locator(`[data-qid="${qid}"][data-letter-index]`).evaluateAll(elements => elements.map(element => element.value));
  const cell = (qid, index) => page.locator(`[data-qid="${qid}"][data-letter-index="${index}"]`);
  const focused = (qid, index) => page.waitForFunction(({ qid, index }) => document.activeElement?.dataset.qid === qid && Number(document.activeElement.dataset.letterIndex) === index, { qid, index });
  const saved = (id, qid, answer) => poll(() => run(id), value => JSON.stringify(value.answers[qid]?.answer) === JSON.stringify(answer), `${qid} did not save its exact value`);
  const paste = async (qid, index, text) => { await cell(qid, index).focus(); await page.evaluate(text => navigator.clipboard.writeText(text), text); await page.keyboard.press('Control+V'); };
  const screenshot = async name => { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(output, name), fullPage: true }); };
  const openCoach = async () => { if (await page.locator('#exam-coach-panel').isHidden()) await page.locator('#exam-coach-pill').click(); await page.locator('#exam-coach-panel').waitFor(); };
  const send = async message => { await page.locator('#exam-coach-input').fill(message); await page.locator('#exam-coach-send').click(); return poll(() => calls.find(call => call.message === message), Boolean, `No model call for ${message}`); };
  const reply = text => page.getByText(text, { exact: true }).waitFor();
  const enter = async (mode = 'practice', groupId) => { const { session } = await api('/sessions', { sessionVersion: 2, libraryId: library.libraryId, setId: 'followup-set', ...(groupId ? { groupId } : { sectionId: 'reading' }), mode }); await page.goto(`${instance.url}/#exam/${library.libraryId}/followup-set/all/${mode}/${session.id}`); await page.locator('.exam-shell[data-phase="instructions"]').waitFor(); await page.locator('#exam-next').click(); return session.id; };

  currentCase = 'continuous keyboard typing crosses two words without mouse input';
  const sessionId = await enter(); await at('word-1');
  await page.evaluate(() => { window.__focusTrace = []; document.querySelector('#inline-passage').addEventListener('focusin', event => window.__focusTrace.push({ qid: event.target.dataset.qid, index: event.target.dataset.letterIndex })); });
  await cell('word-1', 0).focus(); await page.keyboard.type('okden', { delay: 35 });
  assert.deepEqual(await values('word-1'), ['o', 'k']); assert.deepEqual(await values('word-2'), ['d', 'e', 'n']); assert.deepEqual(await values('word-3'), ['', '']); await focused('word-3', 0);
  assert.equal((await api('/state')).attempts.length, 0); assert.equal((await run(sessionId)).cursor.taskId, 'words');
  report.details.keyboardFocusTrace = await page.evaluate(() => window.__focusTrace);
  pass('Real continuous typing fills two words and advances into the third word without clicking between cells or submitting the task');

  currentCase = 'complete-word edits, internal holes, paste and final word';
  await cell('word-2', 0).focus(); await page.keyboard.type('p'); await focused('word-2', 0); assert.deepEqual(await values('word-2'), ['p', 'e', 'n']);
  await page.keyboard.press('End'); await page.keyboard.type('x'); await focused('word-2', 2); assert.deepEqual(await values('word-2'), ['p', 'e', 'x']);
  assert.deepEqual(await values('word-3'), ['', '']);
  await paste('word-2', 0, 'den'); await focused('word-2', 0);
  await cell('word-2', 1).focus(); await page.keyboard.press('Delete'); await saved(sessionId, 'word-2', 'd n');
  await page.keyboard.type('e'); await focused('word-3', 0); assert.deepEqual(await values('word-2'), ['d', 'e', 'n']);
  await paste('word-3', 0, 'th'); await focused('word-3', 0); await page.keyboard.press('Enter');
  await at('word-1'); assert.equal((await api('/state')).attempts.length, 0); assert.deepEqual(await values('word-3'), ['t', 'h']);
  pass('Editing a completed word keeps focus in that word, holes retain their neighbors, paste fills the selected word, and the final word never submits');

  currentCase = 'native composition commit does not duplicate into the next word';
  await cell('word-1', 1).focus(); await page.keyboard.press('Delete');
  await cell('word-2', 0).focus(); await page.keyboard.press('Delete');
  await cell('word-1', 1).focus();
  await page.evaluate(() => {
    window.__compositionTrace = [];
    const active = () => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id, qid: document.activeElement?.dataset.qid, index: document.activeElement?.dataset.letterIndex });
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) document.querySelector('#inline-passage').addEventListener(type, event => window.__compositionTrace.push({ type, qid: event.target.dataset.qid, index: event.target.dataset.letterIndex, data: event.data, inputType: event.inputType, composing: event.isComposing, active: active() }));
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: 'k' });
  report.details.compositionEvents = await page.evaluate(() => window.__compositionTrace);
  report.details.compositionFocus = await page.evaluate(() => ({ qid: document.activeElement?.dataset.qid, index: document.activeElement?.dataset.letterIndex, trace: window.__focusTrace }));
  assert.deepEqual(await values('word-1'), ['o', 'k']); assert.deepEqual(await values('word-2'), ['', 'e', 'n']);
  try { await page.waitForFunction(() => document.activeElement?.dataset.qid === 'word-2' && document.activeElement?.dataset.letterIndex === '0', null, { timeout: 1500 }); }
  catch { report.assertionFailures.push({ currentCase, message: 'IME commit completed the word but did not move to the next word.' }); await cell('word-2', 0).focus(); }
  const composedSaved = await saved(sessionId, 'word-1', 'ok'); report.details.nativeCompositionSavedAnswer = composedSaved.answers['word-1'].answer;
  assert.ok(report.details.compositionEvents.some(event => event.type === 'compositionend'));
  // Some IMEs emit one extra non-composing input after compositionend. Exercise
  // that optional browser event explicitly after the native composition above.
  await cell('word-1', 1).evaluate(input => input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'k', inputType: 'insertText', isComposing: false })));
  assert.deepEqual(await values('word-1'), ['o', 'k']); assert.deepEqual(await values('word-2'), ['', 'e', 'n']); await focused('word-2', 0);
  report.details.extraPostCompositionInput = { dispatched: true, duplicateCharacter: false, nextWordUntouched: true };
  await page.keyboard.type('d'); await saved(sessionId, 'word-2', 'den');
  await screenshot('01-continuous-cloze-and-composition.png');
  if (!report.assertionFailures.length) pass('A real Chromium composition commit fills its original gap once, advances focus and leaves the next word untouched');

  currentCase = 'opening AI does not invoke a model, rebuild the task or reset its timer';
  await saved(sessionId, 'word-3', 'th');
  const initialRun = await run(sessionId), timerId = initialRun.activeTimerId, deadline = initialRun.timers[timerId].deadlineAt;
  await page.evaluate(() => { window.__taskBeforeCoach = document.querySelector('#exam-task-host'); window.__cellBeforeCoach = document.querySelector('[data-qid="word-1"][data-letter-index="0"]'); });
  const initialClock = await page.locator('#exam-time').innerText(), writeCount = writes.length;
  await page.locator('#exam-ai').click(); await page.locator('#exam-coach-panel').waitFor();
  assert.equal(calls.length, 0); assert.equal(writes.length, writeCount);
  assert.equal(await page.evaluate(() => window.__taskBeforeCoach === document.querySelector('#exam-task-host') && window.__cellBeforeCoach === document.querySelector('[data-qid="word-1"][data-letter-index="0"]')), true);
  await page.waitForFunction(text => document.querySelector('#exam-time').textContent !== text, initialClock);
  const afterOpen = await run(sessionId); assert.equal(afterOpen.activeTimerId, timerId); assert.equal(afterOpen.timers[timerId].deadlineAt, deadline); assert.equal(afterOpen.paused, false);
  await page.locator('#exam-coach-input').fill('I can type here without editing the cloze.'); assert.deepEqual(await values('word-1'), ['o', 'k']);
  await cell('word-1', 1).focus(); await page.keyboard.press('Delete'); await cell('word-2', 0).focus(); await page.keyboard.press('Delete');
  const guardedFocus = await page.evaluate(async () => {
    const input = document.querySelector('[data-qid="word-1"][data-letter-index="1"]'), coachInput = document.querySelector('#exam-coach-input');
    input.focus(); input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    input.value = 'k'; input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'k' }));
    coachInput.focus(); await new Promise(resolve => setTimeout(resolve, 30));
    return { activeId: document.activeElement.id, value: input.value };
  });
  assert.deepEqual(guardedFocus, { activeId: 'exam-coach-input', value: 'k' }); assert.deepEqual(await values('word-2'), ['', 'e', 'n']);
  report.details.sameTickAiFocusGuard = guardedFocus;
  await saved(sessionId, 'word-1', 'ok'); assert.equal(await page.locator('#exam-coach-input').evaluate(input => input === document.activeElement), true);
  await cell('word-2', 0).focus(); await page.keyboard.type('d'); await saved(sessionId, 'word-2', 'den');
  pass('A composition-end callback cannot steal focus when the user has already moved into the AI input in the same event turn');
  await page.locator('#exam-coach-collapse').click(); await page.locator('#exam-next').click(); await at('choice-1');
  pass('Opening and typing in AI triggers no model request, leaves the original task nodes intact and lets the same timer keep counting down');

  currentCase = 'immediate final edit is in the captured AI context without hidden material';
  await openCoach(); await page.locator('#exam-coach-input').fill('latest-choice-draft');
  await page.locator('input[name="answer"][value="A"]').focus(); await page.keyboard.press('Space'); await page.locator('#exam-coach-send').click();
  const latest = await poll(() => calls.find(call => call.message === 'latest-choice-draft'), Boolean, 'The latest edited response did not reach chat');
  assert.deepEqual(latest.context.page.questionIds, ['choice-1']); assert.deepEqual(latest.context.page.currentAnswers, [{ questionId: 'choice-1', text: 'A' }]);
  assert.doesNotMatch(JSON.stringify(latest.context.page), /HIDDEN_|VISIBLE_CHOICE_5/); assert.equal(latest.context.page.openReferencePanel, undefined); assert.equal(latest.context.page.openTranscriptPanel, undefined);
  await reply('REPLY: latest-choice-draft'); await screenshot('02-latest-draft-context-1180.png');
  const afterSend = await run(sessionId); assert.equal(afterSend.timers[timerId].deadlineAt, deadline); assert.equal(afterSend.answers['choice-1'].answer, 'A');
  pass('Send captures the immediately preceding keyboard answer from storage, includes only the current question, and omits hidden keys and transcripts');

  currentCase = 'a delayed first-question reply stays in the original conversation';
  const lateGate = gateFor('late-first-question'); await send('late-first-question'); const firstScope = await page.locator('#exam-coach-history').inputValue();
  await page.locator('#exam-next').click(); await at('choice-2');
  assert.equal(await page.locator('#exam-coach-input').isEnabled(), true);
  const second = await send('second-question-now'); assert.deepEqual(second.history, []); assert.deepEqual(second.context.page.questionIds, ['choice-2']); assert.doesNotMatch(JSON.stringify(second), /latest-choice-draft|late-first-question|VISIBLE_CHOICE_4/);
  await reply('REPLY: second-question-now'); const secondScope = await page.locator('#exam-coach-history').inputValue();
  lateGate.release('LATE_REPLY_FOR_FIRST_QUESTION');
  await poll(() => page.evaluate(() => [...document.querySelectorAll('#exam-coach-history option')].map(option => option.value)), values => values.includes(firstScope), 'The old question conversation disappeared');
  await poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('exam-coach:')).some(key => sessionStorage.getItem(key).includes('LATE_REPLY_FOR_FIRST_QUESTION'))), Boolean, 'Late reply was not retained');
  assert.doesNotMatch(await page.locator('#exam-coach-log').innerText(), /LATE_REPLY_FOR_FIRST_QUESTION/);
  await page.locator('#exam-coach-history').selectOption(firstScope); await reply('LATE_REPLY_FOR_FIRST_QUESTION'); assert.equal(await page.locator('#exam-coach-input').isDisabled(), true);
  await screenshot('03-delayed-first-question-selected.png');
  await page.locator('#exam-coach-history').selectOption(secondScope); assert.doesNotMatch(await page.locator('#exam-coach-log').innerText(), /LATE_REPLY_FOR_FIRST_QUESTION/);
  pass('The second question starts with independent history; the delayed first reply appears only when its original conversation is selected');

  currentCase = 'a pending reply survives collapse, exit and reopening the same session';
  const background = gateFor('background-second-question'); await send('background-second-question');
  await page.locator('#exam-coach-collapse').click(); await page.locator('#exam-exit').click(); await page.locator('.exam-library-table').waitFor();
  assert.equal(await page.locator('#exam-coach').count(), 0);
  background.release('BACKGROUND_REPLY_AFTER_EXIT');
  await poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('exam-coach:')).some(key => sessionStorage.getItem(key).includes('BACKGROUND_REPLY_AFTER_EXIT'))), Boolean, 'Reply did not persist after closing the task view');
  await page.goto(`${instance.url}/#exam/${library.libraryId}/followup-set/all/practice/${sessionId}`); await page.locator('#exam-resume').waitFor(); await page.locator('#exam-resume').click(); await at('choice-2'); await openCoach();
  await reply('BACKGROUND_REPLY_AFTER_EXIT'); assert.equal(await page.locator('.exam-shell').getAttribute('data-session-id'), sessionId);
  pass('A reply that finishes after the panel is folded and the task is exited remains visible when the same saved session is reopened');

  currentCase = 'closing a shown answer panel excludes reference-bearing chat history';
  await page.locator('#exam-answers').click(); await page.locator('.exam-help-panel').waitFor();
  const reference = await send('with-visible-reference'); assert.match(JSON.stringify(reference.context.page.openReferencePanel), /HIDDEN_REFERENCE_CHOICE_4/); await reply('HIDDEN_REFERENCE_REPLY: with-visible-reference');
  await page.locator('#exam-answers').click(); await page.locator('.exam-help-panel').waitFor({ state: 'detached' });
  const afterReference = await send('after-reference-closed'); assert.deepEqual(afterReference.history, []); assert.equal(afterReference.context.page.openReferencePanel, undefined); assert.doesNotMatch(JSON.stringify(afterReference), /HIDDEN_/);
  await reply('REPLY: after-reference-closed');
  await page.setViewportSize({ width: 760, height: 850 });
  const geometry = await page.locator('#exam-coach-panel').evaluate(element => { const rect = element.getBoundingClientRect(), send = element.querySelector('#exam-coach-send').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, sendBottom: send.bottom }; });
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewportWidth + 1 && geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight + 1 && geometry.sendBottom <= geometry.bottom);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await screenshot('04-reference-closed-clean-history-760.png'); report.details.narrowPanelGeometry = geometry;
  pass('Reference content is included while visibly opened, then excluded with its old chat history after closing; the 760px panel keeps its controls inside the viewport');

  currentCase = 'TEST exposes AI only after the complete run is submitted';
  await page.locator('#exam-coach-collapse').click(); await page.locator('#exam-exit').click(); await page.locator('.exam-library-table').waitFor(); await page.setViewportSize({ width: 1180, height: 850 });
  const testId = await enter('exam', 'choices'); await at('choice-1'); const beforeTestCalls = calls.length;
  assert.equal(await page.locator('#exam-ai').count(), 0); assert.equal(await page.locator('#exam-coach').isHidden(), true); assert.equal(await page.locator('#exam-coach-pill').isVisible(), false);
  await page.locator('input[name="answer"][value="A"]').check(); await page.locator('#exam-next').click(); await at('choice-2'); assert.equal(await page.locator('#exam-coach').isHidden(), true);
  await page.locator('input[name="answer"][value="B"]').check(); await page.locator('#exam-next').click();
  await page.getByRole('heading', { name: 'Practice Completed', exact: true }).waitFor();
  assert.equal(calls.length, beforeTestCalls); assert.equal((await run(testId)).finished, true);
  await openCoach(); const completed = await send('completed-test-context'); assert.ok(completed.context.page.completed); await reply('REPLY: completed-test-context');
  await screenshot('05-test-completed-ai-1180.png');
  pass('Unfinished TEST offers no AI control and sends no model call; the completed run can open AI and uses a completion snapshot');

  report.sourceAfter = await hashes(); assert.deepEqual(report.sourceAfter, report.sourceBefore);
  report.details.modelCalls = calls; report.details.writeCount = writes.length;
  assert.deepEqual(report.assertionFailures, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.failedApiRequests, []); assert.deepEqual(report.externalRequests, []);
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = { currentCase, message: error.message, stack: error.stack }; report.details.modelCalls = calls;
  report.details.failurePage = await page?.evaluate(() => ({ phase: document.querySelector('.exam-shell')?.dataset.phase, questionId: document.querySelector('.exam-shell')?.dataset.questionId, active: { tag: document.activeElement?.tagName, id: document.activeElement?.id, qid: document.activeElement?.dataset.qid, index: document.activeElement?.dataset.letterIndex }, composition: window.__compositionTrace, inputs: [...document.querySelectorAll('[data-letter-index]')].map(element => ({ qid: element.dataset.qid, index: element.dataset.letterIndex, value: element.value })) })).catch(() => null);
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1;
} finally {
  for (const gate of gates.values()) gate.release('Released fixture during cleanup.');
  await browser?.close(); await instance?.close(); report.finishedUtc = new Date().toISOString();
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log('RESULT_DIR ' + output); if (!report.ok) console.error(report.failure);
}
