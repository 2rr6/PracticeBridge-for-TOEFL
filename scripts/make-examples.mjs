import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArchive } from '../src/archive/zip-adapter.mjs';
import { extractDraft } from '../src/importer.mjs';
import { buildExamPlan, createInlineBlanks } from '../src/exam-plan.mjs';
import { canonicalJSON, collectMediaPaths, readZip, validatePackage } from '../src/package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/examples');
const checkOnly = process.argv.includes('--check');
assert.ok(process.argv.slice(2).every(argument => argument === '--check'), 'Supported argument: --check');
const title = '自编演示 · 校园日常';
const description = '九道自编题、八个独立任务，体验四科机考作答、保存和重练。全部时限为演示设置，不是官方考试规则，也不用于官方成绩预测。';
const rights = '本项目自编演示材料，CC0-1.0。音频由 Windows 本地语音合成，非真人录音。非 ETS 或任何机构的题库。';
const source = 'scripts/make-examples.mjs · 本项目自编演示';
const timingSource = `${source} · 自定练习时限，非官方限时`;
const announcement = 'Attention, students. The campus garden workshop has moved from Saturday to Sunday because of rain. It will still start at ten in the morning. Please bring a water bottle. All gardening tools will be provided.';
const emailBody = 'You borrowed a book from your classmate Maya, but you need it for two more days. Write an email to Maya. Explain why you need extra time, suggest a specific return time, and offer to help her if she needs the book sooner.';
const professor = 'Should universities spend more money on quiet individual study rooms or on shared group spaces?';
const discussionInstructions = 'Your professor is teaching a class about university life. Write a post responding to the professor. State your view and support it with a specific reason or example. You may acknowledge a useful feature of the other option.';
const discussionPosts = [
  { speaker: 'Maya', text: 'I would choose more quiet rooms. When I read a difficult chapter, nearby conversations make it hard to follow the argument.' },
  { speaker: 'Jordan', text: 'I would choose shared spaces. My group often needs a place to compare notes and explain problems to one another.' },
];

// The fixed prefix and five blank marks are authored in the source paragraph.
// The separate answer key only validates their length; it never locates a gap.
const text = `@title ${title}
@description ${description} 完整机考布局请导入含音频 ZIP；本 TXT 是可编辑的来源模板，须同时选择列出的三段 WAV。
@rights ${rights}
@section reading
@group A garden on campus
@passage
A small garden behind the campus library used to be an empty parking area. Last spring, a group of students planted vegetables there. They chose plants that needed little water because the area receives limited rain. The students now meet every Sunday morning to care for the garden. Some of the vegetables go to the campus kitchen, and the rest are shared among volunteers. The project has also created a quiet place where students can take a break between classes.
@question single_choice
Why did the students choose plants that needed little water?
@option A | The campus kitchen requested those plants.
@option B | There is limited rain in the area.
@option C | The students only visited once a month.
@option D | The garden had too much shade.
@answer B
@explanation The passage directly links the choice of plants to limited rainfall.
@time 120
@end
@question single_choice
Which activity is NOT mentioned as a use of the garden?
@option A | Growing vegetables for the campus kitchen.
@option B | Providing a place to rest between classes.
@option C | Holding evening music performances.
@option D | Sharing vegetables among volunteers.
@answer C
@explanation Music performances are not mentioned in the passage.
@time 120
@end
@group Complete a word in the garden paragraph
@passage
Students who care for the campus garden are volun_____. They give their time freely and share vegetables with others.
@question fill_blank
Fill in the missing letters in the paragraph. Type only the missing letters.
@answer teers
@explanation The completed word is volunteers. The fixed prefix is volun, so only teers belongs in the five blank cells.
@time 60
@end
@section listening
@group A workshop announcement
@passage
${announcement}
@groupAudio announcement.wav
@question single_choice
Why was the garden workshop moved to Sunday?
@option A | The tools were not available.
@option B | Rain was expected on Saturday.
@option C | Students requested an earlier time.
@answer B
@explanation The announcement says the workshop moved because of rain.
@time 60
@end
@section writing
@group Build a sentence about studying
@question sentence_order
Put the fragments in order to make a complete sentence. Use each fragment once.
@option A | because it is quiet.
@option B | in the library
@option C | I prefer studying
@answer C | B | A
@time 60
@end
@group Write an email to Maya
@question email
${emailBody}
To: Maya
Subject: Two extra days for your book
@time 420
@end
@group Discuss study spaces
@question discussion
${discussionInstructions}
Professor: ${professor}
Maya: ${discussionPosts[0].text}
Jordan: ${discussionPosts[1].text}
@time 600
@end
@section speaking
@group A short interview
@question interview
Think about a place where you enjoy studying. What makes this place work well for you? Give a specific example.
@audio interview.wav
@prepare 15
@time 45
@end
@group Listen and repeat
@question listen_repeat
Listen to the sentence and repeat it as accurately as you can.
@answer The library will stay open until nine this evening.
@audio repeat.wav
@prepare 0
@time 15
@end
`;

// Reuse the shipped original clips. Generating the manifest must not depend on
// a private synthesis cache or rewrite other published examples/media.
const media = new Map();
for (const name of ['announcement.wav', 'interview.wav', 'repeat.wav']) media.set(name, await readFile(resolve(out, name)));
const files = [...media].map(([name, data]) => ({ name, data: data.toString('base64') }));
const draft = await extractDraft({ files, text, title, useAI: false, consent: false }, null);
assert.deepEqual(draft.issues.filter(item => item.severity === 'error'), []);

const pack = draft.pack;
pack.id = 'practicebridge-original-demo';
pack.version = '1.1.0';
pack.description = description;
pack.examContractVersion = 1;
pack.minReaderVersion = '0.3.0';
const known = new Map(pack.groups.flatMap(group => group.questions.map(question => [question.id, question])));
assert.deepEqual([...known.keys()], ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9']);
assert.deepEqual(pack.groups.map(group => group.questions.length), [2, 1, 1, 1, 1, 1, 1, 1]);
assert.deepEqual(pack.groups.flatMap(group => group.questions.map(question => question.type)), ['single_choice', 'single_choice', 'fill_blank', 'single_choice', 'sentence_order', 'email', 'discussion', 'interview', 'listen_repeat']);

const time = (scope, durationSeconds, prepareSeconds = null) => ({ scope, durationSeconds, prepareSeconds, basis: 'user', source: timingSource });
const noTime = { scope: 'none', durationSeconds: null, prepareSeconds: null, basis: 'unknown', source: '' };
const inherit = { scope: 'inherit_module', durationSeconds: null, prepareSeconds: null, basis: 'unknown', source: '' };
const groupSpecs = [
  ['g1', 'read_academic', inherit], ['g6', 'complete_words', inherit], ['g2', 'listen_announcement', time('question', 60)],
  ['g3', 'build_sentence', time('task', 60)], ['g7', 'write_email', time('task', 420)], ['g8', 'academic_discussion', time('task', 600)],
  ['g4', 'interview', time('question', 45, 15)], ['g5', 'listen_repeat', time('question', 15, 0)],
];
for (const [index, group] of pack.groups.entries()) {
  const [id, taskKind, timing] = groupSpecs[index];
  Object.assign(group, { id, taskKind, timing, presentation: { screen: taskKind === 'complete_words' ? 'all_questions' : 'one_question', passageVisibility: group.section === 'listening' || group.section === 'speaking' ? 'review' : 'attempt', questionPromptVisibility: taskKind === 'interview' ? 'review' : 'attempt' } });
  for (const [ordinal, question] of group.questions.entries()) {
    question.source = `${source} · ${question.id}`;
    question.ordinalInTask = ordinal + 1;
  }
}
const groups = new Map(pack.groups.map(group => [group.id, group]));
for (const [number, qid] of ['q1', 'q2', 'q3'].entries()) known.get(qid).localNumber = number + 1;
known.get('q4').localNumber = 1;
for (const [number, qid] of ['q5', 'q6', 'q7'].entries()) known.get(qid).localNumber = number + 1;
known.get('q8').localNumber = 1;
known.get('q9').localNumber = 2;

const words = groups.get('g6');
words.inlineBlanks = createInlineBlanks(words);
assert.equal(words.inlineBlanks.anchors.length, 1);
assert.equal(words.inlineBlanks.anchors[0].prefix, 'volun');
assert.equal(words.inlineBlanks.anchors[0].rawGap, '_____');
assert.equal(words.inlineBlanks.anchors[0].missingLetterCount, 5);
groups.get('g1').presentation.document = { kind: 'academic', title: 'A garden on campus', blocks: [{ kind: 'paragraph', text: groups.get('g1').passage }] };
groups.get('g2').transcript = groups.get('g2').passage;
groups.get('g2').passage = '';
Object.assign(known.get('q5'), { sentenceFrame: '_____ _____ _____', answerSlots: 3 });
groups.get('g7').presentation.email = { to: 'Maya', subject: 'Two extra days for your book', body: emailBody };
groups.get('g8').presentation.discussion = { prompt: professor, posts: discussionPosts, instructions: discussionInstructions };
known.get('q8').transcript = known.get('q8').prompt;
known.get('q8').prompt = 'Listen to the interview question and answer aloud.';

const instructions = text => ({ text, audio: null, source, basis: 'user', verifiedContent: true });
const section = (name, taskIds, timing, navigation, introduction) => ({ id: name, section: name, title: name[0].toUpperCase() + name.slice(1), modules: [{ id: `${name}-demo`, title: `${name[0].toUpperCase() + name.slice(1)} practice`, sourceNumber: null, taskIds, timing, navigation, instructions: instructions(introduction) }] });
pack.examSets = [{ id: 'campus-demo', title, sections: [
  section('reading', ['g1', 'g6'], time('module', 300), { back: 'module', review: 'module', lockOnAdvance: true }, 'Read the campus passage and complete one word. This original demonstration allows five minutes for the whole Reading module. You may review its three answers before finishing.'),
  section('listening', ['g2'], time('question', 60), { back: 'none', review: 'none', lockOnAdvance: true }, 'Listen to the original synthetic announcement, then answer the question. The one-minute demonstration clock begins when the response screen appears.'),
  section('writing', ['g3', 'g7', 'g8'], noTime, { back: 'task', review: 'task', lockOnAdvance: true }, 'Build a sentence, write an email, and join an academic discussion. These demonstration tasks allow one, seven, and ten minutes respectively. Each task has its own clock.'),
  section('speaking', ['g4', 'g5'], { scope: 'question', durationSeconds: null, prepareSeconds: null, basis: 'unknown', source: '' }, { back: 'none', review: 'none', lockOnAdvance: true }, 'Check your microphone, then answer an interview question and repeat a short sentence. The interview allows fifteen seconds of preparation and forty-five seconds to respond; the repetition allows fifteen seconds with no preparation. These are demonstration settings.'),
] }];

const validated = validatePackage(pack, media);
assert.deepEqual(validated.issues.filter(item => item.severity === 'error'), []);
const normalized = validated.pack, plan = buildExamPlan(normalized);
const tasks = plan.sections.flatMap(section => section.modules.flatMap(module => module.tasks));
assert.equal(tasks.length, 8);
assert.equal(tasks.reduce((total, task) => total + task.questionIds.length, 0), 9);
assert.ok(tasks.every(task => task.timing.durationSeconds > 0));
assert.ok(tasks.filter(task => task.kind === 'complete_words').every(task => task.inlineBlanks?.anchors.length === task.questionIds.length && task.screen === 'all_questions'));
assert.deepEqual(collectMediaPaths(normalized), [...media.keys()].sort());

const json = Buffer.from(JSON.stringify(normalized, null, 2) + '\n');
const zip = new Map();
zip.set('practicebridge.json', json);
for (const [name, bytes] of media) zip.set(name, bytes);
// The shared writer fixes timestamps. Compatibility compares member bytes, as
// different ZIP engines may encode identical content with different containers.
const archive = (await writeArchive({ entries: [...zip].map(([name, bytes]) => ({ name, bytes })) })).buffer;
const roundTrip = await readZip(archive);
assert.equal(canonicalJSON(JSON.parse(roundTrip.get('practicebridge.json'))), canonicalJSON(normalized));
for (const [name, bytes] of media) assert.equal(Buffer.compare(roundTrip.get(name), bytes), 0);

const outputs = new Map([['practicebridge.json', json], ['getting-started.zip', archive], ['getting-started.txt', Buffer.from(text)]]);
if (!checkOnly) await mkdir(out, { recursive: true });
for (const [name, bytes] of outputs) {
  const actual = checkOnly ? await readFile(resolve(out, name)) : bytes;
  if (checkOnly && name.endsWith('.zip')) {
    const stored = await readZip(actual), expected = await readZip(bytes);
    assert.deepEqual([...stored.keys()].sort(), [...expected.keys()].sort(), `${name} member inventory differs`);
    for (const [member, content] of expected) assert.deepEqual(stored.get(member), content, `${name}: ${member} content differs`);
  } else if (checkOnly) {
    // Windows Git checkout can expand LF to CRLF in the two text artifacts.
    assert.equal(actual.toString('utf8').replaceAll('\r\n', '\n'), bytes.toString('utf8').replaceAll('\r\n', '\n'), `${name} content differs; run node scripts/make-examples.mjs`);
  } else await writeFile(resolve(out, name), bytes);
  console.log(`${name} SHA256 ${createHash('sha256').update(actual).digest('hex')}`);
}
console.log(`Original example ${checkOnly ? 'verified' : 'written'}: 8 tasks/groups, 9 stable question IDs, 7 component types, 4 sections, 3 unchanged synthetic audio clips.`);
