import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPracticeAnswer } from '../public/practice.mjs';
import { gradeAnswer } from '../src/store.mjs';

const question = {
  type: 'sentence_order', sentenceFrame: 'I _____ _____ .', answerSlots: 2,
  options: [{ id: 'A', text: 'a notebook' }, { id: 'B', text: 'bought' }, { id: 'C', text: 'buy' }],
  answer: ['B', 'A'],
};

test('saved frame answers display fixed words and chosen fragments without consuming distractors', () => {
  assert.equal(formatPracticeAnswer(question, ['B', 'A']), 'I bought a notebook.');
  assert.deepEqual(gradeAnswer(question, ['B', 'A']), { status: 'correct', correct: 1, total: 1 });
  assert.equal(gradeAnswer(question, ['B', 'A', 'C']).status, 'incorrect');
  assert.equal(gradeAnswer(question, ['A', 'B']).status, 'incorrect');
  assert.deepEqual(question.answer, ['B', 'A']);
});

test('fixed words between slots and source punctuation remain present in both answers', () => {
  const middle = { ...question, sentenceFrame: '_____ you _____ this?', options: [{ id: 'X', text: 'Did' }, { id: 'Y', text: 'make' }, { id: 'Z', text: 'made' }] };
  assert.equal(formatPracticeAnswer(middle, ['X', 'Y']), 'Did you make this?');
  assert.equal(formatPracticeAnswer(middle, ['X', 'Z']), 'Did you made this?');
});

test('incomplete, unmatched and excess historical answers are shown honestly instead of hidden', () => {
  assert.equal(formatPracticeAnswer(question, ['B']), 'I bought _____.');
  assert.equal(formatPracticeAnswer(question, []), '');
  assert.equal(formatPracticeAnswer(question, null), '');
  assert.match(formatPracticeAnswer(question, ['removed', 'A']), /无法匹配的词块：removed/);
  assert.equal(formatPracticeAnswer(question, ['B', 'A', 'C']), 'I bought a notebook.\n多余词块：buy');
});

test('legacy ordered questions display option text while other answer formats keep their existing contract', () => {
  const legacy = { type: 'sentence_order', options: question.options };
  assert.equal(formatPracticeAnswer(legacy, ['B', 'A']), 'bought → a notebook');
  assert.equal(formatPracticeAnswer({ type: 'single_choice' }, 'B'), 'B');
  assert.equal(formatPracticeAnswer({ type: 'fill_blank' }, ['blue', 'azure']), 'blue → azure');
  assert.equal(formatPracticeAnswer({ type: 'email' }, 'Hello,\nThank you.'), 'Hello,\nThank you.');
});

test('a stored snapshot formats independently of later live-question changes', () => {
  const live = structuredClone(question);
  const snapshot = structuredClone(live);
  live.sentenceFrame = 'We _____ _____ .';
  live.options[0].text = 'a camera';
  assert.equal(formatPracticeAnswer(snapshot, snapshot.answer), 'I bought a notebook.');
  assert.equal(formatPracticeAnswer(live, live.answer), 'We bought a camera.');
});
