import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExamDocument } from '../src/exam-document.mjs';

// All passage, prompt, answer and dialogue text below is original synthetic
// material. The user-supplied practice PDF/media must never become test assets.
const page = (number, text, name = 'original-modular-sample.pdf') => ({ name, page: number, kind: 'pdf', text });
function fixture() {
  return [
    page(1, 'Original Language Practice\nSample Test 9'),
    page(2, 'Reading Section, Module 1'),
    page(3, `Fill in the missing letters in the paragraph.
(Questions 1-2)
A pla _ _ can gr _ _ beside a window.

Read a notice.
The workshop opens at noon.
3. When does the workshop open?
(A) At noon
(B) At sunset
Sample Test 9 2`),
    page(4, 'Reading Section, Module 2'),
    page(5, `Fill in the missing letters in the paragraph.
(Questions 1-2)
The small ca- sleeps ne -
- the door.

Read an email.
Please bring a notebook to the class.
3. What should the reader bring?
(A) A paintbrush
(B) A notebook`),
    page(6, 'Reading Section, Module 1\nAnswer Key\nQuestion\nNumber\nAnswer\n1 nt\n2 ow\n3 A'),
    page(7, 'Reading Section, Module 2\nAnswer Key\nQuestion Number Answer\n1 t\n2 ar\n3 B'),
    page(8, 'Listening Section, Module 1'),
    page(9, `Choose the best response.
1. Speaker: Can I borrow your umbrella?
(A) Yes, it is beside the door.
(B) The journey lasted an hour.
Listen to a conversation.
Speaker: I left my pen at home.
Colleague: Here is a spare one.
2. What does the colleague offer?
(A) A pen
(B) A map
3. What did the speaker leave at home?
(A) A key
(B) A pen`),
    page(10, 'Listening Section, Module 2'),
    page(11, `Choose the best response.
1. Speaker: Is the window open?
(A) We arrived yesterday.
(B) I have just closed it.`),
    page(12, 'Listening Section, Module 1\nAnswer Key\nQuestion Number Answer\n1 A\n2 A\n3 B'),
    page(13, 'Listening Section, Module 2\nAnswer Key\nQuestion Number Answer\n1 B'),
    page(14, 'Writing Section'),
    page(15, `Build a Sentence
Arrange the supplied fragments.
1. What did you buy?
I _____ _____ .
a notebook / bought / buy
2. Where can we meet?
_____ _____ at _____ ?
noon / meet / can we`),
    page(16, `Write an Email
You will have 7 minutes to write the email.
Ask a workshop organizer whether a table is available for your drawings.
Your Response:
To: organizer@example.invalid
Subject: Table availability`),
    page(17, `Write for an Academic Discussion
You will have 10 minutes to write.
Teacher: Should a classroom have a shared bookshelf?
Student One: Sharing books would help us explore unfamiliar subjects.
Student Two: We should first decide who will keep the shelf tidy.`),
    page(18, 'Writing Section\nAnswer Key\nQuestion Number Answer\n1 I bought a notebook.\n2 Can we meet at noon?'),
    page(19, 'Speaking Section'),
    page(20, `Listen and Repeat
No time for preparation will be provided.
You are helping visitors find their seats.
Trainer: Your seat is beside the window.
Trainer: Keep the aisle clear for other visitors.`),
    page(21, `Take an Interview
No time for preparation will be provided.
The researcher asks about hobbies.
Interviewer: Which hobby would you like to learn?
Interviewer: Describe a place where you could
practice that hobby.`),
  ];
}
const mediaNames = [
  'audio/Listening1_Question Response_Question1.ogg',
  'audio/Listening2_Question Response_Question1.ogg',
  'audio/Listening1_Conversation_Questions2-3.ogg',
  'audio/Listening1_Conversation_Directions2-3.ogg',
  'audio/Speaking_Listen_Repeat_Question1.ogg',
  'audio/Speaking_Listen_Repeat_Question2.ogg',
  'audio/Speaking_Listen_Repeat_Directions.ogg',
  'audio/Speaking_Interview_Question1.mp4',
  'audio/Speaking_Interview_Question2.mp4',
];
const questions = result => result.pack.groups.flatMap(group => group.questions);
const find = (result, id) => questions(result).find(question => question.id === id);

test('recognition is limited to a modular PDF layout, leaving unrelated documents to other tools', () => {
  assert.equal(parseExamDocument([page(1, 'Reading\n1. Pick a color.\nA. Blue\nB. Red')]), null);
  assert.equal(parseExamDocument(fixture().map(chunk => ({ ...chunk, kind: 'text' }))), null);
  assert.equal(parseExamDocument([]), null);
  assert.equal(parseExamDocument([{ text: 17 }]), null);
});

test('preserves all four sections, module-local ids, answer scopes and source line evidence', () => {
  const result = parseExamDocument(fixture(), { title: 'My practice', mediaNames });
  assert.equal(result.method, 'exam-document');
  assert.equal(result.pack.title, 'My practice');
  assert.deepEqual([...new Set(result.pack.groups.map(group => group.section))], ['reading', 'listening', 'writing', 'speaking']);
  assert.equal(questions(result).length, 18);
  assert.equal(find(result, 'reading-m1-q3').answer, 'A');
  assert.equal(find(result, 'reading-m2-q3').answer, 'B');
  assert.equal(find(result, 'listening-m1-q1').answer, 'A');
  assert.equal(find(result, 'listening-m2-q1').answer, 'B');
  assert.match(find(result, 'reading-m1-q3').source, /第 3 页.*原题号 3.*答案来自.*第 6 页/);
  assert.match(result.pack.groups.find(group => group.questions.some(q => q.id === 'reading-m2-q3')).passage, /Please bring a notebook/);
  assert.equal(new Set(questions(result).map(q => q.id)).size, 18);
  assert.deepEqual(result.issues.filter(item => item.severity === 'error'), []);
});

test('splits missing letters into individual numbered questions, including wrapped hyphens', () => {
  const result = parseExamDocument(fixture());
  assert.equal(find(result, 'reading-m1-q1').answer, 'nt');
  assert.equal(find(result, 'reading-m1-q2').answer, 'ow');
  assert.equal(find(result, 'reading-m2-q1').answer, 't');
  assert.equal(find(result, 'reading-m2-q2').answer, 'ar');
  assert.match(find(result, 'reading-m1-q1').prompt, /pla__.*\n只填写缺少的 2 个字母，不填写完整单词/);
  const group = result.pack.groups.find(group => group.questions.some(q => q.id === 'reading-m1-q1'));
  assert.equal(group.passage, 'A pla _ _ can gr _ _ beside a window.');
});

test('rejects inconsistent blank counts and mismatched letter answers without inferring full words', () => {
  const changedCount = fixture();
  changedCount[2].text = changedCount[2].text.replace('Questions 1-2', 'Questions 1-3');
  const countResult = parseExamDocument(changedCount);
  assert.equal(find(countResult, 'reading-m1-q1'), undefined);
  assert.ok(countResult.issues.some(item => item.severity === 'error' && /空白数量不一致/.test(item.message)));
  assert.ok(countResult.issues.some(item => item.severity === 'error' && /没有对应/.test(item.message)));
  const changedKey = fixture();
  changedKey[5].text = changedKey[5].text.replace('1 nt', '1 plant');
  const keyResult = parseExamDocument(changedKey);
  assert.equal(find(keyResult, 'reading-m1-q1').answer, null);
  assert.ok(keyResult.issues.some(item => item.severity === 'error' && /不符/.test(item.message)));
});

test('sentence ordering preserves fixed words, original fragments and unused distractors', () => {
  const result = parseExamDocument(fixture());
  const q1 = find(result, 'writing-sentence-q1');
  assert.equal(q1.sentenceFrame, 'I _____ _____ .');
  assert.equal(q1.answerSlots, 2);
  assert.deepEqual(q1.options, [{ id: 'F1', text: 'a notebook' }, { id: 'F2', text: 'bought' }, { id: 'F3', text: 'buy' }]);
  assert.deepEqual(q1.answer, ['F2', 'F1']);
  assert.equal(q1.explanation, 'I bought a notebook.');
  assert.match(q1.prompt, /What did you buy\?\nI _____ _____ \./);
  const q2 = find(result, 'writing-sentence-q2');
  assert.deepEqual(q2.answer, ['F3', 'F2', 'F1']);
  assert.equal(q2.sentenceFrame, '_____ _____ at _____ ?');
});

test('ambiguous or incompatible sentence fragments produce explicit issues and no guessed answer', () => {
  const chunks = fixture();
  chunks[14].text = chunks[14].text.replace('a notebook / bought / buy', 'a notebook / bought / bought');
  const result = parseExamDocument(chunks);
  assert.equal(find(result, 'writing-sentence-q1').answer, null);
  assert.ok(result.issues.some(item => item.severity === 'error' && /不能唯一拆成/.test(item.message)));
});

test('email, discussion, repeat targets and interview continuations survive conversion', () => {
  const result = parseExamDocument(fixture());
  const email = find(result, 'writing-email-q1');
  assert.equal(email.timeLimitSeconds, 420);
  assert.match(email.prompt, /organizer@example\.invalid/);
  assert.equal(email.answer, null);
  const discussion = find(result, 'writing-discussion-q1');
  assert.equal(discussion.timeLimitSeconds, 600);
  assert.match(discussion.prompt, /Student One:.*\nStudent Two:/);
  assert.equal(find(result, 'speaking-repeat-q1').answer, 'Your seat is beside the window.');
  assert.equal(find(result, 'speaking-repeat-q1').prepareSeconds, 0);
  assert.equal(find(result, 'speaking-repeat-q1').timeLimitSeconds, 0);
  assert.equal(find(result, 'speaking-interview-q2').prompt, 'Take an Interview');
  assert.equal(find(result, 'speaking-interview-q2').transcript, 'Describe a place where you could\npractice that hobby.');
  assert.match(find(result, 'speaking-interview-q2').source, /原文未编号/);
});

test('filename evidence respects section, module, category and ranges and separates directions from stimuli', () => {
  const result = parseExamDocument(fixture(), { mediaNames });
  assert.equal(find(result, 'listening-m1-q1').audio, mediaNames[0]);
  assert.equal(find(result, 'listening-m2-q1').audio, mediaNames[1]);
  const conversation = result.pack.groups.find(group => group.questions.some(q => q.id === 'listening-m1-q2'));
  assert.equal(conversation.audio, mediaNames[2]);
  assert.equal(find(result, 'listening-m1-q2').audio, null);
  assert.equal(find(result, 'speaking-interview-q2').audio, mediaNames[8]);
  assert.equal(find(result, 'speaking-repeat-q1').audio, mediaNames[4]);
  assert.ok(result.issues.some(item => /尚未试听核实/.test(item.message)));
  assert.ok(result.issues.some(item => /口语原文未编号/.test(item.message)));
  assert.ok(result.pack.groups.some(group => group.directions.some(direction => /Directions/.test(direction.audio || ''))));
  assert.ok(result.pack.groups.every(group => !/Directions/.test(group.audio || '') && group.questions.every(question => !/Directions/.test(question.audio || ''))));
});

test('ambiguous filenames, wrong modules and misleading image filenames never pick a media file', () => {
  const result = parseExamDocument(fixture(), { mediaNames: [
    'one/Listening1_Question Response_Question1.ogg',
    'two/Listening1_Question Response_Question1.ogg',
    'audio/Listening3_Question Response_Question1.ogg',
    'audio/Speaking_Interview_Question1.png',
  ] });
  assert.equal(find(result, 'listening-m1-q1').audio, null);
  assert.equal(find(result, 'listening-m2-q1').audio, null);
  assert.equal(find(result, 'speaking-interview-q1').audio, null);
  assert.ok(result.issues.some(item => /有多个符合/.test(item.message)));
});

test('conflicting keys and repeated local ids remain blocking and unscored', () => {
  const conflicts = fixture();
  conflicts[5].text += '\n3 B';
  const first = parseExamDocument(conflicts);
  assert.equal(find(first, 'reading-m1-q3').answer, null);
  assert.ok(first.issues.some(item => item.severity === 'error' && /相互冲突/.test(item.message)));
  const duplicate = fixture();
  duplicate[2].text += '\n3. Which item is shown?\n(A) A box\n(B) A bag';
  const second = parseExamDocument(duplicate);
  assert.ok(second.issues.some(item => item.severity === 'error' && /重复/.test(item.message)));
  assert.ok(questions(second).filter(q => q.id === 'reading-m1-q3').every(q => q.answer === null));
});

test('additional documents and unsupported blocks cannot silently disappear', () => {
  const extra = parseExamDocument([...fixture(), { name: 'extra.txt', kind: 'text', text: 'A separate task needing conversion.' }]);
  assert.ok(extra.issues.some(item => item.severity === 'error' && /附加文档 extra.txt/.test(item.message)));
  const unsupported = fixture();
  unsupported.push(page(22, 'Writing Section\nMatch each paragraph to a heading.\nThis task uses a different response format.'));
  const result = parseExamDocument(unsupported);
  assert.ok(result.issues.some(item => item.severity === 'error' && /尚未识别的任务内容/.test(item.message)));
  const multiple = parseExamDocument([...fixture(), ...fixture().map(chunk => ({ ...chunk, name: 'other-sample.pdf' }))]);
  assert.equal(multiple.pack.groups.length, 0);
  assert.ok(multiple.issues.some(item => item.severity === 'error'));
});

test('an academic passage title starts a new page group and continuation questions stay attached', () => {
  const chunks = fixture();
  chunks.splice(3, 0,
    page(31, 'A Roof Garden\nSeveral residents share a garden above their building.\n4. Where is the garden?\n(A) Above a building\n(B) Beside a lake'),
    page(32, '5. Who uses the garden?\n(A) Only one gardener\n(B) Several residents'),
  );
  chunks.find(chunk => chunk.page === 6).text += '\n4 A\n5 B';
  const result = parseExamDocument(chunks);
  const group = result.pack.groups.find(group => group.questions.some(q => q.id === 'reading-m1-q4'));
  assert.equal(group.questions.length, 2);
  assert.match(group.title, /A Roof Garden/);
  assert.equal(group.passage, 'A Roof Garden\nSeveral residents share a garden above their building.');
  assert.equal(find(result, 'reading-m1-q5').answer, 'B');
});

// Original synthetic pages in a second observed layout: the section/module title
// repeats on every page, a notice contains its own numbered rules, and some
// question numbers are drawn as graphics so only the indented stem remains.
const placed = (number, rows) => ({ name: 'original-running-header.pdf', page: number, kind: 'pdf', text: rows.map(([, text]) => text).join('\n'), sourceLineX: rows.map(([x]) => x) });
function runningHeaderFixture() {
  const body = (number, header, text) => placed(number, [[190, header], ...text.split('\n').map(line => [79, line])]);
  return [
    body(1, 'Reading Section, Module 1', `In an actual test, the clock will show your remaining time.`),
    body(2, 'Reading Section, Module 1', `Read a notice.
Garden rules:
1. Close the gate: keep the rabbits outside.
2. Water plants: use the green can before noon.
1. What should visitors use to water plants?
(A) A hose
(B) The green can`),
    body(3, 'Reading Section, Module 1', `Tidal Pools
Small animals shelter in rock pools when the tide falls.
2. Where do small animals shelter?
(A) In rock pools
(B) In sand dunes`),
    body(4, 'Reading Section, Module 1', `3. When do the pools form?
(A) When the tide falls
(B) When it rains`),
    body(5, 'Reading Section, Module 1', 'Answer Key\nQuestion Number\nAnswer\n1 B\n2 A\n3 A'),
    placed(6, [[190, 'Listening Section, Module 1'], [79, 'Listen to a conversation.'], [79, 'Speaker: The bus is late again.'],
      [97, 'Why is the speaker waiting?'], [79, '(A) The bus is late'], [79, '(B) The shop is closed'],
      [97, 'What will the speaker probably'], [97, 'do next?'], [79, '(A) Walk home'], [79, '(B) Buy a ticket']]),
    placed(7, [[190, 'Listening Section, Module 1'], [81, 'Where is the speaker?'], [79, '(A) At a bus stop'], [79, '(B) At a library']]),
    body(8, 'Listening Section, Module 1', 'Answer Key\nQuestion Number\nAnswer\n1 A\n2 A\n3 A'),
    body(9, 'Writing Section', `Build a Sentence
1. What did you buy?
I _____ _____ .
a notebook / bought / buy`),
    body(10, 'Writing Section', `2. Where can we meet?
_____ _____ at _____ ?
noon / meet / can we`),
    body(11, 'Writing Section', 'Answer Key\nQuestion Number Answer\n1 I bought a notebook.\n2 Can we meet at noon?'),
    body(12, 'Speaking Section', 'Listen and Repeat\nTrainer: Please take a seat by the door.'),
  ];
}

test('a section title repeated on every page is a running header, not a new module', () => {
  const result = parseExamDocument(runningHeaderFixture());
  const reading = result.pack.groups.filter(group => group.section === 'reading');
  assert.deepEqual(reading.map(group => group.questions.map(q => q.id)), [['reading-m1-q1'], ['reading-m1-q2', 'reading-m1-q3']]);
  assert.match(reading[1].passage, /^Tidal Pools/);
  const writing = result.pack.groups.find(group => group.section === 'writing');
  assert.deepEqual(writing.questions.map(q => q.answer), [['F2', 'F1'], ['F3', 'F2', 'F1']]);
  assert.equal(result.issues.filter(item => item.severity === 'error').length, 0);
});

test('numbered prose without lettered options stays in the passage', () => {
  const notice = parseExamDocument(runningHeaderFixture()).pack.groups[0];
  assert.match(notice.passage, /1\. Close the gate[\s\S]*2\. Water plants/);
  assert.equal(notice.questions.length, 1);
  assert.equal(notice.questions[0].answer, 'B');
});

test('unnumbered stems are recovered from indentation or a fresh option cycle and marked as inferred', () => {
  const result = parseExamDocument(runningHeaderFixture());
  const listening = result.pack.groups.filter(group => group.section === 'listening').flatMap(group => group.questions);
  assert.deepEqual(listening.map(q => [q.id, q.prompt, q.options.map(o => o.id).join(''), q.answer]), [
    ['listening-m1-q1', 'Why is the speaker waiting?', 'AB', 'A'],
    ['listening-m1-q2', 'What will the speaker probably\ndo next?', 'AB', 'A'],
    ['listening-m1-q3', 'Where is the speaker?', 'AB', 'A'],
  ]);
  assert.ok(listening.every(q => q.source.includes('按前一题顺序推定')));
  // Without positions, nothing is guessed: the stems remain unrecognized text.
  const unplaced = parseExamDocument(runningHeaderFixture().map(({ sourceLineX, ...chunk }) => chunk));
  assert.equal(unplaced.pack.groups.filter(group => group.section === 'listening').flatMap(group => group.questions).length, 0);
});
