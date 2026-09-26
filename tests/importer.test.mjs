import test from 'node:test';
import assert from 'node:assert/strict';
import ZipFixture from './helpers/zip-fixture.mjs';
import { extractDraft } from '../src/importer.mjs';

// Original, synthetic fixtures. Nothing is taken from a commercial question bank.
const SOURCE = `@title Garden practice
@rights Original synthetic fixture
@section reading
@group The garden
@passage
The garden opens at nine. Mira waters the plants on Tuesdays.
@question single_choice
When does the garden open?
@option A | At eight.
@option B | At nine.
@answer B
@explanation The passage states that the garden opens at nine.
@end
@question fill_blank
Mira waters the plants on ____.
@end
@section speaking
@group Interview
@question interview
Describe a place where you like to study.
@time 45
@prepare 10
@end`;
const file = (name, text) => ({ name, data: Buffer.from(text).toString('base64') });

// Ordinary worksheet wording, with no PracticeBridge directives. It deliberately
// resets the visible question number, includes NOT, and omits one answer key.
const WORKSHEET = `Title: Campus practice
Rights: Original synthetic fixture
Reading: Campus garden
Passage:
The garden is open on weekdays. It is not open on Sundays.
Questions:
1. Which statement is NOT true?
A. The garden opens on weekdays.
B. The garden opens on Sundays.
C. The garden has a weekday schedule.
2. The garden is closed on ____.
Answer key: 1 B

Speaking: Interview
Audio: interview/prompt.wav
1. Describe a place where you like to study.
Preparation time: 15 seconds
Response time: 45 seconds`;

function syntheticWav() {
  const bytes = Buffer.alloc(44 + 1600);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(1600, 40);
  return bytes;
}

function syntheticPdf(lines) {
  const safe = text => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 10 Tf 50 760 Td 14 TL ${lines.map((text, index) => `${index ? 'T* ' : ''}(${safe(text)}) Tj`).join('\n')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
function syntheticDocx(paragraphs) {
  const zip = new ZipFixture();
  const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`));
  return zip.toBuffer();
}

test('fixed template preserves passage, ordering, unknown answer and source lines', async () => {
  const result = await extractDraft({ files: [file('original.md', SOURCE)] });
  assert.equal(result.method, 'template');
  assert.equal(result.pack.title, 'Garden practice');
  assert.equal(result.pack.groups.length, 2);
  assert.equal(result.pack.groups[0].questions[0].answer, 'B');
  assert.equal(result.pack.groups[0].questions[1].answer, null);
  assert.equal(result.pack.groups[1].section, 'speaking');
  assert.equal(result.pack.groups[1].questions[0].timeLimitSeconds, 45);
  assert.equal(result.pack.groups[1].questions[0].prepareSeconds, 10);
  assert.match(result.pack.groups[0].questions[0].source, /original\.md · 第 7 行/);
  assert.ok(result.sources[0].text.includes(SOURCE));
  assert.ok(result.issues.some(item => item.message.includes('未评分')));
  assert.equal(result.issues.filter(item => item.severity === 'error').length, 0);
});

test('all declared question shapes parse and repeated prompt literal @ is preserved', async () => {
  const result = await extractDraft({ text: `@rights Original
@question sentence_order
Arrange the fragments.
@option A | the library
@option B | I visit
@answer B | A
@end
@question email
Write to your tutor.
@@literal line
@end
@question discussion
What makes a park useful?
@end
@question listen_repeat
The blue door is open.
@end` });
  assert.deepEqual(result.pack.groups[0].questions.map(q => q.type), ['sentence_order', 'email', 'discussion', 'listen_repeat']);
  assert.deepEqual(result.pack.groups[0].questions[0].answer, ['B', 'A']);
  assert.equal(result.pack.groups[0].questions[1].prompt, 'Write to your tutor.\n@literal line');
});

test('unlabeled text produces a reviewable source-only draft instead of invented questions', async () => {
  const result = await extractDraft({ text: 'An original paragraph with no explicit question.' });
  assert.equal(result.method, 'source-only');
  assert.equal(result.pack.groups[0].questions.length, 0);
  assert.equal(result.pack.groups[0].passage, 'An original paragraph with no explicit question.');
  assert.ok(result.issues.some(item => item.severity === 'error'));
});

test('media is connected only by exact explicit names; missing and unassigned media are reported', async () => {
  const result = await extractDraft({ text: '@section speaking\n@question interview\nDescribe your desk.\n@audio voice.mp3\n@image missing.png\n@end', files: [file('voice.mp3', 'fake-media-for-mapping-test'), file('other.wav', 'another-file')] });
  assert.equal(result.pack.groups[0].questions[0].audio, 'voice.mp3');
  assert.ok(result.issues.some(item => item.severity === 'error' && item.message.includes('missing.png')));
  assert.ok(result.issues.some(item => item.severity === 'warning' && item.message.includes('other.wav')));
  assert.equal(result.files.length, 2);
});

test('path traversal, case-folded duplicates, malformed base64 and invalid encodings are refused', async () => {
  await assert.rejects(extractDraft({ files: [file('../bad.txt', 'text')] }), /相对路径/);
  await assert.rejects(extractDraft({ files: [file('A.txt', 'a'), file('a.txt', 'b')] }), /重名/);
  await assert.rejects(extractDraft({ files: [{ name: 'bad.txt', data: '@@@@' }] }), /格式/);
  await assert.rejects(extractDraft({ files: [{ name: 'bad.txt', data: Buffer.from([0xff, 0xff, 0xff]).toString('base64') }] }), /UTF-8/);
});

test('real synthetic PDF extraction retains page evidence and readable question text', async () => {
  const bytes = syntheticPdf(['@title PDF sample', '@rights Original synthetic fixture', '@section speaking', '@question interview', 'Describe a quiet place.', '@end']);
  const result = await extractDraft({ files: [{ name: 'original.pdf', data: bytes.toString('base64') }] });
  assert.equal(result.pack.groups[0].questions[0].prompt, 'Describe a quiet place.');
  assert.match(result.pack.groups[0].questions[0].source, /第 1 页/);
  assert.match(result.sources[0].text, /第 1 页/);
  assert.ok(result.issues.some(item => item.message.includes('未执行 OCR')));
});

test('real synthetic DOCX extraction retains paragraph evidence without inventing Word pages', async () => {
  const bytes = syntheticDocx(['@title DOCX sample', '@rights Original synthetic fixture', '@section speaking', '@question interview', 'Describe a useful notebook.', '@end']);
  const result = await extractDraft({ files: [{ name: 'original.docx', data: bytes.toString('base64') }] });
  assert.equal(result.pack.groups[0].questions[0].prompt, 'Describe a useful notebook.');
  assert.match(result.pack.groups[0].questions[0].source, /第 4 段/);
  assert.equal(result.pack.groups[0].questions[0].source.includes('页'), false);
  assert.ok(result.issues.some(item => item.message.includes('不推算 Word 页码')));
});

test('AI import requires consent and never silently falls back after provider failure', async () => {
  let calls = 0;
  const models = { structure: async () => { calls++; throw new Error('provider-unavailable'); } };
  await assert.rejects(extractDraft({ text: SOURCE, useAI: true, consent: false }, models), /同意/);
  assert.equal(calls, 0);
  await assert.rejects(extractDraft({ text: SOURCE, useAI: true, consent: true }, models), /provider-unavailable/);
  assert.equal(calls, 1);
});

test('AI draft clears unsupported answer/explanation/media and flags rewritten question text', async () => {
  const original = (await extractDraft({ text: SOURCE })).pack;
  original.groups[0].questions[0].prompt = 'A question that does not occur in the source.';
  original.groups[0].questions[0].answer = 'A';
  original.groups[0].questions[0].explanation = 'Invented explanation.';
  original.groups[0].questions[0].audio = 'unused.mp3';
  const result = await extractDraft({ text: SOURCE, files: [file('unused.mp3', 'fake')], useAI: true, consent: true }, { structure: async () => ({ pack: original }) });
  const q = result.pack.groups[0].questions[0];
  assert.equal(q.answer, null);
  assert.equal(q.explanation, '');
  assert.equal(q.audio, null);
  assert.ok(result.issues.some(item => item.severity === 'error' && item.path.endsWith('.prompt')));
  assert.equal(original.groups[0].questions[0].answer, 'A', 'caller draft is not mutated');
});

test('AI draft can retain an explicitly supplied answer key while preserving original source text', async () => {
  const original = (await extractDraft({ text: SOURCE })).pack;
  const result = await extractDraft({ text: SOURCE, useAI: true, consent: true }, { structure: async input => { assert.ok(input.text.includes('[来源：')); return { pack: original }; } });
  assert.equal(result.pack.groups[0].questions[0].answer, 'B');
  assert.equal(result.pack.groups[0].questions[1].answer, null);
  assert.equal(result.issues.filter(item => item.severity === 'error').length, 0);
});

test('an answer key belonging to another source question is not reused by AI', async () => {
  const original = (await extractDraft({ text: SOURCE })).pack;
  original.groups[0].questions[1].answer = 'B';
  const result = await extractDraft({ text: SOURCE, useAI: true, consent: true }, { structure: async () => ({ pack: original }) });
  assert.equal(result.pack.groups[0].questions[0].answer, 'B');
  assert.equal(result.pack.groups[0].questions[1].answer, null);
  assert.ok(result.issues.some(item => item.path === 'groups.0.questions.1.answer'));
});

test('AI cannot invent a source page or associate an answer key from another file', async () => {
  const original = (await extractDraft({ text: '@question fill_blank\nA notebook has ____.' })).pack;
  original.groups[0].questions[0].answer = 'pages';
  original.groups[0].questions[0].source = 'first.txt · 第 999 页';
  const result = await extractDraft({ files: [file('first.txt', '@question fill_blank\nA notebook has ____.'), file('second.txt', 'Answer: pages')], useAI: true, consent: true }, { structure: async () => ({ pack: original }) });
  assert.equal(result.pack.groups[0].questions[0].answer, null);
  assert.equal(result.pack.groups[0].questions[0].source, 'first.txt · 第 2 行');
});

test('separate text files cannot be absorbed by an unfinished prompt in an earlier file', async () => {
  const result = await extractDraft({ files: [file('first.txt', '@question interview\nDescribe your study room.'), file('second.txt', 'This paragraph is a separate source.')] });
  assert.equal(result.pack.groups[0].questions[0].prompt, 'Describe your study room.');
  assert.ok(result.sources.find(source => source.name === 'second.txt').text.includes('This paragraph is a separate source.'));
  assert.ok(result.issues.some(item => item.message.includes('未归入')));
});

test('ordinary unmarked PDF worksheet imports reading and interview with reset Q1 and matching audio', async () => {
  const result = await extractDraft({ files: [
    { name: 'ordinary.pdf', data: syntheticPdf(WORKSHEET.split('\n')).toString('base64') },
    { name: 'interview/prompt.wav', data: syntheticWav().toString('base64') },
  ] });
  assert.equal(result.method, 'worksheet');
  assert.equal(result.pack.title, 'Campus practice');
  assert.equal(result.pack.groups.length, 2);
  const [reading, speaking] = result.pack.groups;
  assert.equal(reading.passage, 'The garden is open on weekdays. It is not open on Sundays.');
  assert.equal(reading.questions[0].prompt, 'Which statement is NOT true?');
  assert.equal(reading.questions[0].answer, 'B');
  assert.equal(reading.questions[1].answer, null);
  assert.equal(reading.questions[1].type, 'fill_blank');
  assert.equal(speaking.questions[0].type, 'interview');
  assert.equal(speaking.questions[0].prompt, 'Describe a place where you like to study.');
  assert.equal(speaking.audio, 'interview/prompt.wav');
  assert.equal(speaking.questions[0].prepareSeconds, 15);
  assert.equal(speaking.questions[0].timeLimitSeconds, 45);
  assert.notEqual(reading.questions[0].id, speaking.questions[0].id);
  assert.match(reading.questions[0].source, /ordinary\.pdf · 第 1 页.*原题号 1/);
  assert.match(speaking.questions[0].source, /ordinary\.pdf · 第 1 页.*原题号 1/);
  assert.equal(result.issues.filter(item => item.severity === 'error').length, 0);
});

test('ordinary DOCX gives paragraph provenance and never carries a local key across reading groups', async () => {
  const ordinary = `Reading: North garden
Passage:
The north garden closes at noon.
Questions:
1. When does the north garden close?
A. At dawn.
B. At noon.
Answer key:
1. B
Reading: South garden
Passage:
The south garden closes at dusk.
Questions:
1. When does the south garden close?
A. At dusk.
B. At noon.
Answer key: 1 A`;
  const result = await extractDraft({ files: [{ name: 'ordinary.docx', data: syntheticDocx(ordinary.split('\n')).toString('base64') }] });
  assert.equal(result.method, 'worksheet');
  assert.equal(result.pack.groups.length, 2);
  assert.equal(result.pack.groups[0].questions[0].answer, 'B');
  assert.equal(result.pack.groups[1].questions[0].answer, 'A');
  assert.match(result.pack.groups[0].questions[0].source, /第 5 段.*原题号 1/);
  assert.match(result.pack.groups[1].questions[0].source, /第 14 段.*原题号 1/);
  assert.equal(result.issues.filter(item => item.severity === 'error').length, 0);
});

test('ordinary duplicate numbering within a group leaves local keys unassigned instead of inventing a new group', async () => {
  const result = await extractDraft({ text: `Reading: Numbering needs review
Questions:
1. Which door is blue?
A. The first door.
B. The second door.
1. Which door is green?
A. The first door.
B. The second door.
Answer key: 1 A` });
  assert.equal(result.method, 'worksheet');
  assert.equal(result.pack.groups.length, 1);
  assert.equal(result.pack.groups[0].questions.length, 2);
  assert.ok(result.pack.groups[0].questions.every(q => q.answer === null));
  assert.ok(result.issues.some(item => item.severity === 'error' && item.message.includes('重复')));
});

test('ordinary ambiguous and missing audio references produce issues without filename guessing', async () => {
  const result = await extractDraft({ text: `Speaking: Interview
Audio: first.wav
Audio: second.wav
1. Describe your notebook.
Audio: maybe.wav
Question audio: missing.wav
Response time: 45 seconds`, files: [{ name: 'first.wav', data: syntheticWav().toString('base64') }, { name: 'second.wav', data: syntheticWav().toString('base64') }] });
  assert.equal(result.pack.groups[0].audio, null);
  assert.equal(result.pack.groups[0].questions[0].audio, 'missing.wav');
  assert.ok(result.issues.some(item => item.message.includes('多个不同')));
  assert.ok(result.issues.some(item => item.message.includes('范围不明确')));
  assert.ok(result.issues.some(item => item.message.includes('找不到明确引用') && item.message.includes('missing.wav')));
});

test('ordinary unsupported short-answer and multi-answer tasks are preserved as source rather than recast', async () => {
  const short = await extractDraft({ text: 'Reading: Open question\nQuestions:\n1. Explain the mechanism in detail.' });
  assert.equal(short.method, 'source-only');
  assert.equal(short.pack.groups[0].questions.length, 0);
  assert.ok(short.sources[0].text.includes('Explain the mechanism in detail.'));
  const multiple = await extractDraft({ text: 'Reading: Multiple answers\nQuestions:\n1. Choose TWO reasons.\nA. It saves time.\nB. It costs less.\nC. It is nearer.\nAnswer key: 1 A and B' });
  assert.equal(multiple.method, 'source-only');
  assert.equal(multiple.pack.groups[0].questions.length, 0);
  assert.ok(multiple.issues.some(item => item.severity === 'error' && item.message.includes('未猜测')));
});

test('ordinary explicit Group heading scopes answer tables while unnumbered entries stay unresolved', async () => {
  const result = await extractDraft({ text: `Reading
Group: First
Questions:
1. Which day is listed?
A. Monday.
B. Friday.
Answer key: 1 A
Group: Second
Questions:
1. Which time is listed?
A. Noon.
B. Midnight.
Answer key: B` });
  assert.equal(result.method, 'worksheet');
  assert.equal(result.pack.groups.length, 2);
  assert.equal(result.pack.groups[0].questions[0].answer, 'A');
  assert.equal(result.pack.groups[1].questions[0].answer, null);
  assert.ok(result.issues.some(item => item.message.includes('答案表格式未识别')));
});

test('optional AI can retain verified conventional local keys and cannot swap option labels', async () => {
  const suppliedFiles = [{ name: 'interview/prompt.wav', data: syntheticWav().toString('base64') }];
  const original = (await extractDraft({ text: WORKSHEET, files: suppliedFiles })).pack;
  const faithful = await extractDraft({ text: WORKSHEET, files: suppliedFiles, useAI: true, consent: true }, { structure: async () => ({ pack: original }) });
  assert.equal(faithful.pack.groups[0].questions[0].answer, 'B');
  assert.equal(faithful.issues.filter(item => item.severity === 'error').length, 0);
  const swapped = structuredClone(original);
  const options = swapped.groups[0].questions[0].options;
  [options[0].text, options[1].text] = [options[1].text, options[0].text];
  const unsafe = await extractDraft({ text: WORKSHEET, files: suppliedFiles, useAI: true, consent: true }, { structure: async () => ({ pack: swapped }) });
  assert.equal(unsafe.pack.groups[0].questions[0].answer, null);
  assert.ok(unsafe.issues.some(item => item.severity === 'error' && item.path === 'groups.0.questions.0.options'));
});
