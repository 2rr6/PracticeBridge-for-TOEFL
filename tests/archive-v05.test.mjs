import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ZipFixture from './helpers/zip-fixture.mjs';
import { readArchive, writeArchive, collectEntry } from '../src/archive/zip-adapter.mjs';
import { createArchiveSession } from '../src/package.mjs';

const fixture = entries => { const zip = new ZipFixture(); for (const [name, bytes] of entries) zip.addFile(name, Buffer.from(bytes)); return zip.toBuffer(); };
const read = async (bytes, budget, signal) => { const files = new Map(); for await (const entry of readArchive({ inputRef: bytes, budget, signal })) files.set(entry.name, await collectEntry(entry)); return files; };
test('legacy deflated ZIP content survives async round trip and SHA-256 inventory', async () => {
  const bytes = fixture([['practicebridge.json', '{"id":"original"}'], ['音频/a.ogg', 'OggS original bytes']]);
  const files = await read(bytes);
  const result = await writeArchive({ entries: [...files].map(([name, bytes]) => ({ name, bytes })) });
  assert.deepEqual(await read(result.buffer), files); assert.equal(result.bytes, result.buffer.length);
  assert.match(result.hash, /^[a-f0-9]{64}$/); assert.equal(result.inventory.length, 2);
});
test('rejects hostile portable names, symlinks, duplicate names, unsupported flags and methods', async () => {
  for (const name of ['../escape', 'a\\b', 'C:/escape', '//server/share', '/root', 'a/../b', 'a./b', 'a /b', 'CON.txt', 'aux', 'lpt9.docx', 'a:NUL', 'a//b']) await assert.rejects(read(fixture([[name, 'x']])), /路径|文件名/);
  for (const pair of [['a', 'A'], ['café', 'cafe\u0301'], ['same', 'same'], ['a', 'a/b']]) await assert.rejects(read(fixture(pair.map(name => [name, 'x']))), /重复|冲突/);
  for (const [attribute, value, pattern] of [['attr', 0xa1ff << 16, /符号链接/], ['flags', 0x801, /加密/], ['flags', 0x820, /flag|标志/], ['method', 99, /方法/]]) {
    const zip = new ZipFixture(); zip.addFile('a', Buffer.from('x')).header[attribute] = value;
    await assert.rejects(read(zip.toBuffer()), pattern);
  }
});
test('declared budgets checked before entry exposure and actual bytes stop forged-size bombs', async () => {
  const zip = new ZipFixture(); zip.addFile('bomb', Buffer.alloc(1024 * 1024, 65));
  await assert.rejects(read(zip.toBuffer(), { maxExpandedBytes: 1000 }), /大小限制/);
  const forged = zip.toBuffer(), c = forged.indexOf(Buffer.from('504b0102', 'hex'));
  forged.writeUInt32LE(0, 22); forged.writeUInt32LE(0, c + 24);
  await assert.rejects(read(forged, { maxExpandedBytes: 1000, maxEntryBytes: 1000 }), /大小|校验/);
  let yielded = 0;
  await assert.rejects(async () => { for await (const entry of readArchive({ inputRef: fixture([['small', 'x'], ['large', 'xxx']]), budget: { maxEntryBytes: 2 } })) yielded++; }, /大小限制/);
  assert.equal(yielded, 0);
});

for (const declaredBytes of [0, 1]) {
  test(`forged declarations ${declaredBytes} cannot undercharge failed decompression and admit later ZIPs`, async () => {
    const session = createArchiveSession({ maxExpandedBytes: 9, maxEntries: 5 });
    const forged = fixture([['bad', Buffer.alloc(10000, 65)]]);
    const central = forged.indexOf(Buffer.from('504b0102', 'hex'));
    forged.writeUInt32LE(declaredBytes, 22); forged.writeUInt32LE(declaredBytes, central + 24);
    forged.writeUInt32LE(0, 14); forged.writeUInt32LE(0, central + 16);
    for (let index = 0; index < 4; index++) {
      await assert.rejects(session.read({ name: `bad-${index}.zip`, bytes: forged }), /校验|大小限制/);
    }
    await assert.rejects(session.read({ name: 'good.zip', bytes: fixture([['good', '12345']]) }), /大小限制/);
    // A forged zero must not get another decompression attempt just because
    // zero declared bytes would fit a numeric counter at its maximum.
    await assert.rejects(session.read({ name: 'after-zero.zip', bytes: forged }), /大小限制/);
    assert.equal(session.usage.entries, 1, 'only the first failing archive reached metadata/decompression');
  });
}

test('unknown failed cost also blocks the next entry stream of the same archive', async () => {
  const bytes = fixture([['bad', Buffer.alloc(10000, 65)], ['good', '12345']]);
  const central = bytes.indexOf(Buffer.from('504b0102', 'hex'));
  bytes.writeUInt32LE(1, 22); bytes.writeUInt32LE(1, central + 24);
  const budget = { maxExpandedBytes: 9, maxEntries: 2 };
  for await (const entry of readArchive({ inputRef: bytes, budget })) {
    await assert.rejects(collectEntry(entry), entry.name === 'bad' ? /校验/ : /预算已耗尽/);
  }
});

test('failed CRC retains shared batch budget before a companion archive is considered', async () => {
  const usage = { expandedBytes: 0, entries: 0 };
  const corrupt = fixture([['bad', '12345']]), central = corrupt.indexOf(Buffer.from('504b0102', 'hex'));
  corrupt.writeUInt32LE(0, 14); corrupt.writeUInt32LE(0, central + 16);
  const budget = { maxExpandedBytes: 9, maxEntries: 3, usage };
  await assert.rejects(read(corrupt, budget), /校验/);
  assert.equal(usage.expandedBytes, 9, 'CRC failure conservatively retains all remaining budget');
  assert.equal(usage.exhausted, true);
  await assert.rejects(read(fixture([['next', '12345']]), budget), /大小限制/);
});

test('recognition fallback reuses both success and rejection without a second decompression or budget reset', async () => {
  const session = createArchiveSession({ maxExpandedBytes: 9, maxEntries: 3 });
  const file = { name: 'safe.zip', bytes: fixture([['a', '12345']]) };
  const first = await session.read(file); assert.equal((await session.read(file)), first);
  assert.deepEqual(session.usage, { expandedBytes: 5, entries: 1 });
  const bad = { name: 'bad.zip', bytes: fixture([['b', '123']]) }, central = bad.bytes.indexOf(Buffer.from('504b0102', 'hex'));
  bad.bytes.writeUInt32LE(0, 14); bad.bytes.writeUInt32LE(0, central + 16);
  await assert.rejects(session.read(bad), /校验/);
  const charged = session.usage;
  await assert.rejects(session.read(bad), /校验/);
  assert.deepEqual(session.usage, charged);
  assert.equal(charged.expandedBytes, 9);
  assert.equal(charged.exhausted, true);
  assert.equal(await session.read(file), first, 'already verified companion content remains reusable');
  await assert.rejects(session.read({ name: 'next.zip', bytes: fixture([['c', '12']]) }), /大小限制/);
});
test('CRC corruption and cancellation reject without leaving output or replacing existing files', async t => {
  const bytes = fixture([['a', 'synthetic']]); bytes[31] ^= 0xff; await assert.rejects(read(bytes), /校验/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(read(fixture([['a', 'x']]), {}, controller.signal), /abort/i);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pb-zip-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'output.zip');
  async function* cancelling() { yield { name: 'a', bytes: Buffer.from('x') }; throw new Error('cancel fixture'); }
  await assert.rejects(writeArchive({ entries: cancelling(), outputRef: target }), /cancel fixture/);
  assert.deepEqual(await readdir(dir), []);
  const result = await writeArchive({ entries: [{ name: 'a', bytes: Buffer.from('x') }], outputRef: target });
  assert.equal(result.bytes, (await readFile(target)).length);
  await assert.rejects(writeArchive({ entries: [], outputRef: target }), /EEXIST/);
});

test('in-flight decompression abort, early stream return and unconsumed stream release all settle', { timeout: 3000 }, async () => {
  const bytes = fixture([['large', Buffer.alloc(2 * 1024 * 1024, 42)]]);
  const controller = new AbortController(); let chunks = 0;
  await assert.rejects(async () => {
    for await (const entry of readArchive({ inputRef: bytes, signal: controller.signal })) {
      for await (const chunk of entry.openStream()) { assert.ok(chunk.length); chunks++; controller.abort(); }
    }
  }, /abort/i);
  assert.equal(chunks, 1);
  for await (const entry of readArchive({ inputRef: bytes })) { for await (const chunk of entry.openStream()) { assert.ok(chunk.length); break; } break; }
  for await (const entry of readArchive({ inputRef: bytes })) { entry.openStream(); break; }
});

test('file reader releases handles and writer abort removes only its incomplete temporary archive', { timeout: 3000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pb-zip-stream-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'original.zip'); const original = fixture([['a', 'original']]);
  await writeFile(input, original);
  assert.equal((await read(input)).get('a').toString(), 'original');
  const controller = new AbortController(); let returned = false;
  async function* source() {
    try { yield Buffer.alloc(4096, 1); controller.abort(); yield Buffer.alloc(4096, 2); }
    finally { returned = true; }
  }
  await assert.rejects(writeArchive({ entries: [{ name: 'large', openStream: source }], outputRef: path.join(dir, 'new.zip'), signal: controller.signal }), /abort/i);
  assert.equal(returned, true);
  assert.deepEqual(await readdir(dir), ['original.zip']);
  assert.deepEqual(await readFile(input), original);
});
