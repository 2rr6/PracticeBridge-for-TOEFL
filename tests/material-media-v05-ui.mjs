import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleBytes = await readFile(path.join(root, 'public', 'media-review.mjs'));
const html = `<!doctype html><html lang="zh-CN"><body><main id="root"></main><script type="module">
  import { mediaEvidenceLabel, renderMediaMappingSummary } from '/media-review.mjs';
  const items = [
    { targetLabel: 'Question 4', assetName: 'question-4.mp3', mappingBasis: 'filename', mappingState: 'applied', decodeState: 'playable', contentCheckState: 'notChecked' },
    { targetLabel: 'Question 3', assetName: null, mappingBasis: 'sequence', mappingState: 'proposed', decodeState: 'notChecked', contentCheckState: 'notChecked' },
    { targetLabel: '<img src=x onerror="window.__injected=true">', assetName: '<script>bad()<\\/script>', mappingBasis: 'user', mappingState: 'applied', decodeState: 'partial', contentCheckState: 'inconclusive' },
  ];
  document.querySelector('#root').innerHTML = renderMediaMappingSummary(items);
  window.__mediaReview = {
    labels: [
      mediaEvidenceLabel({ decodeState: 'playable', contentCheckState: 'notChecked' }),
      mediaEvidenceLabel({ decodeState: 'playable', contentCheckState: 'matched' }),
      mediaEvidenceLabel({ decodeState: 'partial', contentCheckState: 'inconclusive' }),
    ],
    ready: true,
  };
</script></body></html>`;

const server = http.createServer((request, response) => {
  if (request.url === '/media-review.mjs') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); response.end(moduleBytes); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.__mediaReview?.ready);
  assert.deepEqual(await page.evaluate(() => window.__mediaReview.labels), [
    '格式可播放 · 内容尚未核对', '格式可播放 · 内容已核对', '音频不完整 · 对应关系无法确认',
  ]);
  const text = await page.locator('#root').innerText();
  assert.match(text, /Question 4[\s\S]*文件名配对[\s\S]*内容尚未核对/);
  assert.match(text, /Question 3[\s\S]*尚未配对/);
  assert.equal(await page.locator('#root img, #root script').count(), 0, 'Rendered evidence values are escaped before entering the DOM');
  assert.equal(await page.evaluate(() => window.__injected === true), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, scope: 'standalone browser component', checks: ['decode and content states stay distinct in a real DOM', 'basis and missing mappings remain visible', 'untrusted labels are escaped'] }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
