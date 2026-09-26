import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ocrEvidenceToChunk } from '../src/ocr-layout.mjs';
import { extractMaterialSources, buildDraftFromSources, applyScannedPages, markScannedQuestions } from '../src/importer.mjs';
import { createScanOcr } from '../src/scan-ocr.mjs';
import { createStore } from '../src/store.mjs';
import { createMaterialInbox } from '../src/materials.mjs';
import { createMaterialProcessing } from '../src/material-processing.mjs';
import { createCandidateRepository } from '../src/material-candidates.mjs';
import { authoredOcrPdf } from './helpers/ocr-fixture.mjs';

// Self-authored OCR evidence: one Tesseract line per entry, words laid out left
// to right on a 1200 x 1600 pixel page (a 600 x 800 point page at 2x).
function evidence(lines, { low = [], width = 1200, height = 1600 } = {}) {
  const words = [];
  lines.forEach((line, index) => {
    let x = 40;
    for (const text of line.split(' ')) {
      words.push({ text, confidence: low.includes(text) ? 40 : 93, bbox: { x0: x, y0: 40 + index * 40, x1: x + text.length * 14, y1: 66 + index * 40 }, line: index });
      x += text.length * 14 + 12;
    }
  });
  return { version: 1, kind: 'ocr-evidence', state: 'needs_review', text: lines.join('\n'), words, confidence: 90, source: { pageDimensions: { width, height }, pixelRect: { x: 0, y: 0, width, height } }, recognitionMode: 'auto' };
}
const text = lines => ocrEvidenceToChunk(evidence(lines), { name: 'scan.pdf', page: 1, pagePoints: { width: 600, height: 800 } }).text.split('\n');

test('OCR lines become a positioned PDF-style chunk in point units', () => {
  const chunk = ocrEvidenceToChunk(evidence(['Read a notice.', 'Library   hours']), { name: 'scan.pdf', page: 3, pagePoints: { width: 600, height: 800 } });
  assert.equal(chunk.kind, 'pdf'); assert.equal(chunk.page, 3);
  assert.deepEqual(chunk.text.split('\n'), ['Read a notice.', 'Library hours']);
  assert.deepEqual(chunk.layout.transform, [1, 0, 0, -1, 0, 800]);
  const first = chunk.layout.items[0];
  assert.equal(first.x, 20); assert.equal(first.line, 1); assert.ok(Math.abs(first.y - (800 - 33)) < 0.01);
  assert.ok(chunk.layout.items.every(item => item.fontName === 'ocr'));
});

test('exam labels, option letters and task directions are restored only in their printed form', () => {
  assert.deepEqual(text(['Question7', 'Fillin the missing letters in the paragraph.', 'B.notches']), ['Question 7', 'Fill in the missing letters in the paragraph.', 'B. notches']);
  // "A reversible" is an option only next to other lettered options.
  assert.deepEqual(text(['A. carefully', 'A reversible', 'C. reverence']), ['A. carefully', 'A. reversible', 'C. reverence']);
  assert.deepEqual(text(['A reversible process was used.']), ['A reversible process was used.']);
  // Bracketed labels follow the page's own style.
  assert.deepEqual(text(['(A) Oh, that is early.', 'B) How about tomorrow?', '(C) She arrived.']), ['(A) Oh, that is early.', '(B) How about tomorrow?', '(C) She arrived.']);
  // An item number glued to its word count, and a count glued to "words".
  assert.deepEqual(text(['3.6 words', 'Turn in your slip early.', '6words']), ['3. 6 words', 'Turn in your slip early.', '6 words']);
  assert.deepEqual(text(['It rose 3.6 percent.']), ['It rose 3.6 percent.']);
  // A lost question number comes from its neighbours.
  assert.deepEqual(text(['Question', 'Where is it?', 'Question 2', 'Why?']), ['Question 1', 'Where is it?', 'Question 2', 'Why?']);
});

test('blank runs keep their underscore or hyphen count and end where letters resume', () => {
  assert.deepEqual(text(['protect care ___ _ objects']), ['protect care____ objects']);
  assert.deepEqual(text(['clear fr__therec_ __thatdan____was important']), ['clear fr__ therec___ thatdan____ was important']);
  assert.deepEqual(text(['several reg—--, each wi-- specific']), ['several reg----, each wi-- specific']);
  assert.deepEqual(text(['How___ _,iti_ clear']), ['How____, iti_ clear']);
});

test('answer-key rows are repaired from their table context, never elsewhere', () => {
  assert.deepEqual(text(['Listening Section, Module 1', 'Answer Key', 'uestion', '9 C', '10 B', 'ill D', '12 Cc', '13 0', '14 8', '15 A i', '[BH H | po |']),
    ['Listening Section, Module 1', 'Answer Key', '9 C', '10 B', '11 D', '12 C', '13 [?]', '14 B', '15 A']);
  assert.deepEqual(text(['ANSWER KEY AND EXPLANATIONS', '1.D', 'The notes fit.', '2.0', 'Deteriorate fits.', '3.B', 'Question 1', 'A']), ['ANSWER KEY AND EXPLANATIONS', '1. D', 'The notes fit.', '2. [?]', 'Deteriorate fits.', '3. B', 'Question 1', 'A']);
  // An ambiguous shape ("0" was a C or a D in scans) is kept only after an AI
  // proofreading pass has checked the page image.
  const proofread = { ...evidence(['Answer Key', '1 C', '2 0', '3 a', '4 B']), proofread: true };
  assert.deepEqual(ocrEvidenceToChunk(proofread, { name: 'scan.pdf', page: 1, pagePoints: { width: 600, height: 800 } }).text.split('\n'), ['Answer Key', '1 C', '2 D', '3 A', '4 B']);
  assert.deepEqual(text(['Answer Key', '1 C', '2 0', '3 a', '4 B']), ['Answer Key', '1 C', '2 [?]', '3 [?]', '4 B']);
  // Outside an answer key, digits in body text are untouched.
  assert.deepEqual(text(['The shop sold 8 boxes and 0 crates.', 'Question 2 asks about 8 items.']), ['The shop sold 8 boxes and 0 crates.', 'Question 2 asks about 8 items.']);
  assert.deepEqual(text(['What time does it start2', 'The score was 42']), ['What time does it start?', 'The score was 42']);
});

test('scanned pages replace empty PDF pages, lose stale warnings and mark their questions', async () => {
  const part = await extractMaterialSources({ files: [{ name: 'scan.pdf', data: authoredOcrPdf('scan').toString('base64') }], title: 'Scan' });
  assert.ok(part.issues.some(item => /没有可提取的文字/.test(item.message)));
  const lines = ['Reading', 'Tide Pools', 'Science · 20 words', 'Small fish shelter in tide pools.', 'Question1', 'Where do small fish shelter?', 'A. In tide pools', 'B.In caves', 'ANSWER KEY', 'Question 1', 'A'];
  const pages = applyScannedPages(part, 'scan.pdf', new Map([[1, evidence(lines, { low: ['caves'] })]]));
  assert.deepEqual(pages, [1]);
  assert.ok(!part.issues.some(item => /没有可提取的文字|未执行 OCR|页未提取到文字/.test(item.message)));
  const note = part.issues.find(item => /扫描页/.test(item.message));
  assert.match(note.message, /第 1 页是扫描页/); assert.match(note.message, /“caves”/);
  assert.match(part.sources.find(source => source.name === 'scan.pdf').text, /Where do small fish shelter\?/);
  const draft = await buildDraftFromSources(part, { title: 'Scan' });
  markScannedQuestions(draft.pack, 'scan.pdf', pages);
  const [question] = draft.pack.groups.flatMap(group => group.questions);
  assert.equal(question.answer, 'A');
  assert.match(question.source, /扫描识别，请对照原件核对/);
});

test('scan OCR reads pages in batches, caches them and reports failed pages', async t => {
  const root = path.resolve('test-results/scan-ocr'); await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'run-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const service = { assetDir: path.join(dir, 'optional'), artifactDir: path.join(dir, 'artifacts'), status: async () => ({ enabled: true }) };
  await fs.mkdir(service.artifactDir, { recursive: true });
  const calls = [];
  const workerFactory = ({ artifactDir, resolveAsset }) => ({
    async runMaterialTool(request) {
      calls.push(request.parameters.pages.map(page => page.page));
      const asset = await resolveAsset(request.inputAssetIds[0]);
      assert.equal((await fs.readFile(asset.path)).length, asset.size);
      const evidenceRows = [];
      for (const { page } of request.parameters.pages) {
        if (page === 3) { evidenceRows.push({ page, state: 'empty', ref: null }); continue; }
        const bytes = Buffer.from(JSON.stringify({ kind: 'ocr-evidence', page }));
        const ref = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
        await fs.writeFile(path.join(artifactDir, ref), bytes);
        evidenceRows.push({ page, state: 'needs_review', ref });
      }
      return { evidence: evidenceRows };
    },
  });
  const scan = createScanOcr({ ocrService: service, workerFactory, batchPages: 2 });
  const progress = [];
  const first = await scan.recognizePdf({ bytes: Buffer.from('%PDF-1.4 scanned'), pages: [1, 2, 3, 4, 5], onProgress: value => progress.push(value) });
  assert.deepEqual(calls, [[1, 2], [3, 4], [5]]);
  assert.deepEqual([...first.results.keys()], [1, 2, 4, 5]); assert.deepEqual(first.failed, [3]);
  assert.deepEqual(progress.at(-1), { done: 5, total: 5 });
  calls.length = 0;
  const second = await scan.recognizePdf({ bytes: Buffer.from('%PDF-1.4 scanned'), pages: [1, 2, 3] });
  assert.deepEqual(calls, [[3]], 'recognised pages are read from the cache');
  assert.equal(second.results.get(2).page, 2);
  service.status = async () => ({ enabled: false });
  assert.equal(await scan.enabled(), false);
});

async function processingFixture(t, scanOcr) {
  const root = path.resolve('test-results/scan-ocr'); await fs.mkdir(root, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(root, 'processing-'));
  t.after(async () => { await store.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const store = await createStore({ dataDir });
  const inbox = createMaterialInbox({ store }), repository = createCandidateRepository({ store });
  const material = await inbox.receive({ title: 'Scanned worksheet', files: [{ name: 'scan.pdf', data: authoredOcrPdf('scan').toString('base64') }] });
  const processing = createMaterialProcessing({ inbox, models: {}, registerDraft: () => {}, candidateRepository: repository, getWorkspaceEpoch: () => store.captureEpoch(), scanOcr });
  return { processing, material };
}

test('local processing reads scanned pages through OCR and shows progress while it runs', async t => {
  let seen = null, fixture;
  const scanOcr = {
    enabled: async () => true,
    recognizePdf: async ({ pages, onProgress }) => {
      onProgress({ done: 0, total: pages.length });
      seen = fixture.processing.progress(fixture.material.id);
      onProgress({ done: pages.length, total: pages.length });
      return { results: new Map([[1, evidence(['Reading', 'Tide Pools', 'Small fish shelter in tide pools.', 'Question 1', 'Where do small fish shelter?', 'A. In tide pools', 'B. In caves', 'ANSWER KEY', 'Question 1', 'A'])]]), failed: [] };
    },
  };
  fixture = await processingFixture(t, scanOcr);
  const inspected = await fixture.processing.inspect(fixture.material.id);
  assert.deepEqual(seen, { stage: 'ocr', file: 'scan.pdf', done: 0, total: 1 });
  assert.equal(fixture.processing.progress(fixture.material.id), null, 'progress is cleared when OCR ends');
  const [question] = inspected.localDraft.pack.groups.flatMap(group => group.questions);
  assert.equal(question.prompt, 'Where do small fish shelter?');
  assert.match(question.source, /扫描识别/);
  assert.ok(inspected.issues.some(item => /是扫描页，文字由本机英语 OCR 识别/.test(item.message)));
});

test('without enabled OCR, scanned pages stay empty and the user is told how to read them', async t => {
  const { processing, material } = await processingFixture(t, { enabled: async () => false, recognizePdf: async () => { throw new Error('must not run'); } });
  const inspected = await processing.inspect(material.id);
  assert.ok(inspected.issues.some(item => /1 页没有文字层.*安装并启用英语 OCR/.test(item.message)));
  assert.equal(inspected.localDraft.pack.groups.flatMap(group => group.questions).length, 0);
});
