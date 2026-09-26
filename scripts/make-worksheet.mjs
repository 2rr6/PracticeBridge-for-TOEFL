import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import { writeArchive } from '../src/archive/zip-adapter.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,'public/examples/ordinary-worksheet');
const paragraphs=[
  'Title: Original worksheet - campus life',
  'Rights: Original PracticeBridge fixture, CC0-1.0. Synthetic audio; not official examination material.',
  'Reading: Campus garden',
  'Passage:',
  'Students planted a garden behind the library. They chose plants that need little water because rain is limited. Volunteers share some of the vegetables.',
  'Questions:',
  '1. Why did the students choose plants that need little water?',
  'A. The garden is indoors.',
  'B. Rain is limited.',
  'C. The library asked them to do so.',
  '2. What is shared among volunteers?',
  'A. Parking spaces.',
  'B. Vegetables.',
  'C. Library books.',
  'Answer key: 1 B',
  'Reading: Library hours',
  'Passage:',
  'The library will stay open until nine this evening. The quiet study room closes at eight.',
  'Questions:',
  '1. Which statement is NOT correct?',
  'A. The quiet study room stays open until nine.',
  'B. The library closes at nine.',
  'C. The quiet study room closes earlier than the library.',
  'Answer key: 1 A',
  'Listening: Workshop announcement',
  'Audio: set-a/prompt.wav',
  'Questions:',
  '1. Why was the workshop moved to Sunday?',
  'A. The tools were missing.',
  'B. Rain was expected on Saturday.',
  'C. The speaker wanted a later start time.',
  'Answer key: 1 B',
  'Speaking: Interview',
  'Audio: missing.wav',
  'Preparation time: 15 seconds',
  'Response time: 45 seconds',
  'Questions:',
  '1. Think about a place where you enjoy studying. What makes this place work well for you? Give a specific example.',
];
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const doc=new Map();
doc.set('[Content_Types].xml',Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
doc.set('_rels/.rels',Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
doc.set('word/document.xml',Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(s=>`<w:p><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/>${/^(Reading:|Listening:|Speaking:|Title:)/.test(s)?'<w:b/>':''}</w:rPr><w:t xml:space="preserve">${xml(s)}</w:t></w:r></w:p>`).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr></w:body></w:document>`));
const inputs=[['ordinary-worksheet.docx',(await writeArchive({ entries: [...doc].map(([name, bytes]) => ({ name, bytes })) })).buffer],['set-a/prompt.wav',await readFile(resolve(root,'.cache/example-media/announcement.wav'))],['set-b/prompt.wav',await readFile(resolve(root,'.cache/example-media/interview.wav'))]];
await mkdir(out,{recursive:true});const archive=new Map();
for(const [name,data] of inputs){await mkdir(dirname(resolve(out,name)),{recursive:true});await writeFile(resolve(out,name),data);archive.set(name,data);}
await writeFile(resolve(root,'public/examples/ordinary-materials.zip'),(await writeArchive({ entries: [...archive].map(([name, bytes]) => ({ name, bytes })) })).buffer);
console.log('Original ordinary DOCX fixture and two same-name audio files created. One missing reference is intentional; choose set-b/prompt.wav in the author review form.');
