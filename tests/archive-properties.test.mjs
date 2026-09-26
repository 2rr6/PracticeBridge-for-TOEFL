import test from 'node:test';
import assert from 'node:assert/strict';
import { readArchive, writeArchive, collectEntry } from '../src/archive/zip-adapter.mjs';
import ZipFixture from './helpers/zip-fixture.mjs';
import fc from 'fast-check';

test('fast-check byte and Unicode path round trips with replayable shrinking', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.uint8Array({ maxLength: 4096 }), { maxLength: 15 }), async contents => {
    const entries = contents.map((bytes, index) => ({ name: `資料/é-${index}.bin`, bytes: Buffer.from(bytes) }));
    const { buffer } = await writeArchive({ entries });
    const actual = [];
    for await (const entry of readArchive({ inputRef: buffer })) actual.push({ name: entry.name, bytes: await collectEntry(entry) });
    assert.deepEqual(actual, entries);
  }), { seed: 0x5052026, numRuns: 80 });
});
// Reproducible property trials: seed is printed by assertion failure context.
test('seeded archive round-trip preserves names and bytes across empty, Unicode and binary members', async () => {
  let seed = 0x51a05; const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let trial = 0; trial < 40; trial++) {
    const entries = Array.from({ length: next() % 12 }, (_, index) => ({ name: `目录-${trial}/item-${index}.bin`, bytes: Buffer.from(Array.from({ length: next() % 2000 }, () => next() & 255)) }));
    const { buffer } = await writeArchive({ entries }); const actual = [];
    for await (const entry of readArchive({ inputRef: buffer })) actual.push({ name: entry.name, bytes: await collectEntry(entry) });
    assert.deepEqual(actual, entries, `trial ${trial}, seed ${seed}`);
  }
});
test('portable collision property rejects equivalent spelling for every generated path', async () => {
  for (let i = 0; i < 60; i++) {
    const zip = new ZipFixture(); zip.addFile(`Folder-${i}/Café.txt`, Buffer.from('a')); zip.addFile(`folder-${i}/Cafe\u0301.TXT`, Buffer.from('b'));
    await assert.rejects(async () => { for await (const entry of readArchive({ inputRef: zip.toBuffer() })) await collectEntry(entry); }, /重复/);
  }
});
