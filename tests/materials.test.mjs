import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore, atomicWrite } from '../src/store.mjs';
import { InputError } from '../src/package.mjs';
import { createMaterialInbox, MATERIAL_LIMITS } from '../src/materials.mjs';

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-results/materials-tests');
const upload = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const originalText = 'Original synthetic source material. No user documents are embedded in this test.';
const rejectsInput = (fn, pattern) => assert.rejects(fn, error => error instanceof InputError && pattern.test(error.message));
const throwsInput = (fn, pattern) => assert.throws(fn, error => error instanceof InputError && pattern.test(error.message));

async function harness(t) {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(TEST_ROOT, 'run-'));
  const store = await createStore({ dataDir });
  const inbox = createMaterialInbox({ store });
  t.after(async () => {
    await store.close();
    const checked = path.resolve(dataDir);
    assert.ok(checked.startsWith(`${TEST_ROOT}${path.sep}`), 'Only a newly created test directory may be removed');
    await fs.rm(checked, { recursive: true, force: true });
  });
  return { dataDir, store, inbox };
}

test('receipt retains arbitrary and malformed file formats before any processing', async t => {
  const { inbox, dataDir } = await harness(t);
  const originals = [upload('notes.custom', originalText), upload('broken.pdf', 'not a PDF'), upload('audio.zip', 'not a ZIP'), upload('inert.exe', 'MZ - inert fixture only'), upload('empty.txt', '')];
  const received = await inbox.receive({ files: originals, title: 'Incoming materials' });
  assert.equal(received.status, 'received');
  assert.equal(received.analysis, null);
  assert.equal(received.draft, null);
  assert.equal(received.files.length, originals.length);
  assert.deepEqual(await inbox.loadFiles(received.id), originals);
  const filenames = await fs.readdir(path.join(dataDir, 'input-blobs'));
  assert.ok(filenames.every(name => /^[a-f0-9]{64}$/.test(name)), 'Original names are metadata; only hashes are used on disk');
  assert.ok(!filenames.includes('inert.exe'));
});

test('receipt supports pasted text and persists both metadata and originals across restart', async t => {
  const { inbox, store, dataDir } = await harness(t);
  const textOnly = await inbox.receive({ text: originalText });
  const mixed = await inbox.receive({ files: [upload('nested/source.bin', originalText)], text: 'An original supplementary note.', title: 'Saved source' });
  await store.close();
  const reopenedStore = await createStore({ dataDir });
  const reopened = createMaterialInbox({ store: reopenedStore });
  assert.deepEqual(reopened.get(textOnly.id), textOnly);
  assert.deepEqual(reopened.get(mixed.id), mixed);
  assert.equal(reopened.list().length, 2);
  assert.deepEqual(await reopened.loadFiles(mixed.id), [upload('nested/source.bin', originalText)]);
  assert.deepEqual(await reopened.loadFiles(textOnly.id), []);
  await reopenedStore.close();
});

test('identical bytes share storage and ambiguous names remain received for later processing', async t => {
  const { inbox, dataDir } = await harness(t);
  const first = await inbox.receive({ files: [upload('same.bin', 'first'), upload('same.bin', 'second')] });
  const second = await inbox.receive({ files: [upload('another-name.dat', 'first')] });
  assert.equal(first.files.length, 2);
  assert.equal(first.files[0].id, second.files[0].id);
  assert.equal((await fs.readdir(path.join(dataDir, 'input-blobs'))).length, 2);
  assert.deepEqual(await inbox.loadFiles(first.id), [upload('same.bin', 'first'), upload('same.bin', 'second')]);
});

test('processing failures and retries never change the original file descriptors or source text', async t => {
  const { inbox } = await harness(t);
  const received = await inbox.receive({ files: [upload('broken.zip', 'original corrupt archive')], text: originalText });
  await inbox.update(received.id, { status: 'analyzing', processor: 'ai' });
  const failed = await inbox.update(received.id, { status: 'failed', error: 'The archive cannot currently be processed.' });
  assert.deepEqual(failed.files, received.files);
  assert.equal(failed.text, originalText);
  assert.deepEqual(await inbox.loadFiles(received.id), [upload('broken.zip', 'original corrupt archive')]);
  const retried = await inbox.update(received.id, { status: 'received', error: null });
  assert.equal(retried.error, null);
  for (const patch of [{ id: crypto.randomUUID() }, { files: [] }, { text: 'replacement' }, { title: 'replacement' }, { createdAt: new Date().toISOString() }]) {
    await rejectsInput(() => inbox.update(received.id, patch), /原文件和来源记录不可修改/);
  }
  assert.deepEqual(inbox.get(received.id).files, received.files);
});

test('list summaries omit drafts, raw text and full analysis evidence', async t => {
  const { inbox } = await harness(t);
  const received = await inbox.receive({ text: originalText });
  await inbox.update(received.id, {
    status: 'draft_ready',
    analysis: { status: 'processable', summary: 'Can form a draft.', canCreateDraft: true, sources: ['full private evidence'] },
    draft: { pack: { title: 'Synthetic draft' }, sources: [{ name: 'source', text: 'full private evidence' }], issues: [], media: [], method: 'ai' },
  });
  const [summary] = inbox.list();
  assert.deepEqual(summary.analysis, { summary: 'Can form a draft.', status: 'processable', canCreateDraft: true });
  assert.equal(summary.textLength, originalText.length);
  assert.equal(summary.draft, undefined);
  assert.equal(summary.text, undefined);
  assert.ok(!JSON.stringify(summary).includes('full private evidence'));
  assert.equal(inbox.get(received.id).draft.pack.title, 'Synthetic draft');
});

test('updates reject invalid states, oversized drafts, and model secrets atomically', async t => {
  const { inbox } = await harness(t);
  const received = await inbox.receive({ text: originalText });
  await rejectsInput(() => inbox.update(received.id, { status: 'pretend-success' }), /处理状态无效/);
  await rejectsInput(() => inbox.update(received.id, { draft: { text: 'x'.repeat(MATERIAL_LIMITS.metadataBytes) } }), /超过大小限制|超过 8 MB/);
  await rejectsInput(() => inbox.update(received.id, { modelBinding: { provider: 'compatible', apiKey: 'not-an-actual-key' } }), /不能保存密钥/);
  await rejectsInput(() => inbox.update(received.id, { modelBinding: { provider: 'compatible', baseUrl: 'file:///untrusted' } }), /模型地址无效/);
  assert.deepEqual(inbox.get(received.id), received);
  const updated = await inbox.update(received.id, { modelBinding: { provider: 'compatible', baseUrl: 'https://example.invalid/v1', model: 'local-fixture', timeoutSeconds: 60, maxOutputTokens: 3000 } });
  assert.equal(updated.modelBinding.model, 'local-fixture');
});

test('loaded originals and backups verify content hashes and do not overwrite corrupted bytes', async t => {
  const { inbox, dataDir } = await harness(t);
  const received = await inbox.receive({ files: [upload('source.bin', 'original')] });
  const file = received.files[0];
  const location = path.join(dataDir, 'input-blobs', file.id);
  await fs.writeFile(location, 'tampered');
  await rejectsInput(() => inbox.loadFiles(received.id), /完整性校验失败/);
  await rejectsInput(() => inbox.backupFiles([received]), /完整性校验失败/);
  await rejectsInput(() => inbox.writeOriginals(new Map([[file.id, Buffer.from('original')]])), /完整性校验失败/);
  assert.equal(await fs.readFile(location, 'utf8'), 'tampered');
});

test('backup helpers restore raw files and processing metadata only after the caller commits state', async t => {
  const source = await harness(t);
  const destination = await harness(t);
  const received = await source.inbox.receive({ files: [upload('unrecognized.fixture', originalText)], text: 'Supplementary original note.', title: 'Restored materials' });
  const saved = await source.inbox.update(received.id, { status: 'needs_information', analysis: { summary: 'Needs clearer source.', status: 'needs_information', canCreateDraft: false }, error: null });
  const zipFiles = await source.inbox.backupFiles([saved]);
  assert.deepEqual([...zipFiles.keys()], [`input-blobs/${saved.files[0].id}`]);
  const prepared = destination.inbox.prepareRestore([saved], zipFiles);
  assert.equal(destination.inbox.list().length, 0);
  await destination.inbox.writeOriginals(prepared.originals);
  assert.equal(destination.inbox.list().length, 0, 'Writing verified originals does not prematurely replace the main state');
  await destination.store.transact(state => { state.materials = prepared.materials; });
  assert.deepEqual(destination.inbox.get(saved.id), saved);
  assert.deepEqual(await destination.inbox.loadFiles(saved.id), [upload('unrecognized.fixture', originalText)]);
});

test('old backups without material records remain compatible', async t => {
  const { inbox } = await harness(t);
  assert.deepEqual(inbox.prepareRestore(undefined, new Map([['practicebridge-backup.json', Buffer.from('{}')]])), { materials: [], originals: new Map() });
  assert.deepEqual(await inbox.backupFiles(undefined), new Map());
});

test('restore rejects missing or tampered originals, path references, invalid metadata and undeclared originals', async t => {
  const { inbox } = await harness(t);
  const received = await inbox.receive({ files: [upload('source.bin', originalText)] });
  const zipFiles = await inbox.backupFiles([received]);
  throwsInput(() => inbox.prepareRestore([received], new Map()), /原文件缺失/);
  const corrupt = new Map(zipFiles);
  corrupt.set([...corrupt.keys()][0], Buffer.alloc(Buffer.byteLength(originalText), 32));
  throwsInput(() => inbox.prepareRestore([received], corrupt), /完整性校验失败/);
  for (const mutate of [
    record => { record.files[0].id = '../outside'; },
    record => { record.files[0].name = '../outside.bin'; },
    record => { record.files[0].path = 'C:/outside'; },
    record => { record.status = 'unknown'; },
    record => { record.libraryId = 'https://example.invalid/untrusted'; },
    record => { record.id = '../../outside'; },
  ]) {
    const changed = structuredClone(received); mutate(changed);
    throwsInput(() => inbox.prepareRestore([changed], zipFiles), /无效|路径/);
  }
  const unclaimed = Buffer.from('undeclared source');
  const extras = new Map(zipFiles).set(`input-blobs/${hash(unclaimed)}`, unclaimed);
  throwsInput(() => inbox.prepareRestore([received], extras), /未声明/);
  throwsInput(() => inbox.prepareRestore([received], new Map(zipFiles).set('input-blobs/../elsewhere', Buffer.from('x'))), /路径/);
  throwsInput(() => inbox.prepareRestore([received, received], zipFiles), /标识重复/);
});

test('writeOriginals validates every supplied hash before writing any file', async t => {
  const { inbox, dataDir } = await harness(t);
  const bytes = Buffer.from('verified original');
  await rejectsInput(() => inbox.writeOriginals(new Map([[hash(bytes), bytes], ['a'.repeat(64), Buffer.from('wrong hash')]])), /内容标识无效/);
  await assert.rejects(fs.stat(path.join(dataDir, 'input-blobs')), error => error.code === 'ENOENT');
  await rejectsInput(() => inbox.writeOriginals(new Map([['../../outside', bytes]])), /内容标识无效/);
});

test('receipt envelope validation happens before storage and does not claim failed receipt', async t => {
  const { inbox, dataDir } = await harness(t);
  await rejectsInput(() => inbox.receive({ files: [upload('../outside.bin', 'inert')] }), /路径/);
  await rejectsInput(() => inbox.receive({ files: [{ name: 'bad.bin', data: '!!!!' }] }), /编码无效/);
  await rejectsInput(() => inbox.receive({ text: 'x'.repeat(MATERIAL_LIMITS.textChars + 1) }), /材料文字无效或过长/);
  await rejectsInput(() => inbox.receive({}), /请选择原文件/);
  assert.deepEqual(inbox.list(), []);
  await assert.rejects(fs.stat(path.join(dataDir, 'input-blobs')), error => error.code === 'ENOENT');
});

test('concurrent receipts preserve every record while sharing identical original bytes', async t => {
  const { inbox, dataDir } = await harness(t);
  const received = await Promise.all(Array.from({ length: 4 }, (_, index) => inbox.receive({ files: [upload(`source-${index}.bin`, originalText)] })));
  assert.equal(inbox.list().length, 4);
  assert.equal(new Set(received.map(record => record.id)).size, 4);
  assert.equal((await fs.readdir(path.join(dataDir, 'input-blobs'))).length, 1);
  for (const record of received) assert.equal(Buffer.from((await inbox.loadFiles(record.id))[0].data, 'base64').toString(), originalText);
});

test('a failed main-state commit leaves existing records unchanged and keeps source bytes', async t => {
  const { dataDir, store } = await harness(t);
  await store.close();
  let failNext = false;
  const failingStore = await createStore({ dataDir, atomicWriter: async (filename, bytes) => {
    if (failNext) { failNext = false; throw new Error('Synthetic state write failure'); }
    return atomicWrite(filename, bytes);
  } });
  const inbox = createMaterialInbox({ store: failingStore });
  const first = await inbox.receive({ files: [upload('retained.bin', originalText)] });
  failNext = true;
  await assert.rejects(inbox.update(first.id, { status: 'failed', error: 'Must not commit.' }), /Synthetic state write failure/);
  assert.deepEqual(inbox.get(first.id), first);
  failNext = true;
  const newBytes = Buffer.from('Original bytes are retained when metadata commit fails.');
  await assert.rejects(inbox.receive({ files: [upload('pending.bin', newBytes)] }), /Synthetic state write failure/);
  assert.equal(inbox.list().length, 1);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'input-blobs', hash(newBytes))), newBytes);
  assert.deepEqual(await inbox.loadFiles(first.id), [upload('retained.bin', originalText)]);
  await failingStore.close();
});
