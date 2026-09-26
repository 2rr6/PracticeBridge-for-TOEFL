import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createModels } from '../src/models.mjs';
import { createScanOcr, applyProofread, evidenceLines } from '../src/scan-ocr.mjs';
import { ocrEvidenceToChunk } from '../src/ocr-layout.mjs';
import { parseExamDocument } from '../src/exam-document.mjs';

// All model replies are local test doubles; nothing is sent anywhere.
function modelsFixture(t, fetchImpl) {
  const parent = path.resolve(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(parent, 'practicebridge-proofread-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return createModels({ dataDir, fetchImpl });
}
const image = { mime: 'image/jpeg', base64: Buffer.from('not really a jpeg').toString('base64') };
const lines = [{ id: 0, text: 'Answer Key' }, { id: 1, text: '1 0' }];
const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('a scanned page goes to the model as an image next to its OCR lines, only with consent', async t => {
  const sent = [];
  const models = modelsFixture(t, async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return reply({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ lines: [{ id: 0, text: 'Answer Key' }, { id: 1, text: '1 C' }] }) } }] });
  });
  await models.updateSettings({ provider: 'compatible', baseUrl: 'https://example.test/v1', model: 'vision-model', apiKey: 'test-key-not-real' });
  assert.equal(models.publicSettings().capabilities.proofreadScans, true);
  await assert.rejects(() => models.proofreadScanPage({ image, lines }), /同意/);
  assert.equal(sent.length, 0);
  const result = await models.proofreadScanPage({ image, lines, consent: true });
  assert.deepEqual(result.lines, [{ id: 0, text: 'Answer Key' }, { id: 1, text: '1 C' }]);
  const user = sent[0].body.messages.at(-1);
  assert.equal(user.content[0].type, 'text');
  assert.deepEqual(JSON.parse(user.content[0].text), { lines });
  assert.equal(user.content[1].type, 'image_url');
  assert.match(user.content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(sent[0].body.messages[0].content, /never fill in a blank/);
});

test('the official API receives the page as input_image, and replies for unknown lines are refused', async t => {
  let body;
  const models = modelsFixture(t, async (url, init) => {
    body = JSON.parse(init.body);
    return reply({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ lines: [{ id: 7, text: 'invented' }] }) }] }] });
  });
  await models.updateSettings({ provider: 'openai', model: 'vision-model', baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key-not-real' });
  await assert.rejects(() => models.proofreadScanPage({ image, lines, consent: true }), /不对应/);
  const user = body.input.at(-1);
  assert.deepEqual(user.content.map(part => part.type), ['input_text', 'input_image']);
});

test('the local Codex connection is not offered for page images', async t => {
  const models = modelsFixture(t, () => { throw new Error('Unexpected network call'); });
  await models.updateSettings({ provider: 'codex' });
  assert.equal(models.publicSettings().capabilities.proofreadScans, false);
  await assert.rejects(() => models.proofreadScanPage({ image, lines, consent: true }), /Codex/);
});

function evidence(rows, { imageRef = null } = {}) {
  const words = [];
  rows.forEach((row, index) => {
    let x = 40;
    for (const text of row.split(' ')) { words.push({ text, confidence: 60, bbox: { x0: x, y0: 40 + index * 40, x1: x + text.length * 14, y1: 66 + index * 40 }, line: index }); x += text.length * 14 + 12; }
  });
  return { version: 1, kind: 'ocr-evidence', state: 'needs_review', text: rows.join('\n'), words, confidence: 80, source: { imageRef, pageDimensions: { width: 1200, height: 1600 }, pixelRect: { x: 0, y: 0, width: 1200, height: 1600 } }, recognitionMode: 'auto' };
}

test('proofread lines keep word boxes where the word count holds and are marked as proofread', () => {
  const original = evidence(['Listening Section', '9 Cc', 'tellme / you']);
  assert.deepEqual(evidenceLines(original), [{ id: 0, text: 'Listening Section' }, { id: 1, text: '9 Cc' }, { id: 2, text: 'tellme / you' }]);
  const fixed = applyProofread(original, [{ id: 1, text: '9 C' }, { id: 2, text: 'tell / me / you' }], { model: 'vision-model' });
  assert.equal(fixed.proofread, true); assert.equal(fixed.proofreadModel, 'vision-model');
  assert.equal(fixed.text, 'Listening Section\n9 C\ntell / me / you');
  const nine = fixed.words.filter(word => word.line === 1);
  assert.deepEqual(nine.map(word => word.bbox), original.words.filter(word => word.line === 1).map(word => word.bbox));
  assert.equal(nine[0].confidence, 60); assert.equal(nine[1].confidence, 95);
  const split = fixed.words.filter(word => word.line === 2);
  assert.equal(split.length, 5);
  assert.ok(split.every((word, i) => i === 0 || word.bbox.x0 > split[i - 1].bbox.x0));
  // A proofread page trusts letters that local OCR alone must leave open.
  const page = ocrEvidenceToChunk({ ...evidence(['Answer Key', '1 0', '2 B', '3 C']), proofread: true }, { name: 'scan.pdf', page: 1, pagePoints: { width: 600, height: 800 } });
  assert.deepEqual(page.text.split('\n'), ['Answer Key', '1 D', '2 B', '3 C']);
  // Each text line keeps its pixel box, used to show that line of the original.
  assert.equal(page.ocr.lineBoxes.length, 4);
  assert.deepEqual(page.ocr.lineBoxes[1], { x0: 40, y0: 80, x1: 40 + 14 + 12 + 14, y1: 106 });
});

test('proofreading sends each recognised page once, keeps the result and splits a page that overflows', async t => {
  const root = path.resolve('test-results/scan-proofread'); await fsp.mkdir(root, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(root, 'run-')); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const artifactDir = path.join(dir, 'artifacts'); await fsp.mkdir(artifactDir, { recursive: true });
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const { createCanvas } = await import('@napi-rs/canvas');
  const png = createCanvas(300, 400).toBuffer('image/png'), imageRef = sha(png);
  await fsp.writeFile(path.join(artifactDir, imageRef), png);
  const pageEvidence = evidence(['Answer Key', ...Array.from({ length: 11 }, (_, i) => `${i + 1} Cc`)], { imageRef });
  const workerFactory = () => ({
    async runMaterialTool(request) {
      return { evidence: await Promise.all(request.parameters.pages.map(async ({ page }) => {
        const bytes = Buffer.from(JSON.stringify(pageEvidence)), ref = sha(bytes);
        await fsp.writeFile(path.join(artifactDir, ref), bytes).catch(() => {});
        return { page, ref, state: 'needs_review' };
      })) };
    },
  });
  const scanOcr = createScanOcr({ ocrService: { assetDir: path.join(dir, 'optional'), artifactDir, status: async () => ({ enabled: true }) }, workerFactory });
  const pdf = Buffer.from('%PDF-1.4 self-authored scan');
  await scanOcr.recognizePdf({ bytes: pdf, pages: [1, 2] });
  const asked = [];
  const ask = async ({ image: picture, lines: sent }) => {
    asked.push(sent.length);
    assert.equal(picture.mime, 'image/jpeg');
    if (sent.length > 6) throw Object.assign(new Error('too long'), { code: 'incomplete_model_output' });
    return { lines: sent.map(line => ({ id: line.id, text: line.text.replace('Cc', 'C') })), model: 'vision-model' };
  };
  const first = await scanOcr.proofreadPdf({ bytes: pdf, pages: [1, 2, 3], ask });
  assert.deepEqual(first.failed, []); assert.equal(first.proofread, 2); assert.equal(first.model, 'vision-model');
  assert.deepEqual(asked.sort(), [12, 12, 6, 6, 6, 6].sort());
  assert.deepEqual(await scanOcr.proofreadStatus(pdf, [1, 2, 3]), { recognised: 2, proofread: 2 });
  const again = await scanOcr.proofreadPdf({ bytes: pdf, pages: [1, 2], ask: () => { throw new Error('asked twice'); } });
  assert.equal(again.proofread, 2);
  const read = await scanOcr.recognizePdf({ bytes: pdf, pages: [1, 2] });
  assert.equal(read.proofread, 2);
  assert.equal(read.results.get(1).proofread, true);
  assert.match(read.results.get(1).text, /^11 C$/m);
});

// Scanned-page parsing: self-authored pages marked as OCR output, laid out like
// a modular practice test. None of this text comes from a real test.
const scanned = (number, text, proofread = false) => ({ name: 'original-scan.pdf', page: number, kind: 'pdf', text, ocr: { proofread } });
const writing = (frame, tiles, key, proofread = false) => [
  scanned(1, 'Original Language Practice\nSample Test 9'), scanned(2, 'Writing Section'),
  scanned(3, `Build a Sentence\nArrange the supplied fragments.\n1. What did you think of it?\n${frame}\n${tiles}`, proofread),
  scanned(4, `Writing Section\nAnswer Key\nQuestion Number Answer\n1 ${key}`, proofread),
];
const questions = result => result?.pack?.groups.flatMap(group => group.questions) || [];
// A test document needs two sections, two modules and two task types.
const listening = [
  scanned(20, 'Listening Section, Module 1'),
  scanned(21, 'Choose the best response.\n1. Speaker: Is the room open?\n(A) Yes, since noon.\n(B) A blue chair.'),
  scanned(22, 'Listening Section, Module 2'),
  scanned(23, 'Listening Section, Module 1\nAnswer Key\nQuestion Number Answer\n1 A'),
  scanned(24, 'Speaking Section'),
  scanned(25, 'Take an Interview\nAnswer the questions from the interviewer.\n1. Tell me about a park you like.'),
];
const paper = pages => parseExamDocument([...pages, ...listening]);

test('Build a Sentence slots on a scanned page stay separate slots', () => {
  const page = ocrEvidenceToChunk(evidence(['1. What did you think of it?', 'The _____ _____ _____ great.', 'food / was / is / really']), { name: 'scan.pdf', page: 1, pagePoints: { width: 600, height: 800 } });
  assert.equal(page.text.split('\n')[1], 'The _____ _____ _____ great.');
  // Complete the Words gaps still join their stem.
  assert.equal(ocrEvidenceToChunk(evidence(['They gr _ _ fast.']), { name: 'scan.pdf', page: 1, pagePoints: { width: 600, height: 800 } }).text, 'They gr__ fast.');
});

test('on scanned pages the answer key sets each missing-letter count, drops a lone extra gap and reads I among small letters as l', () => {
  const pages = paragraph => [
    scanned(1, 'Original Language Practice\nSample Test 9'), scanned(2, 'Reading Section, Module 1'),
    scanned(3, `Fill in the missing letters in the paragraph.\n(Questions 1-3)\n${paragraph}`),
    scanned(4, 'Reading Section, Module 1\nAnswer Key\nQuestion Number Answer\n1 nt\n2 ow\n3 Ive'),
  ];
  const result = paper(pages('A pla _ can gr _ _ near a window and invo_ _ light.'));
  const fills = questions(result).filter(q => q.type === 'fill_blank');
  assert.deepEqual(fills.map(q => q.answer), ['nt', 'ow', 'lve']);
  assert.match(fills[0].prompt, /pla__\n/);
  assert.match(fills[0].source, /空白数 1 按答案改为 2/);
  assert.match(fills[2].prompt, /invo___\n/);
  assert.match(result.pack.groups.find(group => group.questions.includes(fills[0])).passage, /A pla__ can gr__ near a window and invo___ light\./);
  // "is" read as "i-" is one gap too many; only one choice lines up with the key.
  const extra = paper(pages('A pla _ _ can gr _ _ near a window i- and invo_ _ _ light.'));
  const kept = questions(extra).filter(q => q.type === 'fill_blank');
  assert.deepEqual(kept.map(q => q.answer), ['nt', 'ow', 'lve']);
  assert.match(extra.pack.groups.find(group => group.questions.includes(kept[0])).passage, /window i\[\?\] and/);
  // When several gaps could be the extra one, nothing is guessed.
  const unclear = paper(pages('A pla _ can gr _ near a window i- and invo_ light.'));
  assert.deepEqual(questions(unclear).filter(q => q.type === 'fill_blank'), []);
  assert.ok(unclear.issues.some(issue => /空白数量不一致/.test(issue.message)));
});

test('without AI proofreading a scanned tile answer that is not whole is left open', () => {
  const answerOf = result => questions(result).find(q => q.type === 'sentence_order')?.answer ?? null;
  // Whole: the keyed sentence ends like a sentence and one tile is left over.
  assert.ok(answerOf(paper(writing('The _____ _____ _____ great.', 'food / was / is / really', 'The food was really great.'))));
  // A truncated key or OCR debris among the tiles leaves the answer open.
  for (const [frame, tiles, key] of [['The _____ _____ _____ great', 'food / was / is / really', 'The food was really great'], ['The _____ _____ _____ great.', 'food / was / | / really', 'The food was really great.']]) {
    const result = paper(writing(frame, tiles, key));
    assert.equal(answerOf(result), null);
    assert.ok(result.issues.some(issue => /本机识别的答案句或词块不完整，已留空/.test(issue.message)));
    // After an AI proofreading pass the same reading is used as it stands.
    if (!tiles.includes('|')) assert.ok(answerOf(paper(writing(frame, tiles, key, true))));
  }
});

test('a scanned footer split over two lines never joins the last question', () => {
  const pages = [
    scanned(1, 'Original Language Practice\nSample Test 9'), scanned(2, 'Speaking Section'),
    scanned(3, 'Listen and Repeat\nYou will listen as someone speaks to you. Listen carefully and then repeat what you have heard.\nYou are learning to guide visitors. Repeat only once.\nGuide: The garden opens at nine,\nSample Test 9\n14'),
  ];
  const repeat = questions(paper(pages)).find(q => q.type === 'listen_repeat');
  assert.equal(repeat.answer, 'The garden opens at nine.');
});
