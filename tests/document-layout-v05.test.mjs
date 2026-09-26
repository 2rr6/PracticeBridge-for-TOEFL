import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExamDocument } from '../src/exam-document.mjs';
import { authoredPdf } from './helpers/document-layout-fixture.mjs';

// Original hand-authored source manifest: footer is emitted first, then right
// column, then left. Expected reading order is explicitly supplied here.
const item = (str, x, y, width = 130, height = 12) => ({ str, x, y, width, height });
const page = (number, items) => ({ name: 'original.pdf', page: number, kind: 'pdf', text: items.map(x => x.str).join('\n'), layout: { width: 600, height: 800, items } });

test('region projection preserves raw stream, columns, repeated body and marginal evidence', async () => {
  const { projectDocumentLayout } = await import('../src/document-layout.mjs');
  const raw = [1, 2].map(n => page(n, [item(`Original workbook ${n}`, 180, 20), item('Right first', 330, 650), item('Right second', 330, 620), item('Left first', 40, 650), item('Do NOT erase this repeated prompt.', 40, 620)]));
  const before = structuredClone(raw);
  const result = projectDocumentLayout(raw);
  assert.deepEqual(raw, before);
  assert.deepEqual(result.readingOrder.map(id => result.blocks.find(b => b.id === id).text), ['Left first','Do NOT erase this repeated prompt.','Right first','Right second','Left first','Do NOT erase this repeated prompt.','Right first','Right second']);
  assert.equal(result.blocks.filter(b => b.role === 'footer').length, 2);
  assert.deepEqual(result.evidenceMap[result.blocks[0].id].rawItemIndexes, [0]);
  assert.ok(result.blocks.every(b => b.bounds.y >= 0));
});

test('rotation, ligature and cross-line missing letters retain exact raw evidence', async () => {
  const { projectDocumentLayout } = await import('../src/document-layout.mjs');
  const raw = [page(1, [item('oﬃce', 30, 700), item('ne _', 30, 670), item('_ the door', 30, 650)])];
  raw[0].layout.transform = [0, 1, 1, 0, 0, 0];
  raw[0].layout.rotation = 90;
  const result = projectDocumentLayout(raw, { readingOrder: 'source' });
  assert.equal(result.blocks[0].text, 'oﬃce');
  assert.deepEqual(result.blocks[0].bounds, { x: 700, y: 30, width: 12, height: 130 });
  assert.equal(result.blocks.map(b => b.text).join('\n'), 'oﬃce\nne _\n_ the door');
  assert.deepEqual(result.evidenceMap[result.blocks[0].id].transform, [0, 1, 1, 0, 0, 0]);
});

test('repetition in a page margin alone never removes a question stem', async () => {
  const { projectDocumentLayout } = await import('../src/document-layout.mjs');
  const result = projectDocumentLayout([1,2].map(n => page(n,[item('Which door is NOT open?',40,775),item('Do not open the red door.',40,20)])));
  assert.equal(result.readingOrder.length,4);
  assert.equal(result.ambiguities.filter(a => a.code === 'repeated_margin').length,4);
});

test('module recognition tolerates footer-first stream and preserves negation and answer ownership', () => {
  const p = (page, text) => ({ name: 'original.pdf', kind: 'pdf', page, text });
  const result = parseExamDocument([
    p(1, 'Original Test 3 1\nReading Section, Module 1'),
    p(2, 'Read a notice.\nThe door is NOT open.\n1. What is NOT open?\n(A) The door\n(B) The box'),
    p(3, 'Reading Section, Module 1\nAnswer Key\nQuestion\nNumber\nAnswer\n1 A'),
    p(4, 'Original Test 3 4\nReading Section, Module 2\nFill in the missing letters in the paragraph.\n(Questions 1-1)\nA ca _ sleeps.'),
    p(5, 'Reading Section, Module 2\nAnswer Key\n1 t'),
    p(6, 'Original Test 3 6\nSpeaking Section\nTake an Interview\nInterviewer: Describe a door.'),
  ]);
  assert.ok(result.pack.groups.some(g => g.questions.some(q => q.prompt === 'What is NOT open?' && q.answer === 'A')));
});

test('recognized empty parser results are observable and do not stop generic fallback', async () => {
  const { buildDraftFromSources } = await import('../src/importer.mjs');
  const p = (page, text) => ({ name: 'original.pdf', kind: 'pdf', page, text });
  const chunks = [p(1, 'Reading Section, Module 1\nFill in the missing letters in the paragraph.'), p(2, 'Listening Section, Module 2\nTake an Interview\nAnswer Key'), p(3, '@section speaking\n@question interview\nDescribe your original sketch.\n@end')];
  const result = await buildDraftFromSources({ chunks, sources: [], media: [], issues: [], files: [] });
  assert.ok(result.recognition.some(r => r.state === 'recognized_empty'));
  assert.equal(result.pack.groups[0].questions[0].prompt, 'Describe your original sketch.');
});

test('real authored PDF preserves the independent page/answer manifest through extraction', async () => {
  const { extractMaterialSources, buildDraftFromSources } = await import('../src/importer.mjs');
  const result=await extractMaterialSources({files:[{name:'authored.pdf',data:authoredPdf().toString('base64')}]});
  const before=structuredClone(result.chunks);
  assert.equal(result.chunks.length,9);
  assert.match(result.chunks[0].text,/^Original Workbook 9 1/);
  assert.equal(result.projectedChunks[6].text,'Reading exercise heading across both columns\nLeft column begins here\nLeft second\nRight first\nRight second');
  assert.equal(result.chunks[7].layout.rotation,90);
  assert.ok(result.documentLayout.ambiguities.some(a=>a.code==='rotated_page'&&a.page===8));
  assert.match(result.chunks[8].text,/oﬃce/);
  assert.match(result.projectedChunks[8].text,/ne _\n_ the door/);
  const draft=await buildDraftFromSources(result);
  const group=draft.pack.groups.find(g=>g.questions.some(q=>q.prompt==='Which door is NOT open?'));
  const q=group.questions.find(q=>q.prompt==='Which door is NOT open?');
  assert.equal(group.passage,'Read a notice.\nThe red door is NOT open.');
  assert.deepEqual(q.options.map(o=>o.text),['Red door','Blue door']);assert.equal(q.answer,'A');
  assert.match(q.source,/第 1 页.*答案来自 authored.pdf · 第 3 页/);
  const key=draft.fieldEvidence.find(e=>e.path.endsWith('.answer')&&e.blockIds.some(id=>draft.documentLayout.blocks.find(b=>b.id===id)?.text==='1 A'));
  assert.equal(key.state,'known');
  assert.deepEqual(result.chunks,before);
});

test('a spanning heading does not interleave or merge the two body columns', async () => {
  const {projectDocumentLayout,projectDocumentChunks}=await import('../src/document-layout.mjs');
  const raw=[page(1,[item('Reading exercise heading across both columns',40,750,520),item('Left passage first sentence.',40,700,210),item('Right question first sentence.',340,700,210),item('Left passage second sentence.',40,675,210),item('Right question second sentence.',340,675,210)])];
  const before=structuredClone(raw),layout=projectDocumentLayout(raw);
  assert.equal(projectDocumentChunks(raw,layout)[0].text,'Reading exercise heading across both columns\nLeft passage first sentence.\nLeft passage second sentence.\nRight question first sentence.\nRight question second sentence.');
  assert.deepEqual(raw,before);
});

test('unresolved separated regions keep line boundaries and report ambiguity', async () => {
  const {projectDocumentLayout,projectDocumentChunks}=await import('../src/document-layout.mjs');
  const raw=[page(1,[item('Only left sentence.',40,700,210),item('Only right sentence.',340,700,210)])];
  const layout=projectDocumentLayout(raw);
  assert.equal(projectDocumentChunks(raw,layout)[0].text,'Only left sentence.\nOnly right sentence.');
  assert.ok(layout.ambiguities.some(a=>a.code==='unresolved_regions'));
});

test('repeated Describe Test instructions at the page edge remain body text', async () => {
  const {projectDocumentLayout,projectDocumentChunks}=await import('../src/document-layout.mjs');
  for(const text of ['Describe Test 1','Describe Test 1 2','Explain Workbook 2']){
    const raw=[1,2].map(n=>page(n,[item(text,40,20,90)]));
    const layout=projectDocumentLayout(raw);
    assert.deepEqual(projectDocumentChunks(raw,layout).map(c=>c.text),[text,text]);
    assert.ok(layout.blocks.every(b=>b.role==='body'));
    assert.equal(layout.ambiguities.filter(a=>a.code==='repeated_margin').length,2);
  }
});

test('a wide answer cell is kept with its numeric row instead of treated as a spanning heading', async () => {
  const {projectDocumentLayout,projectDocumentChunks}=await import('../src/document-layout.mjs');
  const raw=[page(1,[item('Writing Answer Key',40,750,300),item('1',40,700,8),item('She wanted to know whether the blue door was open.',140,700,400),item('2',40,675,8),item('He asked whether the workshop would open at noon.',140,675,400)])];
  assert.equal(projectDocumentChunks(raw,projectDocumentLayout(raw))[0].text,'Writing Answer Key\n1 She wanted to know whether the blue door was open.\n2 He asked whether the workshop would open at noon.');
});

test('explicit task-description tables and email label/value rows retain their row boundaries', async () => {
  const {projectDocumentLayout,projectDocumentChunks}=await import('../src/document-layout.mjs');
  const raw=[page(1,[item('Writing Section',40,750,380),item('Type of Task',40,700,100),item('Description',230,700,120),item('Build a Sentence',40,675,120),item('Create an original sentence.',230,675,280),item('Write an Email',40,650,100),item('Write an original email.',230,650,260)]),page(2,[item('Read an email.',40,750,120),item('To:',40,700,20),item('artist@example.invalid',160,700,170),item('From:',40,675,30),item('sender@example.invalid',160,675,180)])];
  const chunks=projectDocumentChunks(raw,projectDocumentLayout(raw));
  assert.equal(chunks[0].text,'Writing Section\nType of Task Description\nBuild a Sentence Create an original sentence.\nWrite an Email Write an original email.');
  assert.equal(chunks[1].text,'Read an email.\nTo: artist@example.invalid\nFrom: sender@example.invalid');
});

test('page-counter evidence is positional and an unrelated numeric margin is not erased', async () => {
  const {projectDocumentLayout}=await import('../src/document-layout.mjs');
  const raw=[page(1,[item('1',80,20,8)]),... [2,3].map(n=>page(n,[item('Practice Test 1',40,20,200),item(String(n-1),550,20,8)]))];
  // Use a positive, conventional imprint title; the separate counter must itself
  // be corroborated at the same position across pages rather than any number.
  const result=projectDocumentLayout(raw);
  assert.equal(result.blocks.find(b=>b.page===1).role,'body');
  assert.ok(result.blocks.filter(b=>b.page>1).every(b=>b.role==='footer'));
});
