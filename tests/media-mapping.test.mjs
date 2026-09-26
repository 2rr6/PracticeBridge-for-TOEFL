import test from 'node:test';
import assert from 'node:assert/strict';

import { applyUserMediaMapping, naturalMediaCompare, resolveMediaMappings } from '../src/media-manifest.mjs';

const asset = (assetId, originalName, scopeId, role = 'stimulus') => ({ assetId, originalName, scopeId, role });
const target = (targetId, scopeId, role, sequenceNumber, extra = {}) => ({ targetId, scopeId, role, sequenceNumber, ...extra });

test('natural ordering treats 1, 2, and 10 numerically inside one explicit scope', () => {
  const names = ['module/q10.mp3', 'module/q2.mp3', 'module/q1.mp3'];
  assert.deepEqual(names.sort(naturalMediaCompare), ['module/q1.mp3', 'module/q2.mp3', 'module/q10.mp3']);
});

test('scoped filename and sequence mapping do not cross modules or shift after a missing number', () => {
  const assets = [
    asset('a1', 'module-a/question-1.mp3', 'module-a'),
    asset('a2', 'module-a/question-2.mp3', 'module-a'),
    asset('a4', 'module-a/question-4.mp3', 'module-a'),
    asset('b1', 'module-b/question-1.mp3', 'module-b'),
  ];
  const targets = [1, 2, 3, 4].map(number => target(`qa${number}`, 'module-a', 'stimulus', number));
  const result = resolveMediaMappings({ assets, targets, autoPair: true });
  assert.deepEqual(result.mappings.map(item => [item.targetId, item.assetId, item.mappingBasis, item.mappingState]), [
    ['qa1', 'a1', 'filename', 'applied'],
    ['qa2', 'a2', 'filename', 'applied'],
    ['qa3', null, 'sequence', 'proposed'],
    ['qa4', 'a4', 'filename', 'applied'],
  ]);
  assert.equal(result.mappings.find(item => item.targetId === 'qa1').assetId, 'a1');
});

test('a local duplicate isolates only that target while later exact numbers still map', () => {
  const assets = [
    asset('a2x', 'module-a/question-2.mp3', 'module-a'),
    asset('a2y', 'module-a/question_02.mp3', 'module-a'),
    asset('a4', 'module-a/question-4.mp3', 'module-a'),
  ];
  const targets = [2, 3, 4].map(number => target(`q${number}`, 'module-a', 'stimulus', number));
  const mappings = resolveMediaMappings({ assets, targets, autoPair: true }).mappings;
  assert.deepEqual(mappings.map(item => [item.targetId, item.assetId, item.mappingState]), [
    ['q2', null, 'ambiguous'], ['q3', null, 'proposed'], ['q4', 'a4', 'applied'],
  ]);
});

test('explicit shared audio maps to multiple questions and explicit references outrank filename guesses', () => {
  const assets = [
    asset('shared', 'module/shared-stimulus.mp3', 'module'),
    asset('guess', 'module/question-1.mp3', 'module'),
  ];
  const targets = [
    target('q1', 'module', 'stimulus', 1, { explicitRef: 'shared' }),
    target('q2', 'module', 'stimulus', 2, { explicitRef: 'shared' }),
  ];
  const mappings = resolveMediaMappings({ assets, targets, autoPair: true }).mappings;
  assert.deepEqual(mappings.map(item => [item.targetId, item.assetId, item.mappingBasis]), [
    ['q1', 'shared', 'explicitRef'], ['q2', 'shared', 'explicitRef'],
  ]);
});

test('Directions, stimulus, and sample answers remain distinct roles', () => {
  const assets = [
    asset('directions', 'module/directions-1.mp3', 'module', 'directions'),
    asset('stimulus', 'module/question-1.mp3', 'module', 'stimulus'),
    asset('sample', 'module/sample-answer-1.mp3', 'module', 'sampleAnswer'),
  ];
  const targets = [
    target('d1', 'module', 'directions', 1),
    target('q1', 'module', 'stimulus', 1),
    target('s1', 'module', 'sampleAnswer', 1),
  ];
  const mappings = resolveMediaMappings({ assets, targets, autoPair: true }).mappings;
  assert.deepEqual(mappings.map(item => [item.targetId, item.assetId]), [['d1', 'directions'], ['q1', 'stimulus'], ['s1', 'sample']]);
  assert.ok(mappings.every(item => item.contentCheckState === 'notChecked'));
});

test('natural-order pairing requires explicit user choice and equal unique unnumbered scope', () => {
  const assets = [asset('opening', 'module/opening.mp3', 'module'), asset('closing', 'module/closing.mp3', 'module')];
  const targets = [target('first', 'module', 'stimulus', null), target('second', 'module', 'stimulus', null)];
  assert.ok(resolveMediaMappings({ assets, targets, autoPair: false }).mappings.every(item => item.assetId === null));
  assert.deepEqual(resolveMediaMappings({ assets, targets, autoPair: true }).mappings.map(item => item.assetId), ['closing', 'opening']);
});

test('sequence-only pairing requires a nonempty explicit scope', () => {
  const mappings = resolveMediaMappings({
    assets: [asset('one', 'question-1.mp3', '')], targets: [target('q1', '', 'stimulus', 1)], autoPair: true,
  }).mappings;
  assert.deepEqual(mappings[0], { targetId: 'q1', assetId: null, mappingBasis: 'sequence', mappingState: 'proposed', contentCheckState: 'notChecked', candidates: [] });
});

test('user correction creates a new candidate revision without mutating the old mapping', () => {
  const candidate = { candidateId: 'candidate-1', revision: 7, mappings: [{ targetId: 'q1', assetId: 'old', mappingBasis: 'filename', mappingState: 'applied', contentCheckState: 'notChecked' }] };
  const revised = applyUserMediaMapping(candidate, { targetId: 'q1', assetId: 'correct', contentChecked: true });
  assert.equal(candidate.revision, 7);
  assert.equal(candidate.mappings[0].assetId, 'old');
  assert.equal(revised.revision, 8);
  assert.deepEqual(revised.mappings[0], { targetId: 'q1', assetId: 'correct', mappingBasis: 'user', mappingState: 'applied', contentCheckState: 'matched' });
});

test('asset-level content review never certifies a newly inferred target relationship', () => {
  const mappings = resolveMediaMappings({
    assets: [{ ...asset('reviewed-elsewhere', 'module/question-2.mp3', 'module'), contentCheckState: 'matched' }],
    targets: [target('unreviewed-q2', 'module', 'stimulus', 2)], autoPair: true,
  }).mappings;
  assert.equal(mappings[0].mappingState, 'applied');
  assert.equal(mappings[0].contentCheckState, 'notChecked');
});

test('content review can be reused only when its target and candidate revision are identical', () => {
  const reviewed = { ...asset('bound', 'module/question-2.mp3', 'module'), contentEvidence: { assetId: 'bound', targetId: 'q2', candidateRevision: 7, state: 'matched' } };
  const matching = resolveMediaMappings({ assets: [reviewed], targets: [target('q2', 'module', 'stimulus', 2, { candidateRevision: 7 })], autoPair: true }).mappings[0];
  const stale = resolveMediaMappings({ assets: [reviewed], targets: [target('q2', 'module', 'stimulus', 2, { candidateRevision: 8 })], autoPair: true }).mappings[0];
  assert.equal(matching.contentCheckState, 'matched');
  assert.equal(stale.contentCheckState, 'notChecked');
});
