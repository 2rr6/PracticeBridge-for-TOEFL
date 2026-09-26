import {appFetch} from './auth-client.mjs';
// Optional browser regression checks. Run explicitly with: node tests/ui-races.mjs
// Uses installed Edge by default; set PRACTICEBRIDGE_BROWSER_CHANNEL for another Playwright channel.
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/.core-tests');
await fs.mkdir(testRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(testRoot, 'ui-races-'));
let instance;
let browser;
const pendingReleases = new Set();
try {
  instance = await startServer({ dataDir });
  const pack = {
    schemaVersion: 1, id: 'ui-ownership-fixture', version: '1', title: 'UI ownership audit', rights: 'Original synthetic automated-test fixture.',
    groups: [{ id: 'group', section: 'reading', title: 'UI ownership audit group', passage: 'One is A. Two is B.', questions: [
      { id: 'q1', type: 'single_choice', prompt: 'First audit question', options: [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }], answer: 'A' },
      { id: 'q2', type: 'single_choice', prompt: 'Second audit question', options: [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }], answer: 'B' },
    ] }],
  };
  const api = async (route, body) => {
    const response = await appFetch(instance.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PracticeBridge': '1' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const preview = await api('/api/import/preview', { files: [{ name: 'practicebridge.json', data: Buffer.from(JSON.stringify(pack)).toString('base64') }] });
  const { library } = await api('/api/import/commit', { draftId: preview.draftId, pack: preview.pack, acknowledged: true });
  browser = await chromium.launch({ channel: process.env.PRACTICEBRIDGE_BROWSER_CHANNEL || 'msedge', headless: true });
  const errors = [];
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const practiceHash = `#practice/${library.libraryId}/group/practice`;
  await page.goto(instance.url + '/' + practiceHash);
  await page.locator('#submit-answer').waitFor();
  let releaseSubmit;
  let notifySubmitWaiting;
  const submitWaiting = new Promise(resolve => { notifySubmitWaiting = resolve; });
  await page.route('**/api/attempts', async route => {
    const response = await route.fetch();
    notifySubmitWaiting();
    await new Promise(resolve => { releaseSubmit = resolve; pendingReleases.add(resolve); });
    pendingReleases.delete(releaseSubmit);
    await route.fulfill({ response });
  });
  await page.locator('input[value="A"]').check();
  await page.locator('#submit-answer').click();
  await submitWaiting;
  await page.locator('a[data-nav="dashboard"]').click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => location.hash), practiceHash, 'Navigation stays on the saving practice until the submission is durable and acknowledged');
  releaseSubmit();
  await page.locator('#new-attempt').waitFor();
  await page.locator('a[data-nav="dashboard"]').click();
  await page.locator('.hero').waitFor();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => location.hash), '#dashboard');
  assert.equal(await page.locator('#submit-answer,#new-attempt').count(), 0, 'A late submission must not overwrite the newly selected page');
  console.log('PASS: delayed submission cannot overwrite a different page.');
  await page.close();

  const next = await browser.newPage();
  next.on('pageerror', error => errors.push(error.message));
  await next.goto(instance.url + '/' + practiceHash);
  await next.locator('#submit-answer').waitFor();
  let releaseState;
  let notifyStateWaiting;
  let delayOneState = true;
  const stateWaiting = new Promise(resolve => { notifyStateWaiting = resolve; });
  await next.route('**/api/state', async route => {
    if (!delayOneState) return route.continue();
    delayOneState = false;
    const response = await route.fetch();
    notifyStateWaiting();
    await new Promise(resolve => { releaseState = resolve; pendingReleases.add(resolve); });
    pendingReleases.delete(releaseState);
    await route.fulfill({ response });
  });
  await next.locator('input[value="A"]').check();
  await next.locator('#submit-answer').click();
  await stateWaiting;
  await next.locator('#next-question').click();
  await next.locator('.question-text').filter({ hasText: 'Second audit question' }).waitFor();
  releaseState();
  await next.waitForTimeout(150);
  assert.equal(await next.locator('#submission-result').innerText(), '', 'Previous correctness and reference answers must not attach to the next question');
  assert.deepEqual(errors, []);
  console.log('PASS: delayed old correctness stays bound to its original question.');
  await next.close();

  const initialPack = structuredClone(pack);
  initialPack.id = 'initial-save-fixture';
  initialPack.groups[0].questions = [{ ...initialPack.groups[0].questions[0], timeLimitSeconds: 1 }];
  const initialPreview = await api('/api/import/preview', { files: [{ name: 'practicebridge.json', data: Buffer.from(JSON.stringify(initialPack)).toString('base64') }] });
  const { library: initialLibrary } = await api('/api/import/commit', { draftId: initialPreview.draftId, pack: initialPreview.pack, acknowledged: true });
  const beforeInitial = await (await appFetch(`${instance.url}/api/state`)).json();
  const initial = await browser.newPage();
  initial.on('pageerror', error => errors.push(error.message));
  let releaseInitial;
  let notifyInitialWaiting;
  let delayInitial = true;
  const initialWaiting = new Promise(resolve => { notifyInitialWaiting = resolve; });
  await initial.route('**/api/sessions', async route => {
    if (!delayInitial) return route.continue();
    delayInitial = false;
    const response = await route.fetch();
    notifyInitialWaiting();
    await new Promise(resolve => { releaseInitial = resolve; pendingReleases.add(resolve); });
    pendingReleases.delete(releaseInitial);
    await route.fulfill({ response });
  });
  await initial.goto(`${instance.url}/#practice/${initialLibrary.libraryId}/group/practice`, { waitUntil: 'domcontentloaded' });
  await initialWaiting;
  await initial.locator('a[data-nav="dashboard"]').click();
  // Navigation may legitimately wait for the pending initial and closing saves.
  // The timer must already be paused while that durable save is pending.
  await initial.waitForTimeout(1200);
  const duringInitial = await (await appFetch(`${instance.url}/api/state`)).json();
  assert.equal(duringInitial.attempts.length, beforeInitial.attempts.length, 'A timer must not submit while leaving a practice and waiting for its first save');
  releaseInitial();
  await initial.locator('.hero').waitFor();
  await initial.waitForTimeout(1500);
  const afterInitial = await (await appFetch(`${instance.url}/api/state`)).json();
  assert.equal(await initial.evaluate(() => location.hash), '#dashboard');
  assert.equal(await initial.locator('.hero').count(), 1, 'An obsolete controller must not overwrite the dashboard after initial save');
  assert.equal(afterInitial.attempts.length, beforeInitial.attempts.length, 'An obsolete one-second timer must not submit an unanswered attempt');
  assert.deepEqual(errors, []);
  console.log('PASS: delayed initial save disposes stale controller and timer without an unintended submission.');
  await initial.close();
} finally {
  for (const release of pendingReleases) release();
  if (browser) await browser.close();
  if (instance) await instance.close();
  const checked = path.resolve(dataDir);
  if (!checked.startsWith(`${testRoot}${path.sep}`)) throw new Error('Unexpected test cleanup path');
  await fs.rm(checked, { recursive: true, force: true });
}
