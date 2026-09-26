import {appFetch} from './auth-client.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import { emptyState, runtimeLibrary } from '../src/store.mjs';
import { canonicalJSON, contentHash, validatePackage } from '../src/package.mjs';
import { buildExamPlan } from '../src/exam-plan.mjs';
import { describeResumeSession, resumableSessionGroups } from '../public/exam-library.mjs';

// The default run authors its own questions and state. Optional --live-state only
// reads a snapshot for display, intercepts every API request, and never resumes or
// writes that workspace. No actual answers or recordings are written to artifacts.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(project, 'test-results'), { recursive: true });
const output = await fs.mkdtemp(path.join(project, 'test-results', 'exam-resume-ui-'));
const dataDir = path.join(output, 'synthetic-data');
await fs.mkdir(dataDir);
// Deliberately synthetic UUIDs; no learner workspace identifiers are checked in.
const file = path.join(dataDir, 'state.json'), libraryId = '00000000-0000-4000-8000-000000000001';
const ids = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000013'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['public/app.mjs', 'public/exam-library.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, sha(await fs.readFile(path.join(project, name)))])));
const report = { startedUtc: new Date().toISOString(), sourceBefore: await hashes(), checks: [], pageErrors: [], externalRequests: [], realModelCalls: 0 };
const pass = text => { report.checks.push(text); console.log('PASS ' + text); };
const choice = n => ({ id: `reading-m1-q${n}`, type: 'single_choice', prompt: `Which original detail belongs to item ${n}?`, answer: 'A', options: [{ id: 'A', text: 'A shared bookshelf.' }, { id: 'B', text: 'An empty yard.' }], source: `Original browser fixture · 原题号 ${n}` });
const taskGroups = [
  { id: 'reading-m1-g2', section: 'reading', taskKind: 'read_daily', title: 'Reading · Module 1 · Read a notice. · 原题号 11–12', passage: 'A shared bookshelf is open on Friday.', questions: [choice(11), choice(12)] },
  { id: 'reading-m1-g3', section: 'reading', taskKind: 'read_daily', title: 'Reading · Module 1 · Read a social media post. · 原题号 13–15', passage: 'A reading club shares books every week.', questions: [choice(13), choice(14), choice(15)] },
  { id: 'writing-g2', section: 'writing', taskKind: 'write_email', title: 'Writing · Write an Email', passage: '', questions: [{ id: 'writing-email-q1', type: 'email', prompt: 'Write an original email about a shared bookshelf.', answer: null, source: 'Original browser fixture.' }] },
];
const pack = validatePackage({ schemaVersion: 1, examContractVersion: 1, minReaderVersion: '0.3.0', id: 'original-resume-ui', version: '1', title: 'TOEFL Practice Test 1 · 续做回归用原创材料', groups: taskGroups, examSets: [{ id: 'resume-set', title: 'Original resume practice', sections: [
  { id: 'reading', section: 'reading', title: 'Reading', modules: [{ id: 'reading-m1', title: 'Reading · Module 1', sourceNumber: 1, taskIds: ['reading-m1-g2', 'reading-m1-g3'] }] },
  { id: 'writing', section: 'writing', title: 'Writing', modules: [{ id: 'writing-main', title: 'Writing', sourceNumber: null, taskIds: ['writing-g2'] }] },
] }] }, new Map());
assert.deepEqual(pack.issues.filter(issue => issue.severity === 'error'), []);
const initial = emptyState();
initial.libraries.push({ libraryId, importedAt: '2026-09-10T18:00:00Z', originalPack: pack.pack, mediaMap: {}, contentHash: contentHash(pack.pack, new Map()) });
initial.sessions = ids.map((id, i) => {
  const group = taskGroups[i === 1 ? 1 : 0];
  return { id, libraryId, groupId: group.id, mode: 'practice', currentIndex: 0, answers: { [group.questions[0].id]: { answer: '', recordingId: null, recordingUrl: null, transcript: '', transcriptConfirmed: false, submissionId: '', attemptId: null } }, remainingSeconds: 0, assisted: false, startedAt: `2026-09-10T18:06:${10 + i * 10}Z`, updatedAt: `2026-09-10T18:06:${11 + i * 10}Z` };
});
await fs.writeFile(file, JSON.stringify(initial, null, 2));
const legacyBefore = canonicalJSON(initial.sessions);
let instance, browser, page, currentCase;
try {
  instance = await startServer({ dataDir, models: { publicSettings: () => ({ provider: 'none', capabilities: {} }), feedback: () => { report.realModelCalls++; throw new Error('Models are forbidden in this test'); } } });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await appFetch(instance.url + '/api' + route, { method, headers: { 'Content-Type': 'application/json', 'X-PracticeBridge': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, 200, `${route}: ${JSON.stringify(result)}`); return result;
  };
  const snapshot = () => api('/state');
  browser = await chromium.launch({ channel: process.env.PRACTICEBRIDGE_BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1180, height: 850 } });
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== instance.url) { report.externalRequests.push(url.href); return route.abort(); } return route.continue(); });
  page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => report.pageErrors.push(error.message));
  const dashboard = async () => { await page.goto(instance.url + '/#dashboard'); await page.locator('#dashboard-resume').waitFor(); };
  const screenshot = async (name, target = page) => { await target.evaluate(() => window.scrollTo(0, 0)); await target.screenshot({ path: path.join(output, name), fullPage: true }); };
  const expand = async root => { for (const detail of await root.locator('details').all()) if (await detail.getAttribute('open') === null) await detail.locator(':scope > summary').click(); };
  currentCase = 'three synthetic regression IDs on the dashboard';
  const initialBytes = await fs.readFile(file);
  await dashboard();
  assert.equal(await page.locator('#dashboard-resume > [data-resume-group]').count(), 2);
  assert.equal(await page.locator(`#dashboard-resume > [data-resume-group="${ids[0]}"]`).count(), 0);
  const notice = page.locator(`[data-resume-group="${ids[2]}"]`), post = page.locator(`[data-resume-group="${ids[1]}"]`);
  assert.match(await notice.locator(':scope > .activity').innerText(), /阅读 · 模块 1 · Read a notice\./);
  assert.match(await notice.locator(':scope > .activity').innerText(), /任务内第 1 \/ 2 题（原题号 11）/);
  assert.match(await post.innerText(), /Read a social media post\./); assert.match(await post.innerText(), /原题号 13/);
  await notice.locator('[data-resume-history] > summary').click();
  assert.equal(await page.locator(`[data-resume-session="${ids[0]}"] > a`).getAttribute('href'), `#practice/${libraryId}/reading-m1-g2/practice/${ids[0]}`);
  assert.deepEqual(await fs.readFile(file), initialBytes);
  await screenshot('01-distinct-tasks-and-old-entry.png');
  pass('The three synthetic regression IDs render as two labelled tasks; the older empty g2 entry remains expandable and viewing them changes no stored bytes');

  currentCase = 'all reported legacy links resume the exact selected task';
  const projections = [];
  for (const [id, questionId] of [[ids[2], 'reading-m1-q11'], [ids[1], 'reading-m1-q13'], [ids[0], 'reading-m1-q11']]) {
    await dashboard(); await expand(page.locator('#dashboard-resume'));
    await page.locator(`[data-resume-session="${id}"] > a`).click();
    await page.waitForFunction(qid => document.querySelector('.exam-shell')?.dataset.questionId === qid, questionId);
    const runId = await page.locator('.exam-shell').getAttribute('data-session-id');
    const run = (await snapshot()).sessions.find(session => session.id === runId);
    assert.equal(run.legacySessionId, id); assert.equal(run.cursor.questionId, questionId); projections.push(runId);
    const count = (await snapshot()).sessions.length;
    await page.reload(); await page.waitForFunction(id => document.querySelector('.exam-shell')?.dataset.sessionId === id, runId); assert.equal(await page.locator('.exam-shell').getAttribute('data-session-id'), runId);
    assert.equal((await snapshot()).sessions.length, count);
    await page.locator('#exam-exit').click(); await page.locator('.exam-library-table').waitFor();
  }
  assert.equal(canonicalJSON((await snapshot()).sessions.filter(session => ids.includes(session.id))), legacyBefore);
  pass('Each of the three original links resumes its own task; reload keeps the canonical run and every original legacy record remains unchanged');

  currentCase = 'separate drafts and more than three scopes stay reachable';
  const drafts = [];
  for (const answer of ['A', 'B']) {
    const { session } = await api('/sessions', { libraryId, groupId: 'reading-m1-g2', mode: 'practice', answers: { 'reading-m1-q11': { answer } } }); drafts.push(session);
  }
  const whole = (await api('/sessions', { sessionVersion: 2, libraryId, setId: 'resume-set', sectionId: 'reading', mode: 'practice' })).session;
  const writing = (await api('/sessions', { sessionVersion: 2, libraryId, setId: 'resume-set', sectionId: 'writing', mode: 'practice' })).session;
  await api('/sessions', { libraryId, groupId: 'reading-m1-g3', mode: 'exam' });
  await dashboard();
  const latestDraft = page.locator(`[data-resume-group="${drafts[1].id}"]`);
  assert.match(await latestDraft.locator(':scope > .activity').innerText(), /第 2 轮/);
  await latestDraft.locator('[data-resume-rounds] > summary').click();
  assert.match(await latestDraft.locator('[data-resume-rounds]').innerText(), /第 1 轮独立草稿/);
  assert.equal(await latestDraft.locator(`[data-resume-session="${drafts[0].id}"] > a`).count(), 1);
  await page.locator('#resume-more > summary').click();
  assert.equal(await page.locator(`#resume-more > [data-resume-group="${ids[1]}"]`).count(), 0); // old source is under its migrated task, not an extra task
  await expand(page.locator('#dashboard-resume'));
  const displayed = new Set(await page.locator('#dashboard-resume [data-resume-session]').evaluateAll(rows => rows.map(row => row.dataset.resumeSession)));
  for (const id of [whole.id, writing.id, ...drafts.map(session => session.id), ...ids]) assert.ok(displayed.has(id), `Missing reachable session ${id}`);
  const wideOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); assert.equal(wideOverflow, false);
  await screenshot('02-independent-rounds-and-all-scopes.png');
  pass('Two different drafts have explicit round labels; all additional scopes and old entries remain reachable without horizontal overflow');

  currentCase = 'library section buttons exclude single-task sessions';
  await page.goto(instance.url + `/#collection/${libraryId}`); await page.locator('.exam-library-table').waitFor();
  assert.equal(await page.locator('[data-start-section="reading"]').getAttribute('data-session-id'), whole.id);
  assert.equal(await page.locator('[data-start-section="writing"]').getAttribute('data-session-id'), writing.id);
  await page.locator('#exam-task-details > summary').click();
  assert.equal(await page.locator(`#exam-task-list [data-resume-session="${drafts[1].id}"] > a`).count(), 1);
  await page.locator('[data-start-section="reading"]').click(); await page.locator('.exam-shell').waitFor();
  assert.equal(await page.locator('.exam-shell').getAttribute('data-session-id'), whole.id);
  await page.locator('#exam-exit').click(); await page.locator('.exam-library-table').waitFor();
  pass('The Reading table button resumes the complete section while individual-task drafts remain in the labelled task history');

  currentCase = 'narrow dashboard layout';
  await dashboard(); await page.setViewportSize({ width: 760, height: 900 }); await page.locator('#resume-more > summary').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await screenshot('03-narrow-dashboard.png');
  pass('The revised dashboard remains readable at a narrow desktop viewport');

  const liveIndex = process.argv.indexOf('--live-state');
  if (liveIndex >= 0) {
    currentCase = 'read-only display of the supplied snapshot';
    const liveFile = path.resolve(process.argv[liveIndex + 1]), bytes = await fs.readFile(liveFile), live = JSON.parse(bytes);
    const libraries = live.libraries.map(item => { const runtime = runtimeLibrary(item); return { ...runtime, examPlan: buildExamPlan(runtime) }; });
    const liveState = { libraries, sessions: live.sessions, attempts: live.attempts, materials: [], jobs: [], settings: { provider: 'none', capabilities: {} } };
    const liveContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1180, height: 850 } });
    const blockedWrites = [];
    await liveContext.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== instance.url) { if (['http:', 'https:'].includes(url.protocol)) report.externalRequests.push(url.href); return route.abort(); }
      if (url.pathname === '/api/state' && request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(liveState) });
      if (url.pathname.startsWith('/api/')) { blockedWrites.push({ method: request.method(), route: url.pathname }); return route.abort(); }
      return route.continue();
    });
    const livePage = await liveContext.newPage(); livePage.on('pageerror', error => report.pageErrors.push(error.message));
    await livePage.goto(instance.url + '/#dashboard'); await livePage.locator('#dashboard-resume').waitFor();
    const computed = resumableSessionGroups(live.sessions, libraries);
    const primary = await livePage.locator('#dashboard-resume > [data-resume-group]').evaluateAll(rows => rows.map(row => row.dataset.resumeGroup));
    assert.deepEqual(primary, computed.slice(0, 3).map(group => group.session.id));
    await screenshot('04-live-snapshot-primary-readonly.png', livePage);
    await expand(livePage.locator('#dashboard-resume'));
    // Discover the same two-notice/one-post regression shape from the explicitly
    // supplied snapshot rather than embedding any real user's record IDs.
    const noticeSources = live.sessions.filter(session => session.sessionVersion !== 2 && session.groupId === 'reading-m1-g2' && session.mode === 'practice').sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const snapshotLibraryId = noticeSources[0]?.libraryId;
    const sameLibraryNotices = noticeSources.filter(session => session.libraryId === snapshotLibraryId);
    const postSource = live.sessions.find(session => session.sessionVersion !== 2 && session.libraryId === snapshotLibraryId && session.groupId === 'reading-m1-g3' && session.mode === 'practice');
    assert.ok(sameLibraryNotices.length >= 2 && postSource, 'The supplied snapshot needs two notice entries and one post entry to check this regression');
    const snapshotIds = [sameLibraryNotices[0].id, postSource.id, sameLibraryNotices[1].id];
    for (const id of snapshotIds) assert.equal(await livePage.locator(`#dashboard-resume [data-resume-session="${id}"]`).count(), 1);
    const noticeGroup = computed.find(group => group.session.libraryId === snapshotLibraryId && (group.session.groupId === 'reading-m1-g2' || group.session.selection?.groupId === 'reading-m1-g2'));
    const postGroup = computed.find(group => group.session.libraryId === snapshotLibraryId && (group.session.groupId === 'reading-m1-g3' || group.session.selection?.groupId === 'reading-m1-g3'));
    assert.ok(noticeGroup && postGroup && noticeGroup !== postGroup);
    assert.match(await livePage.locator(`[data-resume-group="${noticeGroup.session.id}"] > .activity`).innerText(), /Read a notice\./);
    assert.match(await livePage.locator(`[data-resume-group="${postGroup.session.id}"] > .activity`).innerText(), /social media post/);
    assert.equal(await livePage.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await screenshot('05-live-snapshot-all-entries-readonly.png', livePage);
    report.liveSnapshot = { readUtc: new Date().toISOString(), readOnly: true, sessionCount: live.sessions.length, attemptCount: live.attempts.length, groups: computed.map(group => ({ selected: group.session.id, scope: describeResumeSession(group.session, group.library).scopeLabel, independentRuns: group.runs.length, olderEntries: group.history.length })), originalThreeIdsPresent: true, snapshotSha256: sha(bytes), sameBytesAtEnd: sha(await fs.readFile(liveFile)) === sha(bytes), blockedApiRequests: blockedWrites };
    assert.deepEqual(blockedWrites, []); await liveContext.close();
    pass('A read-only supplied snapshot shows recent saved progress first, distinct g2/g3 tasks and all three original links; no workspace API writes occur');
  }
  report.sourceAfter = await hashes(); assert.deepEqual(report.sourceAfter, report.sourceBefore);
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []); assert.equal(report.realModelCalls, 0);
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = { currentCase, message: error.message, stack: error.stack };
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1;
} finally {
  await browser?.close(); await instance?.close(); report.finishedUtc = new Date().toISOString();
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log('RESULT_DIR ' + output); if (!report.ok) console.error(report.failure);
}
