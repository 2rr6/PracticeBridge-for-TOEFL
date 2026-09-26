import test from 'node:test';
import assert from 'node:assert/strict';
import ZipFixture from './helpers/zip-fixture.mjs';
import { LIMITS, InputError, prepareImportFiles, parseNativeImport, readZip, createPackageZip, validatePackage } from '../src/package.mjs';

// Every fixture is generated here from original, inert content; no user documents or audio are bundled.
const upload = (name, value) => ({ name, data: Buffer.from(value).toString('base64') });
const archive = entries => {
  const zip = new ZipFixture();
  for (const [name, bytes] of entries) zip.addFile(name, Buffer.from(bytes));
  return zip.toBuffer();
};
const ogg = () => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24)]);
const originalPack = () => ({
  schemaVersion: 1, id: 'archive-test', version: '1', title: 'An original archive test', rights: 'Original synthetic fixture.',
  groups: [{ id: 'listening', section: 'listening', title: 'The library', audio: 'audio/library.ogg', questions: [
    { id: 'hours', type: 'single_choice', prompt: 'When does the library open?', options: [{ id: 'A', text: 'Eight' }, { id: 'B', text: 'Nine' }], answer: 'A' },
  ] }],
});
const changeCentralSizes = (bytes, size) => {
  const result = Buffer.from(bytes);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while ((offset = result.indexOf(signature, offset)) !== -1) {
    result.writeUInt32LE(size, offset + 24);
    offset += 46;
  }
  return result;
};
const expectInputError = (fn, pattern) => assert.rejects(fn, error => error instanceof InputError && error.status === 400 && pattern.test(error.message));

test('a PDF and an audio-only ZIP become ordinary materials without requiring a manifest', async () => {
  const audioName = 'Practice Materials/Listening/Short Talks/talk 01.ogg';
  const pdfBytes = Buffer.from('%PDF-1.7\nOriginal synthetic intake fixture, not a rendered document.');
  const inputs = [upload('worksheet.pdf', pdfBytes), upload('audio-files.zip', archive([[audioName, ogg()]]))];
  const result = (await prepareImportFiles(inputs));
  assert.equal(result.native, null);
  assert.equal((await parseNativeImport(inputs)), null);
  assert.deepEqual([...result.files.keys()].sort(), [audioName, 'worksheet.pdf'].sort());
  assert.deepEqual(result.files.get(audioName), ogg());
  assert.deepEqual(result.files.get('worksheet.pdf'), pdfBytes);
  assert.ok(!result.files.has('audio-files.zip'));
});

test('ordinary document archives preserve nested paths and allow separate media archives', async () => {
  const result = (await prepareImportFiles([
    upload('documents.zip', archive([['Lesson/notes.md', '# Original lesson\nCheck the opening time.'], ['Lesson/question.txt', 'An original question.']])),
    upload('media.zip', archive([['audio/talk.ogg', ogg()]])),
  ]));
  assert.equal(result.native, null);
  assert.deepEqual([...result.files.keys()].sort(), ['Lesson/notes.md', 'Lesson/question.txt', 'audio/talk.ogg']);
});

test('native exports retain their package, media, source, and validation behavior', async () => {
  const pack = originalPack();
  const inputs = [upload('export.zip', (await createPackageZip(pack, new Map([['audio/library.ogg', ogg()]]))))];
  const { native, files } = (await prepareImportFiles(inputs));
  assert.equal(native.method, 'native-zip');
  assert.equal(native.files, files);
  assert.deepEqual(native.pack, pack);
  assert.equal(native.sources[0].name, 'practicebridge.json');
  assert.deepEqual(JSON.parse(native.sources[0].text), pack);
  assert.deepEqual((await parseNativeImport(inputs)).pack, pack);
  assert.equal(validatePackage(native.pack, files).issues.filter(issue => issue.severity === 'error').length, 0);
});

test('native packages accept a common enclosing folder and keep media references valid', async () => {
  const pack = originalPack();
  const result = (await prepareImportFiles([upload('wrapped.zip', archive([
    ['Release/Version 1/PracticeBridge.JSON', JSON.stringify(pack)],
    ['Release/Version 1/audio/library.ogg', ogg()],
  ]))]));
  assert.equal(result.native.method, 'native-zip');
  assert.deepEqual([...result.files.keys()].sort(), ['PracticeBridge.JSON', 'audio/library.ogg']);
  assert.equal(result.native.pack.groups[0].audio, 'audio/library.ogg');
  assert.equal(validatePackage(result.native.pack, result.files).issues.filter(issue => issue.severity === 'error').length, 0);
});

test('a separately supplied JSON manifest can use an ordinary media ZIP', async () => {
  const pack = originalPack();
  const { native, files } = (await prepareImportFiles([
    upload('my-lesson.json', JSON.stringify(pack)),
    upload('media.zip', archive([['audio/library.ogg', ogg()]])),
  ]));
  assert.equal(native.method, 'native-json');
  assert.equal(native.sources[0].name, 'my-lesson.json');
  assert.deepEqual(native.pack, pack);
  assert.ok(files.has('audio/library.ogg'));
});

test('invalid native manifests fail explicitly instead of falling back to AI input', async () => {
  for (const inputs of [
    [upload('practicebridge.json', '{broken')],
    [upload('invalid.zip', archive([['practicebridge.json', '{broken']]))],
    [upload('wrapped-invalid.zip', archive([['Lesson/practicebridge.json', '{broken']]))],
  ]) await expectInputError(async () => (await prepareImportFiles(inputs)), /JSON 无法解析/);
  await expectInputError(async () => (await prepareImportFiles([upload('missing-manifest.zip', archive([['lesson.json', JSON.stringify(originalPack())]]))])), /缺少 practicebridge\.json/);
});

test('multiple native manifests or a manifest outside a common wrapper are ambiguous', async () => {
  await expectInputError(async () => (await prepareImportFiles([upload('two.zip', archive([
    ['a/practicebridge.json', '{}'], ['b/practicebridge.json', '{}'],
  ]))])), /多个 practicebridge\.json/);
  await expectInputError(async () => (await prepareImportFiles([
    upload('a.zip', archive([['a/practicebridge.json', '{}']])),
    upload('b.zip', archive([['b/practicebridge.json', '{}']])),
  ])), /重复文件名|一个练习包/);
  await expectInputError(async () => (await prepareImportFiles([upload('mixed.zip', archive([
    ['Lesson/practicebridge.json', '{}'], ['elsewhere/talk.ogg', ogg()],
  ]))])), /同一个外层文件夹/);
});

test('duplicate names across archives and direct uploads never silently replace materials', async () => {
  await expectInputError(async () => (await prepareImportFiles([
    upload('a.zip', archive([['audio/talk.ogg', ogg()]])),
    upload('b.zip', archive([['Audio/TALK.ogg', ogg()]])),
  ])), /重复文件名/);
  await expectInputError(async () => (await prepareImportFiles([
    upload('a.zip', archive([['talk.ogg', ogg()]])), upload('TALK.ogg', ogg()),
  ])), /重复文件名/);
  await expectInputError(async () => (await prepareImportFiles([
    upload('A.zip', archive([['one.txt', 'one']])), upload('a.ZIP', archive([['two.txt', 'two']])),
  ])), /重复文件名/);
  await expectInputError(async () => (await prepareImportFiles([
    upload('one.zip', archive([['caf\u00e9.txt', 'one']])), upload('cafe\u0301.txt', 'two'),
  ])), /重复文件名/);
});

test('unsupported files and nested archives report processing errors', async () => {
  for (const name of ['launch.exe', 'run.ps1', 'page.html', 'nested.zip']) {
    await expectInputError(async () => (await prepareImportFiles([upload('materials.zip', archive([[name, 'inert fixture']]))])), /不支持导入此文件/);
  }
  await expectInputError(async () => (await prepareImportFiles([upload('empty.zip', archive([]))])), /没有可导入的文件/);
});

test('malformed archive data and central directories return clear input errors', async () => {
  await expectInputError(async () => (await prepareImportFiles([upload('broken.zip', 'not a ZIP')])), /无法打开 ZIP/);
  const damaged = archive([['notes.txt', 'Original inert material.']]);
  const central = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  damaged[central] = 0;
  await expectInputError(async () => (await prepareImportFiles([upload('broken-directory.zip', damaged)])), /无法打开 ZIP/);
});

test('ordinary ZIP processing retains traversal, symlink, duplicate, and encryption gates', async () => {
  const unsafe = archive([['xx/outside.txt', 'inert']]);
  let offset = 0;
  while ((offset = unsafe.indexOf('xx/outside.txt', offset)) >= 0) {
    unsafe.write('../outside.txt', offset); offset += 14;
  }
  await expectInputError(async () => (await prepareImportFiles([upload('unsafe.zip', unsafe)])), /路径/);
  const link = new ZipFixture();
  link.addFile('linked.ogg', ogg());
  link.getEntry('linked.ogg').header.attr = (0xa1ff << 16) >>> 0;
  await expectInputError(async () => (await prepareImportFiles([upload('symlink.zip', link.toBuffer())])), /符号链接/);
  await expectInputError(async () => (await prepareImportFiles([upload('duplicate.zip', archive([['talk.ogg', ogg()], ['TALK.ogg', ogg()]]))])), /重复文件名/);
  const encrypted = archive([['secret.txt', 'inert']]);
  const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  await expectInputError(async () => (await prepareImportFiles([upload('encrypted.zip', encrypted)])), /已加密/);
});

test('declared archive expansion and member sizes are checked before decompression', async () => {
  const oversized = changeCentralSizes(archive([['oversized.txt', 'inert']]), LIMITS.fileBytes + 1);
  await expectInputError(async () => (await prepareImportFiles([upload('oversized.zip', oversized)])), /解压后超过大小限制/);
  const bomb = changeCentralSizes(archive(Array.from({ length: 7 }, (_, index) => [`part-${index}.txt`, 'inert'])), 24 * 1024 * 1024);
  await expectInputError(async () => (await prepareImportFiles([upload('bomb.zip', bomb)])), /解压后超过大小限制/);
});

test('combined loose files and archive entries share the expansion budget', async () => {
  const loose = Buffer.alloc(24 * 1024 * 1024, 32);
  const bomb = changeCentralSizes(archive(Array.from({ length: 6 }, (_, index) => [`part-${index}.txt`, 'inert'])), 24 * 1024 * 1024);
  await expectInputError(async () => (await prepareImportFiles([upload('notes.txt', loose), upload('bomb.zip', bomb)])), /解压后超过大小限制/);
});

test('multiple ordinary archives share an entry count budget', async () => {
  const first = archive(Array.from({ length: 600 }, (_, index) => [`first-${index}.txt`, 'x']));
  const second = archive(Array.from({ length: 601 }, (_, index) => [`second-${index}.txt`, 'x']));
  await expectInputError(async () => (await prepareImportFiles([upload('first.zip', first), upload('second.zip', second)])), /文件数量过多/);
});

test('false uncompressed sizes and corrupted payloads are rejected, including declared-empty members', async () => {
  const bytes = archive([['notes.txt', 'Original synthetic text repeated. '.repeat(40)]]);
  for (const size of [0, 1]) {
    await expectInputError(async () => (await prepareImportFiles([upload('wrong-size.zip', changeCentralSizes(bytes, size))])), /ZIP 文件校验失败|ZIP 文件大小不一致/);
  }
  const corrupted = Buffer.from(bytes);
  const nameLength = corrupted.readUInt16LE(26);
  const extraLength = corrupted.readUInt16LE(28);
  corrupted[30 + nameLength + extraLength] ^= 0xff;
  await expectInputError(async () => (await prepareImportFiles([upload('corrupt.zip', corrupted)])), /ZIP 文件校验失败/);
  assert.deepEqual((await readZip(archive([['empty.txt', '']]))).get('empty.txt'), Buffer.alloc(0));
});
