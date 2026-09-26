import {appFetch} from './auth-client.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import ZipFixture from './helpers/zip-fixture.mjs';
import { startServer } from '../src/server.mjs';
import { validatePackage,readZip } from '../src/package.mjs';

const root = path.resolve('data/.material-http-tests');
const upload = (name, text) => ({ name, data: Buffer.from(text).toString('base64') });
const worksheet = 'Reading: Original garden fixture\nPassage:\nThe gate opens at nine.\nQuestions:\n1. When does the gate open?\nA. Nine.\nB. Ten.\nAnswer key: 1 A';
const models = overrides => ({
  publicSettings: () => ({ provider: 'fixture', baseUrl: 'http://127.0.0.1:9/v1', model: 'local-fixture', capabilities: { assessMaterials: true, structure: true } }),
  assessMaterials: async input => ({ status: input.sources.length ? 'processable' : 'needs_information', summary: 'Original local fixture assessment.', detectedSections: ['reading'], missingInformation: [], recommendedProcessor: input.availableProcessors.find(p => p !== 'ai') || 'ai', warnings: [], canCreateDraft: input.sources.length > 0, provider: 'fixture', model: 'local-fixture' }),
  ...overrides,
});
async function harness(t, overrides) {
  await fs.mkdir(root, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(root, 'run-'));
  const m = models(overrides);
  const h = { dataDir, instance: await startServer({ dataDir, models: m }) };
  h.api = async (route, body) => {
    const r = await appFetch(h.instance.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-PracticeBridge': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  h.receive = async input => { const r = await h.api('/api/materials', input); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.material; };
  h.restart = async () => { await h.instance.close(); h.instance = await startServer({ dataDir, models: m }); };
  t.after(async () => { await h.instance.close(); assert.ok(path.resolve(dataDir).startsWith(root + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  return h;
}
test('HTTP receipt saves arbitrary originals with no parser or model prerequisite; failed assessment retains them', async t => {
  let calls = 0;
  const h = await harness(t, { publicSettings: () => ({ provider: 'none', capabilities: {} }), assessMaterials: () => { calls++; throw Error('Must not send'); } });
  const inputs = [upload('broken.zip', 'Not a ZIP'), upload('unfamiliar.xyz', '')];
  const material = await h.receive({ files: inputs, text: 'Keep this source.' });
  assert.equal(material.status, 'received'); assert.equal(calls, 0);
  const failed = await h.api(`/api/materials/${material.id}/assess`, { consent: true });
  assert.equal(failed.status, 400); assert.equal(calls, 0);
  await h.restart();
  const saved = (await h.api(`/api/materials/${material.id}`)).body.material;
  assert.deepEqual(saved.files, material.files); assert.equal(saved.text, 'Keep this source.');
  const original = await appFetch(`${h.instance.url}/api/materials/${material.id}/originals/0`);
  assert.equal(await original.text(), 'Not a ZIP'); assert.equal(original.headers.get('content-type'), 'application/octet-stream');
  assert.match(original.headers.get('content-disposition'), /^attachment/);
  const state = (await h.api('/api/state')).body;
  assert.equal(state.libraries.length, 0); assert.equal(state.materials.length, 1); assert.equal(state.materials[0].text, undefined);
});
test('AI assessment selects a supported converter; durable candidate edit reopens after restart and compiles atomically', async t => {
  const h = await harness(t);
  const material = await h.receive({ files: [upload('garden.txt', worksheet)], title: 'Garden draft' });
  const pathBase = `/api/materials/${material.id}`;
  assert.equal((await h.api(pathBase + '/convert', { consent: true })).status, 400);
  const assessed = await h.api(pathBase + '/assess', { consent: true });
  assert.equal(assessed.status, 200, JSON.stringify(assessed.body)); assert.equal(assessed.body.material.analysis.canCreateDraft, true);
  const result = await h.api(pathBase + '/convert', { consent: true });
  assert.equal(result.status, 200, JSON.stringify(result.body));assert.equal(result.body.candidateReview,true);
  const review=(await h.api(pathBase+'/candidates?author=1')).body,candidate=review.candidates[0];assert.equal(candidate.fields.answer,'A');
  assert.equal((await h.api(`${pathBase}/candidates/${candidate.candidateId}/patch`,{fields:{prompt:'Reviewed garden material'},expectedRevision:candidate.revision,expectedEpoch:review.expectedEpoch})).status,200);
  await h.restart();
  const opened = await h.api(pathBase + '/draft');
  assert.equal(opened.status, 200);assert.equal(opened.body.candidateReview,true);
  const latest=(await h.api(pathBase+'/candidates?author=1')).body;assert.equal(latest.candidates[0].fields.prompt,'Reviewed garden material');
  const commit = await h.api(pathBase+'/compile',{sourceRevision:latest.sourceRevision,candidateRevisions:{[candidate.candidateId]:2},selectedIds:[candidate.candidateId],importOperationId:'garden-reviewed',expectedEpoch:latest.expectedEpoch});
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  const state = (await h.api('/api/state')).body;
  assert.equal(state.libraries.length, 1); assert.equal(state.materials[0].status, 'imported'); assert.equal(state.materials[0].libraryId, commit.body.receipt.libraryId);
  assert.deepEqual((await h.api(pathBase)).body.material.files, material.files);
});
test('local processing uses the same saved-material route without model calls', async t => {
  const h = await harness(t, { publicSettings: () => ({ provider: 'none', capabilities: {} }), assessMaterials: () => { throw Error('No network'); } });
  const material = await h.receive({ text: worksheet });
  const base = `/api/materials/${material.id}`;
  const assess = await h.api(base + '/assess', { useAI: false });
  assert.equal(assess.status, 200, JSON.stringify(assess.body));
  const draft = await h.api(base + '/convert', { useAI: false });
  assert.equal(draft.status, 200, JSON.stringify(draft.body)); assert.equal((await h.api(base+'/candidates')).body.candidates.length, 1);
});
test('an unreadable archive stays received and AI cannot turn metadata into invented questions', async t => {
  let seen;
  const h = await harness(t, { assessMaterials: async input => { seen = input; return { status: 'processable', summary: 'Overconfident fixture', detectedSections: [], missingInformation: [], warnings: [], recommendedProcessor: 'ai', canCreateDraft: true }; } });
  const material = await h.receive({ files: [upload('raw.zip', 'broken')] });
  const base = `/api/materials/${material.id}`;
  const assess = await h.api(base + '/assess', { consent: true });
  assert.equal(assess.status, 200, JSON.stringify(assess.body)); assert.deepEqual(seen.sources, []);
  assert.equal(assess.body.material.analysis.canCreateDraft, false); assert.equal(assess.body.material.status, 'needs_information');
  assert.equal((await h.api(base + '/convert', { consent: true })).status, 400);
  assert.deepEqual((await h.api(base)).body.material.files, material.files);
});
test('backup includes received originals and edited drafts; corruption cannot replace current data', async t => {
  const h = await harness(t);
  const material = await h.receive({ files: [upload('unprocessed.opaque', 'Exact original bytes')], text: worksheet });
  const backup = Buffer.from(await (await appFetch(h.instance.url + '/api/backup')).arrayBuffer());
  const parsed = await ZipFixture.from(backup);
  const manifest = JSON.parse(parsed.getEntry('practicebridge-backup.json').getData());
  assert.equal(manifest.state.materials[0].id, material.id);
  assert.equal(parsed.getEntry(`input-blobs/${material.files[0].id}`).getData().toString('utf8'), 'Exact original bytes');
  const extra = await h.receive({ text: 'Received after backup' });
  parsed.updateFile(`input-blobs/${material.files[0].id}`, Buffer.from('Changed bytes'));
  assert.equal((await h.api('/api/restore', { file: upload('tampered.zip', parsed.toBuffer()) })).status, 400);
  assert.equal((await h.api(`/api/materials/${extra.id}`)).status, 200);
  const restored = await h.api('/api/restore', { file: upload('backup.zip', backup) });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal((await h.api('/api/state')).body.materials.length, 1);
  assert.deepEqual((await h.api(`/api/materials/${material.id}`)).body.material.files, material.files);
});
test('restart marks unfinished materials interrupted and never replays an AI request', async t => {
  let calls = 0;
  const h = await harness(t, { assessMaterials: async () => { calls++; } });
  const material = await h.receive({ text: worksheet });
  await h.instance.close();
  const filename = path.join(h.dataDir, 'state.json');
  const state = JSON.parse(await fs.readFile(filename, 'utf8')); state.materials[0].status = 'converting';
  await fs.writeFile(filename, JSON.stringify(state));
  h.instance = await startServer({ dataDir: h.dataDir, models: models({ assessMaterials: async () => { calls++; } }) });
  assert.equal((await h.api(`/api/materials/${material.id}`)).body.material.status, 'interrupted'); assert.equal(calls, 0);
});
test('sentence frames round trip with unused distractors and reject impossible slot counts', () => {
  const pack = { schemaVersion: 1, id: 'frame', version: '1', title: 'Original frame fixture', groups: [{ id: 'g', section: 'writing', title: 'Build', questions: [{ id: 'q', type: 'sentence_order', prompt: 'What did you buy?\nI _____ _____ .', sentenceFrame: 'I _____ _____ .', answerSlots: 2, options: [{ id: 'A', text: 'bought' }, { id: 'B', text: 'a notebook' }, { id: 'C', text: 'buy' }], answer: ['A', 'B'] }] }] };
  const result = validatePackage(pack);
  assert.equal(result.issues.filter(i => i.severity === 'error').length, 0); assert.equal(result.pack.groups[0].questions[0].sentenceFrame, 'I _____ _____ .');
  pack.groups[0].questions[0].answerSlots = 4; pack.groups[0].questions[0].sentenceFrame = 'I __ __ __ __.';
  assert.ok(validatePackage(pack).issues.some(i => i.severity === 'error' && i.path.endsWith('.answerSlots')));
});

test('stale candidate revisions cannot overwrite a newer edit and complete backups retain new artifacts', async t => {
  const h = await harness(t);
  const material = await h.receive({ text: worksheet });
  const base = `/api/materials/${material.id}`;
  await h.api(base + '/assess', { useAI: false });
  await h.api(base+'/convert',{useAI:false});
  const first=(await h.api(base+'/candidates?author=1')).body,candidate=first.candidates[0];
  const patch={expectedRevision:candidate.revision,expectedEpoch:first.expectedEpoch,fields:{prompt:'Newest saved edit'}};
  const route=`${base}/candidates/${candidate.candidateId}/patch`;
  assert.equal((await h.api(route,patch)).status,200);
  assert.equal((await h.api(route,{...patch,fields:{prompt:'Stale edit'}})).status,409);
  assert.equal((await h.api(base+'/candidates?author=1')).body.candidates[0].fields.prompt,'Newest saved edit');
  const backup=await appFetch(h.instance.url+'/api/backup');assert.equal(backup.status,200);
  const files=await readZip(Buffer.from(await backup.arrayBuffer())),manifest=JSON.parse(files.get('practicebridge-backup.json'));
  assert.equal(manifest.version,2);assert.ok(files.has('processing-artifacts/'+manifest.state.candidateSets[material.id].candidates[0].ref));
  assert.equal((await h.api('/api/restore',{file:upload('same-identity.zip','not a backup')})).status,400);
  assert.equal((await h.api(base+'/candidates?author=1')).body.candidates[0].fields.prompt,'Newest saved edit');
});
