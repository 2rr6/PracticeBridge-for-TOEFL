import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';

// Real settings page/server, deliberately absent model. No inference is requested.
const directory = path.resolve('test-results/asr/fix1-ui', crypto.randomUUID());
await fs.mkdir(directory, { recursive: true });
const runtime = await startServer({ dataDir: directory });
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
  const errors = [], checks = [];
  let inferenceRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/api/asr/test')) inferenceRequests++; });
  page.on('pageerror', error => errors.push(error.message));
  const check = (name, pass) => checks.push({ name, pass });
  await page.goto(runtime.url + '/#settings');
  const form = page.locator('[data-asr-form]'); await form.waitFor({ state: 'attached' });
  if (!await page.locator('#asr-fold').evaluate(details => details.open)) await page.locator('#asr-fold > summary').click();
  await form.waitFor();
  const testButton = form.locator('[data-asr-test]'), saveButton = form.locator('[type=submit]');
  const modelA = path.join(directory, 'model-A-not-installed');
  const modelB = path.join(directory, 'model-B-not-installed');
  const modelC = path.join(directory, 'model-C-not-installed');
  await form.locator('[name=interpreter]').fill(process.execPath.replaceAll('\\', '/'));
  await form.locator('[name=modelDirectory]').fill(modelA);
  await form.locator('[name=confirmed]').check();
  await saveButton.click();
  await page.waitForFunction(() => document.querySelector('[data-asr-status]')?.dataset.state === 'configured');
  check('saved confirmed form can selftest', !await testButton.isDisabled());
  check('unchanged submitted paths adopt server normalization', await form.locator('[name=interpreter]').inputValue() === process.execPath);
  await form.locator('[name=interpreter]').fill(process.execPath);
  await form.locator('[name=device]').selectOption('cuda');
  check('unsaved device disables selftest', await testButton.isDisabled());
  check('unsaved explanation visible', (await form.innerText()).includes('未保存'));
  await form.locator('[name=device]').selectOption('cpu');
  check('restoring saved values enables selftest', !await testButton.isDisabled());

  let release, signalReceived;
  const waiting = new Promise(resolve => { signalReceived = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/asr/configure', async route => {
    const response = await route.fetch();
    signalReceived(); await held;
    await route.fulfill({ response });
  }, { times: 1 });
  await form.locator('[name=modelDirectory]').fill(modelB);
  await saveButton.click(); await waiting;
  check('pending save disables selftest', await testButton.isDisabled());
  check('pending save blocks duplicate submission', await saveButton.isDisabled());
  await form.locator('[name=modelDirectory]').fill(modelC);
  const response = page.waitForResponse(url => url.url().endsWith('/api/asr/configure'));
  release(); await response;
  // Wait for the browser to finish applying its async save response.
  await page.waitForFunction(() => !document.querySelector('[data-asr-form] [type=submit]').disabled);
  check('new edit survives slow save completion', await form.locator('[name=modelDirectory]').inputValue() === modelC);
  check('new edit remains dirty after slow save', await testButton.isDisabled());
  const savedText = await page.locator('[data-asr-saved]').count() ? await page.locator('[data-asr-saved]').innerText() : '';
  check('saved target identifies B, not unsaved C', savedText.includes(modelB) && !savedText.includes(modelC));
  await form.locator('..').screenshot({ path: path.join(directory, 'slow-save-new-edit.png') });
  const finalSaved = page.waitForResponse(url => url.url().endsWith('/api/asr/configure'));
  await saveButton.click(); await finalSaved;
  await page.waitForFunction(() => !document.querySelector('[data-asr-form] [data-asr-test]').disabled);
  check('final save identifies C', (await page.locator('[data-asr-saved]').count() ? await page.locator('[data-asr-saved]').innerText() : '').includes(modelC));
  await form.locator('[data-asr-disable]').click();
  await page.waitForFunction(() => document.querySelector('[data-asr-status]')?.dataset.state === 'disabled');
  check('disabled configuration cannot selftest', await testButton.isDisabled());
  check('no page errors', errors.length === 0);
  check('no inference requested', inferenceRequests === 0);
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ checks, errors, inferenceRequests }, null, 2));
  console.log(JSON.stringify({ directory, checks, errors }));
  assert(checks.every(item => item.pass), 'ASR settings dirty-state checks failed');
  console.log('PASS ASR unsaved configuration, delayed saves and explicit test admission');console.log('RESULT_DIR '+directory);
} finally { await browser?.close(); await runtime.close(); }
