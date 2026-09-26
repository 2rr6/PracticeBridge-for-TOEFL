import {appFetch} from './auth-client.mjs';
// Run: node tests/exam-workflow-ui.mjs
// Complete current-engine workflow through user-facing controls. All source
// questions, answers and model replies are independently authored test fixtures.
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import { readZip, canonicalJSON } from '../src/package.mjs';
import { saveAndProcessLocal } from './material-ui-helpers.mjs';
import ZipFixture from './helpers/zip-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(project, 'test-results');
await fs.mkdir(testRoot, { recursive: true });
const run = await fs.mkdtemp(path.join(testRoot, 'exam-workflow-ui-'));
const dataDir = path.join(run, 'data');
const checks = [], pageErrors = [], externalRequests = [], feedbackCalls = [], heldReleases = new Set();
const pass = label => { checks.push(label); console.log('PASS ' + label); };
const source = 'Original workflow browser fixture.';
const q = (id, type, prompt, answer, localNumber) => ({ id, type, prompt, options: [], answer, explanation: '', source, localNumber, ordinalInTask: localNumber, audio: null, image: null, timeLimitSeconds: 0, prepareSeconds: 0 });
const timing = scope => ({ scope, durationSeconds: 900, prepareSeconds: null, basis: 'user', source });
const pack = {
  schemaVersion: 1, examContractVersion: 1, minReaderVersion: '0.3.0', id: 'original-workflow', version: '1.0.0', title: 'Original garden workflow', description: '', rights: '',
  groups: [
    { id: 'notice-task', section: 'reading', title: 'Original garden notice', passage: 'The garden gate opens at nine. Visitors may borrow a map.', audio: null, image: null, taskKind: 'read_daily',
      presentation: { screen: 'one_question', passageVisibility: 'attempt', questionPromptVisibility: 'attempt', document: { kind: 'notice', title: 'Garden notice', blocks: [{ kind: 'paragraph', text: 'The garden gate opens at nine.' }, { kind: 'paragraph', text: 'Visitors may borrow a map.' }] } },
      timing: { scope: 'inherit_module', durationSeconds: null, prepareSeconds: null, basis: 'unknown', source: '' },
      questions: [
        { ...q('gate-time', 'single_choice', 'When does the garden gate open?', 'A', 1), options: [{ id: 'A', text: 'At nine.' }, { id: 'B', text: 'At ten.' }], explanation: 'The notice gives the opening time as nine.' },
        { ...q('borrow-map', 'single_choice', 'What may visitors borrow? No answer key was supplied.', null, 2), options: [{ id: 'A', text: 'A map.' }, { id: 'B', text: 'A spade.' }] },
      ],
    },
    { id: 'email-task', section: 'writing', title: 'Original club email', passage: '', audio: null, image: null, taskKind: 'write_email', timing: timing('task'),
      presentation: { screen: 'one_question', passageVisibility: 'attempt', questionPromptVisibility: 'attempt', email: { to: 'Mira', subject: 'Map for the club walk', instructions: 'Ask to borrow a map, explain the plan, and say when you will return it.' } },
      questions: [q('club-email', 'email', 'Write to Mira. Ask to borrow a map for a club walk, explain your plan, and say when you will return the map.', null, 1)],
    },
  ],
  examSets: [{ id: 'workflow-set', title: 'Original garden workflow', sections: [
    { id: 'reading-section', section: 'reading', title: 'Reading', modules: [{ id: 'reading-module', title: 'Reading module', sourceNumber: 1, taskIds: ['notice-task'], timing: timing('module'), navigation: { back: 'module', review: 'module', lockOnAdvance: true } }] },
    { id: 'writing-section', section: 'writing', title: 'Writing', modules: [{ id: 'writing-module', title: 'Writing module', sourceNumber: 1, taskIds: ['email-task'], navigation: { back: 'none', review: 'none', lockOnAdvance: true } }] },
  ] }],
};
const emailAnswer = 'Hi Mira,\nCould I borrow your map for our club walk on Thursday? We will follow the short route beside the pond. I will return the map on Friday morning.\nThanks,\nAlex';
const feedback = version => ({ summary: `Original local feedback version ${version}.`, strengths: ['The email gives a purpose and a return time.'], corrections: [{ quote: 'Could I borrow your map', issue: 'This request is clear.', suggestion: 'Keep the direct request.', category: 'optional' }], revisedAnswer: emailAnswer, modelAnswer: 'Hi Mira, may our club borrow your map for Thursday? I can return it on Friday morning. Thank you, Alex.', nextSteps: ['Keep the plan and return time specific.'], limitations: ['Synthetic local feedback fixture.'], provider: 'fixture', model: 'original-workflow-double' });
let instance, browser, context, page, oldWriter, currentCase = 'initialization', gateState, releaseState;

try {
  const models = {
    publicSettings: () => ({ provider: 'compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'original-workflow-double', timeoutSeconds: 60, maxOutputTokens: 3000, hasApiKey: false, status: 'configured', capabilities: { chat: true, feedback: true, structure: false, assessMaterials: false } }),
    feedback: request => new Promise(resolve => feedbackCalls.push({ request, resolve, released: false })),
    chat: () => { throw new Error('This workflow must not call chat or a real model'); },
    structure: () => { throw new Error('The original native fixture is processed locally'); },
  };
  instance = await startServer({ dataDir, models });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST', expectedStatus = 200) => {
    const response = await appFetch(`${instance.url}/api${route}`, { method, headers: { 'X-PracticeBridge': '1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(value)); return value;
  };
  const poll = async (check, message, timeout = 12000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(message); };
  const getSession = async id => (await api(`/sessions/${id}`)).session;
  const releaseFeedback = (index, version) => { feedbackCalls[index].released = true; feedbackCalls[index].resolve(feedback(version)); };
  const fixtureZip = new ZipFixture(); fixtureZip.addFile('practicebridge.json', Buffer.from(JSON.stringify(pack, null, 2))); const inputBytes = fixtureZip.toBuffer();
  await fs.writeFile(path.join(run, 'original-practice.zip'), inputBytes);
  browser = await chromium.launch({ channel: process.env.PRACTICEBRIDGE_BROWSER_CHANNEL || 'msedge', headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (window.__workflowHoldState && input === '/api/state') { window.__workflowHoldState = false; input += '?workflow-hold=report'; }
      return originalFetch(input, options);
    };
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== instance.url) { externalRequests.push(url.href); return route.abort('blockedbyclient'); }
    if (url.searchParams.get('workflow-hold') === 'report') {
      const response = await route.fetch(); gateState = true;
      await new Promise(resolve => { releaseState = resolve; heldReleases.add(resolve); }); heldReleases.delete(releaseState);
      return route.fulfill({ response });
    }
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => pageErrors.push(error.message));
  const waitPhase = (qid, phase, target = page) => target.waitForFunction(({ qid, phase }) => { const shell = document.querySelector('.exam-shell'); return shell?.dataset.questionId === qid && shell.dataset.phase === phase; }, { qid, phase });
  const finishModule = async (target = page) => { const dialog = target.getByRole('dialog', { name: 'Finish this module?' }); await dialog.waitFor(); await dialog.getByRole('button', { name: 'Finish Module', exact: true }).click(); await target.locator('.exam-completed').waitFor(); };
  const finishReading = async () => { await page.locator('#exam-next').click(); await waitPhase('borrow-map', 'review'); await page.locator('#end-review-scope').click(); await finishModule(); };
  const closeReport = () => page.locator('.modal .close').click();
  const openCompletedReport = async attempt => { await page.locator(`[data-attempt="${attempt.id}"]`).click(); await page.locator('.modal h3.prewrap').filter({ hasText: attempt.questionSnapshot.prompt }).waitFor(); };

  currentCase = 'original ZIP through material intake and the new table';
  await page.goto(instance.url); await page.locator('.hero').waitFor(); assert.equal((await api('/state')).libraries.length, 0);
  await page.getByRole('link', { name: '导入我的材料', exact: true }).click();
  await page.locator('#import-files').setInputFiles({ name: 'original-practice.zip', mimeType: 'application/zip', buffer: inputBytes });
  await saveAndProcessLocal(page); assert.equal(await page.locator('#candidate-author').isChecked(), false); assert.equal(await page.locator('#compile-candidates').isDisabled(), false);
  assert.equal(feedbackCalls.length, 0); assert.equal((await api('/state')).libraries.length, 0);
  await page.locator('#compile-candidates').click(); await page.locator('#candidate-result .success').waitFor();
  await page.locator('#candidate-result a').first().click(); await page.locator('.exam-library-table').waitFor();
  let state = await api('/state'); const library = state.libraries[0]; assert.equal(library.groups.flatMap(group => group.questions).length, 3);
  assert.equal(state.materials[0].status, 'imported'); assert.equal(await page.locator('#exam-set-rows tr').count(), 1);
  assert.deepEqual(await page.locator('.exam-library-table thead th').allTextContents(), ['No.', 'Title', 'Reading', 'Listening', 'Writing', 'Speaking', 'Report']);
  await page.screenshot({ path: path.join(run, '01-library-table.png'), fullPage: true });
  pass('an original ZIP enters through receipt, local conversion and confirmation, then appears in the current section table');

  currentCase = 'native package export button';
  const exportPromise = page.waitForEvent('download'); await page.locator('#export-pack').click(); const exported = await exportPromise;
  const exportPath = path.join(run, 'library-export.zip'); await exported.saveAs(exportPath); const exportedFiles = (await readZip(await fs.readFile(exportPath)));
  assert.deepEqual([...exportedFiles.keys()], ['practicebridge.json']); const exportedPack = JSON.parse(exportedFiles.get('practicebridge.json'));
  assert.equal(exportedPack.examContractVersion, 1); assert.deepEqual(exportedPack.examSets[0].sections.map(section => section.section), ['reading', 'writing']);
  assert.equal('attempts' in exportedPack, false); assert.equal('mediaUrls' in exportedPack, false); assert.equal('examPlan' in exportedPack, false);
  pass('the table export button downloads a source package with execution metadata and without personal records');

  currentCase = 'reading draft exit, table resume and module submission';
  await page.locator('[data-start-section=reading]').click(); await waitPhase('gate-time', 'instructions'); await page.locator('#exam-next').click(); await waitPhase('gate-time', 'response');
  const firstSessionId = await page.locator('.exam-shell').getAttribute('data-session-id');
  await page.locator('input[name=answer][value=B]').check(); await poll(async () => (await getSession(firstSessionId)).answers['gate-time']?.answer === 'B', 'The initial reading answer did not autosave');
  await page.locator('#exam-exit').click(); await page.locator('.exam-library-table').waitFor();
  assert.equal(await page.locator('[data-start-section=reading]').getAttribute('data-session-id'), firstSessionId);
  await page.locator('[data-start-section=reading]').click(); await page.locator('#exam-resume').waitFor(); await page.locator('#exam-resume').click(); await waitPhase('gate-time', 'response');
  assert.equal(await page.locator('input[name=answer][value=B]').isChecked(), true); await page.locator('#exam-next').click(); await waitPhase('borrow-map', 'response');
  await page.locator('input[name=answer][value=A]').check(); await finishReading();
  state = await api('/state'); assert.equal(state.attempts.length, 2);
  const firstChoice = state.attempts.find(attempt => attempt.questionId === 'gate-time'), firstUnknown = state.attempts.find(attempt => attempt.questionId === 'borrow-map');
  assert.equal(firstChoice.objective.status, 'incorrect'); assert.deepEqual(firstUnknown.objective, { status: 'unscored', correct: null, total: null });
  assert.equal(firstChoice.mode, 'practice'); assert.equal(firstChoice.kind, 'first');
  pass('table resume keeps the draft and module commit produces exact objective results while an answered item without a key stays unscored');

  currentCase = 'saved response report and an independent retry';
  await page.locator('#completed-exit').click(); await page.locator('[data-library-report]').click(); await page.getByRole('dialog', { name: 'Saved responses' }).waitFor();
  await page.locator(`[data-report-id="${firstChoice.id}"]`).click(); await page.locator('.modal').waitFor();
  assert.equal((await page.locator('.modal .answer-text').first().innerText()).trim(), 'B');
  await page.locator('.modal summary').filter({ hasText: '查看题目材料与答案' }).click();
  assert.ok((await page.locator('.modal').innerText()).includes('B. At ten.'));
  await page.locator('#review-toggle').click(); await poll(async () => (await api('/state')).attempts.find(attempt => attempt.id === firstChoice.id).reviewed, 'The report review flag did not save');
  await page.locator('#retry-link').click(); await waitPhase('gate-time', 'instructions'); await page.locator('#exam-next').click(); await waitPhase('gate-time', 'response');
  await page.locator('input[name=answer][value=A]').check(); await page.locator('#exam-next').click(); await waitPhase('borrow-map', 'response'); await page.locator('input[name=answer][value=B]').check(); await finishReading();
  state = await api('/state'); const choiceAttempts = state.attempts.filter(attempt => attempt.questionId === 'gate-time');
  assert.equal(choiceAttempts.length, 2); assert.equal(choiceAttempts[0].id, firstChoice.id); assert.equal(choiceAttempts[0].answer, 'B'); assert.equal(choiceAttempts[1].answer, 'A'); assert.equal(choiceAttempts[1].kind, 'retry'); assert.equal(choiceAttempts[1].objective.status, 'correct');
  assert.equal(state.attempts.filter(attempt => attempt.questionId === 'borrow-map').every(attempt => attempt.objective.status === 'unscored'), true);
  pass('the table Report opens the source-owned response, persists review status and starts a retry without overwriting the first attempt');

  currentCase = 'email clear, autosave, reload and submission';
  await page.locator('#completed-exit').click(); await page.locator('[data-start-section=writing]').click(); await waitPhase('club-email', 'instructions'); await page.locator('#exam-next').click(); await waitPhase('club-email', 'response');
  const emailSessionId = await page.locator('.exam-shell').getAttribute('data-session-id');
  await page.locator('#answer-input').fill('Temporary draft.'); await poll(async () => (await getSession(emailSessionId)).answers['club-email']?.answer === 'Temporary draft.', 'The initial email did not save');
  await page.locator('#answer-input').fill(''); await poll(async () => (await getSession(emailSessionId)).answers['club-email']?.answer === '', 'Clearing an email retained the old draft');
  await page.locator('#answer-input').fill(emailAnswer); await poll(async () => (await getSession(emailSessionId)).answers['club-email']?.answer === emailAnswer, 'The final email did not save');
  await page.reload(); await page.locator('#exam-resume').waitFor(); await page.locator('#exam-resume').click(); await waitPhase('club-email', 'response'); assert.equal(await page.locator('#answer-input').inputValue(), emailAnswer);
  await page.locator('#exam-next').click(); await finishModule(); state = await api('/state'); const emailAttempt = state.attempts.find(attempt => attempt.questionId === 'club-email');
  assert.equal(state.attempts.length, 5); assert.equal(emailAttempt.answer, emailAnswer); assert.equal(emailAttempt.objective.status, 'unscored');
  pass('email clearing and exact text survive autosave and reload, then the new module engine commits an unscored writing attempt');

  currentCase = 'explicit background feedback keeps the current report readable';
  await openCompletedReport(emailAttempt); await page.locator('.modal summary').filter({ hasText: '请求本次作答的 AI 反馈' }).click();
  await page.locator('#request-feedback').click(); assert.equal(feedbackCalls.length, 0); assert.equal((await api('/state')).jobs.length, 0);
  await page.locator('.modal input[name=consent]').check(); await page.locator('#request-feedback').click(); await poll(() => feedbackCalls.length === 1, 'Feedback did not reach the local model double');
  assert.equal(feedbackCalls[0].request.attempt.id, emailAttempt.id); assert.equal(feedbackCalls[0].request.attempt.answer, emailAnswer);
  await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('.modal .answer-text')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  releaseFeedback(0, 1); await poll(async () => (await api('/state')).attempts.find(attempt => attempt.id === emailAttempt.id).evaluations.length === 1, 'The feedback version did not persist');
  await page.waitForTimeout(4200);
  assert.equal(await page.evaluate(() => getSelection().toString()), emailAnswer, 'Background completion must preserve the report being read');
  assert.ok((await page.locator('#evaluation-content').innerText()).includes('尚未生成 AI 反馈'));
  await closeReport(); await openCompletedReport(emailAttempt); assert.ok((await page.locator('#evaluation-content').innerText()).includes('Original local feedback version 1.'));
  await page.screenshot({ path: path.join(run, '02-feedback-report.png'), fullPage: true });
  pass('feedback requires explicit consent, stays bound to the original answer and completes without replacing the report or its text selection');

  currentCase = 'new feedback does not overwrite another report and retains version history';
  await page.locator('.modal summary').filter({ hasText: '请求本次作答的 AI 反馈' }).click(); await page.locator('.modal input[name=consent]').check(); await page.locator('#request-feedback').click();
  await poll(() => feedbackCalls.length === 2, 'A second local feedback version did not start'); await closeReport();
  await page.locator('#completed-exit').click(); await page.locator('[data-library-report]').click(); await page.locator(`[data-report-id="${firstChoice.id}"]`).click(); await page.locator('.modal h3.prewrap').filter({ hasText: firstChoice.questionSnapshot.prompt }).waitFor();
  releaseFeedback(1, 2); await poll(async () => (await api('/state')).attempts.find(attempt => attempt.id === emailAttempt.id).evaluations.length === 2, 'The second feedback version did not persist');
  await page.waitForTimeout(4200); assert.ok((await page.locator('.modal h3.prewrap').innerText()).includes(firstChoice.questionSnapshot.prompt)); assert.equal((await page.locator('.modal').innerText()).includes('Original local feedback'), false);
  await closeReport(); await page.locator('[data-library-report]').click(); await page.locator(`[data-report-id="${emailAttempt.id}"]`).click(); await page.locator('.modal').waitFor();
  assert.ok((await page.locator('#evaluation-content').innerText()).includes('version 2')); await page.locator('.modal summary').filter({ hasText: '历史反馈版本' }).click();
  await page.locator('[data-eval="0"]').click(); assert.ok((await page.locator('#evaluation-content').innerText()).includes('version 1')); await page.locator('[data-eval="1"]').click();
  const reportDownload = page.waitForEvent('download'); await page.locator('#report-export').click(); const reportFile = await reportDownload; const reportPath = path.join(run, 'answer-review.md'); await reportFile.saveAs(reportPath);
  const reportText = await fs.readFile(reportPath, 'utf8'); assert.ok(reportText.includes(emailAnswer)); assert.ok(reportText.includes('Original local feedback version 2.')); await closeReport();
  pass('late feedback remains with its answer, older feedback stays selectable and the visible source response can be exported');

  currentCase = 'late report read cannot reopen over a new browser route';
  await page.locator('[data-library-report]').click();
  await page.evaluate(id => { window.__workflowHoldState = true; document.querySelector(`[data-report-id="${id}"]`).click(); }, emailAttempt.id);
  await poll(() => gateState, 'The report read did not reach its response gate'); await page.evaluate(() => { location.hash = '#analytics'; }); await page.locator('#analytics-results').waitFor();
  releaseState(); releaseState = null; await page.waitForTimeout(180); assert.equal(await page.locator('.modal').count(), 0); assert.equal(await page.locator('#analytics-results').count(), 1);
  pass('a delayed report read cannot reopen a modal after navigation to another route');

  currentCase = 'analytics reconciles first, retry, missing-key and writing attempts';
  assert.equal(await page.locator('.data-table tbody tr').count(), 5); assert.ok((await page.locator('#analytics-results .stat-value').nth(1).innerText()).includes('50%'));
  await page.locator('#more-filters > summary').click(); await page.locator('#filter-scope').selectOption('latest'); assert.equal(await page.locator('.data-table tbody tr').count(), 3); assert.ok((await page.locator('#analytics-results .stat-value').nth(1).innerText()).includes('100%'));
  await page.locator('#filter-section').selectOption('writing'); assert.equal(await page.locator('.data-table tbody tr').count(), 1); assert.equal((await page.locator('#analytics-results .stat-value').nth(1).innerText()).trim(), '—');
  await page.locator('#clear-filters').click(); await page.locator('#filter-status').selectOption('review'); assert.equal(await page.locator('.data-table tbody tr').count(), 0);
  await page.locator('#clear-filters').click(); await page.screenshot({ path: path.join(run, '03-analytics.png'), fullPage: true });
  pass('analytics counts actual attempts and retries, excludes missing keys/writing from accuracy, and respects the saved review flag');

  currentCase = 'backup restoration rejects a held autosave from an old page';
  await page.locator('a[data-nav=settings]').click(); await page.locator('#backup-export').waitFor();
  oldWriter = await context.newPage(); oldWriter.setDefaultTimeout(12000); oldWriter.on('pageerror', error => pageErrors.push(error.message));
  await oldWriter.goto(`${instance.url}/#collection/${library.libraryId}`); await oldWriter.locator('[data-start-section=writing]').click(); await waitPhase('club-email', 'instructions', oldWriter); await oldWriter.locator('#exam-next').click(); await waitPhase('club-email', 'response', oldWriter);
  const activeId = await oldWriter.locator('.exam-shell').getAttribute('data-session-id'), stableDraft = 'Saved draft included in the original backup.';
  await oldWriter.locator('#answer-input').fill(stableDraft); await poll(async () => (await getSession(activeId)).answers['club-email']?.answer === stableDraft, 'The backup draft did not save');
  const beforeBackup = await api('/state'); const backupDownload = page.waitForEvent('download'); await page.locator('#backup-export').click(); const backupFile = await backupDownload;
  const backupPath = path.join(run, 'personal-backup.zip'); await backupFile.saveAs(backupPath); const backupBytes = await fs.readFile(backupPath);
  const backedUp = JSON.parse((await readZip(backupBytes, { allowInputOriginals: true })).get('practicebridge-backup.json'));
  assert.equal(backedUp.state.attempts.length, 5); assert.equal(backedUp.state.materials.length, 1); assert.equal(backedUp.state.sessions.find(item => item.id === activeId).answers['club-email'].answer, stableDraft); assert.equal('model-settings' in backedUp.state, false);
  let heldPatch, releasePatch, patchResponse;
  await oldWriter.route(`**/api/sessions/${activeId}`, async route => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON().answers) return route.continue();
    heldPatch = route.request().postDataJSON(); await new Promise(resolve => { releasePatch = resolve; heldReleases.add(resolve); }); heldReleases.delete(releasePatch);
    const response = await route.fetch(); patchResponse = { status: response.status(), body: await response.json() }; return route.fulfill({ response });
  });
  const oldText = 'An unsaved old-page edit must not overwrite the restored draft.';
  await oldWriter.locator('#answer-input').fill(oldText); await poll(() => heldPatch, 'The old page autosave did not reach its gate');
  await page.locator('details').filter({ has: page.locator('#backup-file') }).locator('summary').click(); await page.locator('#backup-file').setInputFiles(backupPath); await page.locator('#restore-confirm').check(); await page.locator('#backup-restore').click(); await page.locator('.hero').waitFor();
  const restored = await api('/state'); assert.notEqual(restored.workspaceEpoch, beforeBackup.workspaceEpoch); assert.deepEqual(restored.attempts, beforeBackup.attempts); assert.equal(restored.libraries[0].contentHash, beforeBackup.libraries[0].contentHash);
  releasePatch(); releasePatch = null; await poll(() => patchResponse, 'The old autosave did not return after restore'); assert.equal(patchResponse.status, 409); assert.match(patchResponse.body.error, /工作区/);
  await oldWriter.waitForFunction(() => document.querySelector('#exam-save-state')?.textContent.includes('未保存'));
  assert.equal(await oldWriter.locator('#answer-input').inputValue(), oldText); const latest = await getSession(activeId); assert.equal(latest.answers['club-email'].answer, stableDraft);
  await api(`/sessions/${activeId}`, { writerToken: heldPatch.writerToken, expectedRevision: latest.revision, answers: { 'club-email': 'Stale epoch with the current revision.' } }, 'PATCH', 409);
  await oldWriter.screenshot({ path: path.join(run, '04-stale-page-protection.png'), fullPage: true });
  const restoredPage = await context.newPage(); restoredPage.on('pageerror', error => pageErrors.push(error.message)); await restoredPage.goto(`${instance.url}/#exam/${library.libraryId}/workflow-set/all/practice/${activeId}`); await restoredPage.locator('#exam-resume').waitFor(); assert.equal(await restoredPage.locator('#answer-input').inputValue(), stableDraft);
  pass('the UI backup restores originals, immutable attempts, feedback and draft data; stale writes receive 409 while the old page retains its unsaved text');

  currentCase = 'restart persistence and final audit';
  const persistedAttempts = canonicalJSON((await api('/state')).attempts);
  await context.close(); context = null; await instance.close(); instance = await startServer({ dataDir, models });
  state = await api('/state'); assert.equal(canonicalJSON(state.attempts), persistedAttempts); assert.equal(state.libraries.length, 1); assert.equal(state.materials.length, 1); assert.equal(state.attempts.find(attempt => attempt.id === emailAttempt.id).evaluations.length, 2);
  assert.equal(state.sessions.find(item => item.id === activeId).answers['club-email'].answer, stableDraft); assert.equal(feedbackCalls.length, 2); assert.deepEqual(externalRequests, []); assert.deepEqual(pageErrors, []);
  pass('restart preserves all five attempts, both feedback versions and the restored draft with no extra model request or page error');
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify({ ok: true, checks, attempts: state.attempts.length, feedbackRequests: feedbackCalls.length, realModelRequests: 0, externalRequests, pageErrors, input: 'Original synthetic native package through visible import controls' }, null, 2) + '\n');
  console.log('RESULT_DIR ' + run);
} catch (error) {
  console.error(`FAIL during ${currentCase}: ${error.stack || error.message}`); process.exitCode = 1;
  await page?.screenshot({ path: path.join(run, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(run, 'failure.json'), JSON.stringify({ currentCase, error: error.stack || error.message, checks, pageErrors, externalRequests }, null, 2) + '\n'); console.log('RESULT_DIR ' + run);
} finally {
  for (const release of heldReleases) release(); for (const call of feedbackCalls) if (!call.released) call.resolve(feedback(0));
  await context?.close(); await browser?.close(); await instance?.close();
}
