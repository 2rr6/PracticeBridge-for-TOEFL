import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ZipFixture from './helpers/zip-fixture.mjs';
import { syntheticPdf } from './helpers/pdf-fixture.mjs';
import { createStore } from '../src/store.mjs';
import { createMaterialInbox } from '../src/materials.mjs';
import { createMaterialProcessing } from '../src/material-processing.mjs';
import { LIMITS, validatePackage } from '../src/package.mjs';

// All sources are original synthetic fixtures. The model is an injected stub;
// no provider request, credential lookup or user PDF/audio archive is used.
const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-results/material-processing-tests');
const upload = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });
const worksheet = '@title Original garden practice\n@rights Original synthetic text\n@section reading\n@group The garden\n@passage\nThe garden opens at nine.\n@question single_choice\nWhen does the garden open?\n@option A | At eight.\n@option B | At nine.\n@answer B\n@end';
const nativePack = () => ({ schemaVersion: 1, id: 'original-garden', version: '1.0.0', title: 'Original garden practice', description: '', rights: 'Original synthetic text', groups: [{ id: 'g1', section: 'reading', title: 'The garden', passage: 'The garden opens at nine.', audio: null, image: null, questions: [{ id: 'q1', type: 'single_choice', prompt: 'When does the garden open?', options: [{ id: 'A', text: 'At eight.' }, { id: 'B', text: 'At nine.' }], answer: 'B', explanation: '', audio: null, image: null, timeLimitSeconds: 60, prepareSeconds: 0, source: 'original.txt' }] }] });
const assessment = (overrides = {}) => ({ status: 'processable', summary: '已读取现有文字，可生成待核对草稿。', detectedSections: ['reading'], missingInformation: [], recommendedProcessor: 'ai', warnings: [], canCreateDraft: true, provider: 'compatible', model: 'synthetic-test', ...overrides });
const wave = () => { const bytes = Buffer.alloc(44); bytes.write('RIFF', 0); bytes.writeUInt32LE(36, 4); bytes.write('WAVE', 8); return bytes; };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function within(promise, milliseconds = 1500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Operation did not stop promptly')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function harness(t, { behavior = {}, wrapInbox } = {}) {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(TEST_ROOT, 'run-'));
  const store = await createStore({ dataDir });
  const inbox = createMaterialInbox({ store });
  const calls = { assess: [], structure: [], registered: [] };
  const settings = { provider: 'compatible', baseUrl: 'https://model.example.test/v1', model: 'synthetic-test', timeoutSeconds: 15, maxOutputTokens: 1500, structuredOutputMode: 'json_schema', capabilities: { assessMaterials: true, structure: true } };
  const models = {
    publicSettings: () => structuredClone(settings),
    async assessMaterials(input) { calls.assess.push(input); return behavior.assess ? behavior.assess(input) : assessment({ recommendedProcessor: input.availableProcessors.find(value => value !== 'ai') || 'ai' }); },
    async structure(input) { calls.structure.push(input); return behavior.structure ? behavior.structure(input) : { pack: nativePack() }; },
  };
  const registerDraft = args => {
    calls.registered.push(args);
    const checked = validatePackage(args.pack, args.files);
    return { draftId: crypto.randomUUID(), ...checked, issues: [...args.sourceIssues, ...checked.issues], sources: args.sources, method: args.method };
  };
  const processor = createMaterialProcessing({ inbox: wrapInbox ? wrapInbox(inbox, settings) : inbox, models, registerDraft });
  t.after(async () => {
    await processor.stop();
    await store.close();
    const checked = path.resolve(dataDir);
    assert.ok(checked.startsWith(`${TEST_ROOT}${path.sep}`), 'Only this newly created test directory may be removed');
    await fs.rm(checked, { recursive: true, force: true });
  });
  return { processor, inbox, store, dataDir, models, settings, calls, behavior, registerDraft };
}

test('receipt precedes AI assessment, and the selected local processor creates a separate validated draft', async t => {
  const h = await harness(t);
  const originals = [upload('original.txt', worksheet), upload('companion.wav', wave())];
  const received = await h.inbox.receive({ files: originals });
  assert.equal(received.status, 'received');
  assert.equal(h.calls.assess.length, 0);
  await assert.rejects(h.processor.convert(received.id, { consent: true }), /先评估/);
  const assessed = await h.processor.assess(received.id, { consent: true });
  assert.equal(assessed.material.status, 'assessed');
  assert.equal(assessed.material.analysis.mode, 'ai');
  assert.equal(assessed.material.analysis.recommendedProcessor, 'worksheet');
  assert.equal(assessed.material.draft, null);
  assert.equal(h.calls.assess.length, 1);
  assert.equal(h.calls.structure.length, 0);
  assert.deepEqual(Object.keys(h.calls.assess[0].files[0]).sort(), ['mime', 'name', 'size']);
  const result = await h.processor.convert(received.id, { consent: true });
  assert.equal(result.material.status, 'draft_ready');
  assert.equal(result.materialId, received.id);
  assert.ok(result.draftId);
  assert.equal(result.method, 'ai-plan/worksheet');
  assert.equal(result.pack.groups[0].questions[0].answer, 'B');
  assert.equal(h.calls.structure.length, 0);
  assert.ok(h.calls.registered[0].files instanceof Map);
  assert.equal(h.calls.registered[0].materialRevision, result.material.updatedAt);
  assert.deepEqual(await h.inbox.loadFiles(received.id), originals);
  assert.equal(h.store.read().libraries.length, 0, 'A draft is not a committed library');
});

test('explicit local assessment and conversion require neither model capability nor sending consent', async t => {
  const h = await harness(t);
  h.settings.provider = 'none';
  h.settings.capabilities = {};
  const received = await h.inbox.receive({ text: worksheet });
  const assessed = await h.processor.assess(received.id, { useAI: false });
  assert.equal(assessed.material.analysis.mode, 'local');
  assert.equal(assessed.material.modelBinding, null);
  const result = await h.processor.convert(received.id, { useAI: false });
  assert.equal(result.method, 'local/worksheet');
  assert.equal(result.material.status, 'draft_ready');
  assert.equal(h.calls.assess.length + h.calls.structure.length, 0);
});

test('temporary restore pause interrupts old work, blocks new starts and resumes without automatic resend',async t=>{
  const entered=deferred(),held=deferred();
  const h=await harness(t,{behavior:{assess:async()=>{entered.resolve();return held.promise;}}}),material=await h.inbox.receive({text:worksheet});
  const pending=h.processor.assess(material.id,{consent:true}),stopped=assert.rejects(pending,/中断/);await entered.promise;
  await within(h.processor.pause());await stopped;assert.equal(h.processor.busy(),false);
  await assert.rejects(h.processor.assess(material.id,{useAI:false}),/中断/);
  h.processor.resume();assert.equal(h.calls.assess.length,1);assert.equal(h.inbox.get(material.id).status,'interrupted');
  held.resolve(assessment());await tick();assert.equal(h.inbox.get(material.id).status,'interrupted');
  assert.equal((await h.processor.assess(material.id,{useAI:false})).material.status,'assessed');
});

test('AI consent and availability checks leave already-received originals intact', async t => {
  const h = await harness(t);
  const originals = [upload('source.custom', worksheet)];
  const received = await h.inbox.receive({ files: originals });
  await assert.rejects(h.processor.assess(received.id), /允许本次 AI/);
  h.settings.capabilities = {};
  await assert.rejects(h.processor.assess(received.id, { consent: true }), /配置可用模型/);
  assert.equal(h.inbox.get(received.id).status, 'received');
  assert.deepEqual(await h.inbox.loadFiles(received.id), originals);
  assert.equal(h.calls.assess.length, 0);
});

test('a malformed PDF does not discard readable companion sources', async t => {
  const h = await harness(t);
  const originals = [upload('broken.pdf', 'This is not a PDF'), upload('readable.txt', worksheet)];
  const received = await h.inbox.receive({ files: originals });
  const inspected = await h.processor.inspect(received.id);
  assert.ok(inspected.sources.some(source => source.name === 'readable.txt' && source.text.includes('When does the garden open?')));
  assert.ok(inspected.issues.some(issue => issue.path === 'broken.pdf' && issue.severity === 'error'));
  assert.ok(inspected.availableProcessors.includes('worksheet'));
  const assessed = await h.processor.assess(received.id, { useAI: false });
  assert.equal(assessed.material.analysis.status, 'partially_processable');
  const converted = await h.processor.convert(received.id, { useAI: false });
  assert.ok(converted.issues.some(issue => issue.path === 'broken.pdf'));
  assert.deepEqual(await h.inbox.loadFiles(received.id), originals);
});

test('unsafe ZIP fails only that attachment while an independent PDF proceeds and all originals remain exact', async t => {
  const h = await harness(t);
  const zip = new ZipFixture(); zip.addFile('../outside.txt', Buffer.from('NEVER EXPOSE THIS MEMBER'));
  const originals = [upload('unsafe.zip', zip.toBuffer()), upload('worksheet.pdf', syntheticPdf(worksheet.split('\n')))];
  const received = await h.inbox.receive({ files: originals });
  const inspected = await h.processor.inspect(received.id);
  assert.ok(inspected.sources.some(source => source.name === 'worksheet.pdf' && source.text.includes('When does the garden open?')));
  assert.ok(inspected.issues.some(issue => issue.path === 'unsafe.zip' && issue.code === 'archive_processing_failed'));
  assert.ok(inspected.sources.every(source => !source.text.includes('NEVER EXPOSE')));
  const assessed = await h.processor.assess(received.id, { useAI: false });
  assert.equal(assessed.material.analysis.status, 'partially_processable');
  const converted = await h.processor.convert(received.id, { useAI: false });
  assert.equal(converted.pack.groups[0].questions[0].answer, 'B');
  assert.deepEqual(await h.inbox.loadFiles(received.id), originals);
  assert.equal(h.calls.assess.length + h.calls.structure.length, 0);
});

test('unknown failed decompression blocks later ZIPs while an independent PDF still proceeds', async t => {
  const h = await harness(t);
  const bad = new ZipFixture(); bad.addFile('bad.txt', Buffer.alloc(10000, 65));
  const bytes = bad.toBuffer(), central = bytes.indexOf(Buffer.from('504b0102', 'hex'));
  bytes.writeUInt32LE(1, 22); bytes.writeUInt32LE(1, central + 24);
  const good = new ZipFixture(); good.addFile('later.txt', Buffer.from(worksheet));
  const originals = [upload('bad.zip', bytes), upload('later.zip', good.toBuffer()), upload('worksheet.pdf', syntheticPdf(worksheet.split('\n')))];
  const received = await h.inbox.receive({ files: originals });
  const inspected = await h.processor.inspect(received.id);
  assert.ok(inspected.issues.some(issue => issue.path === 'bad.zip' && issue.code === 'archive_processing_failed'));
  assert.ok(inspected.issues.some(issue => issue.path === 'later.zip' && /预算已耗尽/.test(issue.message)));
  assert.deepEqual(inspected.sources.map(source => source.name), ['worksheet.pdf']);
  const assessed = await h.processor.assess(received.id, { useAI: false });
  assert.equal(assessed.material.analysis.status, 'partially_processable');
  const converted = await h.processor.convert(received.id, { useAI: false });
  assert.equal(converted.pack.groups[0].questions[0].answer, 'B');
  assert.deepEqual(await h.inbox.loadFiles(received.id), originals);
  assert.equal(h.calls.assess.length + h.calls.structure.length, 0);
});

test('a DOCX inside an accepted outer ZIP still receives its own real-byte and CRC checks', async t => {
  const h = await harness(t);
  const docx = new ZipFixture(); docx.addFile('word/document.xml', Buffer.from('<xml>' + 'x'.repeat(50000) + '</xml>'));
  const bytes = docx.toBuffer(), central = bytes.indexOf(Buffer.from('504b0102', 'hex'));
  bytes.writeUInt32LE(0, 22); bytes.writeUInt32LE(0, central + 24);
  const outer = new ZipFixture(); outer.addFile('bomb.docx', bytes);
  outer.addFile('nested.zip', Buffer.from('PK inert, never recursively opened'));
  const originals = [upload('documents.zip', outer.toBuffer()), upload('worksheet.pdf', syntheticPdf(worksheet.split('\n')))];
  const received = await h.inbox.receive({ files: originals });
  const inspected = await h.processor.inspect(received.id);
  assert.ok(inspected.issues.some(issue => issue.path === 'bomb.docx' && /安全读取 DOCX/.test(issue.message)));
  assert.ok(inspected.issues.some(issue => issue.path === 'nested.zip'));
  assert.ok(inspected.sources.every(source => source.name !== 'bomb.docx' && source.name !== 'nested.zip'));
  assert.ok(inspected.sources.some(source => source.name === 'worksheet.pdf'));
  assert.deepEqual(await h.inbox.loadFiles(received.id), originals);
});

test('unknown text extensions and malformed JSON are passed as readable evidence', async t => {
  const h = await harness(t, { behavior: { assess: () => assessment() } });
  const received = await h.inbox.receive({ files: [upload('notes.custom', worksheet), upload('unstructured.json', '{not a practice package')] });
  await h.processor.assess(received.id, { consent: true });
  const evidence = h.calls.assess[0].sources;
  assert.ok(evidence.some(source => source.name === 'notes.custom' && source.text === worksheet));
  assert.ok(evidence.some(source => source.name === 'unstructured.json' && source.text === '{not a practice package'));
  const result = await h.processor.convert(received.id, { consent: true });
  assert.equal(result.method, 'ai-plan/ai');
  assert.equal(h.calls.structure.length, 1);
  assert.ok(h.calls.structure[0].text.includes('When does the garden open?'));
});

test('ordinary archives may contain readable JSON without a native manifest', async t => {
  const h = await harness(t);
  const zip = new ZipFixture();
  zip.addFile('notes.json', Buffer.from(JSON.stringify({ notes: 'Original garden material.' })));
  zip.addFile('lesson.txt', Buffer.from(worksheet));
  const received = await h.inbox.receive({ files: [upload('ordinary.zip', zip.toBuffer())] });
  const inspected = await h.processor.inspect(received.id);
  assert.equal(inspected.processingError, null);
  assert.ok(inspected.sources.some(source => source.name === 'notes.json'));
  assert.ok(inspected.availableProcessors.includes('worksheet'));
});

test('native selection uses the original package while still collecting readable JSON', async t => {
  const h = await harness(t);
  const original = nativePack();
  const received = await h.inbox.receive({ files: [upload('practicebridge.json', JSON.stringify(original))] });
  const inspected = await h.processor.inspect(received.id);
  assert.ok(inspected.extracted?.chunks.length);
  assert.ok(inspected.availableProcessors.includes('native'));
  await h.processor.assess(received.id, { consent: true });
  const result = await h.processor.convert(received.id, { consent: true });
  assert.equal(result.method, 'ai-plan/native');
  assert.equal(result.pack.groups[0].questions[0].answer, 'B');
  assert.equal(h.calls.structure.length, 0);
});

test('native input remains convertible when AI explicitly recommends its own structure route', async t => {
  const h = await harness(t, { behavior: { assess: () => assessment() } });
  const received = await h.inbox.receive({ files: [upload('practicebridge.json', JSON.stringify(nativePack()))] });
  await h.processor.assess(received.id, { consent: true });
  const result = await h.processor.convert(received.id, { consent: true });
  assert.equal(result.material.status, 'draft_ready');
  assert.equal(h.calls.structure.length, 1);
  assert.ok(h.calls.structure[0].text.includes('When does the garden open?'));
  assert.equal(result.method, 'ai-plan/ai');
});

test('media-only input cannot become questions even if an AI stub invents readiness', async t => {
  const h = await harness(t, { behavior: { assess: () => assessment({ detectedSections: ['listening'] }) } });
  const received = await h.inbox.receive({ files: [upload('listen.wav', wave())] });
  const result = await h.processor.assess(received.id, { consent: true });
  assert.equal(result.material.status, 'needs_information');
  assert.equal(result.material.analysis.canCreateDraft, false);
  assert.deepEqual(result.material.analysis.detectedSections, []);
  assert.equal(result.material.analysis.mediaFiles, 1);
  await assert.rejects(h.processor.convert(received.id, { consent: true }), /先评估/);
  assert.equal(h.calls.structure.length, 0);
});

test('unreadable binary files and empty text stay received without invented local content', async t => {
  const h = await harness(t);
  const originals = [upload('inert.exe', Buffer.from([77, 90, 0, 1, 2])), upload('empty.txt', '')];
  const received = await h.inbox.receive({ files: originals });
  const assessed = await h.processor.assess(received.id, { useAI: false });
  assert.equal(assessed.material.status, 'needs_information');
  assert.equal(assessed.material.analysis.canCreateDraft, false);
  assert.equal(h.calls.assess.length, 0);
  assert.deepEqual(await h.inbox.loadFiles(received.id), originals);
});

test('model failures preserve originals and a conversion can be retried without another assessment', async t => {
  const behavior = { assess: () => { throw new Error('Synthetic assessment failure'); } };
  const h = await harness(t, { behavior });
  const originals = [upload('original.txt', worksheet)];
  const received = await h.inbox.receive({ files: originals });
  await assert.rejects(h.processor.assess(received.id, { consent: true }), /Synthetic assessment/);
  assert.equal(h.inbox.get(received.id).status, 'failed');
  assert.equal(h.inbox.get(received.id).analysis, null);
  behavior.assess = () => assessment();
  await h.processor.assess(received.id, { consent: true });
  behavior.structure = () => { throw new Error('Synthetic conversion failure'); };
  await assert.rejects(h.processor.convert(received.id, { consent: true }), /Synthetic conversion/);
  assert.equal(h.inbox.get(received.id).status, 'failed');
  assert.equal(h.inbox.get(received.id).analysis.canCreateDraft, true);
  behavior.structure = () => ({ pack: nativePack() });
  const result = await h.processor.convert(received.id, { consent: true });
  assert.equal(result.material.status, 'draft_ready');
  assert.equal(h.calls.assess.length, 2);
  assert.deepEqual(await h.inbox.loadFiles(received.id), originals);
});

test('empty model conversion output fails before registering a draft', async t => {
  const h = await harness(t, { behavior: { assess: () => assessment(), structure: () => ({ pack: { ...nativePack(), groups: [] } }) } });
  const received = await h.inbox.receive({ text: worksheet });
  await h.processor.assess(received.id, { consent: true });
  await assert.rejects(h.processor.convert(received.id, { consent: true }), /尚未产生可核对/);
  assert.equal(h.inbox.get(received.id).status, 'failed');
  assert.equal(h.calls.registered.length, 0);
  assert.equal(h.inbox.get(received.id).draft, null);
});

test('duplicate processing on one record is locked until the first operation settles', async t => {
  const waiting = deferred();
  const entered = deferred();
  const h = await harness(t, { behavior: { assess: input => { entered.resolve(); return waiting.promise; } } });
  const received = await h.inbox.receive({ text: worksheet });
  const first = h.processor.assess(received.id, { consent: true });
  await entered.promise;
  assert.equal(h.processor.busy(), true);
  await assert.rejects(h.processor.assess(received.id, { consent: true }), error => error.status === 409);
  await assert.rejects(h.processor.convert(received.id, { consent: true }), error => error.status === 409);
  waiting.resolve(assessment({ recommendedProcessor: 'worksheet' }));
  await first;
  await h.processor.awaitIdle();
  assert.equal(h.processor.busy(), false);
  assert.equal(h.calls.assess.length, 1);
});

test('a setting change during local extraction prevents the first outbound request', async t => {
  const h = await harness(t, { wrapInbox: (inbox, settings) => ({ ...inbox, async loadFiles(id) { const files = await inbox.loadFiles(id); settings.baseUrl = 'https://changed.example.test/v1'; return files; } }) });
  const received = await h.inbox.receive({ text: worksheet });
  await assert.rejects(h.processor.assess(received.id, { consent: true }), /模型连接或设置已改变/);
  assert.equal(h.calls.assess.length, 0);
  assert.equal(h.inbox.get(received.id).status, 'failed');
});

test('settings changed while assessment is in flight invalidate the returned plan', async t => {
  const waiting = deferred();
  const entered = deferred();
  const h = await harness(t, { behavior: { assess: () => { entered.resolve(); return waiting.promise; } } });
  const received = await h.inbox.receive({ text: worksheet });
  const run = h.processor.assess(received.id, { consent: true });
  const rejected = assert.rejects(run, /模型连接或设置已改变/);
  await entered.promise;
  h.settings.model = 'a-different-model';
  waiting.resolve(assessment());
  await rejected;
  assert.equal(h.inbox.get(received.id).analysis, null);
  assert.equal(h.inbox.get(received.id).status, 'failed');
});

test('conversion requires the same model connection, limits and chosen mode as its assessment', async t => {
  const h = await harness(t, { behavior: { assess: () => assessment() } });
  const received = await h.inbox.receive({ text: worksheet });
  await h.processor.assess(received.id, { consent: true });
  await assert.rejects(h.processor.convert(received.id, { useAI: false }), /评估方式不同/);
  h.settings.maxOutputTokens += 100;
  await assert.rejects(h.processor.convert(received.id, { consent: true }), /设置已改变/);
  assert.equal(h.calls.structure.length, 0);
  assert.equal(h.inbox.get(received.id).status, 'assessed');
});

test('a late conversion result from changed model settings is never persisted or registered', async t => {
  const waiting = deferred();
  const entered = deferred();
  const h = await harness(t, { behavior: { assess: () => assessment(), structure: () => { entered.resolve(); return waiting.promise; } } });
  const received = await h.inbox.receive({ text: worksheet });
  await h.processor.assess(received.id, { consent: true });
  const run = h.processor.convert(received.id, { consent: true });
  const rejected = assert.rejects(run, /模型连接或设置已改变/);
  await entered.promise;
  h.settings.baseUrl = 'https://changed.example.test/v1';
  waiting.resolve({ pack: nativePack() });
  await rejected;
  assert.equal(h.inbox.get(received.id).draft, null);
  assert.equal(h.calls.registered.length, 0);
});

test('cancel releases the operation promptly and an older response cannot overwrite a new assessment', async t => {
  const waiting = deferred();
  const entered = deferred();
  const behavior = { assess: () => { entered.resolve(); return waiting.promise; } };
  const h = await harness(t, { behavior });
  const received = await h.inbox.receive({ text: worksheet });
  const run = h.processor.assess(received.id, { consent: true });
  const rejected = assert.rejects(run, /处理已中断/);
  await entered.promise;
  const cancelled = await within(h.processor.cancel(received.id));
  await rejected;
  await within(h.processor.awaitIdle());
  assert.equal(cancelled.material.status, 'interrupted');
  assert.equal(h.processor.busy(), false);
  behavior.assess = () => assessment({ summary: 'A newly requested assessment.', recommendedProcessor: 'worksheet' });
  await h.processor.assess(received.id, { consent: true });
  const newest = h.inbox.get(received.id);
  waiting.resolve(assessment({ summary: 'An obsolete response.' }));
  await tick();
  assert.deepEqual(h.inbox.get(received.id), newest);
});

test('shutdown detaches an unfinished model conversion without awaiting its remote timeout', async t => {
  const waiting = deferred();
  const entered = deferred();
  const h = await harness(t, { behavior: { assess: () => assessment(), structure: () => { entered.resolve(); return waiting.promise; } } });
  const received = await h.inbox.receive({ text: worksheet });
  await h.processor.assess(received.id, { consent: true });
  const run = h.processor.convert(received.id, { consent: true });
  const rejected = assert.rejects(run, /处理已中断/);
  await entered.promise;
  await within(h.processor.stop());
  await rejected;
  assert.equal(h.inbox.get(received.id).status, 'interrupted');
  assert.equal(h.processor.busy(), false);
  waiting.resolve({ pack: nativePack() });
  await tick();
  assert.equal(h.inbox.get(received.id).status, 'interrupted');
  assert.equal(h.inbox.get(received.id).draft, null);
  assert.equal(h.calls.registered.length, 0);
  await assert.rejects(h.processor.assess(received.id, { useAI: false }), /处理已中断/);
});

test('persistent drafts reopen after restart without another model call and preserve the read revision', async t => {
  const h = await harness(t);
  const received = await h.inbox.receive({ files: [upload('notes.custom', worksheet)] });
  await h.processor.assess(received.id, { useAI: false });
  const first = await h.processor.convert(received.id, { useAI: false });
  await h.processor.stop();
  await h.store.close();
  const reopenedStore = await createStore({ dataDir: h.dataDir });
  const reopenedInbox = createMaterialInbox({ store: reopenedStore });
  const reopenedProcessor = createMaterialProcessing({ inbox: reopenedInbox, models: h.models, registerDraft: h.registerDraft });
  const preview = await reopenedProcessor.openDraft(received.id);
  assert.notEqual(preview.draftId, first.draftId);
  assert.deepEqual(preview.pack, first.pack);
  assert.equal(h.calls.registered.at(-1).materialRevision, reopenedInbox.get(received.id).updatedAt);
  assert.equal(h.calls.assess.length + h.calls.structure.length, 0);
  await reopenedProcessor.stop();
  await reopenedStore.close();
});

test('path-traversing, symlink and oversized ZIP members remain stored but cannot enable conversion', async t => {
  const h = await harness(t, { behavior: { assess: () => assessment() } });
  const traversal = new ZipFixture(); traversal.addFile('xx/escape.txt', Buffer.from('inert'));
  const unsafe = traversal.toBuffer();
  let at = 0;
  while ((at = unsafe.indexOf('xx/escape.txt', at)) >= 0) { unsafe.write('../escape.txt', at); at += 13; }
  const symlink = new ZipFixture(); symlink.addFile('link.txt', Buffer.from('inert')); symlink.getEntry('link.txt').header.attr = (0xa1ff << 16) >>> 0;
  const oversized = new ZipFixture(); oversized.addFile('large.txt', Buffer.from('inert'));
  const oversizedBytes = oversized.toBuffer();
  const central = oversizedBytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  oversizedBytes.writeUInt32LE(LIMITS.fileBytes + 1, central + 24);
  for (const [index, bytes] of [unsafe, symlink.toBuffer(), oversizedBytes].entries()) {
    const originals = [upload(`archive-${index}.zip`, bytes)];
    const received = await h.inbox.receive({ files: originals, text: worksheet });
    const result = await h.processor.assess(received.id, { consent: true });
    assert.equal(result.material.analysis.canCreateDraft, false);
    assert.equal(result.material.status, 'needs_information');
    assert.ok(result.material.issues.some(issue => issue.severity === 'error'));
    await assert.rejects(h.processor.convert(received.id, { consent: true }), /先评估/);
    assert.deepEqual(await h.inbox.loadFiles(received.id), originals);
  }
  assert.equal(h.calls.structure.length, 0);
});

test('aggregate entry budget includes directories and only rejects the attachment that exceeds it', async t => {
  const h = await harness(t);
  const files = [];
  for (let archive = 0; archive < 2; archive++) {
    const zip = new ZipFixture();
    for (let index = 0; index < 600; index++) zip.addFile(`archive-${archive}/folder-${index}/`, Buffer.alloc(0));
    zip.addFile(`archive-${archive}/notes.custom`, Buffer.from(worksheet));
    files.push(upload(`archive-${archive}.zip`, zip.toBuffer()));
  }
  const received = await h.inbox.receive({ files });
  const result = await h.processor.assess(received.id, { useAI: false });
  assert.equal(result.material.analysis.canCreateDraft, true);
  assert.ok(result.material.issues.some(issue => /数量过多|1200/.test(issue.message)));
  const inspected = await h.processor.inspect(received.id);
  assert.ok(inspected.sources.some(source => source.name === 'archive-0/notes.custom'));
  assert.ok(!inspected.sources.some(source => source.name === 'archive-1/notes.custom'));
  assert.deepEqual(await h.inbox.loadFiles(received.id), files);
});

test('an uninspected processor recommendation is rejected without registration', async t => {
  const h = await harness(t, { behavior: { assess: () => assessment({ recommendedProcessor: 'native' }) } });
  const received = await h.inbox.receive({ text: worksheet });
  await assert.rejects(h.processor.assess(received.id, { consent: true }), /没有返回可核对/);
  assert.equal(h.inbox.get(received.id).status, 'failed');
  assert.equal(h.calls.registered.length, 0);
});
