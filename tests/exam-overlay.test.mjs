import {appFetch} from './auth-client.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ZipFixture from './helpers/zip-fixture.mjs';
import { createExamOverlay, validateExamOverlayReferences } from '../src/exam-overlay.mjs';
import { buildExamPlan } from '../src/exam-plan.mjs';
import { canonicalJSON, collectMediaPaths, contentHash, readZip, validatePackage } from '../src/package.mjs';
import { createStore, runtimeLibrary } from '../src/store.mjs';
import { createMaterialInbox } from '../src/materials.mjs';
import { startServer } from '../src/server.mjs';

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-results/exam-overlay');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const upload = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });
const tasks = plan => plan.sections.flatMap(section => section.modules.flatMap(module => module.tasks));
const clips = plan => tasks(plan).flatMap(task => task.directions).filter(direction => direction.audio);
const source = (section, module, n) => `original.pdf · 第 31 页 · 第 ${n + 3} 行 · ${section}${module ? ` Section, Module ${module}` : ''} · 原题号 ${n}`;

function wave(seed = 1) {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  bytes.writeInt16LE(seed, 44); bytes.writeInt16LE(-seed, 46);
  return bytes;
}

// Original synthetic text and audio only. The filenames exercise the legacy
// converter's structural convention; no source exam content is included.
function fixture({ pdf = false } = {}) {
  const groups = [], files = new Map(); let seed = 1;
  const media = name => { files.set(name, wave(seed++)); return name; };
  for (const module of [1, 2]) {
    const ranges = module === 1 ? [[9, 10, 'Conversation'], [11, 12, 'Conversation'], [13, 14, 'Announcements'], [15, 18, 'Academic Talks']] : [[9, 10, 'Conversation'], [11, 12, 'Announcements'], [13, 16, 'Academic Talks']];
    ranges.forEach(([first, last, category], index) => groups.push({
      id: `listening-m${module}-g${index + 1}`, section: 'listening', title: `Listening · Module ${module} · ${category === 'Announcements' ? 'Listen to an announcement.' : category === 'Academic Talks' ? 'Listen to a talk.' : 'Listen to a conversation.'}`,
      passage: `${category === 'Conversation' ? 'Listen to a conversation.' : category === 'Announcements' ? 'Listen to an announcement in a classroom.' : 'Listen to a talk in a class.'}\nAn original speaker describes a small library.`,
      audio: media(`audio/Listening${module}_${category}_Questions${first}-${last}.wav`),
      questions: Array.from({ length: last - first + 1 }, (_, i) => ({ id: `listening-m${module}-q${first + i}`, type: 'single_choice', prompt: 'Which place is described?', options: [{ id: 'A', text: 'A library.' }, { id: 'B', text: 'A park.' }], answer: 'A', source: source('Listening', module, first + i) })),
    }));
    for (const [first, last, category] of ranges) media(`audio/Listening${module}_${category}_Directions${first}-${last}.wav`);
  }
  for (const [index, type, category] of [[1, 'listen_repeat', 'Listen Repeat'], [2, 'interview', 'Interview']]) {
    groups.push({ id: `speaking-g${index}`, section: 'speaking', title: category, passage: `Original ${category} directions.`, questions: [{ id: `speaking-${index === 1 ? 'repeat' : 'interview'}-q1`, type, prompt: 'Describe the open library.', answer: type === 'listen_repeat' ? 'The library opens today.' : null, audio: media(`audio/Speaking_${category}_Question1.wav`), source: source('Speaking', null, 1) }] });
    media(`audio/Speaking_${category}_Directions.wav`);
  }
  const rows = [
    [72, 760, 'Write for an Academic Discussion'], [72, 730, 'A professor asks a question and students respond.'], [72, 700, 'You will have 10 minutes to write.'], [72, 650, 'An effective response will contain at least 100 words.'],
    [72, 480, 'Should a class share a small bookshelf?'], [72, 465, 'Explain your view using an example.'],
    [160, 380, 'Sharing books makes new subjects easier to explore.'], [160, 365, 'A shelf gives us a reason to discuss our interests.'],
    [160, 330, 'We need a way to keep the shelf tidy.'], [160, 315, 'Clear labels could make the collection manageable.'],
  ];
  const discussionText = rows.map(row => row[2]).join('\n');
  groups.push({ id: 'writing-g3', section: 'writing', title: 'Original discussion', passage: '', questions: [{ id: 'writing-discussion-q1', type: 'discussion', prompt: discussionText, source: source('Writing', null, 1) }] });
  const raw = { schemaVersion: 1, id: `exam-${'b'.repeat(16)}`, version: '1.0.0', title: 'Original legacy overlay fixture', rights: 'Original synthetic exercises.', groups };
  const checked = validatePackage(raw, files);
  assert.deepEqual(checked.issues.filter(issue => issue.severity === 'error'), []);
  const mediaMap = Object.fromEntries(collectMediaPaths(checked.pack).map(name => [name, sha(files.get(name))]));
  const library = { libraryId: crypto.randomUUID(), importedAt: new Date().toISOString(), originalPack: checked.pack, mediaMap, contentHash: contentHash(checked.pack, mediaMap) };
  const zip = new ZipFixture(); for (const [name, bytes] of files) zip.addFile(name, bytes);
  const uploads = [upload('original-audio.zip', zip.toBuffer())];
  if (pdf) uploads.push(upload('original.pdf', Buffer.from('%PDF-1.7\nSynthetic extraction is supplied by the test.')));
  const chunk = { name: 'original.pdf', page: 31, kind: 'pdf', text: discussionText, layout: { width: 600, height: 800, items: rows.map(([x, y, str]) => ({ x, y, str, width: 360, height: 12, hasEOL: true })) } };
  const materials = [{ id: crypto.randomUUID(), libraryId: library.libraryId, files: uploads.map(file => { const bytes = Buffer.from(file.data, 'base64'); return { id: sha(bytes), name: file.name, size: bytes.length }; }) }];
  return { library, runtime: runtimeLibrary(library), files, uploads, materials, chunk };
}

function fakeInbox(f, { uploadsById } = {}) {
  const counts = { reads: 0 };
  const inbox = {
    get(id) { const found = f.materials.find(material => material.id === id); if (!found) throw new Error('Unknown material'); return structuredClone(found); },
    async loadFiles(id) { counts.reads += 1; inbox.get(id); return structuredClone(uploadsById?.get(id) || f.uploads); },
  };
  return { inbox, counts };
}

test('legacy originals supply nine instruction clips and verified discussion layout without mutating stored content', async () => {
  const f = fixture({ pdf: true }), before = canonicalJSON({ library: f.library, runtime: f.runtime, materials: f.materials });
  const { inbox, counts } = fakeInbox(f); let extractions = 0;
  const overlay = createExamOverlay({ inbox, extractSources: async () => { extractions += 1; return { chunks: [f.chunk], issues: [] }; } });
  const result = await overlay.project(f.library, f.runtime, f.materials), plan = buildExamPlan(result.pack, { mediaCatalog: result.mediaCatalog });
  assert.equal(clips(plan).length, 9);
  assert.equal(result.extraMedia.length, 9);
  assert.ok(clips(plan).every(clip => clip.audio.startsWith(`/api/exam-media/${f.materials[0].id}/`) && clip.basis === 'filename' && clip.verifiedContent === false));
  const discussion = result.pack.groups.find(group => group.id === 'writing-g3').presentation.discussion;
  assert.equal(discussion.posts.length, 2);
  assert.match(discussion.prompt, /Should a class share/);
  assert.equal(canonicalJSON({ library: f.library, runtime: f.runtime, materials: f.materials }), before);
  assert.equal(contentHash(f.library.originalPack, f.library.mediaMap), f.library.contentHash);
  for (const descriptor of result.extraMedia) {
    const loaded = await overlay.readMedia(descriptor.materialId, descriptor.hash);
    assert.deepEqual(loaded.bytes, f.files.get(descriptor.name));
    assert.equal(sha(loaded.bytes), descriptor.hash);
  }
  result.pack.groups[0].title = 'Changed by a caller';
  const again = await overlay.project(f.library, f.runtime, f.materials);
  assert.notEqual(again.pack.groups[0].title, 'Changed by a caller');
  assert.equal(counts.reads, 1); assert.equal(extractions, 1);
  overlay.clear();
  await overlay.project(f.library, f.runtime, f.materials);
  assert.equal(counts.reads, 2); assert.equal(extractions, 2);
});

test('identical original copies do not create audio or PDF ambiguity; different audio bytes do', async () => {
  const f = fixture({ pdf: true });
  f.materials.push({ ...structuredClone(f.materials[0]), id: crypto.randomUUID() });
  const { inbox } = fakeInbox(f); let extractions = 0;
  const overlay = createExamOverlay({ inbox, extractSources: async () => { extractions += 1; return { chunks: [f.chunk], issues: [] }; } });
  const duplicate = await overlay.project(f.library, f.runtime, f.materials);
  assert.equal(duplicate.extraMedia.length, 9);
  assert.equal(duplicate.pack.groups.find(group => group.id === 'writing-g3').presentation.discussion.posts.length, 2);
  assert.equal(extractions, 1);
  const altered = await ZipFixture.from(Buffer.from(f.uploads[0].data, 'base64'));
  const name = [...f.files.keys()].find(name => name.includes('Directions'));
  altered.updateFile(name, wave(999));
  const alternative = [upload('original-audio.zip', altered.toBuffer()), f.uploads[1]];
  const secondInbox = fakeInbox(f, { uploadsById: new Map([[f.materials[1].id, alternative]]) }).inbox;
  const conflict = await createExamOverlay({ inbox: secondInbox, extractSources: async () => ({ chunks: [f.chunk], issues: [] }) }).project(f.library, f.runtime, f.materials);
  assert.equal(conflict.extraMedia.length, 8);
  assert.ok(conflict.issues.some(issue => /未自动选择/.test(issue.message)));
  assert.ok(!conflict.extraMedia.some(media => media.name === name));
});

test('unreadable originals preserve plain fallback and cannot bypass validated media reads', async () => {
  const f = fixture({ pdf: true }), originalPrompt = f.library.originalPack.groups.at(-1).questions[0].prompt;
  const inbox = fakeInbox(f).inbox;
  inbox.loadFiles = async () => [upload('bad.zip', Buffer.from('This is not a ZIP archive.'))];
  const overlay = createExamOverlay({ inbox, extractSources: async () => { throw new Error('Should not extract invalid archives'); } });
  const result = await overlay.project(f.library, f.runtime, f.materials);
  assert.equal(result.extraMedia.length, 0);
  assert.equal(result.pack.groups.at(-1).questions[0].prompt, originalPrompt);
  assert.equal(result.pack.groups.at(-1).presentation.discussion, undefined);
  assert.ok(result.issues.some(issue => /未通过读取检查/.test(issue.message)));
  await assert.rejects(overlay.readMedia('../outside', '0'.repeat(64)), error => error.status === 404);
  await assert.rejects(overlay.readMedia(f.materials[0].id, '0'.repeat(64)), /ZIP|zip|压缩/);
});

test('clearing an in-flight projection prevents stale media from entering the next workspace cache', async () => {
  const f = fixture({ pdf: true }), { inbox, counts } = fakeInbox(f);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocker = new Promise(resolve => { release = resolve; });
  const overlay = createExamOverlay({ inbox, extractSources: async () => { entered(); await blocker; return { chunks: [f.chunk], issues: [] }; } });
  const pending = overlay.project(f.library, f.runtime, f.materials);
  await ready; overlay.clear(); release();
  await assert.rejects(pending, error => error.status === 409);
  const next = await overlay.project(f.library, f.runtime, f.materials);
  assert.equal(next.extraMedia.length, 9);
  assert.equal(counts.reads, 2);
});

test('ordinary packages and existing native exam contracts never trigger legacy original extraction', async () => {
  const f = fixture(), { inbox, counts } = fakeInbox(f), overlay = createExamOverlay({ inbox });
  const ordinary = structuredClone(f.library); ordinary.originalPack.id = 'ordinary-material';
  const one = await overlay.project(ordinary, f.runtime, f.materials);
  assert.equal(one.pack, f.runtime); assert.equal(one.extraMedia.length, 0);
  const native = structuredClone(f.library); native.originalPack.examSets = [];
  const two = await overlay.project(native, f.runtime, f.materials);
  assert.equal(two.pack, f.runtime); assert.equal(counts.reads, 0);
});

test('frozen URLs validate against hashed backup originals, including referenced inner ZIP bytes', async () => {
  const f = fixture(), overlay = createExamOverlay({ inbox: fakeInbox(f).inbox });
  const projected = await overlay.project(f.library, f.runtime, f.materials);
  const state = { materials: f.materials, sessions: [{ sessionVersion: 2, planSnapshot: buildExamPlan(projected.pack, { mediaCatalog: projected.mediaCatalog }) }] };
  const originals = new Map(f.uploads.map(file => { const bytes = Buffer.from(file.data, 'base64'); return [sha(bytes), bytes]; }));
  await assert.doesNotReject(() => validateExamOverlayReferences(state, originals));
  const badHash = structuredClone(state); clips(badHash.sessions[0].planSnapshot)[0].audio = `/api/exam-media/${f.materials[0].id}/${'0'.repeat(64)}`;
  await assert.rejects(() => validateExamOverlayReferences(badHash, originals), /找不到/);
  const missingMaterial = structuredClone(state); missingMaterial.materials = [];
  await assert.rejects(() => validateExamOverlayReferences(missingMaterial, originals), /缺失/);
  await assert.rejects(() => validateExamOverlayReferences(state, new Map()), /不完整/);
  const malformed = structuredClone(state); clips(malformed.sessions[0].planSnapshot)[0].audio += '/outside';
  await assert.rejects(() => validateExamOverlayReferences(malformed, originals), /地址无效/);
});

async function harness(t) {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(TEST_ROOT, 'run-')), f = fixture();
  const store = await createStore({ dataDir }), inbox = createMaterialInbox({ store });
  const infos = [];
  for (const name of Object.keys(f.library.mediaMap)) infos.push(await store.writeBlob(f.files.get(name), 'audio/wav'));
  await store.transact(state => { state.libraries.push(f.library); for (const info of infos) state.blobs[info.id] = info; });
  const material = await inbox.receive({ title: 'Original legacy material', files: f.uploads });
  await inbox.update(material.id, { libraryId: f.library.libraryId, status: 'imported' });
  await store.close();
  const models = { publicSettings: () => ({ provider: 'none', capabilities: {} }), feedback: () => { throw new Error('No model service may run in this test'); } };
  const h = { dataDir, f, materialId: material.id, instance: await startServer({ dataDir, models }) };
  h.api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await appFetch(h.instance.url + route, { method, headers: { 'X-PracticeBridge': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  h.backup = async () => Buffer.from(await (await appFetch(h.instance.url + '/api/backup')).arrayBuffer());
  h.restart = async () => { await h.instance.close(); h.instance = await startServer({ dataDir, models }); };
  t.after(async () => {
    await h.instance.close();
    const checked = path.resolve(dataDir);
    assert.ok(checked.startsWith(`${TEST_ROOT}${path.sep}`), 'Only the newly created test directory can be removed');
    await fs.rm(checked, { recursive: true, force: true });
  });
  return h;
}

test('HTTP legacy overlay survives restart and backup restore while source export and original library stay unchanged', async t => {
  const h = await harness(t), stateFile = path.join(h.dataDir, 'state.json'), beforeRead = await fs.readFile(stateFile, 'utf8');
  const publicState = await h.api('/api/state');
  assert.equal(publicState.status, 200, JSON.stringify(publicState.body));
  const library = publicState.body.libraries[0];
  assert.equal(library.extraMedia.length, 9); assert.equal(clips(library.examPlan).length, 9);
  assert.equal(await fs.readFile(stateFile, 'utf8'), beforeRead, 'Read-only projection must not persist any runtime metadata');
  const create = await h.api('/api/sessions', { sessionVersion: 2, libraryId: library.libraryId, mode: 'exam' });
  assert.equal(create.status, 200, JSON.stringify(create.body));
  assert.equal(clips(create.body.session.planSnapshot).length, 9);
  const clip = library.extraMedia[0], url = clip.url, expected = h.f.files.get(clip.name);
  const partial = await appFetch(h.instance.url + url, { headers: { Range: 'bytes=12-23' } });
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('Content-Range'), `bytes 12-23/${expected.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), expected.subarray(12, 24));
  const head = await appFetch(h.instance.url + url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('Content-Length')), expected.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await appFetch(h.instance.url + url, { headers: { Range: 'bytes=9999-' } })).status, 416);
  const exported = await readZip(Buffer.from(await (await appFetch(`${h.instance.url}/api/library/${library.libraryId}/export`)).arrayBuffer()));
  assert.equal(canonicalJSON(JSON.parse(exported.get('practicebridge.json'))), canonicalJSON(h.f.library.originalPack));
  assert.equal([...exported.keys()].some(name => /Directions/.test(name)), false);
  const backup = await h.backup(), manifest = JSON.parse((await readZip(backup)).get('practicebridge-backup.json'));
  assert.equal(manifest.state.libraries[0].contentHash, h.f.library.contentHash);
  assert.equal(canonicalJSON(manifest.state.libraries[0]), canonicalJSON(h.f.library));
  assert.ok(manifest.state.sessions[0].planSnapshot);
  await h.restart();
  const uncached = await appFetch(h.instance.url + url);
  assert.equal(uncached.status, 200); assert.deepEqual(Buffer.from(await uncached.arrayBuffer()), expected);
  const restored = await h.api('/api/restore', { file: upload('synthetic-backup.zip', backup) });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const restoredMedia = await appFetch(h.instance.url + url);
  assert.equal(restoredMedia.status, 200); assert.deepEqual(Buffer.from(await restoredMedia.arrayBuffer()), expected);
  const restoredSession = (await h.api(`/api/sessions/${create.body.session.id}`)).body.session;
  assert.notEqual(restoredSession.writerToken, create.body.session.writerToken);
  assert.equal(canonicalJSON(restoredSession.planSnapshot), canonicalJSON(create.body.session.planSnapshot));
});

test('HTTP restore rejects a dangling overlay URL before replacing any workspace state', async t => {
  const h = await harness(t);
  const created = await h.api('/api/sessions', { sessionVersion: 2, libraryId: h.f.library.libraryId, mode: 'practice' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const zip = await ZipFixture.from(await h.backup()), manifest = JSON.parse(zip.getEntry('practicebridge-backup.json').getData());
  clips(manifest.state.sessions[0].planSnapshot)[0].audio = `/api/exam-media/${h.materialId}/${'0'.repeat(64)}`;
  zip.updateFile('practicebridge-backup.json', Buffer.from(JSON.stringify(manifest)));
  const before = await fs.readFile(path.join(h.dataDir, 'state.json'), 'utf8');
  const refused = await h.api('/api/restore', { file: upload('dangling-media.zip', zip.toBuffer()) });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /说明音频/);
  assert.equal(await fs.readFile(path.join(h.dataDir, 'state.json'), 'utf8'), before);
});
