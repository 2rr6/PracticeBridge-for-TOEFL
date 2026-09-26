import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { addExamDocumentMetadata, buildExamPlan, createInlineBlanks, isLegacyModularExam, matchExamDirections } from '../src/exam-plan.mjs';
import { canonicalJSON, collectMediaPaths, contentHash, createPackageZip, mapPackageMedia, parseNativeImport, validatePackage } from '../src/package.mjs';
import { gradeAnswer } from '../src/store.mjs';

// All content is original synthetic material. Only structural source labels and
// filename conventions resemble the modular PDF format supported by the adapter.
const source = (section, module, n, page = 4, numbered = true) => `original.pdf · 第 ${page} 页 · 第 ${n + 3} 行 · ${section}${module ? ` Section, Module ${module}` : ''} · ${numbered ? `原题号 ${n}` : `原文顺序第 ${n} 条（原文未编号）`}`;
const base = (id, type, prompt, answer, src) => ({ id, type, prompt, answer, options: [], explanation: '', audio: null, image: null, timeLimitSeconds: 0, prepareSeconds: 0, source: src });
const group = (id, section, title, passage, questions, audio = null) => ({ id, section, title, passage, questions, audio, image: null });
function wave() {
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(38, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(2, 40);
  return bytes;
}
function legacy97() {
  const groups = [], files = new Map();
  const addAudio = name => { files.set(name, wave()); return name; };
  for (const module of [1, 2]) {
    const words = Array.from({ length: 10 }, (_, i) => module === 2 && i === 6 ? 'pre -\n- - -' : 'pre _ _ _ _');
    const passage = `😀 These words appear in this original paragraph: ${words.join(', ')}. Keep the ending.`;
    const blanks = Array.from({ length: 10 }, (_, i) => base(`reading-m${module}-q${i + 1}`, 'fill_blank', 'Fill in the missing letters in the paragraph.', 'test', source('Reading', module, i + 1, module === 1 ? 4 : 9)));
    groups.push(group(`reading-m${module}-g1`, 'reading', `Reading · Module ${module} · Fill in the missing letters`, passage, blanks));
    for (const [gi, first, last, title] of [[2, 11, 12, 'Read a notice.'], [3, 13, 15, 'Read an email.'], [4, 16, 20, 'A Shared Roof']]) {
      const questions = Array.from({ length: last - first + 1 }, (_, i) => ({ ...base(`reading-m${module}-q${first + i}`, 'single_choice', `Which detail supports statement ${first + i}?`, 'A', source('Reading', module, first + i)), options: [{ id: 'A', text: 'The stated detail.' }, { id: 'B', text: 'An unrelated detail.' }] }));
      const body = gi === 3 ? `${title}\nTo: reader@example.invalid\nFrom: class@example.invalid\nSubject: Notebook\nBring a notebook to the workshop.` : `${title}\nA small group shares useful materials.`;
      groups.push(group(`reading-m${module}-g${gi}`, 'reading', `Reading · Module ${module} · ${title}`, body, questions));
    }
  }
  for (const module of [1, 2]) {
    const ranges = module === 1 ? [[1, 8, 'Question Response'], [9, 10, 'Conversation'], [11, 12, 'Conversation'], [13, 14, 'Announcements'], [15, 18, 'Academic Talks']] : [[1, 8, 'Question Response'], [9, 10, 'Conversation'], [11, 12, 'Announcements'], [13, 16, 'Academic Talks']];
    ranges.forEach(([first, last, category], index) => {
      const cue = category === 'Question Response' ? 'Choose the best response.' : category === 'Conversation' ? 'Listen to a conversation.' : category === 'Announcements' ? 'Listen to an announcement in a classroom.' : 'Listen to a talk in a class.';
      const questions = Array.from({ length: last - first + 1 }, (_, i) => {
        const number = first + i;
        const q = { ...base(`listening-m${module}-q${number}`, 'single_choice', category === 'Question Response' ? `Speaker: May I use item ${number}?` : `What does statement ${number} describe?`, 'A', source('Listening', module, number, module === 1 ? 17 : 22)), options: [{ id: 'A', text: 'The supplied response.' }, { id: 'B', text: 'An unrelated response.' }] };
        if (category === 'Question Response') q.audio = addAudio(`audio/Listening${module}_Question Response_Question${number}.wav`);
        return q;
      });
      const audio = category === 'Question Response' ? null : addAudio(`audio/Listening${module}_${category}_Questions${first}-${last}.wav`);
      if (audio) addAudio(`audio/Listening${module}_${category}_Directions${first}-${last}.wav`);
      groups.push(group(`listening-m${module}-g${index + 1}`, 'listening', `Listening · Module ${module} · ${cue}`, `${cue}\nSpeaker: These materials belong to our workshop.`, questions, audio));
    });
  }
  const sentences = Array.from({ length: 10 }, (_, i) => ({ ...base(`writing-sentence-q${i + 1}`, 'sentence_order', 'What did you buy?\nI _____ _____ .', ['B', 'A'], source('Writing', null, i + 1, 28)), options: [{ id: 'A', text: 'a notebook' }, { id: 'B', text: 'bought' }, { id: 'C', text: 'buy' }], sentenceFrame: 'I _____ _____ .', answerSlots: 2 }));
  groups.push(group('writing-g1', 'writing', 'Writing · Build a Sentence', 'Move the supplied words to build a sentence.\nA clock will show the time for this task.', sentences));
  const email = base('writing-email-q1', 'email', 'Write an Email\nYou will have 7 minutes to write the email.\nAsk the workshop organizer about an available table.\nYour Response:\nTo: organizer@example.invalid\nSubject: A table', null, source('Writing', null, 1, 30, false));
  email.timeLimitSeconds = 420;
  groups.push(group('writing-g2', 'writing', 'Writing · Write an Email', '', [email]));
  const discussion = base('writing-discussion-q1', 'discussion', 'Write for an Academic Discussion\nYou will have 10 minutes to write.\nShould a classroom have a shared bookshelf?\nOne view favors sharing; another stresses tidy storage.', null, source('Writing', null, 1, 31, false));
  discussion.timeLimitSeconds = 600;
  groups.push(group('writing-g3', 'writing', 'Writing · Write for an Academic Discussion', '', [discussion]));
  const repeat = Array.from({ length: 7 }, (_, i) => ({ ...base(`speaking-repeat-q${i + 1}`, 'listen_repeat', 'Listen and repeat.', `This is original practice sentence ${i + 1}.`, source('Speaking', null, i + 1, 34, false)), audio: addAudio(`audio/Speaking_Listen_Repeat_Question${i + 1}.wav`) }));
  groups.push(group('speaking-g1', 'speaking', 'Speaking · Listen and Repeat', 'No time for preparation will be provided.\nYou are showing visitors their seats.', repeat));
  addAudio('audio/Speaking_Listen_Repeat_Directions.wav');
  const interviews = Array.from({ length: 4 }, (_, i) => ({ ...base(`speaking-interview-q${i + 1}`, 'interview', `Describe an activity related to topic ${i + 1}.`, null, source('Speaking', null, i + 1, 35, false)), audio: addAudio(`audio/Speaking_Interview_Question${i + 1}.wav`) }));
  groups.push(group('speaking-g2', 'speaking', 'Speaking · Take an Interview', 'No time for preparation will be provided.\nAn interviewer asks about hobbies.', interviews));
  addAudio('audio/Speaking_Interview_Directions.wav');
  const raw = { schemaVersion: 1, id: `exam-${'a'.repeat(16)}`, version: '1.0.0', title: 'Original modular practice', description: '', rights: 'Original synthetic material', groups };
  const checked = validatePackage(raw, files);
  assert.deepEqual(checked.issues.filter(item => item.severity === 'error'), []);
  return { pack: checked.pack, files };
}
const allTasks = plan => plan.sections.flatMap(section => section.modules.flatMap(module => module.tasks));
const errors = value => value.issues.filter(item => item.severity === 'error');

test('97-question legacy projection restores all modules and 20 exact anchored blanks without mutating stored JSON', () => {
  const { pack, files } = legacy97();
  const before = canonicalJSON(pack), beforeHash = contentHash(pack, {});
  assert.equal(isLegacyModularExam(pack), true);
  const plan = buildExamPlan(pack, { mediaCatalog: [...files.keys()] });
  assert.deepEqual(plan.sections.map(section => [section.section, section.modules.map(module => module.tasks.reduce((n, task) => n + task.questionIds.length, 0))]), [['reading', [20, 20]], ['listening', [18, 16]], ['writing', [12]], ['speaking', [11]]]);
  const tasks = allTasks(plan);
  assert.equal(tasks.length, 22);
  assert.equal(new Set(tasks.flatMap(task => task.questionIds)).size, 97);
  const anchors = tasks.flatMap(task => task.inlineBlanks?.anchors || []);
  assert.equal(anchors.length, 20);
  for (const task of tasks.filter(task => task.inlineBlanks)) {
    const passage = pack.groups.find(group => group.id === task.groupId).passage;
    assert.equal(task.screen, 'all_questions');
    assert.equal(task.inlineBlanks.answerMode, 'missing_letters');
    assert.equal(task.inlineBlanks.textHash, createHash('sha256').update(passage).digest('hex'));
    assert.deepEqual(task.inlineBlanks.anchors.map(anchor => anchor.localNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const anchor of task.inlineBlanks.anchors) {
      assert.equal(passage.slice(anchor.start, anchor.end), anchor.rawGap);
      assert.equal(passage.slice(anchor.prefixStart, anchor.prefixEnd), 'pre');
      assert.equal(anchor.missingLetterCount, 4);
    }
  }
  assert.ok(anchors.some(anchor => anchor.rawGap.includes('\n')));
  assert.equal(canonicalJSON(pack), before);
  assert.equal(contentHash(pack, {}), beforeHash);
  assert.equal(canonicalJSON(validatePackage(pack, files).pack), before);
  assert.equal(Object.hasOwn(pack, 'examSets'), false);
});

test('timing ownership matches source structure without turning legacy defaults into official durations', () => {
  const { pack } = legacy97();
  const plan = buildExamPlan(pack);
  const tasks = allTasks(plan);
  assert.ok(plan.sections[0].modules.every(module => module.timing.scope === 'module' && module.timing.durationSeconds === null));
  assert.ok(plan.sections[1].modules.every(module => module.timing.scope === 'question' && module.timing.durationSeconds === null));
  assert.equal(tasks.find(task => task.kind === 'build_sentence').timing.scope, 'task');
  assert.equal(tasks.find(task => task.kind === 'build_sentence').timing.durationSeconds, null);
  assert.equal(tasks.find(task => task.kind === 'write_email').timing.durationSeconds, 420);
  assert.equal(tasks.find(task => task.kind === 'academic_discussion').timing.durationSeconds, 600);
  assert.ok(tasks.filter(task => ['listen_repeat', 'interview'].includes(task.kind)).every(task => task.timing.prepareSeconds === 0 && task.timing.durationSeconds === null));
});

test('nine instruction clips are unique task directions, separate from stimuli, with optional runtime URLs', () => {
  const { pack, files } = legacy97();
  const mediaCatalog = [...files.keys()].map((name, index) => ({ name, url: `/api/media/${String(index).padStart(64, '0')}` }));
  const result = matchExamDirections(pack, mediaCatalog);
  assert.equal(result.matches.length, 9);
  assert.deepEqual(result.issues, []);
  assert.equal(new Set(result.matches.map(item => item.groupId)).size, 9);
  assert.ok(result.matches.every(item => item.direction.audio.startsWith('/api/media/') && item.direction.basis === 'filename' && item.direction.verifiedContent === false));
  const plan = buildExamPlan(pack, { mediaCatalog });
  assert.equal(allTasks(plan).flatMap(task => task.directions).filter(direction => direction.audio).length, 9);
  assert.ok(allTasks(plan).filter(task => task.kind.startsWith('listen_') && task.kind !== 'listen_repeat').every(task => task.presentation.passageVisibility === 'review'));
  assert.ok(allTasks(plan).filter(task => task.kind === 'listen_response').every(task => task.presentation.questionPromptVisibility === 'review'));
  const one = [...files.keys()].find(name => /Listening1_Conversation_Directions9-10/.test(name));
  const ambiguous = matchExamDirections(pack, [one, `duplicate/${one}`]);
  assert.equal(ambiguous.matches.length, 0);
  assert.ok(ambiguous.issues.length >= 2);
  const missing = structuredClone(pack);
  missing.groups.find(group => group.id === 'listening-m1-g5').questions.splice(1, 1);
  assert.equal(matchExamDirections(missing, [...files.keys()].filter(name => /Listening1_Academic Talks_Directions/.test(name))).matches.length, 0);
});

test('new metadata validates and round-trips through a native ZIP including instructions audio', async () => {
  const { pack: old, files } = legacy97();
  const added = addExamDocumentMetadata(old, { mediaCatalog: [...files.keys()] }).pack;
  const moduleAudio = 'audio/module-opening.wav'; files.set(moduleAudio, wave());
  added.examSets[0].sections[0].modules[0].instructions = { text: 'Original module directions.', audio: moduleAudio, source: 'Original fixture', basis: 'user', verifiedContent: false };
  const checked = validatePackage(added, files);
  assert.deepEqual(errors(checked), []);
  assert.equal(checked.pack.examContractVersion, 1);
  assert.equal(checked.pack.minReaderVersion, '0.3.0');
  assert.equal(collectMediaPaths(checked.pack).length, 44);
  assert.equal(checked.pack.groups.find(group => group.id === 'listening-m1-g2').passage, '');
  assert.match(checked.pack.groups.find(group => group.id === 'listening-m1-g2').transcript, /These materials belong/);
  const response = checked.pack.groups.find(group => group.id === 'listening-m1-g1').questions[0];
  assert.equal(response.prompt, 'Choose the best response.');
  assert.match(response.transcript, /Speaker: May I use item 1/);
  const zip = (await createPackageZip(checked.pack, files));
  const imported = (await parseNativeImport([{ name: 'practicebridge.zip', data: zip.toString('base64') }]));
  const again = validatePackage(imported.pack, imported.files);
  assert.deepEqual(errors(again), []);
  assert.equal(canonicalJSON(again.pack), canonicalJSON(checked.pack));
  for (const name of collectMediaPaths(checked.pack)) assert.deepEqual(imported.files.get(name), files.get(name));
  const mapped = mapPackageMedia(checked.pack, name => `/api/media/${createHash('sha256').update(name).digest('hex')}`);
  assert.ok(mapped.examSets[0].sections[0].modules[0].instructions.audio.startsWith('/api/media/'));
  assert.ok(mapped.groups.flatMap(group => group.directions).filter(direction => direction.audio).every(direction => direction.audio.startsWith('/api/media/')));
  assert.ok(!JSON.stringify(checked.pack).includes('/api/media/'));
});

test('inline validation preserves an explicit fixed suffix and UTF-16 offsets rather than replacing the whole word', () => {
  const raw = { schemaVersion: 1, id: 'suffix-example', version: '1', title: 'Suffix example', groups: [group('cloze', 'reading', 'Original inline exercise', '😀 A con__tion remains stable.', [base('gap', 'fill_blank', 'Fill the missing letters.', 'di', 'Original source')])] };
  raw.groups[0].taskKind = 'complete_words';
  raw.groups[0].inlineBlanks = { textField: 'passage', offsetUnit: 'utf16', answerMode: 'missing_letters', anchors: [{ questionId: 'gap', localNumber: null, prefixStart: 5, prefixEnd: 8, start: 8, end: 10, missingLetterCount: 2, prefix: 'con', rawGap: '__', source: 'Original source' }] };
  const checked = validatePackage(raw);
  assert.deepEqual(errors(checked), []);
  const blank = checked.pack.groups[0].inlineBlanks;
  assert.equal(blank.textHash.length, 64);
  const anchor = blank.anchors[0], text = checked.pack.groups[0].passage;
  assert.equal(text.slice(0, anchor.start) + 'di' + text.slice(anchor.end), '😀 A condition remains stable.');
  const changed = structuredClone(checked.pack); changed.groups[0].passage = changed.groups[0].passage.replace('stable', 'different');
  assert.ok(errors(validatePackage(changed)).some(item => /哈希/.test(item.message)));
});

test('mismatched anchor lengths, overlap, full-word answers and missing execution markers are rejected', () => {
  const { pack: old, files } = legacy97();
  const valid = addExamDocumentMetadata(old, { mediaCatalog: [...files.keys()] }).pack;
  for (const mutate of [
    pack => { pack.groups[0].inlineBlanks.anchors[0].missingLetterCount = 2; },
    pack => { pack.groups[0].inlineBlanks.anchors[1].prefixStart = 0; },
    pack => { pack.groups[0].questions[0].answer = 'pretest'; },
    pack => { pack.groups[0].inlineBlanks.answerMode = 'whole_word'; },
    pack => { delete pack.examContractVersion; },
    pack => { pack.minReaderVersion = '0.2.0'; },
  ]) { const changed = structuredClone(valid); mutate(changed); assert.ok(errors(validatePackage(changed, files)).length); }
});

test('a question cannot be referenced twice in one frozen plan even across modules or sections', () => {
  const { pack: old, files } = legacy97();
  const valid = addExamDocumentMetadata(old, { mediaCatalog: [...files.keys()] }).pack;
  const repeated = structuredClone(valid);
  repeated.examSets[0].sections[0].modules[1].taskIds.push('reading-m1-g1');
  assert.ok(errors(validatePackage(repeated, files)).some(item => /重复|多次/.test(item.message)));
  assert.throws(() => buildExamPlan(repeated), /重复/);
  const duplicatedQuestion = structuredClone(valid);
  duplicatedQuestion.groups[1].questions[0].id = duplicatedQuestion.groups[2].questions[0].id;
  assert.throws(() => buildExamPlan(duplicatedQuestion), /题目 ID/);
});

test('generic legacy packs retain canonical content and use internal, unnumbered scope containers', () => {
  const raw = { schemaVersion: 1, id: 'unclassified-user-material', version: '1', title: 'My materials', groups: [
    group('reading-items', 'reading', 'My list, not an official module', 'A short original paragraph.', [{ ...base('r1', 'single_choice', 'Choose one.', 'A', ''), options: [{ id: 'A', text: 'One' }, { id: 'B', text: 'Two' }] }]),
    group('writing-items', 'writing', 'Mixed practice', '', [{ ...base('w1', 'sentence_order', 'Arrange the sentence.', ['A', 'B'], ''), options: [{ id: 'A', text: 'We' }, { id: 'B', text: 'read.' }] }, base('w2', 'email', 'Write a short message.', null, '')]),
    group('listening-items', 'listening', 'A recorded exercise', '', [{ ...base('l1', 'single_choice', 'Which item?', 'A', ''), options: [{ id: 'A', text: 'One' }, { id: 'B', text: 'Two' }] }]),
  ] };
  const pack = validatePackage(raw).pack;
  pack.groups[0].questions[0].timeLimitSeconds = 60;
  const before = canonicalJSON(pack);
  const plan = buildExamPlan(pack);
  assert.ok(plan.sections.flatMap(section => section.modules).every(module => module.sourceNumber === null && !module.title.includes('Module 1')));
  assert.equal(plan.sections.find(section => section.section === 'reading').modules[0].timing.scope, 'module');
  assert.equal(plan.sections.find(section => section.section === 'listening').modules[0].navigation.back, 'none');
  const writing = plan.sections.find(section => section.section === 'writing').modules[0];
  assert.equal(writing.tasks.length, 2);
  assert.deepEqual(writing.tasks.map(task => task.kind), ['build_sentence', 'write_email']);
  assert.ok(allTasks(plan).every(task => task.timing.durationSeconds === null));
  assert.equal(canonicalJSON(pack), before);
});

test('selectors choose only the requested branch and task/question IDs stay unique', () => {
  const { pack } = legacy97();
  const whole = buildExamPlan(pack);
  const reading = buildExamPlan(pack, { setId: whole.id, sectionId: 'reading' });
  assert.equal(reading.sections.length, 1);
  assert.equal(allTasks(reading).flatMap(task => task.questionIds).length, 40);
  const groupOnly = buildExamPlan(pack, { groupId: 'reading-m1-g2' });
  assert.equal(allTasks(groupOnly).length, 1);
  assert.deepEqual([allTasks(groupOnly)[0].numberStart, allTasks(groupOnly)[0].numberEnd], [1, 2]);
  assert.throws(() => buildExamPlan(pack, { sectionId: 'not-present' }), /没有可运行/);
  assert.throws(() => buildExamPlan(pack, { setId: 'not-present' }), /找不到/);
});

test('rich discussion roles come from source layout; missing layout leaves the exact plain fallback', () => {
  const { pack: old } = legacy97();
  const target = old.groups.find(group => group.id === 'writing-g3');
  const rows = [
    [72, 760, 'Write for an Academic Discussion'], [72, 730, 'A professor asks a question and students respond.'], [72, 700, 'You will have 10 minutes to write.'], [72, 650, 'An effective response will contain at least 100 words.'],
    [72, 480, 'Should a class share a small bookshelf?'], [72, 465, 'Explain your view using an example.'],
    [160, 380, 'Sharing books makes new subjects easier to explore.'], [160, 365, 'A shelf also gives us a reason to discuss our interests.'],
    [160, 330, 'We first need a way to keep the shelf tidy.'], [160, 315, 'Clear labels could make a small collection manageable.'],
  ];
  target.questions[0].prompt = rows.map(row => row[2]).join('\n');
  const chunk = { name: 'original.pdf', page: 31, kind: 'pdf', text: target.questions[0].prompt, layout: { width: 600, height: 800, items: rows.map(([x, y, str]) => ({ x, y, str, width: 360, height: 12, hasEOL: true })) } };
  const enriched = addExamDocumentMetadata(old, { chunks: [chunk] }).pack;
  const discussion = enriched.groups.find(group => group.id === 'writing-g3').presentation.discussion;
  assert.equal(discussion.prompt, rows.slice(4, 6).map(row => row[2]).join('\n'));
  assert.deepEqual(discussion.posts.map(post => post.speaker), ['Student 1', 'Student 2']);
  assert.equal(discussion.posts[0].text, rows.slice(6, 8).map(row => row[2]).join('\n'));
  const fallback = addExamDocumentMetadata(old).pack.groups.find(group => group.id === 'writing-g3');
  assert.equal(fallback.presentation.discussion, undefined);
  assert.equal(fallback.questions[0].prompt, target.questions[0].prompt);
});

test('strict metadata rejects unknown fields, null objects, unsupported timing assertions and dishonest audio verification', () => {
  const { pack: old, files } = legacy97();
  const valid = addExamDocumentMetadata(old, { mediaCatalog: [...files.keys()] }).pack;
  for (const mutate of [
    pack => { pack.groups[0].presentation = null; },
    pack => { pack.groups[0].presentation.customRenderer = 'arbitrary'; },
    pack => { pack.groups[0].timing = { scope: 'module', durationSeconds: 60, prepareSeconds: null, basis: 'unknown', source: '' }; },
    pack => { const d = pack.groups.flatMap(group => group.directions).find(direction => direction.audio); d.verifiedContent = true; },
    pack => { pack.examSets[0].sections[0].modules[0].sourceNumber = 1.2; },
  ]) { const changed = structuredClone(valid); mutate(changed); assert.ok(errors(validatePackage(changed, files)).length); }
});

test('anchor discovery never depends on the answer and handles fixed suffixes when markers are explicit', () => {
  const q = base('one-gap', 'fill_blank', 'Fill the letters.', null, 'Original source');
  const g = group('one', 'reading', 'One original gap', 'A con__tion matters.', [q]);
  const before = createInlineBlanks(g);
  q.answer = 'not-an-anchor';
  assert.deepEqual(createInlineBlanks(g), before);
  assert.equal(g.passage.slice(before.anchors[0].end).startsWith('tion'), true);
});

function passageInteraction(kind) {
  const sentences = ['A lamp shines.', 'The room is quiet.', 'A reader arrives.'];
  const passage = sentences.join(' ');
  let offset = 0;
  const ranges = sentences.map((sentence, index) => { const result = { id: String.fromCharCode(65 + index), start: offset, end: offset + sentence.length }; offset += sentence.length + 1; return result; });
  const candidates = kind === 'sentence_select' ? ranges : [0, ranges[0].end, ranges[1].end, passage.length].map((position, index) => ({ id: String.fromCharCode(65 + index), start: position, end: position }));
  const question = { ...base('interaction-q', 'single_choice', kind === 'sentence_select' ? 'Select the sentence that describes the room.' : 'Insert this sentence: A note remains on the table.', 'B', 'Original interaction fixture'), interaction: { kind, textField: 'passage', offsetUnit: 'utf16', candidates, ...(kind === 'sentence_insert' ? { sentence: 'A note remains on the table.' } : {}) } };
  return { schemaVersion: 1, examContractVersion: 1, minReaderVersion: '0.3.0', id: `original-${kind}`, version: '1', title: 'Original passage interaction', groups: [{ ...group('passage-task', 'reading', 'An original passage', passage, [question]), taskKind: 'read_academic' }], examSets: [{ id: 'one-set', title: 'One set', sections: [{ id: 'reading', section: 'reading', title: 'Reading', modules: [{ id: 'reading-main', title: 'Original reading', sourceNumber: null, taskIds: ['passage-task'] }] }] }] };
}

test('sentence selection preserves clickable source ranges and grades candidate IDs even with empty options', async () => {
  const raw = passageInteraction('sentence_select');
  const result = validatePackage(raw);
  assert.deepEqual(errors(result), []);
  const question = result.pack.groups[0].questions[0];
  assert.deepEqual(question.options, []);
  assert.equal(question.interaction.textHash, createHash('sha256').update(raw.groups[0].passage).digest('hex'));
  assert.equal(raw.groups[0].passage.slice(question.interaction.candidates[1].start, question.interaction.candidates[1].end), 'The room is quiet.');
  assert.equal(gradeAnswer(question, 'B').status, 'correct');
  assert.equal(gradeAnswer(question, 'A').status, 'incorrect');
  assert.equal(gradeAnswer(question, '').status, 'unanswered');
  const plan = buildExamPlan(result.pack);
  assert.equal(allTasks(plan)[0].kind, 'read_academic');
  assert.deepEqual(allTasks(plan)[0].questionIds, ['interaction-q']);
  const zip = (await createPackageZip(result.pack, new Map()));
  const imported = (await parseNativeImport([{ name: 'interaction.zip', data: zip.toString('base64') }]));
  assert.equal(canonicalJSON(validatePackage(imported.pack).pack), canonicalJSON(result.pack));
});

test('sentence insertion uses exactly four explicit zero-length positions without editing source passage', () => {
  const raw = passageInteraction('sentence_insert'), before = raw.groups[0].passage;
  const result = validatePackage(raw);
  assert.deepEqual(errors(result), []);
  const q = result.pack.groups[0].questions[0];
  assert.equal(q.interaction.candidates.length, 4);
  assert.ok(q.interaction.candidates.every(candidate => candidate.start === candidate.end));
  assert.equal(q.interaction.sentence, 'A note remains on the table.');
  assert.equal(result.pack.groups[0].passage, before);
  assert.equal(gradeAnswer(q, 'B').status, 'correct');
  delete raw.groups[0].questions[0].interaction.sentence;
  raw.groups[0].questions[0].options = null;
  const inPrompt = validatePackage(raw);
  assert.deepEqual(errors(inPrompt), []);
  assert.equal(inPrompt.pack.groups[0].questions[0].interaction.sentence, undefined);
  assert.match(inPrompt.pack.groups[0].questions[0].prompt, /A note remains on the table\./);
});

test('interaction validation rejects ambiguous/missing source positions, stale hashes and imported raw interaction HTML', () => {
  const cases = [
    ['sentence_select', p => { p.groups[0].questions[0].interaction.candidates[1].start = 2; }],
    ['sentence_select', p => { p.groups[0].questions[0].interaction.candidates[0].end = 0; }],
    ['sentence_select', p => { p.groups[0].questions[0].interaction.candidates[1].id = 'A'; }],
    ['sentence_select', p => { p.groups[0].questions[0].answer = 'Z'; }],
    ['sentence_select', p => { p.groups[0].questions[0].interaction.textHash = '0'.repeat(64); }],
    ['sentence_select', p => { p.groups[0].questions[0].interaction.sentence = 'This field is only for insertion.'; }],
    ['sentence_insert', p => { p.groups[0].questions[0].interaction.candidates.pop(); }],
    ['sentence_insert', p => { p.groups[0].questions[0].interaction.candidates[1].end += 1; }],
    ['sentence_insert', p => { p.groups[0].questions[0].interaction.candidates[1].start = p.groups[0].questions[0].interaction.candidates[1].end = 0; }],
    ['sentence_insert', p => { p.groups[0].questions[0].interaction.sentence = ''; }],
    ['sentence_insert', p => { p.groups[0].questions[0].options = [{ id: 'A', text: 'Only one conflicting option' }]; }],
    ['sentence_insert', p => { p.groups[0].passage = ''; }],
    ['sentence_insert', p => { p.groups[0].passage = '<sentence-insert option="A">A lamp shines.</sentence-insert> The room is quiet.'; }],
  ];
  for (const [kind, mutate] of cases) { const raw = passageInteraction(kind); mutate(raw); assert.ok(errors(validatePackage(raw)).length, mutate.toString()); }
  const unicode = passageInteraction('sentence_select');
  unicode.groups[0].passage = `😀 ${unicode.groups[0].passage}`;
  unicode.groups[0].questions[0].interaction.candidates[0].start = 1;
  assert.ok(errors(validatePackage(unicode)).some(item => /Unicode/.test(item.message)));
});

test('provided single-choice options must agree with the source interaction candidate IDs', () => {
  const raw = passageInteraction('sentence_select');
  raw.groups[0].questions[0].options = ['A', 'B', 'C'].map(id => ({ id, text: `Original candidate ${id}` }));
  assert.deepEqual(errors(validatePackage(raw)), []);
  raw.groups[0].questions[0].options[2].id = 'D';
  assert.ok(errors(validatePackage(raw)).some(item => /ID 必须/.test(item.message)));
});
