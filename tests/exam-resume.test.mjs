import test from 'node:test';
import assert from 'node:assert/strict';
import { describeResumeSession, examResumeHash, matchingSectionSessions, renderCompletedResumeSources, renderResumeGroup, resumableSessionGroups, resumableSessions } from '../public/exam-library.mjs';

// Deliberately synthetic UUIDs; no learner workspace identifiers are checked in.
const libraryId = '00000000-0000-4000-8000-000000000001';
const ids = { noticeOld: '00000000-0000-4000-8000-000000000011', postOld: '00000000-0000-4000-8000-000000000012', noticeNew: '00000000-0000-4000-8000-000000000013' };
const questions = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: `reading-m1-q${from + i}`, source: `Original fixture · 原题号 ${from + i}` }));
const groups = [
  { id: 'reading-m1-g2', section: 'reading', title: 'Reading · Module 1 · Read a notice. · 原题号 11–12', questions: questions(11, 12) },
  { id: 'reading-m1-g3', section: 'reading', title: 'Reading · Module 1 · Read a social media post. · 原题号 13–15', questions: questions(13, 15) },
];
const tasks = groups.map((group, i) => ({ id: group.id, groupId: group.id, kind: 'read_daily', questionIds: group.questions.map(question => question.id), numberStart: i ? 13 : 11, numberEnd: i ? 15 : 12 }));
const section = { id: 'reading', section: 'reading', modules: [{ id: 'reading-m1', title: 'Reading · Module 1', sourceNumber: 1, tasks }] };
const library = { libraryId, title: 'Original resume fixture', contentHash: 'source-hash', groups, examPlan: { id: 'set', sections: [section] } };
const old = (id, groupId, minute, answer = '') => ({ id, libraryId, groupId, mode: 'practice', answers: { [groups.find(group => group.id === groupId).questions[0].id]: { answer } }, currentIndex: 0, startedAt: `2026-09-10T18:${minute}:00Z`, updatedAt: `2026-09-10T18:${minute}:00Z` });
const modern = (id, selectedGroups = groups.map(group => group.id), minute = '20') => {
  const selectedTasks = tasks.filter(task => selectedGroups.includes(task.groupId));
  return { sessionVersion: 2, id, libraryId, sourceHash: library.contentHash, mode: 'practice', finished: false, selection: { setId: 'set', sectionId: 'reading' }, planSnapshot: { id: 'set', sections: [{ ...section, modules: [{ ...section.modules[0], tasks: selectedTasks }] }] }, cursor: { sectionId: 'reading', moduleId: 'reading-m1', taskId: selectedTasks[0].id, questionId: selectedTasks[0].questionIds[0], phase: 'instructions' }, answers: {}, visited: {}, marked: {}, moduleStates: {}, startedAt: `2026-09-10T18:${minute}:00Z`, updatedAt: `2026-09-10T18:${minute}:00Z` };
};

test('the three reported links collapse only the same empty task and keep distinct reading tasks', () => {
  const sessions = [old(ids.noticeOld, groups[0].id, '06'), old(ids.postOld, groups[1].id, '07'), old(ids.noticeNew, groups[0].id, '08')];
  const before = JSON.stringify(sessions);
  const rows = resumableSessionGroups(sessions, [library]);
  assert.deepEqual(rows.map(row => row.session.id), [ids.noticeNew, ids.postOld]);
  assert.deepEqual(rows[0].history.map(entry => entry.session.id), [ids.noticeOld]);
  assert.equal(rows[0].history[0].target, sessions[0]);
  assert.equal(examResumeHash(rows[0].history[0].target), `#practice/${libraryId}/reading-m1-g2/practice/${ids.noticeOld}`);
  assert.equal(JSON.stringify(sessions), before);
  assert.match(describeResumeSession(sessions[2], library).scopeLabel, /阅读 · 模块 1 · Read a notice\./);
  assert.match(describeResumeSession(sessions[1], library).scopeLabel, /Read a social media post\./);
  assert.match(describeResumeSession(sessions[2], library).questionLabel, /任务内第 1 \/ 2 题（原题号 11）/);
  assert.match(describeResumeSession(sessions[1], library).questionLabel, /原题号 13/);
  assert.equal(describeResumeSession(sessions[1], library).progressLabel, '尚未作答');
});

test('new blank records cannot displace a real draft, recording, transcript or navigation progress', () => {
  const draft = old('draft', groups[0].id, '06', ['A', '']);
  const blank = old('blank', groups[0].id, '40', [' ', '']);
  assert.equal(resumableSessions([blank, draft], [library])[0], draft);
  const recorded = modern('recorded'); recorded.answers[tasks[0].questionIds[0]] = { answer: '', recordingId: 'saved-recording' };
  const empty = modern('empty', undefined, '50');
  assert.equal(resumableSessions([empty, recorded], [library])[0], recorded);
  recorded.answers = { [tasks[0].questionIds[0]]: { answer: '', transcript: 'A retained transcript.' } };
  assert.equal(resumableSessions([empty, recorded], [library])[0], recorded);
  recorded.answers = {}; recorded.cursor.questionId = tasks[1].questionIds[1]; recorded.cursor.taskId = tasks[1].id;
  assert.equal(resumableSessions([empty, recorded], [library])[0], recorded);
  assert.match(describeResumeSession(recorded, library).questionLabel, /任务内第 2 \/ 3 题（原题号 14）/);
});

test('separate unfinished answers remain independent rounds, with stable labels and exact links', () => {
  const older = old('older-answer', groups[0].id, '06', 'A');
  const newer = old('newer-answer', groups[0].id, '07', 'B');
  const newestBlank = old('blank', groups[0].id, '30');
  const rows = resumableSessionGroups([older, newestBlank, newer], [library]);
  assert.equal(rows.length, 1); assert.equal(rows[0].session, newer);
  assert.deepEqual(rows[0].runs.map(run => run.id), [newer.id, older.id]);
  assert.deepEqual(resumableSessions([older, newestBlank, newer], [library]).map(run => run.id), [newer.id, older.id]);
  const html = renderResumeGroup(rows[0]);
  assert.match(html, /第 2 轮 · 保存于/); assert.match(html, /另有 1 轮未完成草稿/); assert.match(html, /第 1 轮独立草稿/);
  assert.ok(html.includes(examResumeHash(older))); assert.ok(html.includes(examResumeHash(newestBlank)));
  assert.equal(rows[0].history.length, 1);
});

test('library, mode and exact question scope stay distinct; an old source follows its actual migrated run', () => {
  const source = old('source', groups[0].id, '06', 'A');
  const projected = modern('projected', [groups[0].id]); projected.selection = { groupId: groups[0].id }; projected.legacySessionId = source.id;
  projected.answers = structuredClone(source.answers);
  const duplicate = old('duplicate', groups[0].id, '30');
  const otherMode = { ...old('exam', groups[0].id, '40'), mode: 'exam' };
  const otherLibrary = { ...old('other-library', groups[0].id, '40'), libraryId: 'other-library' };
  const subset = modern('subset', [groups[0].id]); subset.planSnapshot.sections[0].modules[0].tasks = [{ ...tasks[0], questionIds: [tasks[0].questionIds[0]] }];
  const wholeSection = modern('whole-section');
  const rows = resumableSessionGroups([source, projected, duplicate, otherMode, otherLibrary, subset, wholeSection], [library, { ...library, libraryId: otherLibrary.libraryId }]);
  assert.equal(rows.length, 5);
  const group = rows.find(row => row.session === projected);
  assert.equal(group.history.length, 2);
  assert.equal(group.history.find(entry => entry.session === source).target, projected);
  assert.ok(!resumableSessions([source, projected], [library]).includes(source));
});

test('completed migration sources remain out of active practice but have an explicit review entry', () => {
  const source = old('source', groups[0].id, '06', 'A');
  const projected = modern('completed', [groups[0].id]); projected.legacySessionId = source.id; projected.finished = true;
  assert.deepEqual(resumableSessions([source, projected], [library]), []);
  const html = renderCompletedResumeSources([source, projected], [library]);
  assert.match(html, /1 条已完成接续的旧记录/);
  assert.match(html, /查看完成轮次/); assert.ok(html.includes(examResumeHash(projected)));
  assert.ok(!html.includes(examResumeHash(source)));
});

test('an invalid or stale migration target cannot conceal its recoverable legacy source', () => {
  const source = old('source', groups[0].id, '06', 'A');
  const projected = modern('stale-projection', [groups[0].id]); projected.legacySessionId = source.id; projected.sourceHash = 'different-content';
  assert.deepEqual(resumableSessions([source, projected], [library]), [source]);
  projected.sourceHash = library.contentHash; projected.planSnapshot.sections = [];
  assert.deepEqual(resumableSessions([source, projected], [library]), [source]);
});

test('section buttons resume only the complete selected section, prioritizing real progress', () => {
  const set = { id: 'set', sections: [{ ...section, modules: [{ ...section.modules[0], tasks: undefined, taskIds: groups.map(group => group.id) }] }] };
  const partial = modern('partial', [groups[0].id]); partial.selection = { groupId: groups[0].id }; partial.answers[questions(11, 11)[0].id] = { answer: 'A' };
  const blank = modern('blank', undefined, '50'), draft = modern('draft'); draft.answers[questions(11, 11)[0].id] = { answer: 'A' };
  const testMode = { ...modern('test'), mode: 'exam' };
  const staleSource = { ...modern('stale'), sourceHash: 'other-source' };
  const shifted = modern('wrong-questions'); shifted.planSnapshot.sections[0].modules[0].tasks = [{ ...tasks[0], questionIds: [tasks[0].questionIds[1], tasks[0].questionIds[0]] }, tasks[1]];
  const sessions = [partial, blank, draft, testMode, staleSource, shifted];
  assert.deepEqual(matchingSectionSessions(sessions, library, set, 'reading', 'practice').map(run => run.id), [draft.id, blank.id]);
  assert.deepEqual(matchingSectionSessions(sessions, library, set, 'reading', 'exam').map(run => run.id), [testMode.id]);
  const fullSet = modern('full-set'); fullSet.planSnapshot.sections.push({ id: 'writing', section: 'writing', modules: [] }); fullSet.cursor.sectionId = 'writing';
  assert.deepEqual(matchingSectionSessions([fullSet], library, set, 'reading', 'practice'), []);
  fullSet.finished = true;
  assert.deepEqual(matchingSectionSessions([fullSet], library, set, 'reading', 'practice'), [fullSet]);
  assert.deepEqual(resumableSessions([staleSource], [library]), []);
});

test('resume markup escapes source titles while leaving the original records untouched', () => {
  const safeLibrary = structuredClone(library); safeLibrary.title = '<img src=x onerror=alert(1)>'; safeLibrary.groups[0].title = 'Read <script>alert(1)</script> & return';
  const session = old('safe', groups[0].id, '06'); const before = JSON.stringify({ session, safeLibrary });
  const html = renderResumeGroup(resumableSessionGroups([session], [safeLibrary])[0]);
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img src=x')); assert.match(html, /&lt;script&gt;/);
  assert.equal(JSON.stringify({ session, safeLibrary }), before);
});

test('saved timing presets and content revisions stay separate; object key order alone does not create another scope', () => {
  const one = modern('one'); one.preset = { readingModuleSeconds: 600, sentenceTaskSeconds: 360 };
  const same = modern('same', undefined, '30'); same.preset = { sentenceTaskSeconds: 360, readingModuleSeconds: 600 };
  const longer = modern('longer'); longer.preset = { ...one.preset, readingModuleSeconds: 900 };
  const revision = modern('revision'); revision.preset = one.preset; revision.contentRevision = 'new-revision';
  const semantic = modern('semantic'); semantic.preset = one.preset; semantic.planSnapshot.version = 2;
  const rows = resumableSessionGroups([one, same, longer, revision, semantic], [library]);
  assert.equal(rows.length, 4);
  assert.equal(rows.find(row => row.session === same).history[0].session, one);
});

test('real activity timestamps outrank later heartbeat saves and scalar false or zero are still responses', () => {
  const active = old('active', groups[0].id, '20', false); active.lastUserActivityAt = '2026-09-10T18:20:00Z';
  const heartbeat = old('heartbeat', groups[0].id, '50', 0); heartbeat.lastUserActivityAt = '2026-09-10T18:10:00Z';
  assert.equal(resumableSessionGroups([heartbeat, active], [library])[0].session, active);
  delete active.lastUserActivityAt; delete heartbeat.lastUserActivityAt;
  active.answers['reading-m1-q11'].savedAt = '2026-09-10T18:20:00Z'; heartbeat.answers['reading-m1-q11'].savedAt = '2026-09-10T18:10:00Z';
  const rows = resumableSessionGroups([heartbeat, active], [library]);
  assert.equal(rows[0].session, active); assert.equal(rows[0].runs.length, 2);
});
