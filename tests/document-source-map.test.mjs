import test from 'node:test';
import assert from 'node:assert/strict';
import ZipFixture from './helpers/zip-fixture.mjs';

test('field maps resolve exact text to bounded source blocks and leave unknowns unmapped', async () => {
  const { projectDocumentLayout, mapDocumentFields } = await import('../src/document-layout.mjs');
  const layout = projectDocumentLayout([{ name: 'source.txt', kind: 'text', text: '1. Which door is NOT open?\n(A) Red door\n(B) Blue door' }]);
  const evidence = mapDocumentFields({ groups: [{ id: 'g1', passage: '', questions: [{ id: 'q1', prompt: 'Which door is NOT open?', options: [{ id: 'A', text: 'Red door' }], answer: 'A', explanation: 'Not in source' }] }] }, layout);
  assert.ok(evidence.find(e => e.path === 'groups.0.questions.0.prompt').blockIds.length);
  assert.equal(evidence.find(e => e.path.endsWith('.explanation')).state, 'missing');
  assert.equal(evidence.find(e => e.path.endsWith('.answer')).state, 'unmapped');
});

test('actual DOCX imports paragraphs and cells as inert text and never creates pages', async () => {
  const { extractMaterialSources }=await import('../src/importer.mjs');
  const zip=new ZipFixture();
  zip.addFile('[Content_Types].xml',Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels',Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  const p=t=>`<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  zip.addFile('word/document.xml',Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('&lt;img src=x onerror=alert(1)&gt;')}<w:tbl><w:tr><w:tc>${p('Number')}</w:tc><w:tc>${p('Answer')}</w:tc></w:tr><w:tr><w:tc>${p('1')}</w:tc><w:tc>${p('B')}</w:tc></w:tr></w:tbl></w:body></w:document>`));
  const result=await extractMaterialSources({files:[{name:'authored.docx',data:zip.toBuffer().toString('base64')}]});
  assert.equal(result.chunks.length,3);
  assert.equal(result.chunks[0].text,'<img src=x onerror=alert(1)>');
  assert.deepEqual(result.chunks[2].semantic.cells.map(c=>c.text),['1','B']);
  assert.ok(result.chunks.every(c=>c.page===undefined&&c.layoutState==='unknown'));
  assert.ok(result.documentLayout.blocks.every(b=>b.page===null&&b.bounds===null));
});

test('actual DOCX with an empty paragraph keeps all original semantic paragraphs', async () => {
  const {extractMaterialSources}=await import('../src/importer.mjs');
  const zip=new ZipFixture();
  zip.addFile('[Content_Types].xml',Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels',Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('word/document.xml',Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>1. Which door is open?</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>A. Blue door</w:t></w:r></w:p></w:body></w:document>'));
  const input={files:[{name:'empty-paragraph.docx',data:zip.toBuffer().toString('base64')}]},before=structuredClone(input);
  const result=await extractMaterialSources(input);
  assert.deepEqual(input,before);
  assert.equal(result.files[0].data,input.files[0].data);
  assert.deepEqual(result.chunks.map(c=>c.text),['1. Which door is open?','','A. Blue door']);
  assert.deepEqual(result.chunks.map(c=>c.paragraph),[1,2,3]);
  assert.deepEqual(result.projectedChunks.map(c=>c.text),['1. Which door is open?','','A. Blue door']);
  assert.deepEqual(result.chunks[1].semantic,{kind:'paragraph',path:[1],styleId:null});
  assert.ok(result.chunks.every(c=>c.page===undefined&&c.layoutState==='unknown'));
});

test('an empty semantic paragraph skips geometry without rewriting its source', async () => {
  const {projectDocxSemantics,projectDocumentLayout,projectDocumentChunks}=await import('../src/document-layout.mjs');
  const chunks=projectDocxSemantics({type:'document',children:[{type:'paragraph',children:[]}]},'empty.docx');
  const before=structuredClone(chunks),layout=projectDocumentLayout(chunks);
  assert.deepEqual(chunks,before);
  assert.equal(chunks.length,1);assert.equal(chunks[0].text,'');
  assert.deepEqual(layout.blocks,[]);assert.deepEqual(layout.readingOrder,[]);
  assert.deepEqual(layout.ambiguities,[]);
  const projected=projectDocumentChunks(chunks,layout);
  assert.equal(projected.length,1);assert.equal(projected[0].text,'');
  assert.deepEqual(projected[0].semantic,chunks[0].semantic);
  assert.deepEqual(projected[0].sourceBlockIds,[]);
});

test('DOCX semantic projection retains table cells and paragraphs without invented pagination', async () => {
  const { projectDocxSemantics } = await import('../src/document-layout.mjs');
  const text = value => ({ type: 'text', value });
  const p = value => ({ type: 'paragraph', children: [text(value)] });
  const document = { type: 'document', children: [p('<img src=x onerror=alert(1)>'), { type: 'table', children: [{ type: 'tableRow', children: [{ type: 'tableCell', children: [p('Question')] }, { type: 'tableCell', children: [p('Answer')] }] }] }] };
  const result = projectDocxSemantics(document, 'original.docx');
  assert.equal(result[0].text, '<img src=x onerror=alert(1)>');
  assert.equal(result[1].semantic.kind, 'table-row');
  assert.deepEqual(result[1].semantic.cells.map(c => c.text), ['Question', 'Answer']);
  assert.ok(result.every(c => c.page === undefined && c.layoutState === 'unknown'));
});

test('answer-table evidence includes both number and answer cells on the projected row', async () => {
  const {projectDocumentLayout,mapDocumentFields}=await import('../src/document-layout.mjs');
  const layout=projectDocumentLayout([{name:'table.pdf',page:3,kind:'pdf',text:'1\nB',layout:{width:600,height:800,items:[{str:'1',x:40,y:600,width:8,height:12,line:1},{str:'B',x:180,y:600,width:8,height:12,line:2}]}}]);
  const result=mapDocumentFields({groups:[{questions:[{answer:'B',source:'table.pdf · 第 1 页 · 第 1 行；答案来自 table.pdf · 第 3 页 · 第 1 行'}]}]},layout);
  const evidence=result.find(e=>e.path.endsWith('.answer'));
  assert.deepEqual(evidence.blockIds.map(id=>layout.blocks.find(b=>b.id===id).text),['1','B']);
});

test('a resolvable answer reference is not a located answer value', async () => {
  const {projectDocumentLayout,mapDocumentFields}=await import('../src/document-layout.mjs');
  const layout=projectDocumentLayout([{name:'answer.pdf',page:3,kind:'pdf',text:'1 B'}]);
  const source='answer.pdf · 第 1 页 · 第 1 行；答案来自 answer.pdf · 第 3 页 · 第 1 行';
  const map=answer=>mapDocumentFields({groups:[{questions:[{type:'single_choice',options:[{id:'A',text:'Red'},{id:'B',text:'Blue'}],answer,source}]}]},layout).find(e=>e.path.endsWith('.answer'));
  for(const value of ['A','Z']){const e=map(value);assert.equal(e.state,'conflict');assert.equal(e.valueLocated,false);assert.ok(e.blockIds.length);}
  assert.equal(map('B').state,'known');assert.equal(map('B').valueLocated,true);
  assert.equal(map(['F1','F2']).state,'referenced');
});

test('ambiguous prompt evidence retains sensitive-source visibility', async () => {
  const {projectDocumentLayout,mapDocumentFields}=await import('../src/document-layout.mjs');
  const layout=projectDocumentLayout([{name:'source.txt',kind:'text',text:'1. Which door is open?\nAnswer: B. Which door is open? Blue is the answer.'}]);
  const result=mapDocumentFields({groups:[{questions:[{prompt:'Which door is open?',answer:'B',explanation:'Blue is the answer.'}]}]},layout);
  const entry=result.find(e=>e.path.endsWith('.prompt'));
  assert.equal(entry.state,'ambiguous');
  assert.deepEqual(entry.sourceReferences.map(r=>r.visibility),['source','reference']);
});

test('a one-word value found on hundreds of lines stays ambiguous within the candidate schema limit', async () => {
  const { projectDocumentLayout, mapDocumentFields } = await import('../src/document-layout.mjs');
  const text = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}: the answer is here`).join('\n');
  const layout = projectDocumentLayout([{ name: 'long.txt', kind: 'text', text }]);
  const evidence = mapDocumentFields({ groups: [{ questions: [{ type: 'sentence_order', prompt: 'Order the words', options: [{ id: 'F1', text: 'the' }], source: 'long.txt · 第 1 页' }] }] }, layout);
  const tile = evidence.find(e => e.path.endsWith('.options.0.text'));
  assert.equal(tile.state, 'ambiguous');
  assert.ok(tile.blockIds.length > 1 && tile.blockIds.length <= 500, String(tile.blockIds.length));
  assert.ok(tile.sourceReferences.length <= 500);
});
