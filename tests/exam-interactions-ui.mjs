import {appFetch} from './auth-client.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';

// Original fixtures only. This browser check uses a disposable local data store,
// never calls a model, and never reads the learner's saved library or recordings.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(project, 'test-results');
await fs.mkdir(artifactRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(artifactRoot, 'exam-interactions-ui-'));
const dataDir = path.join(output, 'data');
await fs.mkdir(dataDir);

const source = 'Original browser interaction fixture';
const timing = (scope, durationSeconds = 1800) => ({ scope, durationSeconds, prepareSeconds: null, basis: 'user', source });
const inherited = { scope: 'inherit_module', durationSeconds: null, prepareSeconds: null, basis: 'unknown', source: '' };
const question = (id, type, prompt, answer, localNumber) => ({ id, type, prompt, answer, localNumber, options: [], explanation: '', audio: null, image: null, timeLimitSeconds: 0, prepareSeconds: 0, source });
const blankWords = [
  ['con', '__', 'di'], ['commu', '____', 'nity'], ['child', '___', 'ren'], ['mark', '__', 'et'], ['stu', '____', 'dent'],
  ['ques', '____', 'tion'], ['par', '____', 'tial'], ['re', '____', 'turn'], ['wrap', '____', 'ping'], ['note', '____', 'book'],
];
const clozePassage = "🌿 A con__tion for the commu____'s garden is that child___ can visit the mark__ after school. A stu____ writes a ques____ on paper, then makes a par____ note before a re____ visit. The wrap____ covers a note____ on the bench.";
const clozeQuestions = blankWords.map(([, , answer], index) => ({ ...question(`cloze-q${index + 1}`, 'fill_blank', 'Fill in the missing letters in the paragraph.', answer, index + 1), ordinalInTask: index + 1 }));
const anchors = blankWords.map(([prefix, rawGap], index) => {
  const prefixStart = clozePassage.indexOf(prefix + rawGap), start = prefixStart + prefix.length;
  assert.ok(prefixStart >= 0);
  return { questionId: clozeQuestions[index].id, localNumber: index + 1, prefixStart, prefixEnd: start, start, end: start + rawGap.length, missingLetterCount: rawGap.length, prefix, rawGap, source };
});
const sentences = ['A lamp shines above the desk.', 'The room stays quiet after dusk.', 'A note rests on the table.'];
const readingPassage = sentences.join(' ');
const ranges = sentences.map((text, index) => ({ id: String.fromCharCode(65 + index), start: readingPassage.indexOf(text), end: readingPassage.indexOf(text) + text.length }));
const selectionQuestion = {
  ...question('select-q11', 'single_choice', 'Select the sentence about the quiet room.', 'B', 11), ordinalInTask: 1,
  interaction: { kind: 'sentence_select', textField: 'passage', offsetUnit: 'utf16', candidates: ranges },
};
const insertionQuestion = {
  ...question('insert-q12', 'single_choice', 'Insert this sentence after the sentence about the quiet room.', 'C', 12), ordinalInTask: 2,
  interaction: { kind: 'sentence_insert', textField: 'passage', offsetUnit: 'utf16', sentence: 'A visitor waits near the doorway.', candidates: [0, ranges[0].end, ranges[1].end, readingPassage.length].map((start, index) => ({ id: String.fromCharCode(65 + index), start, end: start })) },
};
const otherReadingQuestions = Array.from({ length: 8 }, (_, index) => ({
  ...question(`choice-q${index + 13}`, 'single_choice', `Original choice ${index + 13}: What rests on the table?`, 'A', index + 13), ordinalInTask: index + 3,
  options: [{ id: 'A', text: 'A note.' }, { id: 'B', text: 'A cup.' }],
}));
const sentenceQuestion = id => ({
  ...question(id, 'sentence_order', 'What can the group do today?\nWe _____ _____ and _____ today.', ['A', 'B', 'C'], id.endsWith('1') ? 1 : 2),
  sentenceFrame: 'We _____ _____ and _____ today.', answerSlots: 3,
  options: [{ id: 'A', text: 'can' }, { id: 'B', text: 'read' }, { id: 'C', text: 'write' }, { id: 'D', text: 'reads' }],
});
const pack = {
  schemaVersion: 1, examContractVersion: 1, minReaderVersion: '0.3.0', id: 'original-ui-interactions', version: '1.0.0', title: 'Original UI interaction practice', description: '', rights: 'Original synthetic fixture',
  groups: [
    { id: 'inline-words', section: 'reading', title: 'Original inline paragraph', passage: clozePassage, questions: clozeQuestions, audio: null, image: null, taskKind: 'complete_words', timing: inherited, presentation: { screen: 'all_questions', passageVisibility: 'attempt', questionPromptVisibility: 'attempt' }, inlineBlanks: { textField: 'passage', offsetUnit: 'utf16', answerMode: 'missing_letters', anchors } },
    { id: 'passage-questions', section: 'reading', title: 'Original passage interactions', passage: readingPassage, questions: [selectionQuestion, insertionQuestion, ...otherReadingQuestions], audio: null, image: null, taskKind: 'read_academic', timing: inherited, presentation: { screen: 'one_question', passageVisibility: 'attempt', questionPromptVisibility: 'attempt' } },
    { id: 'sentence-task', section: 'writing', title: 'Original sentence frames', passage: '', questions: [sentenceQuestion('sentence-q1'), sentenceQuestion('sentence-q2')], audio: null, image: null, taskKind: 'build_sentence', timing: timing('task'), presentation: { screen: 'one_question', passageVisibility: 'attempt', questionPromptVisibility: 'attempt' } },
  ],
  examSets: [{ id: 'original-set', title: 'Original UI interaction practice', sections: [
    { id: 'reading', section: 'reading', title: 'Reading', modules: [{ id: 'reading-main', title: 'Original Reading module', sourceNumber: 1, taskIds: ['inline-words', 'passage-questions'], timing: timing('module'), navigation: { back: 'module', review: 'module', lockOnAdvance: true } }] },
    { id: 'writing', section: 'writing', title: 'Writing', modules: [{ id: 'writing-main', title: 'Original Writing module', sourceNumber: null, taskIds: ['sentence-task'], timing: { scope: 'none', durationSeconds: null, prepareSeconds: null, basis: 'unknown', source: '' }, navigation: { back: 'task', review: 'task', lockOnAdvance: true } }] },
  ] }],
};

let instance, browser, page;
const checks = [], errors = [];
const check = message => { checks.push(message); console.log(`PASS ${message}`); };
const waitUntil = async (get, predicate, label) => {
  const deadline = Date.now() + 10000;
  let value;
  do {
    value = await get();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
};

try {
  instance = await startServer({ dataDir });
  const api = async (route, body, method = body ? 'POST' : 'GET') => {
    const response = await appFetch(instance.url + '/api' + route, { method, headers: { 'Content-Type': 'application/json', 'X-PracticeBridge': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const preview = await api('/import/preview', { files: [{ name: 'practicebridge.json', data: Buffer.from(JSON.stringify(pack)).toString('base64') }] });
  assert.deepEqual(preview.issues.filter(issue => issue.severity === 'error'), []);
  const { library } = await api('/import/commit', { draftId: preview.draftId, pack: preview.pack, acknowledged: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== instance.url) { errors.push(`External request: ${url.href}`); return route.abort(); }
    return route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && response.url().includes('/api/')) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
  const screenshot = async name => {
    await page.waitForFunction(() => {
      const toast = document.getElementById('toast');
      return (!toast || (!toast.classList.contains('visible') && getComputedStyle(toast).opacity === '0')) && document.getElementById('exam-save-state')?.textContent !== 'Saving…';
    });
    await page.screenshot({ path: path.join(output, name) });
  };
  const at = (qid, phase = 'response') => page.locator(`.exam-shell[data-question-id="${qid}"][data-phase="${phase}"]`).waitFor();
  const cell = (qid, index) => page.locator(`[data-qid="${qid}"][data-letter-index="${index}"]`);
  const values = qid => page.locator(`[data-qid="${qid}"][data-letter-index]`).evaluateAll(elements => elements.map(element => element.value));
  const focused = (qid, index) => page.waitForFunction(({ qid, index }) => document.activeElement?.dataset.qid === qid && Number(document.activeElement.dataset.letterIndex) === index, { qid, index });
  const paste = async (qid, index, text) => { await cell(qid, index).focus(); await page.evaluate(text => navigator.clipboard.writeText(text), text); await page.keyboard.press('Control+V'); };
  const run = id => api('/state').then(state => state.sessions.find(session => session.id === id));
  const savedAnswer = (sessionId, qid, answer) => waitUntil(() => run(sessionId), session => JSON.stringify(session.answers[qid]?.answer) === JSON.stringify(answer), `Saved answer for ${qid}`);
  const enter = async section => {
    await page.goto(instance.url + `#exam/${library.libraryId}/original-set/${section}/practice`);
    await page.locator('.exam-shell[data-phase="instructions"]').waitFor();
    const id = await page.locator('.exam-shell').getAttribute('data-session-id');
    await page.locator('#exam-next').click();
    return id;
  };

  const readingSessionId = await enter('reading');
  await at('cloze-q1');
  assert.equal(await page.locator('.exam-word').count(), 10);
  assert.equal(await page.locator('.exam-letter').count(), blankWords.reduce((count, [, gap]) => count + gap.length, 0));
  assert.match(await page.locator('.exam-range').innerText(), /Questions 1–10 of 20/);
  assert.equal(await page.locator('.exam-word').first().textContent(), 'contion');
  const firstClock = await run(readingSessionId), timerId = firstClock.activeTimerId, deadline = firstClock.timers[timerId].deadlineAt;
  assert.ok(timerId && deadline);
  await cell('cloze-q1', 0).focus(); await page.keyboard.type('di');
  assert.deepEqual(await values('cloze-q1'), ['d', 'i']);
  await focused('cloze-q2', 0);
  await page.keyboard.press('Shift+Tab'); await focused('cloze-q1', 0);
  await page.keyboard.press('Tab'); await page.keyboard.type('nity');
  await focused('cloze-q3',0);
  await cell('cloze-q2',3).focus();
  await page.keyboard.press('ArrowLeft'); await focused('cloze-q2', 2);
  await page.keyboard.press('Home'); await focused('cloze-q2', 0);
  await page.keyboard.press('End'); await focused('cloze-q2', 3);
  await page.keyboard.press('Backspace'); assert.deepEqual(await values('cloze-q2'), ['n', 'i', 't', '']);
  await page.keyboard.press('Backspace'); await focused('cloze-q2', 2);
  assert.deepEqual(await values('cloze-q2'), ['n', 'i', 't', '']);
  await page.keyboard.type('ty');
  check('Ten inline gaps retain a fixed suffix; typing, Tab, arrows, Home, End, and Backspace work');

  // Deliberate internal hole must remain an empty cell when the page is restored.
  await cell('cloze-q2', 1).fill('');
  await page.locator('#exam-next').click(); await at('select-q11');
  await savedAnswer(readingSessionId, 'cloze-q2', 'n ty');
  await page.locator('#exam-back').click(); await at('cloze-q1');
  assert.equal(await cell('cloze-q2', 1).inputValue(), '', 'An internal saved hole must render as empty, not a literal space');
  await cell('cloze-q2', 1).focus(); await page.keyboard.press('Backspace'); await focused('cloze-q2', 0);
  assert.deepEqual(await values('cloze-q2'), ['n', '', 't', 'y']);
  await paste('cloze-q2', 0, 'nity');
  assert.deepEqual(await values('cloze-q2'), ['n', 'i', 't', 'y']);
  await paste('cloze-q2', 0, 'a b'); assert.deepEqual(await values('cloze-q2'), ['n', 'i', 't', 'y']);
  await paste('cloze-q2', 2, 'abc'); assert.deepEqual(await values('cloze-q2'), ['n', 'i', 't', 'y']);
  for (const q of clozeQuestions.slice(2)) { await paste(q.id, 0, q.answer); assert.equal((await values(q.id)).join(''), q.answer); }
  check('Internal blank survives page re-entry; Backspace on an empty cell moves without deleting its neighbor; paste rejects spaces and overflow');

  // Browser zoom changes the CSS viewport. Half the layout viewport with a 2x
  // device scale tests the same responsive layout at a 1280 x 800 physical size.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 400, deviceScaleFactor: 2, mobile: false });
  assert.equal(await page.evaluate(() => innerWidth), 640);
  assert.equal(await page.evaluate(() => devicePixelRatio), 2);
  for (const q of clozeQuestions) {
    await cell(q.id, 0).scrollIntoViewIfNeeded();
    const geometry = await cell(q.id, 0).locator('xpath=../..').evaluate(element => {
      const word = element.getBoundingClientRect();
      return { left: word.left, right: word.right, viewport: innerWidth, cells: [...element.querySelectorAll('input')].map(input => { const r = input.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width }; }) };
    });
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport + 1, `${q.id} horizontally clipped`);
    assert.ok(geometry.cells.every(item => item.width > 5 && Math.abs(item.top - geometry.cells[0].top) < 1), `${q.id} split or collapsed cells`);
    assert.equal((await values(q.id)).join(''), q.answer);
  }
  await cell('cloze-q1', 0).scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  assert.ok(overflow.content <= overflow.width + 1, JSON.stringify(overflow));
  await screenshot('01-cloze-200-percent-layout.png');
  check('200% equivalent layout preserves all ten unbroken words, reachable cells, and no page overflow');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.locator('#exam-next').click(); await at('select-q11');
  let currentClock = await run(readingSessionId);
  assert.equal(currentClock.activeTimerId, timerId); assert.equal(currentClock.timers[timerId].deadlineAt, deadline);
  await page.locator('[data-candidate="B"]').click();
  await page.locator('[data-candidate="B"][aria-pressed="true"]').waitFor();
  await screenshot('02-sentence-selection.png');
  await page.locator('#exam-next').click(); await at('insert-q12');
  assert.equal(await page.locator('[data-candidate]').count(), 4);
  await page.locator('[data-candidate="C"]').click();
  await page.locator('[data-candidate="C"][aria-pressed="true"]').waitFor();
  assert.equal(await page.locator('[data-candidate="C"]').innerText(), insertionQuestion.interaction.sentence);
  const insertedText = await page.locator('.exam-interactive-passage').evaluate(element => { const clone = element.cloneNode(true); clone.querySelectorAll('[data-candidate][aria-pressed="false"]').forEach(candidate => candidate.remove()); return clone.textContent; });
  assert.equal(insertedText, `${sentences[0]} ${sentences[1]}${insertionQuestion.interaction.sentence} ${sentences[2]}`);
  await screenshot('03-sentence-insertion.png');
  await page.locator('#exam-back').click(); await at('select-q11');
  assert.equal(await page.locator('[data-candidate="B"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#exam-back').click(); await at('cloze-q1');
  for (const q of clozeQuestions) assert.equal((await values(q.id)).join(''), q.answer);
  await page.locator('#exam-next').click(); await at('select-q11');
  await page.locator('#exam-next').click(); await at('insert-q12');
  assert.equal(await page.locator('[data-candidate="C"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#exam-next').click();
  for (const q of otherReadingQuestions) { await at(q.id); await page.locator(`input[name="answer"][value="${q.answer}"]`).check(); await page.locator('#exam-next').click(); }
  await page.locator('.exam-shell[data-phase="review"]').waitFor();
  assert.equal(await page.locator('.exam-review-status.unanswered,.exam-review-status.partial').count(), 0);
  currentClock = await run(readingSessionId);
  assert.equal(currentClock.activeTimerId, timerId); assert.equal(currentClock.timers[timerId].deadlineAt, deadline);
  assert.equal((await api('/state')).attempts.length, 0);
  await page.locator('#end-review-scope').click(); await page.locator('[data-result="confirm"]').click();
  await page.locator('.exam-completed').waitFor();
  const readingState = await api('/state');
  assert.equal(readingState.attempts.length, 20);
  assert.ok(readingState.attempts.every(attempt => attempt.objective.status === 'correct'));
  assert.equal(readingState.sessions.find(session => session.id === readingSessionId).finished, true);
  check('Sentence selection/insertion IDs restore and grade correctly with all twenty answers at one module commit');
  check('Reading clock keeps one timer and deadline through Next, Back, and Review');

  const writingSessionId = await enter('writing'); await at('sentence-q1');
  const bank = id => page.locator(`[data-token="${id}"]`), slot = index => page.locator(`[data-slot="${index}"]`);
  const slots = () => page.locator('[data-slot]').allTextContents();
  await bank('C').dragTo(slot(2));
  await savedAnswer(writingSessionId, 'sentence-q1', ['', '', 'C']);
  assert.equal(await bank('C').isDisabled(), true); assert.equal(await slot(2).innerText(), 'write');
  await bank('A').click(); await bank('B').click();
  assert.deepEqual(await slots(), ['can', 'read', 'write']);
  await slot(1).click(); await savedAnswer(writingSessionId, 'sentence-q1', ['A', '', 'C']);
  assert.equal(await slot(2).innerText(), 'write');
  await page.locator('#exam-next').click(); await at('sentence-q2');
  await page.locator('#exam-back').click(); await at('sentence-q1');
  assert.equal(await slot(0).innerText(), 'can'); assert.equal(await slot(1).getAttribute('draggable'), 'false'); assert.equal(await slot(2).innerText(), 'write');
  await bank('B').click();
  await slot(2).dragTo(slot(0)); assert.deepEqual(await slots(), ['write', 'read', 'can']);
  await slot(0).dragTo(slot(2)); assert.deepEqual(await slots(), ['can', 'read', 'write']);
  assert.equal(await bank('D').isDisabled(), false); assert.match(await page.locator('#ordered-tokens').innerText(), /^We .* and .* today\.$/);
  await screenshot('04-sentence-slots.png');
  await page.locator('#exam-next').click(); await at('sentence-q2');
  for (const id of ['A', 'B', 'C']) await bank(id).click();
  await page.locator('#exam-next').click(); await page.locator('.exam-shell[data-phase="review"]').waitFor();
  await page.locator('.exam-time-remaining').waitFor();
  assert.equal(await page.locator('.exam-time-remaining h1').innerText(), 'Time Remaining');
  assert.equal(await page.locator('.exam-review-table').count(), 0);
  assert.equal((await api('/state')).attempts.length, 20);
  await page.locator('#exam-back').click(); await at('sentence-q2');
  assert.deepEqual(await slots(), ['can', 'read', 'write']);
  await page.locator('#exam-next').click(); await page.locator('.exam-time-remaining').waitFor();
  await screenshot('05-writing-time-remaining.png');
  await page.locator('#exam-next').click();
  await page.locator('.exam-completed').waitFor();
  const finalState = await api('/state');
  assert.equal(finalState.attempts.length, 22); assert.ok(finalState.attempts.every(attempt => attempt.objective.status === 'correct'));
  check('Native drag into slot three saves explicit empty IDs; removal, swaps, Back, fixed frame, and distractor survive commit');
  check('Writing Time Remaining returns to the answer with Back and commits the task once with Continue');
  assert.deepEqual(errors, []); check('No page errors, failed API requests, or external network requests');
} catch (error) {
  errors.push(error.stack); console.error(error.stack); process.exitCode = 1;
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(`OUTPUT ${output}`);
  await browser?.close(); await instance?.close();
  const resolvedData = path.resolve(dataDir);
  assert.ok(resolvedData.startsWith(path.resolve(output) + path.sep) && path.resolve(output).startsWith(path.resolve(artifactRoot) + path.sep));
  await fs.rm(resolvedData, { recursive: true, force: true });
}
