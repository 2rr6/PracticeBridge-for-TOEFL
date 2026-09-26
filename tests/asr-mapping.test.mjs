import test from 'node:test';
import assert from 'node:assert/strict';
import { compareAsrEvidence, retractAsrEvidence } from '../src/asr-mapping.mjs';
const base = { assetId: 'a'.repeat(64), targetId: 'q1', candidateRevision: 2, transcript: 'Alice does not need twenty tickets.', asrIssues: [] };

for (const [a, b] of [['-5', '5'], ['+5', '-5'], ['1,500', '1.500'], ['.5', '5'], ['1 500', '1,500'], ['1/2', '1:2'], ['5%', '5'], ['1e-5', '1e5'], ['5 %', '5'], ['±5', '5'], ['∓5', '5'], ['≈ 5', '5'], ['5 ‰', '5'], ['5 ‱', '5'], ['(5)', '5'], ['$ 5', '5'], ['5 §', '5'], ['5 ※', '5']]) {
  test(`numeric expressions remain distinct: ${a} versus ${b}`, () => {
    const reference = `The value is ${a}.`, transcript = `The value is ${b}.`;
    const item = compareAsrEvidence({ ...base, reference, transcript });
    assert.equal(item.state, 'conflict', `${a} versus ${b}`);
    assert(item.doubts.some(d => d.code === 'number_difference'), `${a} versus ${b}`);
    assert.equal(item.reference, reference); assert.equal(item.transcript, transcript);
  });
}
test('identical signed decimals still match across sentence punctuation', () => {
  const equal = compareAsrEvidence({ ...base, reference: 'The value is -1,500.25.', transcript: 'the value is -1,500.25!' });
  assert.equal(equal.state, 'matched'); assert.deepEqual(equal.doubts, []);
});
test('no reference is a transcription, never a match', () => {
  const item = compareAsrEvidence(base);
  assert.equal(item.state, 'notChecked'); assert.equal(item.kind, 'transcribed');
});
test('negation, numbers, proper names and nearby candidates remain explicit doubts', () => {
  for (const [reference, code] of [['Alice does need twenty tickets.', 'negation_difference'], ['Alice does not need thirty tickets.', 'number_difference'], ['Bob does not need twenty tickets.', 'name_difference']]) {
    const item = compareAsrEvidence({ ...base, reference });
    assert.equal(item.state, 'conflict'); assert(item.doubts.some(d => d.code === code)); assert.equal(item.reference, reference);
  }
  assert.equal(compareAsrEvidence({ ...base, reference: base.transcript, adjacentReferences: [base.transcript] }).state, 'inconclusive');
});
test('retraction preserves original evidence and revision relation', () => {
  const item = compareAsrEvidence({ ...base, reference: base.transcript });
  const next = retractAsrEvidence(item);
  assert.equal(item.state, 'matched'); assert.equal(next.state, 'notChecked'); assert.equal(next.retracted, true);
  assert.equal(next.transcript, item.transcript); assert.equal(next.candidateRevision, 2);
});
test('out-of-range timestamps and nonspeech never establish a match', () => {
  for (const code of ['segment_outside_audio', 'possible_non_speech', 'empty_transcript']) assert.equal(compareAsrEvidence({ ...base, reference: base.transcript, asrIssues: [{ code }] }).state, 'inconclusive');
});
test('missing engine issue evidence cannot establish a text match', () => {
  const { asrIssues, ...input } = base;
  assert.equal(compareAsrEvidence({ ...input, reference: base.transcript }).state, 'inconclusive');
});
