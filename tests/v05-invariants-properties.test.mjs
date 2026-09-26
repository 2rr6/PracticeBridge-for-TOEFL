import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import fc from 'fast-check';
import { createStore, gradeAnswer } from '../src/store.mjs';
import { createMaterialInbox } from '../src/materials.mjs';
import { createCandidateRepository } from '../src/material-candidates.mjs';
import { createMaterialCompiler } from '../src/material-compiler.mjs';
import { canonicalJSON, contentHash, createPackageZip, parseNativeImport, validatePackage } from '../src/package.mjs';
import { resolveMediaMappings } from '../src/media-manifest.mjs';
import { reduceBlankEdit } from '../public/exam-letters.mjs';

// These are bounded self-authored fixtures, not private input, model output, or
// claims about browser IME / media decoding. fast-check reports replay seeds,
// shrink paths and the minimized input on any failing property.
const SEEDS = Object.freeze({
  package: 0x5050501,
  subset: 0x5050502,
  lifecycle: 0x5050503,
  mapping: 0x5050504,
  letters: 0x5050505,
});
const scratchRoot = path.resolve('test-results/v05-invariants-properties');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sorted = values => [...values].sort();
const unscored = { status: 'unscored', correct: null, total: null };

function pcmWave(value) {
  const frames = 32, bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) bytes.writeInt16LE((value + frame * 97) % 30000, 44 + frame * 2);
  return bytes;
}

const questionArbitrary = fc.record({
  answer: fc.constantFrom(null, 'A', 'B'),
  ownAudio: fc.boolean(),
  selected: fc.boolean(),
});
const packageArbitrary = fc.record({
  salt: fc.integer({ min: 0, max: 4096 }),
  prose: fc.constantFrom('A quiet garden.', 'Café — a blue label.', '自编材料 / sample α.'),
  questions: fc.array(questionArbitrary, { minLength: 2, maxLength: 5 }),
});

function packageFixture(input, { pending = false } = {}) {
  const files = new Map(), expectedQuestions = new Map();
  const addAudio = (name, offset) => { files.set(name, pcmWave(input.salt + offset)); return name; };
  const groups = [0, 1].map(number => ({
    id: 'group-' + number,
    title: 'Self-authored group ' + number,
    section: 'reading',
    taskKind: 'read_daily',
    passage: input.prose + '\n\nThe final paragraph belongs to group ' + number + ' and must remain whole.',
    audio: addAudio('audio/group-' + number + '.wav', 100 + number),
    questions: [],
  }));
  input.questions.forEach((declaration, number) => {
    const group = groups[number % groups.length];
    const question = {
      id: 'q-' + number,
      type: 'single_choice',
      prompt: 'Which label is recorded for self-authored sample ' + input.salt + '-' + number + '?',
      options: [{ id: 'A', text: 'Blue' }, { id: 'B', text: 'Green' }],
      answer: number === 0 ? null : declaration.answer,
    };
    if (declaration.ownAudio) question.audio = addAudio('audio/question-' + number + '.wav', 200 + number);
    group.questions.push(question);
    expectedQuestions.set(question.id, { question: structuredClone(question), groupId: group.id, selected: declaration.selected });
  });
  const instructions = {
    text: 'Read the complete supplied passage.',
    audio: addAudio('audio/instructions.wav', 300),
    basis: 'user',
    source: 'Self-authored instructions',
    verifiedContent: false,
  };
  const pack = {
    schemaVersion: 1, id: 'self-authored-' + input.salt, version: '1', title: 'Generated self-authored material',
    examContractVersion: 1, minReaderVersion: '0.3.0',
    groups,
    examSets: [{
      id: 'set', title: 'Self-authored set',
      sections: [{
        id: 'reading', title: 'Reading', section: 'reading',
        modules: [{
          id: 'module', title: 'Shared reading module', sourceNumber: 2,
          taskIds: groups.map(group => group.id), instructions,
          navigation: { back: 'none', review: 'none', lockOnAdvance: true },
        }],
      }],
    }],
  };
  if (pending) pack.groups.push({
    id: 'pending', title: 'Original missing stimulus', section: 'listening', taskKind: 'listen_conversation',
    questions: [{
      id: 'pending-q', type: 'single_choice', prompt: 'Listen to the missing original stimulus.',
      options: [{ id: 'A', text: 'First' }, { id: 'B', text: 'Second' }], answer: 'A',
    }],
  });
  // This unreferenced attachment must not become a formal package dependency.
  addAudio('audio/unused.wav', 400);
  const expectedMedia = new Set(['audio/instructions.wav', ...groups.slice(0, 2).map(group => group.audio)]);
  for (const { question } of expectedQuestions.values()) if (question.audio) expectedMedia.add(question.audio);
  return { pack, files, expectedQuestions, expectedMedia };
}

function normalize(pack, files) {
  const result = validatePackage(pack, files);
  assert.deepEqual(result.issues.filter(issue => issue.severity === 'error'), []);
  return result.pack;
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
  return value;
}

async function withRepository(work) {
  await fs.mkdir(scratchRoot, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(scratchRoot, 'run-'));
  let store;
  try {
    store = await createStore({ dataDir });
    const inbox = createMaterialInbox({ store });
    const repository = createCandidateRepository({ store });
    return await work({ store, inbox, repository, compiler: createMaterialCompiler({ store, repository }), dataDir });
  } finally {
    if (store) await store.close();
    // Delete only the exact per-trial directory created above.
    assert.equal(path.dirname(path.resolve(dataDir)), scratchRoot);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function compileRequest(saved, selected, materialId, expectedEpoch, importOperationId) {
  return {
    materialId, sourceRevision: saved.sourceRevision,
    candidateRevisions: Object.fromEntries(selected.map(candidate => [candidate.candidateId, candidate.revision])),
    selectedIds: selected.map(candidate => candidate.candidateId), expectedEpoch, importOperationId,
  };
}

test('v0.5 property: semantic package round trips preserve normalized content and media identities', async () => {
  await fc.assert(fc.asyncProperty(packageArbitrary, async input => {
    const fixture = packageFixture(input);
    const untouched = structuredClone(fixture.pack);
    const normalized = normalize(fixture.pack, fixture.files);
    const identities = Object.fromEntries([...fixture.expectedMedia].map(name => [name, sha256(fixture.files.get(name))]));
    const variants = [
      { pack: normalized, files: fixture.files },
      { pack: reverseObjectKeys(normalized), files: new Map([...fixture.files].reverse()) },
    ];
    for (const variant of variants) {
      const zip = await createPackageZip(variant.pack, variant.files);
      const imported = await parseNativeImport([{ name: 'self-authored.zip', data: zip.toString('base64') }]);
      assert.ok(imported);
      const actual = normalize(imported.pack, imported.files);
      assert.deepEqual(actual, normalized);
      assert.equal(canonicalJSON(actual), canonicalJSON(normalized));
      assert.deepEqual(sorted([...imported.files.keys()].filter(name => name !== 'practicebridge.json')), sorted(fixture.expectedMedia));
      const actualIdentities = {};
      for (const name of fixture.expectedMedia) {
        assert.deepEqual(imported.files.get(name), fixture.files.get(name), name);
        actualIdentities[name] = sha256(imported.files.get(name));
      }
      assert.deepEqual(actualIdentities, identities);
      assert.equal(contentHash(actual, actualIdentities), contentHash(variant.pack, identities));
      for (const group of actual.groups) {
        assert.equal(group.passage, untouched.groups.find(original => original.id === group.id).passage);
        for (const question of group.questions) {
          const authored = fixture.expectedQuestions.get(question.id).question;
          assert.equal(question.prompt, authored.prompt);
          assert.deepEqual(question.options, authored.options);
          assert.equal(question.answer, authored.answer);
        }
      }
    }
    assert.deepEqual(fixture.pack, untouched, 'export and validation do not rewrite the supplied source');
  }), { seed: SEEDS.package, numRuns: 24 });
});

const subsetExamples = [
  [{ salt: 0, prose: 'A quiet garden.', questions: [{ answer: null, ownAudio: false, selected: false }, { answer: 'A', ownAudio: true, selected: false }] }],
  [{ salt: 1, prose: '自编材料 / sample α.', questions: [{ answer: null, ownAudio: true, selected: true }, { answer: 'B', ownAudio: true, selected: true }] }],
  [{ salt: 2, prose: 'Café — a blue label.', questions: [{ answer: null, ownAudio: false, selected: true }, { answer: 'A', ownAudio: false, selected: false }] }],
];

test('v0.5 property: arbitrary ready subsets retain originals, reachable dependencies and unscored unknown keys', async () => {
  await fc.assert(fc.asyncProperty(packageArbitrary, async input => withRepository(async ({ store, inbox, repository, compiler, dataDir }) => {
    const fixture = packageFixture(input, { pending: true });
    const material = await inbox.receive({ title: 'Self-authored subset', text: 'Complete original text ' + input.salt + '\n' + input.prose });
    const saved = await repository.ingestPack({
      materialId: material.id, pack: fixture.pack, files: fixture.files, method: 'native-json',
      expectedEpoch: store.read().workspaceEpoch,
    });
    assert.equal(saved.candidates.length, input.questions.length + 1);
    assert.equal(saved.candidates.find(candidate => candidate.sourceQuestionId === 'pending-q').readiness.canAnswer, false);
    const selected = saved.candidates.filter(candidate => fixture.expectedQuestions.get(candidate.sourceQuestionId)?.selected);
    for (const candidate of saved.candidates.filter(candidate => candidate.sourceQuestionId !== 'pending-q')) assert.equal(candidate.readiness.canAnswer, true);
    const originalCandidates = structuredClone(saved.candidates);
    // Walk declared references and actual artifacts, independently of the
    // compiler's dependencyClosure helper and output collection routines.
    const queue = selected.flatMap(candidate => candidate.dependencyRefs), visited = new Set();
    while (queue.length) {
      const ref = queue.shift();
      if (visited.has(ref)) continue;
      visited.add(ref);
      assert.ok(Object.hasOwn(saved.artifactIndex, ref), 'every dependency has a declared artifact');
      const artifact = await repository.readArtifact(ref);
      assert.deepEqual(artifact, saved.artifactIndex[ref], 'actual immutable artifact agrees with its reference');
      queue.push(...(artifact.dependencyRefs || []));
      if (artifact.kind === 'media') assert.deepEqual(await store.readBlob(artifact.value.blob.id), fixture.files.get(artifact.value.name));
    }
    const request = compileRequest(saved, selected, material.id, store.read().workspaceEpoch, 'subset-operation');
    const result = await compiler.compilePracticeSubset(request);
    assert.deepEqual((await repository.load(material.id)).candidates, originalCandidates, 'all unselected and selected candidates remain intact');
    assert.equal(inbox.get(material.id).text, material.text);
    assert.equal(result.completeness.pending, 1);
    assert.equal(result.completeness.selected, selected.length);
    assert.equal(result.completeness.total, input.questions.length + 1);
    assert.deepEqual(Object.keys(store.read().importReceipts), ['subset-operation']);
    const stateBytes = await fs.readFile(path.join(dataDir, 'state.json'));
    assert.deepEqual(await compiler.compilePracticeSubset(request), result);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'state.json')), stateBytes, 'exact retry performs no persisted rewrite');

    if (!selected.length) {
      assert.equal(result.normalizedPack, null);
      assert.equal(result.receipt, null);
      assert.equal(store.read().libraries.length, 0);
      return;
    }
    assert.equal(result.receipt.added, selected.length);
    assert.equal(store.read().libraries.length, 1);
    const library = store.read().libraries[0], selectedQuestionIds = new Set(selected.map(candidate => candidate.sourceQuestionId));
    assert.deepEqual(sorted(library.originalPack.groups.flatMap(group => group.questions.map(question => question.id))), sorted(selectedQuestionIds));
    const expectedMedia = new Set(['audio/instructions.wav']);
    for (const group of library.originalPack.groups) {
      const original = fixture.pack.groups.find(item => item.id === group.id);
      assert.equal(group.passage, original.passage, 'shared passage is never truncated to a selected question');
      expectedMedia.add(original.audio);
      for (const question of group.questions) {
        const authored = fixture.expectedQuestions.get(question.id).question;
        assert.equal(question.prompt, authored.prompt);
        assert.equal(question.answer, authored.answer);
        if (authored.audio) expectedMedia.add(authored.audio);
        if (authored.answer === null) {
          for (const submitted of ['', 'A', 'B']) assert.deepEqual(gradeAnswer(question, submitted), unscored);
        }
      }
    }
    const module = library.originalPack.examSets[0].sections[0].modules[0];
    assert.deepEqual(module.instructions, fixture.pack.examSets[0].sections[0].modules[0].instructions);
    assert.deepEqual(sorted(module.taskIds), sorted(library.originalPack.groups.map(group => group.id)));
    assert.deepEqual(sorted(Object.keys(library.mediaMap)), sorted(expectedMedia));
    for (const name of expectedMedia) {
      const expectedHash = sha256(fixture.files.get(name));
      assert.equal(library.mediaMap[name], expectedHash, name);
      assert.ok(store.read().blobs[expectedHash], 'compiled runtime can resolve its media identity');
      assert.deepEqual(await store.readBlob(expectedHash), fixture.files.get(name));
    }
    const exported = await createPackageZip(library.originalPack, fixture.files);
    const imported = await parseNativeImport([{ name: 'subset.zip', data: exported.toString('base64') }]);
    assert.deepEqual(normalize(imported.pack, imported.files), library.originalPack);
    assert.deepEqual(sorted([...imported.files.keys()].filter(name => name !== 'practicebridge.json')), sorted(expectedMedia));
  })), { seed: SEEDS.subset, numRuns: 12, examples: subsetExamples });
});

const lifecycleKinds = ['create', 'edit', 'restore', 'compile', 'retry'];
const lifecycleArbitrary = fc.tuple(
  fc.shuffledSubarray(lifecycleKinds, { minLength: lifecycleKinds.length, maxLength: lifecycleKinds.length }),
  fc.array(fc.record({ kind: fc.constantFrom(...lifecycleKinds), selector: fc.nat({ max: 31 }) }), { maxLength: 5 }),
  fc.array(fc.nat({ max: 31 }), { minLength: lifecycleKinds.length, maxLength: lifecycleKinds.length }),
).map(([prefix, extra, selectors]) => [...prefix.map((kind, index) => ({ kind, selector: selectors[index] })), ...extra]);

test('v0.5 property: shuffled lifecycle commands reject stale epochs and never duplicate committed receipts', async () => {
  await fc.assert(fc.asyncProperty(lifecycleArbitrary, async commands => withRepository(async ({ store, inbox, repository, compiler, dataDir }) => {
    let model = { records: [], libraries: [], receipts: {} };
    const snapshots = [], history = [];
    let creationNumber = 0, operationNumber = 0, editNumber = 0;
    const stateBytes = () => fs.readFile(path.join(dataDir, 'state.json'));
    const remember = () => snapshots.push({ state: store.read(), model: structuredClone(model) });
    const create = async () => {
      const number = creationNumber++;
      const prompt = 'Original self-authored prompt ' + number + '.';
      const material = await inbox.receive({ title: 'Lifecycle ' + number, text: 'Original source ' + number });
      const saved = await repository.ingestPack({
        materialId: material.id, expectedEpoch: store.read().workspaceEpoch, method: 'native-json',
        pack: {
          schemaVersion: 1, id: 'lifecycle-' + number, title: 'Self-authored lifecycle', version: '1',
          groups: [{
            id: 'g', title: 'Read', section: 'reading', taskKind: 'read_daily', passage: 'The complete original passage.',
            questions: [{ id: 'q', type: 'single_choice', prompt, options: [{ id: 'A', text: 'Blue' }, { id: 'B', text: 'Green' }], answer: 'A' }],
          }],
        },
      });
      assert.equal(saved.candidates.length, 1);
      model.records.push({
        materialId: material.id, sourceRevision: saved.sourceRevision, candidateId: saved.candidates[0].candidateId,
        revision: 1, prompt, answer: 'A',
      });
    };
    const compile = async record => {
      const request = compileRequest({ sourceRevision: record.sourceRevision }, [record], record.materialId, store.read().workspaceEpoch, 'operation-' + operationNumber++);
      const prior = model.libraries.find(item => item.candidateId === record.candidateId && item.revision === record.revision);
      const result = await compiler.compilePracticeSubset(request);
      assert.equal(result.receipt.added, prior ? 0 : 1, 'one current revision can be added only once');
      assert.equal(result.receipt.selected, 1);
      const question = result.normalizedPack.groups[0].questions[0];
      assert.equal(question.prompt, record.prompt);
      assert.equal(question.answer, record.answer);
      if (prior) assert.equal(result.receipt.libraryId, prior.libraryId);
      else {
        assert.ok(!model.libraries.some(item => item.libraryId === result.receipt.libraryId));
        model.libraries.push({
          libraryId: result.receipt.libraryId, candidateId: record.candidateId, revision: record.revision,
          prompt: record.prompt, answer: record.answer,
        });
      }
      assert.ok(!Object.hasOwn(model.receipts, request.importOperationId));
      model.receipts[request.importOperationId] = structuredClone(result.receipt);
      history.push({ request, result: structuredClone(result) });
    };
    const assertModel = async () => {
      const actual = store.read();
      assert.deepEqual(sorted(actual.materials.map(item => item.id)), sorted(model.records.map(item => item.materialId)));
      assert.equal(actual.libraries.length, model.libraries.length);
      assert.deepEqual(sorted(Object.keys(actual.importReceipts)), sorted(Object.keys(model.receipts)));
      for (const [operationId, receipt] of Object.entries(model.receipts)) assert.deepEqual(actual.importReceipts[operationId].receipt, receipt);
      for (const expected of model.libraries) {
        const library = actual.libraries.find(item => item.libraryId === expected.libraryId);
        assert.ok(library);
        assert.equal(library.originalPack.groups[0].questions[0].prompt, expected.prompt, 'previous compiled prompt stays frozen after edits');
        assert.equal(library.originalPack.groups[0].questions[0].answer, expected.answer);
        assert.equal(library.lineage.candidates.length, 1);
        assert.equal(library.lineage.candidates[0].candidateId, expected.candidateId);
        assert.equal(library.lineage.candidates[0].revision, expected.revision);
      }
      for (const expected of model.records) {
        const saved = await repository.load(expected.materialId);
        assert.equal(saved.sourceRevision, expected.sourceRevision);
        assert.equal(saved.candidates.length, 1);
        const candidate = saved.candidates[0];
        assert.equal(candidate.candidateId, expected.candidateId);
        assert.equal(candidate.revision, expected.revision);
        assert.equal(candidate.fields.prompt, expected.prompt);
        assert.equal(candidate.fields.answer, expected.answer);
      }
    };

    await create(); remember();
    await compile(model.records[0]); remember();
    for (const [index, command] of commands.entries()) {
      const record = model.records[command.selector % model.records.length];
      if (command.kind === 'create') await create();
      if (command.kind === 'edit') {
        const prompt = 'User-edited self-authored prompt ' + editNumber++ + ' at step ' + index + '.';
        await repository.patchCandidate({
          materialId: record.materialId, candidateId: record.candidateId, expectedRevision: record.revision,
          expectedEpoch: store.read().workspaceEpoch, fields: { prompt }, actor: 'user',
        });
        record.revision++; record.prompt = prompt;
      }
      if (command.kind === 'compile') await compile(record);
      if (command.kind === 'retry') {
        const prior = history[command.selector % history.length], before = await stateBytes();
        if (prior.request.expectedEpoch === store.read().workspaceEpoch) assert.deepEqual(await compiler.compilePracticeSubset(prior.request), prior.result);
        else await assert.rejects(compiler.compilePracticeSubset(prior.request), error => error.status === 409);
        assert.deepEqual(await stateBytes(), before, 'retry neither duplicates a receipt nor rewrites state');
      }
      if (command.kind === 'restore') {
        const oldEpoch = store.read().workspaceEpoch;
        const chosen = snapshots[command.selector % snapshots.length];
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        // Capture an actual production command before its await, then let the
        // restore publish before that command reaches its store transaction.
        const oldWrite = store.withEpoch(oldEpoch, async () => {
          await gate;
          return inbox.receive({ text: 'Late old-epoch source ' + index });
        }).then(value => ({ value }), error => ({ error }));
        let beforeLateWrite;
        try {
          const permit = await store.beginRestore(oldEpoch);
          try { await permit.publish(chosen.state); } finally { permit.release(); }
          model = structuredClone(chosen.model);
          assert.notEqual(store.read().workspaceEpoch, oldEpoch);
          beforeLateWrite = await stateBytes();
        } finally { release(); }
        assert.equal((await oldWrite).error?.status, 409);
        assert.deepEqual(await stateBytes(), beforeLateWrite, 'delayed old command cannot change the restored file');
        const current = model.records[0];
        await assert.rejects(repository.patchCandidate({
          materialId: current.materialId, candidateId: current.candidateId, expectedRevision: current.revision,
          expectedEpoch: oldEpoch, fields: { prompt: 'Stale edit must not apply.' }, actor: 'user',
        }), error => error.status === 409);
        await assert.rejects(compiler.compilePracticeSubset(compileRequest(
          { sourceRevision: current.sourceRevision }, [current], current.materialId, oldEpoch, 'stale-' + index,
        )), error => error.status === 409);
        assert.deepEqual(await stateBytes(), beforeLateWrite, 'stale edit and compile leave no receipt or state changes');
      }
      await assertModel();
      remember();
    }
  })), { seed: SEEDS.lifecycle, numRuns: 12 });
});

const mappingArbitrary = fc.record({
  modules: fc.integer({ min: 2, max: 4 }),
  questions: fc.integer({ min: 3, max: 6 }),
  multiplicities: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 24, maxLength: 24 }),
  padded: fc.boolean(),
  autoPair: fc.boolean(),
  revision: fc.integer({ min: 2, max: 20 }),
});

test('v0.5 property: scoped missing and duplicate media never acquire unearned content confirmation', () => {
  fc.assert(fc.property(mappingArbitrary, input => {
    const assets = [], targets = [], expected = new Map();
    for (let module = 0; module < input.modules; module++) {
      const scopeId = 'module-' + module;
      for (let number = 1; number <= input.questions; number++) {
        const targetId = scopeId + '-q' + number;
        targets.push({ targetId, scopeId, role: 'stimulus', sequenceNumber: number, candidateRevision: input.revision });
        // The first scope always contains a missing number, a duplicate and a
        // unique number. Other scopes repeat the same basenames independently.
        const count = module === 0 && number <= 3 ? [0, 2, 1][number - 1] : input.multiplicities[module * 6 + number - 1];
        const provenance = [];
        for (let copy = 0; copy < count; copy++) {
          const assetId = scopeId + '-audio-' + number + '-' + copy;
          const suffix = input.padded ? String(number).padStart(2, '0') : String(number);
          assets.push({
            assetId, originalName: scopeId + '/copy-' + copy + '/question-' + suffix + '.wav',
            scopeId, role: 'stimulus', contentCheckState: 'matched',
            contentEvidence: { assetId, targetId: copy === 0 ? 'some-other-target' : targetId, candidateRevision: input.revision - 1, state: 'matched' },
          });
          provenance.push(assetId);
        }
        // Same number in the same module but a different role is not a stimulus.
        assets.push({ assetId: scopeId + '-directions-' + number, originalName: scopeId + '/directions/question-' + number + '.wav', scopeId, role: 'directions' });
        expected.set(targetId, { assetId: count === 1 ? provenance[0] : null, mappingState: count === 1 ? 'applied' : count === 2 ? 'ambiguous' : 'proposed', contentCheckState: 'notChecked' });
      }
    }
    targets.push({ targetId: 'unscoped', scopeId: '', role: 'stimulus', sequenceNumber: 1, candidateRevision: input.revision });
    expected.set('unscoped', { assetId: null, mappingState: 'proposed', contentCheckState: 'notChecked' });
    const untouched = structuredClone({ assets, targets });
    const inspect = (orderedAssets, orderedTargets) => {
      const mappings = resolveMediaMappings({ assets: orderedAssets, targets: orderedTargets, autoPair: input.autoPair }).mappings;
      assert.equal(mappings.length, expected.size);
      assert.equal(new Set(mappings.map(item => item.targetId)).size, expected.size);
      for (const item of mappings) assert.deepEqual({
        assetId: item.assetId, mappingState: item.mappingState, contentCheckState: item.contentCheckState,
      }, expected.get(item.targetId), item.targetId);
      return Object.fromEntries(mappings.map(item => [item.targetId, { assetId: item.assetId, mappingState: item.mappingState, contentCheckState: item.contentCheckState }]));
    };
    assert.deepEqual(inspect(assets, targets), inspect([...assets].reverse(), [...targets].reverse()));
    assert.deepEqual({ assets, targets }, untouched);
  }), { seed: SEEDS.mapping, numRuns: 32 });
});

const letter = fc.constantFrom(...'aBcDeFgHiJkLmNoPqRsTuVwXyZ');
const lettersArbitrary = fc.record({
  words: fc.array(fc.array(fc.oneof(fc.constant(''), letter), { minLength: 3, maxLength: 8 }), { minLength: 2, maxLength: 4 }),
  commands: fc.array(fc.record({
    word: fc.nat({ max: 255 }), position: fc.nat({ max: 255 }),
    kind: fc.constantFrom('type', 'paste', 'delete', 'invalid'),
    text: fc.array(letter, { minLength: 1, maxLength: 9 }).map(values => values.join('')),
  }), { minLength: 20, maxLength: 50 }),
});

test('v0.5 property: cell edit sequences preserve untouched coordinates and internal empty positions', () => {
  fc.assert(fc.property(lettersArbitrary, input => {
    const words = input.words.map(cells => [...cells]);
    // The oracle is a sparse coordinate ledger. It never joins, compacts or
    // trims an answer string and does not use reduceBlankEdit to predict edits.
    const occupied = words.map(cells => new Map(cells.flatMap((value, position) => value ? [[position, value]] : [])));
    const commands = [
      { word: 0, position: 0, kind: 'paste', text: 'abc' },
      { word: 0, position: 1, kind: 'delete', text: '' },
      ...input.commands,
    ];
    for (const command of commands) {
      const word = command.word % words.length, index = command.position % words[word].length;
      const before = words.map(cells => [...cells]), cells = words[word];
      const priorCount = occupied[word].size;
      const deletion = command.kind === 'delete';
      const text = deletion ? '' : command.kind === 'invalid' ? 'a b' : command.kind === 'type' ? command.text[0] : command.text.slice(0, cells.length - index);
      const result = reduceBlankEdit(cells, index, text, { deletion });
      assert.deepEqual(words, before, 'the supplied arrays are immutable even on invalid input');
      if (command.kind === 'invalid') {
        assert.deepEqual(result, { valid: false });
        continue;
      }
      assert.equal(result.valid, true);
      const touched = new Set();
      if (deletion) { touched.add(index); occupied[word].delete(index); }
      else for (const [offset, value] of [...text].entries()) { touched.add(index + offset); occupied[word].set(index + offset, value); }
      words[word] = result.cells;
      for (let other = 0; other < words.length; other++) {
        if (other !== word) assert.deepEqual(words[other], before[other]);
      }
      assert.equal(result.cells.length, before[word].length);
      for (let position = 0; position < result.cells.length; position++) {
        if (!touched.has(position)) assert.equal(result.cells[position], before[word][position], 'untouched coordinate ' + position);
        assert.equal(result.cells[position], occupied[word].get(position) || '');
      }
      const lastOccupied = occupied[word].size ? Math.max(...occupied[word].keys()) : -1;
      assert.equal(result.answer.length, lastOccupied + 1, 'only trailing empty cells may be omitted');
      for (let position = 0; position <= lastOccupied; position++) assert.equal(result.answer[position], occupied[word].get(position) || ' ', 'internal position ' + position);
      assert.equal(result.completed, priorCount < cells.length && occupied[word].size === cells.length);
    }
  }), { seed: SEEDS.letters, numRuns: 40 });
});

