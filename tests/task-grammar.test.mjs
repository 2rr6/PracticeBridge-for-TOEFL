import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskGrammar, coverSentence } from '../src/task-grammar.mjs';
import { buildDraftFromSources, extractMaterialSources } from '../src/importer.mjs';
import { validatePackage } from '../src/package.mjs';

// All passages, prompts and answers below are original synthetic material in
// the shapes observed in third-party practice banks and pasted web pages.
const page = (number, text, name = 'original-bank.pdf') => ({ name, page: number, kind: 'pdf', text });
const pasted = text => [{ name: '粘贴文字', kind: 'text', text }];
const questions = result => result.pack.groups.flatMap(group => group.questions);
const errors = result => result.issues.filter(item => item.severity === 'error');
const filled = q => { let i = 0; const byId = Object.fromEntries(q.options.map(o => [o.id, o.text])); return q.sentenceFrame.replace(/_{2,}/g, () => byId[q.answer[i++]]); };

test('coverSentence keeps uncovered words as fixed text and prefers exact capitalization', () => {
  // Tiles are often lower-case even when they open the sentence ("which" → "Which").
  assert.deepEqual(coverSentence('The guide who met us was kind.', ['was', 'the', 'who', 'guide', 'met us', 'is']), { frame: '_____ _____ _____ _____ _____ kind.', order: [1, 3, 2, 4, 0] });
  // When one tile could fill either "The" or "the", the exact match gets the tile.
  assert.deepEqual(coverSentence('The dog saw the cat.', ['the', 'dog', 'saw', 'cat']), { frame: 'The _____ _____ _____ _____.', order: [1, 2, 0, 3] });
  const reach = coverSentence('Do you know when it starts?', ['starts', 'when', 'know', 'Do', 'does', 'it', 'you']);
  assert.equal(reach.frame, '_____ _____ _____ _____ _____ _____?');
  // Two different covers leave the same number of fixed words: no guess.
  assert.equal(coverSentence('the cat saw the dog', ['the', 'cat saw', 'dog']), null);
  assert.equal(coverSentence('Hello there.', ['goodbye', 'friend']), null);
});

test('choice questions keep their passage and per-passage keys despite restarted numbering', () => {
  const result = parseTaskGrammar([
    page(1, `Reading passages with answers
Passage 1: Harbor Ferry Times
Notice · 40 words · 2 questions
The morning ferry leaves at seven. Bicycles ride free before noon.
Question 1
When does the morning ferry leave?
A. At six
B. At seven
Question 2
What rides free before noon?
A. Bicycles
B. Scooters
ANSWER KEY
1. B
The notice gives seven o'clock.
2. A`),
    page(2, `Passage 2: Quiet Study Rooms
Notice · 30 words · 1 question
Rooms on the third floor are silent at all times.
Question 1
Which floor is always silent?
A. The first
B. The third
A N S W E R K E Y
1. B`),
  ]);
  const groups = result.pack.groups;
  assert.deepEqual(groups.map(g => [g.section, g.title, g.questions.map(q => q.answer)]), [
    ['reading', 'Harbor Ferry Times', ['B', 'A']], ['reading', 'Quiet Study Rooms', ['B']],
  ]);
  assert.match(groups[0].passage, /^The morning ferry leaves at seven/);
  assert.doesNotMatch(groups[0].passage, /40 words/);
  assert.equal(groups[0].questions[0].explanation, "The notice gives seven o'clock.");
  assert.equal(errors(result).length, 0);
});

test('a transcript printed after its questions stays with that recording, and missing audio is reported', () => {
  const result = parseTaskGrammar(pasted(`Transcripts, questions and answers
Lost Umbrella
Play this recording — https://example.invalid/audio/umbrella
Question 1
Choose the best response.
A. Thanks for bringing it back.
B. The bus is late.
T R A N S C R I P T
I think this umbrella is yours.
Library Hours Change
Play this recording — https://example.invalid/audio/hours
Question 2
What is changing?
A. The library hours
B. The cafe menu
TRANSCRIPT
Starting Monday, the library opens at eight.
Answer key
1. A
2. A`));
  const [first, second] = result.pack.groups;
  assert.deepEqual([first.section, first.title, first.passage], ['listening', 'Lost Umbrella', 'I think this umbrella is yours.']);
  assert.equal(first.questions[0].options[1].text, 'The bus is late.');
  assert.equal(second.title, 'Library Hours Change');
  assert.ok(result.issues.some(item => item.severity === 'warning' && item.message.includes('https://example.invalid/audio/hours')));
});

test('Build a Sentence items in slash, spaced-bank, quoted and sample-answer shapes', () => {
  const result = parseTaskGrammar(pasted(`Build a Sentence practice
Question 1
Context: "I missed the bus this morning."
Arrange these words into a sentence: late / you / were / Why / was
(1 extra word should not be used)
Answer: Why were you late
Extra words not used: was
2. Daily routines
Speaker: Tell me about your morning.
coffee I drink always black does
Answer: I always drink black coffee.
Item 3
“Where did you park?”
the near library parked I
Example 4
Question: How was the trip?
Scrambled words:
the / was / views / amazing / were
Your sentence:
Sample answer: The views were amazing today.`));
  const qs = questions(result);
  assert.deepEqual(qs.map(filled), ['Why were you late', 'I always drink black coffee.', 'the views were amazing today.']);
  assert.equal(qs[0].prompt, 'I missed the bus this morning.');
  // "today" is in the sample answer but not among the tiles: fixed frame text.
  assert.equal(qs[2].sentenceFrame, '_____ _____ _____ _____ today.');
  // Item 3 has tiles but no stated answer: kept out of the pack with an error.
  assert.ok(errors(result).some(item => /原题号 3 没有明示答案/.test(item.message)));
  assert.equal(validatePackage(result.pack).issues.filter(item => item.severity === 'error').length, 0);
});

test('an answer key at the back resolves numbered-only keys and repeated stems', () => {
  const result = parseTaskGrammar(pasted(`Build a Sentence
Item 1
“Did you finish?”
finished I have already it
Reading
Tide Pools
Science · 20 words
Small fish shelter in tide pools.
Question 1
Where do small fish shelter?
A. In tide pools
B. In caves
ANSWER KEY
Build a Sentence
Item 1
I have already finished it.
Reading
Question 1
Where do small fish shelter?
A. In tide pools
The passage says tide pools.`));
  const [sentence, choice] = questions(result);
  assert.equal(filled(sentence), 'I have already finished it.');
  assert.equal(choice.answer, 'A');
  assert.equal(choice.explanation, 'The passage says tide pools.');
});

test('writing tasks keep the prompt and leave out response areas and sample answers', () => {
  const result = parseTaskGrammar(pasted(`Write an Email prompt bank
1. Request
You borrowed a projector from the media office and it stopped working.
Writing to: Media Office
Subject: Broken projector
• Explain what happened
• Ask how to return it
2. Follow-up
Your club application has had no reply for two weeks.
Subject: Application status
• Ask about the status
Write for an Academic Discussion
1. Campus Gardens
Professor: Should every campus keep a community garden? Why or why not?
Mina: Gardens teach practical skills.
Your post:
Sample answer: I agree with Mina because...`));
  const qs = questions(result);
  assert.deepEqual(qs.map(q => q.type), ['email', 'email', 'discussion']);
  assert.match(qs[0].prompt, /Writing to: Media Office\nSubject: Broken projector\n• Explain what happened/);
  assert.doesNotMatch(qs[2].prompt, /Sample answer|Your post/);
  assert.match(qs[2].explanation, /^I agree with Mina/);
});

test('"Writing to:" is a field label, not a Writing section heading', () => {
  const result = parseTaskGrammar(pasted(`Write an Email
1. Inquiry
You want to rent a practice room.
Writing to: Music Department
Subject: Practice room
• Ask about prices
2. Complaint
Your order arrived late.
Writing to: Online Store
Subject: Late order
• Describe the delay`));
  assert.equal(questions(result).length, 2);
  assert.match(questions(result)[0].prompt, /• Ask about prices$/);
});

test('speaking items need task-like text; headings and prose alone do not create questions', () => {
  const result = parseTaskGrammar(pasted(`Listen and Repeat
1. 6 words
Please return the keys today.
6 words
2. Study Technique No. 1: Listen closely and repeat each phrase twice.
3. Which club would you join? Explain your choice.
Longer sentences
Tiers group sentences by length.
4. 9 words
The lab closes early on the last Friday.
Take an Interview
1. Weekend plans
What do you usually do on weekends, and why?
2. Planning notes
Teachers should prepare the room before class. Arrange the chairs in a circle so that every learner can see the board and hear the others clearly during each activity of the lesson today.`));
  const qs = questions(result);
  assert.deepEqual(qs.map(q => [q.type, q.answer]), [
    ['listen_repeat', 'Please return the keys today.'],
    ['listen_repeat', 'The lab closes early on the last Friday.'],
    ['interview', null],
  ]);
  assert.ok(result.issues.some(item => /原文没有对应的音频文件/.test(item.message)));
});

test('a syllabus "Professor:" field is not a discussion prompt', () => {
  const result = parseTaskGrammar(pasted(`Academic Discussion warm-up
1. Course facts
Professor: Dana Reyes, PhD
Office: Room 4
Email: reyes@example.invalid`));
  assert.equal(result.recognized, false);
});

test('page furniture repeated at page edges is removed before parsing', () => {
  const footer = 'Original Bank · Build a Sentence · example.invalid';
  const result = parseTaskGrammar([
    page(1, `Build a Sentence\n1. Morning\nSpeaker: When do you wake up?\nup wake I early\nAnswer: I wake up early.\n${footer}\nSection 4, Writing`),
    page(2, `2. Lunch\nSpeaker: Where is lunch?\nis the cafe in lunch\nAnswer: Lunch is in the cafe.\n${footer}\nSection 4, Writing`),
    page(3, `3. Evening\nSpeaker: What do you read?\nnovels read I\nAnswer: I read novels.\n${footer}\nSection 4, Writing`),
  ]);
  assert.deepEqual(questions(result).map(filled), ['I wake up early.', 'lunch is in the cafe.', 'I read novels.']);
  assert.ok(questions(result).every(q => !q.explanation.includes('example.invalid')));
});

test('the importer uses the task reader for single-task pasted text', async () => {
  const text = `Reading practice
Passage 1: Bike Share
Notice · 20 words · 1 question
Bikes must be returned within two hours.
Question 1
How long can a bike be kept?
A. One hour
B. Two hours
Answers
1. B`;
  const inspected = await extractMaterialSources({ text });
  const draft = await buildDraftFromSources(inspected, {});
  assert.equal(draft.method, 'task-grammar');
  assert.equal(draft.pack.groups[0].questions[0].answer, 'B');
  assert.ok(draft.recognition.some(item => item.profile === 'task-grammar' && item.state === 'recognized'));
});

test('one-line answer tables, repeated numbers and multiple-answer items stay conservative', () => {
  const keyed = parseTaskGrammar(pasted(`Reading practice
Passage 1: Two Doors
Notice · 10 words · 2 questions
The blue door is on the left.
1. Which door is blue?
A. The left one.
B. The right one.
2. Which side is it on?
A. Left.
B. Right.
Answer key: 1 A, 2 A`));
  assert.deepEqual(questions(keyed).map(q => q.answer), ['A', 'A']);
  assert.equal(questions(keyed)[1].options[1].text, 'Right.');
  const repeated = parseTaskGrammar(pasted(`Reading practice
Passage 1: Two Doors
Notice · 10 words · 2 questions
The blue door is on the left.
1. Which door is blue?
A. The left one.
B. The right one.
1. Which door is green?
A. The left one.
B. The right one.
Answer key: 1 A`));
  assert.ok(questions(repeated).every(q => q.answer === null));
  assert.ok(errors(repeated).some(item => item.message.includes('重复')));
  const multiple = parseTaskGrammar(pasted(`Reading practice
Passage 1: Choices
Notice · 10 words · 1 question
Walking saves money and time.
1. Choose TWO benefits.
A. Money
B. Time
C. Noise
Answer key: 1 A`));
  assert.equal(multiple.recognized, false);
  assert.ok(errors(multiple).some(item => item.message.includes('多项回答')));
});

test('copied web Complete the Words restores gaps only from the page\'s own full text', async () => {
  const { createInlineBlanks } = await import('../src/exam-plan.mjs');
  const result = parseTaskGrammar(pasted(`Complete the Words: practice questions
Question 1. River otters. Type the missing letters in each box, then check.
River otters live near clean water. They ca small fish and sw quickly.
Check answers
Reset
Show model answer
River otters live near clean water. They catch small fish and swim quickly.
Question 2. Desert plants. Type the missing letters in each box, then check.
Cacti st water in thick stems.
Check answers
Show model answer
Many cacti keep water in thick stems.`));
  const [group] = result.pack.groups;
  assert.equal(group.title, 'River otters');
  assert.equal(group.passage, 'River otters live near clean water. They ca___ small fish and sw__ quickly.');
  assert.deepEqual(group.questions.map(q => [q.type, q.answer]), [['fill_blank', 'tch'], ['fill_blank', 'im']]);
  assert.equal(createInlineBlanks(group).anchors.length, 2);
  // Item 2's full text differs beyond the gaps: nothing is inferred.
  assert.equal(result.pack.groups.length, 1);
  assert.ok(errors(result).some(item => item.message.includes('不能逐词对应')));
});
