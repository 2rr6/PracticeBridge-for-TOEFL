import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingFullTestSessions, matchingSectionSessions, renderResumeGroup, resumableSessionGroups } from '../public/exam-library.mjs';

const groups = [
  { id: 'read-a', section: 'reading', questions: [{ id: 'r1' }, { id: 'r2' }] },
  { id: 'read-b', section: 'reading', questions: [{ id: 'r3' }] },
  { id: 'listen-a', section: 'listening', questions: [{ id: 'l1' }] },
  { id: 'build-a', section: 'writing', questions: [{ id: 'w1' }] },
  { id: 'email-a', section: 'writing', questions: [{ id: 'w2' }] },
  { id: 'repeat-a', section: 'speaking', questions: [{ id: 's1' }, { id: 's2' }] },
];
const set = { id: 'original-full-set', sections: [
  { id: 'reading', section: 'reading', modules: [{ id: 'rm1', taskIds: ['read-a'] }, { id: 'rm2', taskIds: ['read-b'] }] },
  { id: 'listening', section: 'listening', modules: [{ id: 'lm1', taskIds: ['listen-a'] }] },
  { id: 'writing', section: 'writing', modules: [{ id: 'wm1', taskIds: ['build-a', 'email-a'] }] },
  { id: 'speaking', section: 'speaking', modules: [{ id: 'sm1', taskIds: ['repeat-a'] }] },
] };
const library = { libraryId: '00000000-0000-4000-8000-000000000002', contentHash: 'original-fixture-source', title: 'Original full-paper fixture', groups };
const runtimeSections = () => set.sections.map(section => ({ ...section, modules: section.modules.map(module => ({ id: module.id, tasks: module.taskIds.map(groupId => ({ id: groupId, groupId, questionIds: groups.find(group => group.id === groupId).questions.map(question => question.id) })) })) }));
const session = (id, minute = '01') => ({ id, sessionVersion: 2, libraryId: library.libraryId, sourceHash: library.contentHash, selection: { setId: set.id }, mode: 'exam', finished: false, planSnapshot: { version: 1, id: set.id, sections: runtimeSections() }, cursor: { sectionId: 'reading', moduleId: 'rm1', taskId: 'read-a', questionId: 'r1', phase: 'instructions' }, answers: {}, updatedAt: `2026-01-01T00:${minute}:00Z` });

test('the full TEST entry requires every section, module and ordered source question', () => {
  const whole = session('whole'), wrong = [];
  const mutate = change => { const item = session(`wrong-${wrong.length}`); change(item); wrong.push(item); };
  mutate(item => item.planSnapshot.sections.pop());
  mutate(item => item.planSnapshot.sections.reverse());
  mutate(item => item.planSnapshot.sections[0].modules.reverse());
  mutate(item => item.planSnapshot.sections[0].modules[0].tasks[0].questionIds.reverse());
  mutate(item => item.planSnapshot.sections[0].modules[0].tasks[0].questionIds.pop());
  mutate(item => item.planSnapshot.sections[0].modules[0].id = 'different-module');
  mutate(item => item.planSnapshot.sections[0].modules[0].tasks[0].groupId = 'different-group');
  const before = structuredClone([whole, ...wrong]);
  assert.deepEqual(matchingFullTestSessions([whole, ...wrong], library, set), [whole]);
  assert.deepEqual([whole, ...wrong], before, 'Entry selection must remain read-only');
});

test('a full run resumes across later sections and harmless runtime task segmentation', () => {
  const whole = session('later-section');
  whole.cursor = { sectionId: 'speaking', moduleId: 'sm1', taskId: 'repeat-a', questionId: 's2', phase: 'response' };
  whole.planSnapshot.sections[0].modules[0].tasks = [
    { id: 'read-a-part-one', groupId: 'read-a', questionIds: ['r1'] },
    { id: 'read-a-part-two', groupId: 'read-a', questionIds: ['r2'] },
  ];
  assert.deepEqual(matchingFullTestSessions([whole], library, set), [whole]);
  assert.deepEqual(matchingFullTestSessions([whole], library, { ...set, sections: runtimeSections() }), [whole]);
});

test('old single-section TEST selectors do not become full papers even in one-section sets', () => {
  const whole = session('whole'), section = session('old-section'), group = session('old-task');
  section.selection.sectionId = 'reading'; group.selection.groupId = 'read-a';
  for (const item of [whole, section, group]) item.planSnapshot.sections = item.planSnapshot.sections.slice(0, 1);
  const readingSet = { ...set, sections: set.sections.slice(0, 1) };
  assert.deepEqual(matchingFullTestSessions([section, group, whole], library, readingSet), [whole]);
  assert.deepEqual(matchingSectionSessions([section], library, readingSet, 'reading', 'exam'), [section]);
});

test('completed, stale, foreign, legacy and practice sessions cannot occupy the full TEST entry', () => {
  const whole = session('whole'), wrong = [];
  for (const change of [item => item.finished = true, item => item.sourceHash = 'old-source', item => delete item.sourceHash, item => item.libraryId = 'other-library', item => item.mode = 'practice', item => item.sessionVersion = 1, item => item.planSnapshot.id = 'other-set']) {
    const item = session(`wrong-${wrong.length}`); change(item); wrong.push(item);
  }
  assert.deepEqual(matchingFullTestSessions([...wrong, whole], library, set), [whole]);
  assert.deepEqual(matchingFullTestSessions([whole], library, { id: set.id, sections: [] }), []);
});

test('saved answers and recordings outrank newer blank full runs without losing other drafts', () => {
  const blank = session('blank', '30'), answer = session('answer', '10'), recorded = session('recorded', '11'), navigated = session('navigated', '20');
  answer.answers.r1 = { answer: 'B' }; recorded.answers.s1 = { answer: '', recordingId: 'original-recording-id' }; navigated.cursor.questionId = 'r2';
  const runs = [blank, answer, navigated, recorded];
  assert.deepEqual(matchingFullTestSessions(runs, library, set).map(item => item.id), ['recorded', 'answer', 'navigated', 'blank']);
  const grouped = resumableSessionGroups(runs, [library]);
  assert.equal(grouped.length, 1); assert.deepEqual(grouped[0].runs.map(item => item.id), ['recorded', 'answer']);
  const html = renderResumeGroup(grouped[0]);
  for (const id of runs.map(item => item.id)) assert.ok(html.includes(`/${id}`), `The ${id} run must remain accessible`);
});
