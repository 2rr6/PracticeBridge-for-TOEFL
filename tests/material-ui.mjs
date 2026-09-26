import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const run = resolve('test-results', `materials-ui-${Date.now()}`);
await mkdir(run, { recursive: true });
const checks = [], errors = [], calls = [];
const worksheet = 'Reading: Original garden fixture\nPassage:\nThe gate opens at nine.\nQuestions:\n1. When does the gate open?\nA. Nine.\nB. Ten.\nAnswer key: 1 A';
let instance, browser, assessmentRelease, saveRelease;
let delayAssessment = false;
const models = {
  publicSettings: () => ({ provider: 'compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'local-ui-fixture', hasApiKey: false, capabilities: { assessMaterials: true, structure: true }, status: 'configured' }),
  assessMaterials: async input => {
    calls.push(input);
    if (delayAssessment) await new Promise(resolve => { assessmentRelease = resolve; });
    return { status: input.sources.length ? 'processable' : 'needs_information', summary: 'Local protocol fixture assessment.', detectedSections: [], missingInformation: [], warnings: [], recommendedProcessor: input.availableProcessors.find(p => p !== 'ai') || 'ai', canCreateDraft: input.sources.length > 0, provider: 'fixture', model: 'local-ui-fixture' };
  },
  structure: async () => { throw Object.assign(new Error('模拟整理失败；原件应保留。'), { status: 502 }); },
};
const pass = name => { checks.push(name); console.log('PASS ' + name); };
try {
  instance = await startServer({ dataDir: resolve(run, 'data'), models });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  const state = () => fetch(instance.url + '/api/state').then(r => r.json());
  const material = id => fetch(instance.url + '/api/materials/' + id).then(r => r.json()).then(r => r.material);
  async function until(predicate) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await page.waitForTimeout(50); } throw Error('Material state timed out'); }
  async function receive(name, buffer) {
    await page.goto(instance.url + '/#import');
    await page.locator('#import-files').setInputFiles({ name, buffer: Buffer.from(buffer), mimeType: 'application/octet-stream' });
    await page.locator('#save-material').click(); await page.locator('#material-detail').waitFor();
    return page.locator('#material-detail').getAttribute('data-material-id');
  }
  async function processAI() { await page.locator('#material-ai-consent input[name=consent]').check(); await page.locator('#process-material-ai').click(); }
  const bad = await receive('unknown.zip', 'Not an archive');
  assert.equal(calls.length, 0); assert.equal((await state()).libraries.length, 0);
  await page.reload(); await page.locator('#material-detail').waitFor();
  assert.equal(await page.locator('#material-detail').getAttribute('data-material-id'), bad);
  await page.screenshot({ path: resolve(run, '01-received.png'), fullPage: true });
  pass('arbitrary original is received before AI, persists through reload, and remains outside the practice library');
  await processAI(); await until(async () => (await material(bad)).status === 'needs_information');
  await page.locator('#material-status').getByText('需要补充材料', { exact: true }).waitFor();
  assert.equal((await material(bad)).files.length, 1); assert.equal(await page.locator('#commit-import').count(), 0);
  await page.screenshot({ path: resolve(run, '02-needs-information.png'), fullPage: true });
  pass('unreadable archive receives an assessment and retains originals without a manifest gate or invented draft');
  const usable = await receive('original-worksheet.txt', worksheet);
  delayAssessment = true;
  await processAI(); await until(() => Boolean(assessmentRelease));
  await page.locator('a[data-nav=dashboard]').click(); await page.locator('.hero').waitFor();
  delayAssessment = false; assessmentRelease(); assessmentRelease = null;
  await until(async () => (await material(usable)).status === 'draft_ready');
  assert.equal(await page.locator('.hero').count(), 1); assert.equal((await state()).libraries.length, 0);
  await page.goto(instance.url + '/#materials'); await page.locator('#materials-list').waitFor();
  await page.locator('#materials-search').fill('original-worksheet');
  assert.equal(await page.locator('#materials-list [data-material-id]').count(), 1);
  await page.goto(instance.url + '/#import/' + usable); await page.locator('#candidate-author').waitFor();
  await page.screenshot({ path: resolve(run, '03-saved-draft.png'), fullPage: true });
  pass('AI assessment continues into real local conversion after navigation, and its saved draft reopens from the material library');
  await page.locator('#candidate-author').check();
  const text='Unsent old-page edit';await page.locator('textarea[name=prompt]').first().fill(text);
  const review=await fetch(`${instance.url}/api/materials/${usable}/candidates?author=1`).then(r=>r.json()),candidate=review.candidates[0];
  let held;
  const arrived = new Promise(resolve => { held = resolve; });
  await page.route('**/api/materials/*/candidates/*/patch', async route => { held(); await new Promise(resolve => { saveRelease = resolve; }); await route.continue(); });
  await page.getByRole('button',{name:'保存字段校对'}).first().click(); await arrived;
  const otherSave=await appFetch(`${instance.url}/api/materials/${usable}/candidates/${candidate.candidateId}/patch`,{method:'POST',headers:{'Content-Type':'application/json','X-PracticeBridge':'1'},body:JSON.stringify({fields:{prompt:'Newer persisted edit'},expectedRevision:candidate.revision,expectedEpoch:review.expectedEpoch})});assert.equal(otherSave.status,200);
  saveRelease(); saveRelease = null;
  await until(() => page.getByRole('button',{name:'保存字段校对'}).first().isEnabled());
  assert.equal(await page.locator('textarea[name=prompt]').first().inputValue(),text);
  assert.match(await page.locator('[data-candidate-error]').first().textContent(),/更新|冲突/);
  assert.equal((await fetch(`${instance.url}/api/materials/${usable}/candidates?author=1`).then(r=>r.json())).candidates[0].fields.prompt,'Newer persisted edit');
  pass('a delayed candidate save loses to the newer persisted revision while the old page keeps its unsaved text');
  await page.goto(instance.url + '/#materials'); await page.locator('#materials-list').waitFor();
  await page.goto(instance.url + '/#import/' + usable); await page.locator('#compile-candidates').click();
  await page.locator('#candidate-result .success').waitFor();
  assert.equal((await state()).libraries.length, 1); assert.equal((await material(usable)).status, 'imported');
  const failing = await receive('notes.txt', 'Original unstructured material without a supported numbered question.');
  await processAI(); await until(async () => (await material(failing)).status === 'failed');
  await page.locator('#material-saved-error').waitFor();
  assert.equal(await page.locator('#process-material-ai').isEnabled(), true); assert.equal((await material(failing)).files.length, 1);
  await page.screenshot({ path: resolve(run, '04-retry.png'), fullPage: true });
  pass('conversion failure retains original files, displays the reason and leaves retry available');
  await page.setViewportSize({ width: 430, height: 930 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await writeFile(resolve(run, 'result.json'), JSON.stringify({ ok: true, checks, errors, model: 'injected local protocol fixtures only' }, null, 2));
  console.log('RESULT_DIR ' + run);
} catch (error) { await writeFile(resolve(run, 'failure.txt'), error.stack); throw error; }
finally { assessmentRelease?.(); saveRelease?.(); await browser?.close(); await instance?.close(); }
import {appFetch} from './auth-client.mjs';
