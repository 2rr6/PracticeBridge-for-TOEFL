import {appFetch} from './auth-client.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import { canonicalJSON } from '../src/package.mjs';

// Original questions, generated tone and a new disposable data store only.
// Existing learner workspaces, audio, model settings and credentials are unused.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(project, 'test-results'), { recursive: true });
const output = await fs.mkdtemp(path.join(project, 'test-results', 'exam-full-test-ui-'));
const dataDir = path.join(output, 'data'), source = 'Original full-paper browser fixture.';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceHash = async () => hash(await fs.readFile(path.join(project, 'public', 'exam-library.mjs')));
const report = { startedUtc: new Date().toISOString(), sourceBefore: await sourceHash(), checks: [], pageErrors: [], externalRequests: [], modelCalls: 0, createRequests: [] };
const pass = message => { report.checks.push(message); console.log('PASS ' + message); };
const timing = (scope, durationSeconds = null) => ({ scope, durationSeconds, prepareSeconds: null, basis: durationSeconds === null ? 'unknown' : 'document', source });
const question = (id, type, prompt, answer, localNumber = 1) => ({ id, type, prompt, answer, localNumber, ordinalInTask: 1, source, options: [] });
const choice = (id, localNumber = 1) => ({ ...question(id, 'single_choice', `Original ${id}: What is available in the garden?`, 'A', localNumber), options: [{ id: 'A', text: 'A shared map.' }, { id: 'B', text: 'A red shovel.' }] });
const groups = [
  { id: 'read-a', section: 'reading', title: 'Original garden notice', taskKind: 'read_daily', passage: 'A shared map is available in the garden.', timing: timing('inherit_module'), questions: [choice('r1'), { ...choice('r2', 2), ordinalInTask: 2 }] },
  { id: 'read-b', section: 'reading', title: 'Original garden post', taskKind: 'read_daily', passage: 'The garden opens at nine.', timing: timing('inherit_module'), questions: [choice('r3')] },
  { id: 'listen-a', section: 'listening', title: 'Original tone stimulus', taskKind: 'listen_response', passage: '', audio: 'tone.wav', timing: timing('question'), questions: [choice('l1')] },
  { id: 'build-a', section: 'writing', title: 'Original sentence task', taskKind: 'build_sentence', passage: '', timing: timing('task', 360), questions: [{ ...question('w1', 'sentence_order', 'Who reads today?\nWe _____ _____.', ['A', 'B']), sentenceFrame: 'We _____ _____.', answerSlots: 2, options: [{ id: 'A', text: 'read' }, { id: 'B', text: 'today' }] }] },
  { id: 'email-a', section: 'writing', title: 'Original email task', taskKind: 'write_email', passage: '', timing: timing('task'), questions: [question('w2', 'email', 'Write an email requesting the shared garden map.', null, 2)] },
  { id: 'repeat-a', section: 'speaking', title: 'Original repeat task', taskKind: 'listen_repeat', passage: '', timing: timing('question'), questions: Array.from({ length: 7 }, (_, i) => ({ ...question(`s${i + 1}`, 'listen_repeat', 'Repeat the original stimulus.', null, i + 1), ordinalInTask: i + 1, audio: 'tone.wav' })) },
];
const module = (id, taskIds, sourceNumber = 1) => ({ id, title: id, taskIds, sourceNumber });
const sections = [
  { id: 'reading', section: 'reading', title: 'Reading', modules: [{ ...module('rm1', ['read-a']), timing: timing('module', 600) }, { ...module('rm2', ['read-b'], 2), timing: timing('module', 600) }] },
  { id: 'listening', section: 'listening', title: 'Listening', modules: [module('lm1', ['listen-a'])] },
  { id: 'writing', section: 'writing', title: 'Writing', modules: [module('wm1', ['build-a', 'email-a'])] },
  { id: 'speaking', section: 'speaking', title: 'Speaking', modules: [module('sm1', ['repeat-a'])] },
];
const pack = { schemaVersion: 1, examContractVersion: 1, minReaderVersion: '0.3.0', id: 'original-full-paper', version: '1', title: 'Original full-paper entry fixture', rights: 'Original synthetic content.', groups, examSets: [
  { id: 'full-set', title: 'Original four-section paper', sections },
  { id: 'reading-set', title: 'Original reading-only paper', sections: sections.slice(0, 1) },
] };
const tone = Buffer.alloc(44 + 8000);
tone.write('RIFF'); tone.writeUInt32LE(tone.length - 8, 4); tone.write('WAVEfmt ', 8); tone.writeUInt32LE(16, 16); tone.writeUInt16LE(1, 20); tone.writeUInt16LE(1, 22); tone.writeUInt32LE(16000, 24); tone.writeUInt32LE(32000, 28); tone.writeUInt16LE(2, 32); tone.writeUInt16LE(16, 34); tone.write('data', 36); tone.writeUInt32LE(8000, 40);
for (let i = 0; i < 4000; i++) tone.writeInt16LE(Math.round(Math.sin(i * Math.PI * 660 / 16000) * 1000), 44 + i * 2);
let instance, browser, page, currentCase = 'fixture import';
try {
  const deniedModel = () => { report.modelCalls++; throw new Error('Model calls are forbidden in this fixture'); };
  instance = await startServer({ dataDir, models: { publicSettings: () => ({ provider: 'none', capabilities: {} }), feedback: deniedModel, chat: deniedModel, structure: deniedModel, assessMaterials: deniedModel } });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await appFetch(instance.url + '/api' + route, { method, headers: { 'Content-Type': 'application/json', 'X-PracticeBridge': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`); return value;
  };
  const snapshot = () => api('/state');
  const saved = async id => (await api(`/sessions/${id}`)).session;
  const rawState = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const poll = async (read, predicate, label) => { const deadline = Date.now() + 12000; do { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline); throw new Error(label); };
  const input = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });
  const preview = await api('/import/preview', { files: [input('practicebridge.json', JSON.stringify(pack)), input('tone.wav', tone)] });
  assert.deepEqual(preview.issues.filter(issue => issue.severity === 'error'), []);
  const { library } = await api('/import/commit', { draftId: preview.draftId, pack: preview.pack, acknowledged: true });
  const libraryId = library.libraryId, create = async (mode, sectionId, setId = 'full-set') => (await api('/sessions', { sessionVersion: 2, libraryId, setId, mode, ...(sectionId ? { sectionId } : {}) })).session;
  const oldReading = await create('exam', 'reading'), oldWriting = await create('exam', 'writing'), oldSingleSet = await create('exam', 'reading', 'reading-set'), oldPractice = await create('practice', 'writing');
  for (const [session, questionId, answer] of [[oldReading, 'r1', 'A'], [oldWriting, 'w1', ['A', '']], [oldSingleSet, 'r1', 'B']]) await api(`/sessions/${session.id}`, { writerToken: session.writerToken, expectedRevision: session.revision, answers: { [questionId]: { answer } } }, 'PATCH');
  const oldTestIds = [oldReading.id, oldWriting.id, oldSingleSet.id], oldBefore = canonicalJSON((await rawState()).sessions.filter(item => oldTestIds.includes(item.id)));
  browser = await chromium.launch({ channel: process.env.PRACTICEBRIDGE_BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 850 }, serviceWorkers: 'block' });
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== instance.url) { report.externalRequests.push(url.href); return route.abort(); } return route.continue(); });
  page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions') report.createRequests.push(request.postDataJSON()); });
  const openLibrary = async mode => { await page.goto(`${instance.url}/#collection/${libraryId}`); await page.locator('.exam-library-table').waitFor(); if (mode === 'exam') await page.locator('[data-library-mode=exam]').click(); };
  const row = (setId = 'full-set') => page.locator(`[data-set-id="${setId}"]`);
  const waitPhase = (qid, phase) => page.waitForFunction(({ qid, phase }) => { const shell = document.querySelector('.exam-shell'); return shell?.dataset.questionId === qid && shell.dataset.phase === phase; }, { qid, phase });
  const leave = async () => { await page.locator('#exam-exit').click(); await page.locator('.exam-library-table').waitFor(); };
  const screenshot = async name => { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(output, name), fullPage: true }); };
  const assertFullRequest = (request, setId = 'full-set') => { assert.equal(request.libraryId, libraryId); assert.equal(request.setId, setId); assert.equal(request.mode, 'exam'); assert.equal(request.sessionVersion, 2); assert.equal(Object.hasOwn(request, 'sectionId'), false); assert.equal(Object.hasOwn(request, 'groupId'), false); };

  currentCase = 'PRACTICE keeps the existing per-section entries';
  await openLibrary('practice');
  assert.equal(await row().locator('[data-start-section]').count(), 4);
  assert.equal(await row().locator('[data-start-full-test]').count(), 0);
  assert.equal(await row().locator('[data-start-section=writing]').getAttribute('data-session-id'), oldPractice.id);
  assert.equal(await row().locator('[data-start-section=reading]').getAttribute('data-session-id'), null);
  pass('PRACTICE retains four independent section buttons and its existing writing session');

  currentCase = 'TEST offers one full-paper start and read-only subject counts';
  await page.locator('[data-library-mode=exam]').click();
  assert.equal(await row().locator('[data-start-section]').count(), 0);
  assert.equal(await row().locator('[data-start-full-test]').innerText(), '开始整套测试');
  assert.equal(await row().locator('[data-start-full-test]').getAttribute('data-session-id'), null);
  assert.deepEqual(await row().locator('[data-test-section-count]').allTextContents(), ['3 题', '1 题', '2 题', '7 题']);
  assert.match(await row().innerText(), /共 13 题/); assert.match(await page.locator('#exam-mode-description').innerText(), /整套结束后/);
  await page.locator('#exam-task-details > summary').click();
  const historyLinks = await page.locator('#exam-task-list a').evaluateAll(items => items.map(item => item.getAttribute('href')));
  for (const id of oldTestIds) assert.ok(historyLinks.some(href => href.endsWith(`/${id}`)), 'The old single-section TEST record remains linked');
  await page.locator('#exam-task-details > summary').click(); await screenshot('01-test-full-paper.png');
  pass('TEST shows one full-paper control, exact subject counts and accessible old single-section TEST history');

  currentCase = 'the full-paper button creates a four-section session with no subject filter';
  await row().locator('[data-start-full-test]').click(); await waitPhase('r1', 'instructions');
  assert.equal(report.createRequests.length, 1); assertFullRequest(report.createRequests[0]);
  const fullId = await page.locator('.exam-shell').getAttribute('data-session-id');
  const full = await saved(fullId);
  assert.deepEqual(full.selection, { setId: 'full-set' });
  assert.deepEqual(full.planSnapshot.sections.map(section => section.section), ['reading', 'listening', 'writing', 'speaking']);
  assert.equal(full.planSnapshot.sections.flatMap(section => section.modules).length, 5);
  assert.deepEqual(full.planSnapshot.sections.flatMap(section => section.modules.flatMap(module => module.tasks.flatMap(task => task.questionIds))), ['r1', 'r2', 'r3', 'l1', 'w1', 'w2', 's1', 's2', 's3', 's4', 's5', 's6', 's7']);
  assert.equal(full.planSnapshot.sections[0].modules[0].timing.durationSeconds, 600, 'The original source timing is retained');
  await page.locator('#exam-next').click(); await waitPhase('r1', 'response');
  await page.locator('input[name=answer][value=B]').check();
  await poll(() => saved(fullId), item => item.answers.r1?.answer === 'B', 'Full-paper answer did not autosave');
  await leave();
  pass('Start creates all four sections, all five modules and 13 ordered questions while autosaving the answer');

  currentCase = 'full-paper resume favors a draft over a newer blank and creates no duplicate';
  await create('exam'); await openLibrary('exam');
  assert.equal(await row().locator('[data-start-full-test]').innerText(), '继续整套测试');
  assert.equal(await row().locator('[data-start-full-test]').getAttribute('data-session-id'), fullId);
  const countBeforeResume = (await snapshot()).sessions.length;
  await row().locator('[data-start-full-test]').click(); await page.locator('#exam-resume').waitFor(); await page.locator('#exam-resume').click(); await waitPhase('r1', 'response');
  assert.equal(await page.locator('.exam-shell').getAttribute('data-session-id'), fullId); assert.equal(await page.locator('input[name=answer][value=B]').isChecked(), true);
  assert.equal((await snapshot()).sessions.length, countBeforeResume); assert.equal(report.createRequests.length, 1);
  await leave();
  pass('Continue resumes the existing answered full paper and ignores newer empty runs without another POST');

  currentCase = 'PRACTICE still creates only the chosen listening section and resumes writing';
  await row().locator('[data-start-section=listening]').click(); await waitPhase('l1', 'instructions');
  const practiceRequest = report.createRequests.at(-1); assert.equal(practiceRequest.mode, 'practice'); assert.equal(practiceRequest.sectionId, 'listening'); assert.equal(Object.hasOwn(practiceRequest, 'groupId'), false);
  const listening = await saved(await page.locator('.exam-shell').getAttribute('data-session-id')); assert.deepEqual(listening.planSnapshot.sections.map(section => section.section), ['listening']);
  await leave(); const countBeforeWriting = (await snapshot()).sessions.length;
  await row().locator('[data-start-section=writing]').click(); await waitPhase('w1', 'instructions'); assert.equal(await page.locator('.exam-shell').getAttribute('data-session-id'), oldPractice.id);
  assert.equal((await snapshot()).sessions.length, countBeforeWriting); await leave();
  pass('PRACTICE continues to create a single selected section and reopen its own earlier writing session');

  currentCase = 'timing text, custom fields and narrow TEST layout';
  await page.locator('[data-library-mode=exam]').click(); await page.setViewportSize({ width: 760, height: 850 }); await screenshot('02-test-760.png');
  const fullButton = await row().locator('[data-start-full-test]').boundingBox(); assert.ok(fullButton.x >= 0 && fullButton.x + fullButton.width <= 760, 'The full-paper button remains in the narrow viewport');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
  await page.locator('.exam-library-table-wrap').evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const reportButton = await row().locator('[data-library-report]').boundingBox(); assert.ok(reportButton.x >= 0 && reportButton.x + reportButton.width <= 760, 'The table scroll exposes Report in the narrow viewport');
  await screenshot('02-test-760-report.png');
  await page.locator('.exam-library-table-wrap').evaluate(element => { element.scrollLeft = 0; });
  await page.locator('#exam-timing-settings').click();
  const dialog = page.getByRole('dialog', { name: '计时设置', exact: true }), text = await dialog.innerText();
  assert.match(text, /Reading 每模块默认 12:00/); assert.match(text, /Build a Sentence 整个任务默认 6:50/);
  assert.match(text, /第 1–2 题 8 秒，第 3–5 题 10 秒，第 6–7 题 12 秒/);
  await page.locator('#exam-preset').selectOption('custom');
  assert.equal(await page.locator('[data-time-key=readingModuleSeconds]').getAttribute('placeholder'), '默认 720 秒');
  assert.equal(await page.locator('[data-time-key=sentenceTaskSeconds]').getAttribute('placeholder'), '默认 410 秒');
  assert.equal(await page.locator('[data-time-key=repeatSeconds]').getAttribute('placeholder'), '默认按题序 8 / 10 / 12 秒');
  await screenshot('03-timing-760.png');
  await page.locator('#save-timing').scrollIntoViewIfNeeded();
  const saveButton = await page.locator('#save-timing').boundingBox(); assert.ok(saveButton.y >= 0 && saveButton.y + saveButton.height <= 850, 'The timing dialog scroll exposes Save');
  await screenshot('04-timing-buttons-760.png');
  for (const [key, value] of Object.entries({ readingModuleSeconds: '555', sentenceTaskSeconds: '444', repeatSeconds: '9' })) await page.locator(`[data-time-key=${key}]`).fill(value);
  await page.locator('#save-timing').click(); await dialog.waitFor({ state: 'detached' });
  assert.equal((await saved(fullId)).preset, 'document', 'New settings must not rewrite an existing run');
  pass('The narrow TEST table and timing dialog show 12:00, 6:50 and the 8/10/12-second sequence; custom settings preserve existing runs');

  currentCase = 'one-section papers still distinguish old section TEST records';
  assert.equal(await row('reading-set').locator('[data-start-full-test]').getAttribute('data-session-id'), null);
  await row('reading-set').locator('[data-start-full-test]').click(); await waitPhase('r1', 'instructions');
  assertFullRequest(report.createRequests.at(-1), 'reading-set');
  const single = await saved(await page.locator('.exam-shell').getAttribute('data-session-id'));
  assert.notEqual(single.id, oldSingleSet.id); assert.deepEqual(single.selection, { setId: 'reading-set' });
  assert.deepEqual(single.preset, { readingModuleSeconds: 555, sentenceTaskSeconds: 444, repeatSeconds: 9 });
  assert.deepEqual(single.planSnapshot.sections.map(section => section.section), ['reading']); await leave();
  assert.equal(canonicalJSON((await rawState()).sessions.filter(item => oldTestIds.includes(item.id))), oldBefore);
  assert.equal((await snapshot()).attempts.length, 0); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []); assert.equal(report.modelCalls, 0);
  pass('A reading-only paper starts with a set-only selector and the chosen preset; every old single-section TEST record remains byte-equivalent');
  report.sourceAfter = await sourceHash(); assert.equal(report.sourceAfter, report.sourceBefore); report.ok = true;
} catch (error) {
  report.ok = false; report.failure = { currentCase, message: error.message, stack: error.stack }; process.exitCode = 1;
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close(); await instance?.close(); report.finishedUtc = new Date().toISOString();
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log('RESULT_DIR ' + output); if (!report.ok) console.error(report.failure);
}
