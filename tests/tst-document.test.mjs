import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { parseTstDocument } from '../src/tst-document.mjs';
import { extractMaterialSources } from '../src/importer.mjs';
import { validatePackage } from '../src/package.mjs';
import { buildExamPlan } from '../src/exam-plan.mjs';
import { createStore } from '../src/store.mjs';
import { createMaterialInbox } from '../src/materials.mjs';
import { createMaterialProcessing } from '../src/material-processing.mjs';

// This entire compact workbook is authored for this test. No actual publisher
// passages, questions, answer keys, media filenames or PDFs are test assets.
function page(number, section, body, { links = [], positions = {} } = {}) {
  const text = `Practice Test #9\n\nFor the TOEFL® ${section} Section\n\n${body}\n${number}`;
  const lines = text.split('\n');
  const items = lines.flatMap((str, index) => str.trim() ? [{ str, x: 60, y: 760 - index * 12, width: str.length * 4, height: 10, fontName: 'body', line: index + 1, ...(positions[str] || {}) }] : []);
  return { name: 'authored-modular-workbook.pdf', kind: 'pdf', page: number, text, layout: { width: 612, height: 792, items }, links };
}
function withAudio(chunk, associations) {
  for (const [text, name] of associations) {
    const item = chunk.layout.items.find(item => item.str === text);
    assert.ok(item, `fixture anchor ${text}`);
    chunk.links.push({ url: `https://example.invalid/practice/${name}`, rect: [item.x + 15, item.y - 2, item.x + 30, item.y + 10] });
  }
  return chunk;
}
function fixture() {
  return [
    page(1, 'Reading', 'Directions\nType of Task Description\nRead each text.'),
    page(2, 'Reading', 'Module 1\n\nFill in the missing letters in the paragraph.\n\nA pla _ _ can gr _ _.'),
    page(3, 'Reading', 'Read an email.\n\n3. What should the reader bring?\na. A pencil.\nb. A cup.\n\nSubject: Art class\nBring a pencil on Tuesday.', { positions: {
      'Read an email.': { y: 680 }, '3. What should the reader bring?': { y: 500 }, 'a. A pencil.': { y: 480 }, 'b. A cup.': { y: 460 }, 'Subject: Art class': { y: 650 }, 'Bring a pencil on Tuesday.': { y: 630 },
    } }),
    page(4, 'Reading', 'Campus Transport\n\nTrains move quickly. Buses stop often. Walking takes longer.\n\n4. What stops often?\na. Buses.\nb. Trains.\n\n5. There are four locations in the passage marked (A, B, C, and D). Where would the following\nsentence best fit?\n\nThey pause beside the main gate.\n\n(A) Trains move quickly. (B) Buses stop often. (C) Walking takes longer. (D)'),
    page(5, 'Reading', 'Module 2\n\nFill in the missing letters in the paragraph.\n\nThe wa _ _ is clean.'),
    page(6, 'Reading', 'Room Hours\n\nDoors close at noon.\n\n7. When do the doors close?\na. At noon.\nb. At dawn.'),
    page(7, 'Reading', 'Answer Key'),
    page(8, 'Reading', 'Module 1: Answer Key\n\n1-2\n\nA pla{nt} can gr{ow}.\n\n3. A\n\nThe email asks for a pencil.\n\n4. A\n\nBuses stop often.\n\n5. C\n\nThe added sentence refers to buses.'),
    page(9, 'Reading', 'Module 2: Answer Key\n\n6-6\n\nThe wa{ll} is clean.\n\n7. A\n\nThe passage states noon.'),
    page(10, 'Listening', 'Directions\nType of Task Description\nListen once.'),
    withAudio(page(11, 'Listening', 'Module 1\n\nChoose the best response.\n\n1.\na. It starts next year.\nb. Yes, the room is ready.'), [['1.', 'tea-short.mp3']]),
    withAudio(page(12, 'Listening', 'Listen to a conversation.\nDo not read the questions before listening.'), [['Listen to a conversation.', 'window-chat.mp3']]),
    page(13, 'Listening', '2. What is open?\na. The window.\nb. The box.\n\n3. What will the speakers do?\na. Draw.\nb. Close the window.'),
    withAudio(page(14, 'Listening', 'Listen to an announcement.\n\n4. Where is the event?\na. The hall.\nb. The garden.'), [['Listen to an announcement.', 'hall-news.mp3']]),
    withAudio(page(15, 'Listening', 'Listen to a talk in a science class.\n\n5. What is the topic?\na. Seeds.\nb. Windows.'), [['Listen to a talk in a science class.', 'seed-lesson.mp3']]),
    withAudio(page(16, 'Listening', 'Module 2\n\nChoose the best response.\n\n6.\na. The tree is tall.\nb. I will send the form.'), [['6.', 'form-short.mp3']]),
    withAudio(page(17, 'Listening', 'Listen to a talk in an art class.\n\n7. What is the topic?\na. Clay.\nb. Sand.'), [['Listen to a talk in an art class.', 'clay-lesson.mp3']]),
    page(18, 'Listening', 'Answer Key'),
    page(19, 'Listening', 'Module 1: Answer Key\n\nListen and Choose #1\n\n1. B, Yes, the room is ready.\n\nThe reply permits starting.\n\nTranscript: Can we begin now?\n\nConversation #1\n\n2. A\n\nThe window is open.\n\n3. B\n\nThey decide to close it.\n\nConversation #1 Transcript\n\nSpeaker One: The window is open.\nSpeaker Two: Let us close it.\n\nAnnouncement #1\n\n4. A\n\nThe announcement names the hall.\n\nAnnouncement #1 Transcript\n\nThe evening concert is in the hall.\n\nListen to an Academic Talk #1\n\n5. A\n\nThe talk describes seeds.\n\nListen to an Academic Talk #1 Transcript\n\nA seed holds the beginning of a plant.'),
    page(20, 'Listening', 'Module 2: Answer Key\n\nListen and Choose #2\n\n6. B, I will send the form.\n\nThe reply accepts the request.\n\nTranscript: Please send the form.\n\nListen to an Academic Talk #2\n\n7. A\n\nThe topic is clay.\n\nListen to an Academic Talk #2 Transcript\n\nClay can be shaped while wet.'),
    page(21, 'Speaking', 'Directions\nType of Task Description\nListen and respond.'),
    withAudio(page(22, 'Speaking', 'Listen and Repeat\nNo time for preparation will be provided.\nYou are helping in a workshop.\n\n1. Listen and repeat only once.\n\n2. Listen and repeat only once.'), [['You are helping in a workshop.', 'workshop-directions.mp3'], ['1. Listen and repeat only once.', 'workshop-first.mp3'], ['2. Listen and repeat only once.', 'workshop-second.mp3']]),
    withAudio(page(23, 'Speaking', 'Take an Interview\nYou will have 45 seconds to respond to each question.\nYou will not be given any time to prepare.\n\n1.\nPlease speak after the question.'), [['1.', 'hobby-interview.mp3']]),
    page(24, 'Speaking', 'Answer Key'),
    withAudio(page(25, 'Speaking', 'Listen and Repeat\n\n1. Put the brush beside the cup.\n\n2. Open the small box carefully.\n\nTake an Interview\n\n1. What do you enjoy making?\n\nSample Answer\n\nI enjoy making paper models.'), [['Sample Answer', 'hobby-sample-answer.mp3']]),
    page(26, 'Writing', 'Directions\nType of Task Description\nYou will have 6 minutes to complete the Build a Sentence tasks.'),
    page(27, 'Writing', 'Build a Sentence\nYou will have 6 minutes to complete 2 questions.\n\n1. What did you buy?\nI _____ _____.\na book / bought / buy\n\n2. How do you sing?\nWe _____ _____ _____.\nsing / softly / loudly'),
    page(28, 'Writing', 'Write an Email\nAsk the editor whether your story arrived.\nYour Response:\nTo: Editor\nSubject: Story submission\nYou will have 7 minutes to read and write.'),
    page(29, 'Writing', 'Write for an Academic Discussion\nYour professor asks about class projects.\nIn your response, support your opinion.\nAn effective response has at least 100 words.\nNoah\nLeah\nI enjoy shared projects.\nWe can divide the work.\nWe can learn together.\nWe can compare ideas.\nIt saves time.\nI prefer individual projects.\nI can choose the topic.\nI can set the pace.\nI can revise freely.\nDr. Avery\nShould a class use shared projects?\nExplain your position.\nSpace for typing answers. You will have 10\nminutes to read and write.', { positions: {
      'Write for an Academic Discussion': { x: 220, y: 690 },
      'Your professor asks about class projects.': { x: 62, y: 620 },
      'In your response, support your opinion.': { x: 62, y: 600 },
      'An effective response has at least 100 words.': { x: 62, y: 580 },
      'Noah': { x: 306, y: 579, width: 24 }, 'Leah': { x: 306, y: 460, width: 24 },
      'I enjoy shared projects.': { x: 354, y: 620 }, 'We can divide the work.': { x: 354, y: 606 },
      'We can learn together.': { x: 354, y: 592 }, 'We can compare ideas.': { x: 354, y: 578 }, 'It saves time.': { x: 354, y: 564 },
      'I prefer individual projects.': { x: 354, y: 490 }, 'I can choose the topic.': { x: 354, y: 476 },
      'I can set the pace.': { x: 354, y: 462 }, 'I can revise freely.': { x: 354, y: 448 },
      'Dr. Avery': { x: 145, y: 380 }, 'Should a class use shared projects?': { x: 62, y: 350 },
      'Explain your position.': { x: 62, y: 336 }, 'Space for typing answers. You will have 10': { x: 292, y: 357 }, 'minutes to read and write.': { x: 292, y: 343 },
    } }),
    page(30, 'Writing', 'Answer Key'),
    page(31, 'Writing', 'Build a Sentence\n\n1. I bought a book.\n\n2. We sing softly.\n\nWrite an Email - Sample Response\n\nPlease confirm my submission.\n\nWrite for an Academic Discussion\n\nShared projects teach cooperation.'),
  ];
}
const mediaNames = () => [...new Set(fixture().flatMap(page => page.links.map(link => new URL(link.url).pathname.split('/').at(-1))))];
const media = () => new Map(mediaNames().map(name => [name, Buffer.from('ID3' + '0'.repeat(40))]));
const question = (pack, id) => pack.groups.flatMap(group => group.questions).find(q => q.id === id);

test('publisher workbook keeps all twelve task kinds, source numbering, controls and media provenance', () => {
  const result = parseTstDocument(fixture(), { mediaNames: mediaNames() });
  assert.equal(result.pack.groups.reduce((sum, group) => sum + group.questions.length, 0), 21);
  assert.equal(new Set(result.pack.groups.map(group => group.taskKind)).size, 12);
  const checked = validatePackage(result.pack, media());
  assert.deepEqual(checked.issues.filter(issue => issue.severity === 'error'), []);
  const plan = buildExamPlan(checked.pack);
  assert.deepEqual(plan.sections.map(section => section.section), ['reading', 'listening', 'writing', 'speaking']);
  assert.equal(question(checked.pack, 'reading-m2-q6').answer, 'll');
  const email = checked.pack.groups.find(group => group.id === 'reading-m1-g2');
  assert.match(email.passage, /Bring a pencil on Tuesday/);
  assert.equal(email.questions[0].options[1].text, 'A cup.');
  assert.match(question(checked.pack, 'reading-m1-q3').source, /第 3 页.*第 8 页/);
  const insert = question(checked.pack, 'reading-m1-q5');
  assert.equal(insert.interaction.kind, 'sentence_insert');
  assert.equal(insert.answer, 'C');
  assert.equal(insert.options.length, 0);
  assert.equal(insert.interaction.candidates.length, 4);
  const passage = checked.pack.groups.find(group => group.questions.includes(insert)).passage;
  const third = insert.interaction.candidates[2].start;
  assert.match(passage.slice(0, third), /Buses stop often\.$/);
  assert.equal(question(checked.pack, 'listening-m1-q1').audio, 'tea-short.mp3');
  assert.equal(question(checked.pack, 'listening-m1-q1').transcript, 'Can we begin now?');
  assert.match(question(checked.pack, 'listening-m1-q1').source, /PDF|原页链接/);
  const talks = checked.pack.groups.filter(group => group.taskKind === 'listen_talk');
  assert.match(talks[0].transcript, /A seed holds/);
  assert.match(talks[1].transcript, /Clay can be shaped/);
  assert.doesNotMatch(talks[0].transcript, /concert|window/);
  assert.equal(checked.pack.groups.find(group => group.taskKind === 'listen_repeat').directions[0].audio, 'workshop-directions.mp3');
  assert.equal(checked.pack.groups.find(group => group.taskKind === 'interview').timing.durationSeconds, 45);
  const speaking = plan.sections.find(section => section.section === 'speaking');
  assert.equal(speaking.modules.length, 2);
  assert.ok(speaking.modules.every(module => module.sourceNumber === null));
  assert.equal(question(checked.pack, 'speaking-interview-q1').localNumber, 1);
  assert.ok(checked.pack.groups.every(group => !group.audio?.includes('sample-answer') && group.questions.every(q => !q.audio?.includes('sample-answer'))));
  const discussion = checked.pack.groups.find(group => group.taskKind === 'academic_discussion').presentation.discussion;
  assert.deepEqual(discussion.posts.map(post => post.speaker), ['Noah', 'Leah']);
  assert.match(discussion.prompt, /^Dr\. Avery\nShould a class use shared projects/);
});

test('a source sentence-key mismatch keeps the original blank frame and remains unscored', () => {
  const { pack, issues } = parseTstDocument(fixture());
  assert.deepEqual(question(pack, 'writing-build_sentence-q1').answer, ['F2', 'F1']);
  const mismatch = question(pack, 'writing-build_sentence-q2');
  assert.equal(mismatch.sentenceFrame, 'We _____ _____ _____.');
  assert.equal(mismatch.answerSlots, 3);
  assert.equal(mismatch.answer, null);
  assert.equal(mismatch.explanation, 'We sing softly.');
  assert.ok(issues.some(issue => issue.path === `${mismatch.id}.answer` && /未按答案修改空位/.test(issue.message)));
});

test('cloze positions come from the printed gaps, while inconsistent or missing keys stay unresolved', () => {
  const changed = fixture();
  changed.find(page => page.page === 8).text = changed.find(page => page.page === 8).text.replace('pla{nt}', 'pla{net}');
  const { pack } = parseTstDocument(changed);
  const group = pack.groups[0];
  assert.equal(group.inlineBlanks.anchors[0].missingLetterCount, 2);
  assert.equal(group.questions[0].answer, null);
  assert.equal(group.questions[1].answer, 'ow');
  const missing = fixture();
  missing.find(page => page.page === 8).text = missing.find(page => page.page === 8).text.replace('1-2', 'Unnumbered key');
  const unknown = parseTstDocument(missing).pack.groups[0];
  assert.ok(unknown.questions.every(q => q.localNumber === null && q.answer === null));
  assert.equal(unknown.inlineBlanks.anchors.length, 2);
});

test('audio is linked by the PDF annotation geometry, never by input order or a guessed filename', () => {
  const reversed = parseTstDocument(fixture(), { mediaNames: mediaNames().reverse() }).pack;
  assert.equal(question(reversed, 'listening-m1-q1').audio, 'tea-short.mp3');
  const ambiguous = parseTstDocument(fixture(), { mediaNames: [...mediaNames().filter(name => name !== 'tea-short.mp3'), 'folder-a/tea-short.mp3', 'folder-b/tea-short.mp3'] });
  assert.equal(question(ambiguous.pack, 'listening-m1-q1').audio, null);
  assert.ok(ambiguous.issues.some(issue => issue.path === 'listening-m1-q1.audio' && /同名媒体不唯一/.test(issue.message)));
  const noLink = fixture(); noLink.find(page => page.page === 11).links = [];
  assert.equal(question(parseTstDocument(noLink, { mediaNames: mediaNames() }).pack, 'listening-m1-q1').audio, null);
});

test('an insertion excerpt appearing twice cannot choose an arbitrary passage position', () => {
  const pages = fixture(), academic = pages.find(page => page.page === 4);
  academic.text = academic.text.replace('Trains move quickly. Buses stop often. Walking takes longer.\n\n4.', 'Trains move quickly. Buses stop often. Walking takes longer.\nTrains move quickly. Buses stop often. Walking takes longer.\n\n4.');
  delete academic.layout;
  const result = parseTstDocument(pages);
  assert.equal(question(result.pack, 'reading-m1-q5').interaction, undefined);
  assert.ok(result.issues.some(issue => /插句题的标记段落无法唯一对应/.test(issue.message)));
});

test('a duplicate key is not taken from another module or silently selected', () => {
  const pages = fixture(); pages.find(page => page.page === 9).text += '\n7. B\nA conflicting copied entry.';
  const result = parseTstDocument(pages);
  assert.equal(question(result.pack, 'reading-m2-q7').answer, null);
  assert.equal(question(result.pack, 'reading-m1-q3').answer, 'A');
  assert.ok(result.issues.some(issue => issue.path === 'reading-m2-q7.answer' && /重复或冲突/.test(issue.message)));
});

test('unrecognized files remain with the established converter routes and multiple sources are explicit', () => {
  assert.equal(parseTstDocument([{ name: 'original.txt', kind: 'text', text: 'Practice Test #9\nModule 1\nAnswer Key' }]), null);
  const added = [...fixture(), { name: 'notes.txt', kind: 'text', text: 'Unconverted extra instructions.' }];
  assert.ok(parseTstDocument(added).issues.some(issue => issue.severity === 'error' && issue.path === 'notes.txt'));
});

function originalPdf({ figure = false, template = false } = {}) {
  let stream = 'BT /F1 12 Tf 40 740 Td (For the TOEFL Reading Section) Tj ET\nBT /F1 12 Tf 40 700 Td (An of) Tj /F2 12 Tf (fi) Tj /F1 12 Tf (ce opens.) Tj ET\nBT /F1 12 Tf 40 660 Td (A) Tj 40 0 Td (B) Tj ET';
  if (figure) stream += '\nq 180 0 0 120 40 500 cm /Im1 Do Q\nq 20 0 0 20 40 470 cm /Im1 Do Q';
  if (template) {
    const lines = ['@title Original color practice', '@rights Original test figure and question', '@section reading', '@group Colors', '@passage', 'A small figure contains four color squares.', '@question single_choice', 'Which color appears in the figure?', '@option A | Red', '@option B | Brown', '@answer A', '@end'];
    stream += lines.map((line, index) => `\nBT /F1 11 Tf 40 ${440 - index * 14} Td (${line}) Tj ET`).join('');
  }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> ${figure ? '/XObject << /Im1 8 0 R >>' : ''} >> /Contents 6 0 R /Annots [7 0 R] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Annot /Subtype /Link /Rect [40 675 80 685] /A << /S /URI /URI (https://example.invalid/source-only.mp3) >> >>',
  ];
  if (figure) objects.push('<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 25 >>\nstream\nff000000ff000000ffffffff>\nendstream');
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('real PDF extraction preserves touching letter runs and reads link metadata without fetching it', async () => {
  const bytes = originalPdf();
  const extracted = await extractMaterialSources({ files: [{ name: 'authored-glyphs.pdf', data: bytes.toString('base64') }] });
  assert.match(extracted.chunks[0].text, /An office opens\./);
  assert.match(extracted.chunks[0].text, /A B/);
  assert.equal(extracted.chunks[0].links[0].url, 'https://example.invalid/source-only.mp3');
  assert.ok(extracted.chunks[0].layout.items.every(item => Number.isInteger(item.line) && item.line > 0));
});

test('a PDF figure preserves its pixels, deterministic name and original page geometry; icons stay excluded', async () => {
  const source = { name: 'authored-figure.pdf', data: originalPdf({ figure: true }).toString('base64') };
  const first = await extractMaterialSources({ files: [source] });
  assert.equal(first.derivedFiles.length, 1);
  assert.equal(first.chunks[0].images.length, 1);
  assert.deepEqual(first.chunks[0].images[0].rect, [40, 500, 220, 620]);
  assert.equal(first.files.length, 2);
  assert.ok(first.media.some(item => item.name === first.derivedFiles[0].name && item.mime === 'image/png'));
  const png = Buffer.from(first.derivedFiles[0].data, 'base64');
  assert.equal(png.readUInt32BE(16), 2); assert.equal(png.readUInt32BE(20), 2);
  const blocks = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') blocks.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  assert.deepEqual(inflateSync(Buffer.concat(blocks)), Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]));
  const second = await extractMaterialSources({ files: [source] });
  assert.deepEqual(second.derivedFiles, first.derivedFiles);
  const reused = await extractMaterialSources({ files: [source, first.derivedFiles[0]] });
  assert.equal(reused.derivedFiles.length, 0);
  assert.equal(reused.files.length, 2);
  const capitalized = { ...first.derivedFiles[0], name: first.derivedFiles[0].name.toUpperCase() };
  const sameCaseFolded = await extractMaterialSources({ files: [source, capitalized] });
  assert.equal(sameCaseFolded.chunks[0].images[0].name, capitalized.name);
  assert.ok(sameCaseFolded.media.some(item => item.name === capitalized.name));
  await assert.rejects(extractMaterialSources({ files: [source, { name: first.derivedFiles[0].name, data: Buffer.from('different bytes').toString('base64') }] }), /内容不同/);
});

test('material conversion and reopening regenerate the same figure while retaining an edited saved draft', async t => {
  const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-results/tst-image-pipeline-tests');
  await fs.mkdir(testRoot, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(testRoot, 'run-'));
  const store = await createStore({ dataDir }), inbox = createMaterialInbox({ store });
  const registered = [];
  const models = { publicSettings: () => ({ provider: 'none', capabilities: {} }), assessMaterials: () => { throw new Error('No model may be called'); }, structure: () => { throw new Error('No model may be called'); } };
  const processor = createMaterialProcessing({ inbox, models, registerDraft: args => {
    registered.push(args);
    const checked = validatePackage(args.pack, args.files);
    return { draftId: `test-${registered.length}`, ...checked, issues: [...args.sourceIssues, ...checked.issues] };
  } });
  t.after(async () => {
    await processor.stop(); await store.close();
    assert.ok(path.resolve(dataDir).startsWith(`${testRoot}${path.sep}`));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const original = { name: 'original-figure-practice.pdf', data: originalPdf({ figure: true, template: true }).toString('base64') };
  const received = await inbox.receive({ files: [original] });
  await processor.assess(received.id, { useAI: false });
  const converted = await processor.convert(received.id, { useAI: false });
  const imageName = [...registered[0].files.keys()].find(name => name.startsWith('derived/'));
  assert.ok(imageName);
  assert.deepEqual(converted.issues.filter(issue => issue.severity === 'error'), []);
  const draft = structuredClone(inbox.get(received.id).draft);
  draft.pack.title = 'A deliberate reviewer edit';
  draft.pack.groups[0].image = imageName;
  await inbox.update(received.id, { draft });
  const reopened = await processor.openDraft(received.id);
  assert.equal(reopened.pack.title, 'A deliberate reviewer edit');
  assert.equal(reopened.pack.groups[0].image, imageName);
  assert.deepEqual(reopened.issues.filter(issue => issue.severity === 'error'), []);
  assert.deepEqual(registered[1].files.get(imageName), registered[0].files.get(imageName));
  assert.deepEqual(await inbox.loadFiles(received.id), [original]);
});
