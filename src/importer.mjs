import { readArchive, writeArchive, collectEntry } from './archive/zip-adapter.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseExamDocument } from './exam-document.mjs';
import { parseTstDocument } from './tst-document.mjs';
import { extractPdfFigures } from './pdf-images.mjs';
import { matchExamDirections } from './exam-plan.mjs';
import { collectMediaPaths } from './package.mjs';
import { hasReadingInteractionEvidence } from './models.mjs';
import { projectDocumentLayout, projectDocumentChunks, projectDocxSemantics, mapDocumentFields } from './document-layout.mjs';
import { parseTaskGrammar } from './task-grammar.mjs';

/*
 * PracticeBridge's deterministic text template (all demo prose is original):
 *
 * @title My materials
 * @rights Original material, shared under CC BY 4.0
 * @section reading
 * @group A quiet garden
 * @passage
 * The garden opens at nine.
 * @question single_choice
 * When does the garden open?
 * @option A | At eight.
 * @option B | At nine.
 * @answer B
 * @explanation The passage explicitly says nine.
 * @source Optional reference label
 * @end
 * @section speaking
 * @group Interview practice
 * @question interview
 * Describe a place where you like to study.
 * @time 60
 * @prepare 15
 * @audio interview.mp3
 * @end
 *
 * @question also supports fill_blank, sentence_order, email, discussion and
 * listen_repeat. @option supplies sentence_order fragments. Separate an ordered
 * answer with |, for example @answer B | A | C. A fill_blank answer may use | for
 * explicitly supplied accepted alternatives. Missing answers remain null.
 * For listen_repeat, @answer must supply the exact target sentence; @prompt is
 * the task instruction and @source is provenance. A missing target permits
 * recording practice but cannot receive an exact-repeat comparison.
 * @groupAudio / @groupImage attach exact supplied relative file names to a group;
 * @audio / @image attach them to the current question. No filename/order guessing.
 * @prompt and @explanation accept following lines until the next directive.
 * @description is package metadata. Prefix a literal @ in text with @@.
 * PDF line order and DOCX pagination are not inferred to match visual layout.
 */

const TYPES = new Set(['single_choice', 'fill_blank', 'sentence_order', 'email', 'discussion', 'interview', 'listen_repeat']);
const SECTIONS = new Set(['reading', 'listening', 'speaking', 'writing']);
const MEDIA = Object.freeze({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.webm': 'audio/webm', '.mp4': 'audio/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' });
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_TEXT_CHARS = 500000;
const issue = (severity, message, at = '') => ({ severity, message, path: at });

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
function safeName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 400) throw inputError('文件名为空或过长。');
  const normal = name.normalize('NFC').replace(/\\/g, '/');
  if (/^[\/]|^[a-z]:|[\u0000-\u001f:?#]/i.test(normal) || normal.split('/').some(part => !part || part === '.' || part === '..')) throw inputError('文件名必须是安全的相对路径。');
  return normal;
}
function decodeFile(file) {
  if (!file || typeof file.data !== 'string') throw inputError('上传文件的数据格式或大小无效。');
  const name = safeName(file.name);
  const maxBytes = /\.(?:pdf|docx)$/i.test(name) ? MAX_DOCUMENT_BYTES : MAX_FILE_BYTES;
  if (file.data.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
      file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw inputError('上传文件的数据格式或大小无效。');
  const buffer = Buffer.from(file.data, 'base64');
  if (buffer.length > maxBytes) throw inputError(/\.(?:pdf|docx)$/i.test(name) ? '单个 PDF/DOCX 文档不得超过 64 MB。' : '单个导入文件不得超过 25 MB。');
  if (buffer.toString('base64') !== file.data) throw inputError('上传文件的数据编码无效。');
  return { name, data: file.data, buffer };
}
function decodeText(buffer, name) {
  try {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch { throw inputError(`${name} 无法按 UTF-8 或带字节标记的 UTF-16 读取，请另存为 UTF-8 文本。`); }
}
function normalText(text) { return text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, ''); }
function evidenceText(text) { return text.normalize('NFC').replace(/\s+/g, ' ').trim(); }

async function extractPdf(buffer, name) {
  if (buffer.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) < 0) throw inputError(`${name} 不是有效的 PDF 文件。`);
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const packageUrl = import.meta.resolve('pdfjs-dist/package.json');
  const task = getDocument({
    data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false,
    standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', packageUrl)).replace(/\\/g, '/'),
    cMapUrl: fileURLToPath(new URL('cmaps/', packageUrl)).replace(/\\/g, '/'), cMapPacked: true,
  });
  const chunks = [];
  const issues = [];
  const derivedFiles = [];
  const sourceHash = createHash('sha256').update(buffer).digest('hex');
  let document;
  try {
    document = await task.promise;
    if (document.numPages > 200) throw inputError(`${name} 超过 200 页，请拆分后导入。`);
    let length = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ disableNormalization: true });
      const lines = [];
      const positionedItems = [];
      let line = '';
      let lastY;
      let lastEndX;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const y = item.transform?.[5];
        const x = item.transform?.[4];
        if (line && Number.isFinite(y) && Number.isFinite(lastY) && Math.abs(y - lastY) > 3) { lines.push(line); line = ''; lastEndX = undefined; }
        // Separate PDF text runs may be touching glyphs within one word (for
        // example an embedded ligature). Use their actual positions to avoid
        // turning "office" into "o ffi ce". Larger or unknown gaps stay spaces.
        const touchingLetters = /[A-Za-z]$/.test(line) && /^[A-Za-z]/.test(item.str) &&
          Number.isFinite(x) && Number.isFinite(lastEndX) && x - lastEndX >= -0.5 && x - lastEndX <= 0.5;
        if (line && item.str && !/\s$/.test(line) && !/^\s/.test(item.str) && !touchingLetters) line += ' ';
        if (item.str.trim()) positionedItems.push({
          str: item.str, x, y, width: item.width, height: item.height,
          hasEOL: Boolean(item.hasEOL), fontName: item.fontName, line: lines.length + 1, transform: item.transform ? [...item.transform] : null,
        });
        line += item.str;
        lastY = y;
        if (item.str && Number.isFinite(x) && Number.isFinite(item.width)) lastEndX = x + item.width;
        if (item.hasEOL) { lines.push(line); line = ''; lastY = undefined; lastEndX = undefined; }
      }
      if (line) lines.push(line);
      const text = lines.join('\n');
      length += text.length;
      if (length > MAX_TEXT_CHARS) throw inputError(`${name} 提取文字过多，请拆分后导入。`);
      const viewport = page.getViewport({ scale: 1 });
      const layout = {
        width: viewport.width, height: viewport.height, transform: [...viewport.transform], rotation: viewport.rotation,
        items: positionedItems,
      };
      // Read link annotations as evidence only. This never fetches their URLs;
      // a converter may match them to media the user has already supplied.
      const annotations = await page.getAnnotations({ intent: 'display' });
      const links = annotations.flatMap(annotation => {
        if (typeof annotation.url !== 'string' || annotation.url.length > 4096 || !Array.isArray(annotation.rect) || annotation.rect.length !== 4 || !annotation.rect.every(Number.isFinite)) return [];
        try {
          const url = new URL(annotation.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
          return [{ url: url.href, rect: annotation.rect }];
        } catch { return []; }
      });
      if (links.length > 500) throw inputError(`${name} 第 ${pageNumber} 页链接过多，请拆分后导入。`);
      let images = [];
      // These workbook pages can contain a standalone reading figure or a
      // Listen and Repeat scenario. Small portraits and speaker icons are not
      // content figures, and are excluded using their printed page dimensions.
      if (/For the TOEFL\s*®?\s*Reading\s+Section/i.test(text) || /^\d+\s*\.\s*Listen and repeat only once\./mi.test(text)) {
        const figures = await extractPdfFigures(page, { ops: OPS, sourceHash, pageNumber });
        images = figures.images; derivedFiles.push(...figures.files);
        for (const message of figures.skipped) issues.push(issue('warning', `${name} 第 ${pageNumber} 页：${message}`, name));
      }
      chunks.push({ name, text, page: pageNumber, kind: 'pdf', layout, links, images });
      if (!text.trim()) issues.push(issue('warning', `${name} 第 ${pageNumber} 页未提取到文字；扫描图像需要先做 OCR。`, name));
      page.cleanup();
    }
  } catch (error) {
    if (error.status) throw error;
    throw inputError(`${name} 无法提取文字，可能受密码保护、损坏或不是受支持的 PDF。`);
  } finally { await task.destroy(); }
  issues.push(issue('warning', `${name} 按 PDF 文字层提取；分栏、表格、图片和阅读顺序须对照原文件复核，未执行 OCR。`, name));
  return { chunks, issues, derivedFiles };
}

async function extractDocx(buffer, name, { signal } = {}) {
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw inputError(`${name} 不是有效的 DOCX 文件。`);
  try {
    const entries = [];
    const budget = { maxCompressedBytes: 64 * 1024 * 1024, maxEntries: 5000, maxExpandedBytes: 50 * 1024 * 1024, maxEntryBytes: 25 * 1024 * 1024, maxRatio: 200 };
    for await (const entry of readArchive({ inputRef: buffer, budget, signal })) {
      const bytes = await collectEntry(entry);
      if (entry.kind !== 'directory') entries.push({ name: entry.name, bytes });
    }
    if (!entries.some(entry => entry.name === 'word/document.xml')) throw new Error('invalid_docx');
    // Mammoth sees only a canonical archive reconstructed from validated bytes.
    const safeBuffer = (await writeArchive({ entries, budget, signal })).buffer;
    const mammoth = await import('mammoth');
    let chunks = [];
    const result = await mammoth.convertToHtml({ buffer: safeBuffer }, {
      externalFileAccess: false, includeEmbeddedStyleMap: false,
      transformDocument(document) {
        chunks = projectDocxSemantics(document, name);
        // Capture semantics before conversion, then render an empty tree. No
        // source HTML or embedded image/link is ever rendered or dereferenced.
        return { ...document, children: [] };
      },
    });
    signal?.throwIfAborted();
    if (chunks.reduce((sum,chunk) => sum + chunk.text.length,0) > MAX_TEXT_CHARS) throw new Error('docx_too_large');
    const issues = [issue('warning', `${name} 按语义段落和表格行提取文字；分页和精确布局未知，不推算 Word 页码，图片仍需对照原件。`, name)];
    if (result.messages?.length) issues.push(issue('warning', `${name} 的文字提取器报告 ${result.messages.length} 项格式提示，请对照原文检查。`, name));
    return { chunks, issues };
  } catch (error) { if (signal?.aborted) throw signal.reason; throw inputError(`${name} 无法安全读取 DOCX 文字，文件可能损坏或解压后过大。`); }
}

function sourceLocation(chunk, line) {
  return `${chunk.name}${chunk.page ? ` · 第 ${chunk.page} 页` : ''}${chunk.paragraph ? ` · 第 ${chunk.paragraph} 段` : ''} · 第 ${line} 行`;
}
function markedSource(chunks) {
  return chunks.map(chunk => `[来源：${chunk.name}${chunk.page ? `；第 ${chunk.page} 页` : ''}${chunk.paragraph ? `；第 ${chunk.paragraph} 段` : ''}]\n${chunk.text}`).join('\n\n');
}
function inferSection(type) {
  if (['interview', 'listen_repeat'].includes(type)) return 'speaking';
  if (['email', 'discussion', 'sentence_order'].includes(type)) return 'writing';
  return 'reading';
}
function timeDefault(type) { return ['interview', 'listen_repeat'].includes(type) ? 60 : ['email', 'discussion'].includes(type) ? 600 : 0; }

function parseTemplate(chunks, suppliedTitle) {
  const allText = chunks.map(chunk => chunk.text).join('\n\n');
  const hash = createHash('sha256').update(allText).digest('hex').slice(0, 16);
  const pack = { schemaVersion: 1, id: `import-${hash}`, version: '1.0.0', title: suppliedTitle || '待确认的练习资料', description: '', rights: '', groups: [] };
  const issues = [];
  let group;
  let question;
  let section;
  let active;
  let questionCount = 0;
  let unassigned = 0;
  let previousName;
  const getGroup = () => {
    if (!group) {
      group = { id: `g${pack.groups.length + 1}`, section: section || 'reading', title: `题组 ${pack.groups.length + 1}`, passage: '', audio: null, image: null, questions: [] };
      pack.groups.push(group);
    }
    return group;
  };
  const assignQuestion = (field, value, location) => {
    if (!question) { issues.push(issue('error', `${location}：@${field} 必须放在 @question 之后。`, location)); return; }
    question[field] = value;
  };
  const setActive = (object, key, value = '') => { object[key] = value; active = { object, key }; };
  for (const chunk of chunks) {
    // Pages/paragraphs within one document are continuous. Separate input files
    // are independent: an omitted @end must not absorb another file's prose.
    if (previousName !== undefined && previousName !== chunk.name) { group = undefined; question = undefined; section = undefined; active = undefined; }
    previousName = chunk.name;
    const lines = normalText(chunk.text).split('\n');
    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index];
      const trimmed = raw.trim();
      const location = sourceLocation(chunk, index + 1);
      const directive = trimmed.startsWith('@@') ? null : trimmed.match(/^@([a-z]+)\b\s*:?\s*(.*)$/i);
      if (!directive) {
        const literal = raw.replace(/^(\s*)@@/, '$1@');
        if (active) active.object[active.key] += `${active.object[active.key] ? '\n' : ''}${literal}`;
        else if (trimmed && !/^```(?:text|md|markdown)?\s*$/i.test(trimmed)) unassigned++;
        continue;
      }
      const command = directive[1].toLowerCase();
      const value = directive[2].trim();
      active = undefined;
      switch (command) {
        case 'title': if (!suppliedTitle) pack.title = value; break;
        case 'rights': pack.rights = value; break;
        case 'description': setActive(pack, 'description', value); break;
        case 'section':
          if (!SECTIONS.has(value)) issues.push(issue('error', `${location}：不支持的 section：${value}`, location));
          section = value;
          if (group && !group.questions.length) group.section = value;
          else group = undefined;
          question = undefined;
          break;
        case 'group':
          group = undefined;
          question = undefined;
          getGroup().title = value || `题组 ${pack.groups.length}`;
          break;
        case 'passage': setActive(getGroup(), 'passage', value); break;
        case 'question': {
          const type = value.split(/\s*\|\s*/, 1)[0].trim();
          if (!TYPES.has(type)) issues.push(issue('error', `${location}：不支持的题型：${type}`, location));
          const currentGroup = getGroup();
          if (!section && !currentGroup.questions.length) currentGroup.section = inferSection(type);
          question = { id: `q${++questionCount}`, type, prompt: value.includes('|') ? value.slice(value.indexOf('|') + 1).trim() : '', options: [], answer: null, explanation: '', audio: null, image: null, timeLimitSeconds: timeDefault(type), prepareSeconds: 0, source: location };
          currentGroup.questions.push(question);
          active = { object: question, key: 'prompt' };
          break;
        }
        case 'prompt':
        case 'explanation':
          if (question) setActive(question, command, value);
          else issues.push(issue('error', `${location}：@${command} 必须放在 @question 之后。`, location));
          break;
        case 'option': {
          if (!question) { issues.push(issue('error', `${location}：选项缺少所属题目。`, location)); break; }
          const separator = value.indexOf('|');
          if (separator < 1 || !value.slice(separator + 1).trim()) { issues.push(issue('error', `${location}：选项请使用 @option A | 选项内容。`, location)); break; }
          question.options.push({ id: value.slice(0, separator).trim(), text: value.slice(separator + 1).trim() });
          active = { object: question.options.at(-1), key: 'text' };
          break;
        }
        case 'answer':
          if (question) {
            const answers = value.split('|').map(part => part.trim()).filter(Boolean);
            question.answer = !answers.length ? null : question.type === 'sentence_order' || answers.length > 1 ? answers : value;
          } else issues.push(issue('error', `${location}：答案缺少所属题目。`, location));
          break;
        case 'source': if (question) question.source = value ? `${value} · ${question.source}` : question.source; break;
        case 'audio':
        case 'image': assignQuestion(command, value || null, location); break;
        case 'groupaudio': getGroup().audio = value || null; break;
        case 'groupimage': getGroup().image = value || null; break;
        case 'time':
        case 'prepare': {
          const n = Number(value);
          const field = command === 'time' ? 'timeLimitSeconds' : 'prepareSeconds';
          if (!/^\d+$/.test(value) || !Number.isInteger(n) || n > 7200) issues.push(issue('error', `${location}：计时须为 0–7200 的整数秒数。`, location));
          else assignQuestion(field, n, location);
          break;
        }
        case 'end': question = undefined; break;
        default: issues.push(issue('warning', `${location}：未识别指令 @${command}，文字已保留在来源面板。`, location));
      }
    }
  }
  for (const current of pack.groups) {
    current.passage = current.passage.trim();
    for (const q of current.questions) {
      q.prompt = q.prompt.trim();
      q.explanation = q.explanation.trim();
      q.options = q.options.map(option => ({ ...option, text: option.text.trim() }));
      if (!q.prompt) issues.push(issue('error', '题目缺少题干，请对照来源补齐。', `groups.${current.id}.questions.${q.id}.prompt`));
      if (['single_choice', 'fill_blank', 'sentence_order'].includes(q.type) && q.answer === null) issues.push(issue('warning', '原文未提供答案键，此题将保留为未评分。', `groups.${current.id}.questions.${q.id}.answer`));
    }
  }
  if (unassigned) issues.push(issue('warning', `有 ${unassigned} 行文字未归入模板字段，已完整保留在来源面板，请核对是否漏题。`, 'sources'));
  if (!questionCount) {
    if (!pack.groups.length) pack.groups.push({ id: 'g1', section: 'reading', title: '待整理原文', passage: allText.trim(), audio: null, image: null, questions: [] });
    issues.push(issue('error', '未识别出固定模板题目。请使用 @question 模板、编辑草稿，或在明确同意后请求 AI 整理。', 'groups'));
  }
  return { pack, issues, method: questionCount ? 'template' : 'source-only' };
}

/*
 * Conservative ordinary-worksheet reader. Supported examples have an explicit
 * Reading/Listening/Speaking/Writing heading, numbered questions, A./B. options,
 * and group-local Answer key lines. Speaking: Interview is an explicit task type.
 * Passage:, Questions:, Group:, Audio:, Preparation time: and Response time:
 * are conventional document labels, not PracticeBridge-specific directives.
 *
 * Audio: before the first question belongs to the group. After questions begin,
 * use Question audio: or Group audio: to avoid guessing its scope. Group-local
 * numbering is preserved in source labels; globally unique runtime IDs are new.
 * Unsupported task shapes stay in sources and are reported, never recast as an
 * arbitrary question type. This is not a general PDF layout or OCR interpreter.
 */
export function parseConventionalWorksheet(chunks, suppliedTitle = '') {
  const allText = chunks.map(chunk => chunk.text).join('\n\n');
  const pack = {
    schemaVersion: 1, id: `import-${createHash('sha256').update(allText).digest('hex').slice(0, 16)}`, version: '1.0.0',
    title: suppliedTitle || '待确认的练习资料', description: '', rights: '', groups: [],
  };
  const issues = [];
  const records = [];
  let current;
  let question;
  let lastSection;
  let previousName;
  let mode = 'none';
  let active;
  let recognized = false;
  let unassigned = 0;
  let totalQuestions = 0;

  const taskType = value => {
    const label = value.trim().toLowerCase().replace(/[_.-]+/g, ' ');
    if (/\b(?:listen(?:ing)?\s*(?:and|&)\s*repeat|repeat(?:ing)?\s+(?:sentences?|after))\b/.test(label)) return 'listen_repeat';
    if (/\binterview(?:s|\s+questions)?\b/.test(label)) return 'interview';
    if (/\b(?:email|e mail)\b/.test(label)) return 'email';
    if (/\b(?:academic\s+)?discussion\b/.test(label)) return 'discussion';
    if (/\b(?:sentence\s+(?:order|ordering)|reorder\s+sentences?)\b/.test(label)) return 'sentence_order';
    if (/\b(?:fill\s+(?:in\s+)?(?:the\s+)?blanks?|gap\s+fill(?:ing)?)\b/.test(label)) return 'fill_blank';
    if (/\b(?:multiple\s+choice|single\s+choice)\b/.test(label)) return 'single_choice';
    return null;
  };
  const cleanHeading = value => value.trim().replace(/^#{1,6}\s+/, '').replace(/^\[([^\]]+)\]$/, '$1').replace(/^\*\*([^*]+)\*\*$/, '$1').trim();
  const startGroup = (section, title, location, hint = null) => {
    current = {
      group: { id: `g${records.length + 1}`, section, title: title || `${section[0].toUpperCase()}${section.slice(1)}`, passage: '', audio: null, image: null, questions: [] },
      questions: [], keys: [], typeHint: hint, defaultPrepare: undefined, defaultTime: undefined,
      mediaConflicts: new Set(), instructions: [], location,
    };
    records.push(current);
    lastSection = section;
    question = undefined;
    mode = 'preamble';
    active = undefined;
    recognized = true;
  };
  const append = (object, field, value) => { object[field] += `${object[field] ? '\n' : ''}${value}`; };
  const touch = location => { if (question) question.lastLocation = location; };
  const startQuestion = (number, prompt, location) => {
    question = {
      number, prompt, options: [], answerCandidates: [], explanation: '', audio: null, image: null,
      prepare: undefined, time: undefined, firstLocation: location, lastLocation: location,
      mediaConflicts: new Set(), typeHint: current.typeHint,
    };
    current.questions.push(question);
    mode = 'questions';
    active = { object: question, field: 'prompt' };
  };
  const addKeys = (value, location) => {
    if (!current) { issues.push(issue('warning', `${location}：答案表没有明确所属题组，未自动关联。`, location)); return; }
    const content = value.trim();
    if (!content) return;
    const parts = content.split(/\s*[;,]\s*/);
    const parsed = parts.map(part => part.match(/^(?:(?:Question|Q)\s*)?(\d{1,4})\s*(?:[.):=\-]\s*)?\s+(.+)$/i) || part.match(/^(?:(?:Question|Q)\s*)?(\d{1,4})[.):=\-]\s*(.+)$/i));
    if (parsed.some(match => !match)) {
      issues.push(issue('warning', `${location}：答案表格式未识别，未猜测答案。请使用“1 B”或每行“1. B”等明确编号。`, location));
      return;
    }
    for (const match of parsed) current.keys.push({ number: Number(match[1]), answer: match[2].trim(), location });
  };
  const attachMedia = (scope, kind, value, location) => {
    if (!current) { issues.push(issue('error', `${location}：媒体引用没有所属题组。`, location)); return; }
    let target;
    let conflicts;
    if (scope === 'question') {
      if (!question) { issues.push(issue('error', `${location}：题目媒体引用必须位于编号题目之后。`, location)); return; }
      target = question; conflicts = question.mediaConflicts;
    } else if (scope === 'group' || !current.questions.length) { target = current.group; conflicts = current.mediaConflicts; }
    else {
      issues.push(issue('error', `${location}：${kind === 'audio' ? 'Audio' : 'Image'} 的题组或题目范围不明确。请改为 Group ${kind}: 或 Question ${kind}:，或在草稿中确认关联。`, location));
      return;
    }
    const reference = value.trim().replace(/^(?:"([^"]+)"|'([^']+)')$/, (_all, quoted, singleQuoted) => quoted || singleQuoted);
    if (!reference || /\s+(?:or|and)\s+|[;|]|\.(?:mp3|wav|ogg|m4a|webm|mp4|png|jpe?g|webp|gif)\s*,/i.test(reference) || !Object.hasOwn(MEDIA, path.posix.extname(reference).toLowerCase())) {
      issues.push(issue('error', `${location}：媒体引用未明确指定一个受支持的文件名，未自动配对。`, location));
      return;
    }
    if (conflicts.has(kind)) return;
    if (target[kind] && target[kind] !== reference) {
      target[kind] = null;
      conflicts.add(kind);
      issues.push(issue('error', `${location}：同一位置出现多个不同的 ${kind} 引用，已清空关联，请手动确认。`, location));
      return;
    }
    target[kind] = reference;
    touch(location);
  };

  for (const chunk of chunks) {
    if (previousName !== undefined && previousName !== chunk.name) { current = undefined; question = undefined; lastSection = undefined; mode = 'none'; active = undefined; }
    previousName = chunk.name;
    const lines = normalText(chunk.text).split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const raw = lines[lineIndex];
      const trimmed = raw.trim();
      const heading = cleanHeading(trimmed);
      const location = sourceLocation(chunk, lineIndex + 1);
      if (!trimmed) {
        if (active?.object?.[active.field]) append(active.object, active.field, '');
        continue;
      }
      const sectionHeader = heading.match(/^(Reading|Listening|Speaking|Writing)(?:\s+(?:Section|Comprehension|\d+))?(?:(?:\s*:\s*|\s+[-–—]\s+)(.+))?\s*$/i);
      const sectionFirst = heading.match(/^Section\s+\d+\s*[:–—-]\s*(Reading|Listening|Speaking|Writing)(?:\s*:\s*(.+))?$/i);
      if (sectionHeader || sectionFirst) {
        const match = sectionHeader || sectionFirst;
        const section = match[1].toLowerCase();
        startGroup(section, match[2] || heading, location, taskType(match[2] || ''));
        continue;
      }
      const explicitTask = heading.match(/^(Interview(?:\s+Questions)?|Email(?:\s+Writing)?|Academic\s+Discussion|Sentence\s+Order|Listen\s+(?:and|&)\s+Repeat)(?:\s*:\s*(.+))?\s*$/i);
      if (explicitTask) {
        const hint = taskType(explicitTask[1]);
        const section = inferSection(hint);
        if (current && !current.questions.length && current.group.section === section && !current.group.passage) {
          current.typeHint = hint;
          if (explicitTask[2]) current.group.title = explicitTask[2];
          mode = 'preamble'; active = undefined;
        } else startGroup(section, explicitTask[2] || explicitTask[1], location, hint);
        continue;
      }
      const groupHeader = heading.match(/^(?:Group|Set|Part)\s*(?:(\d+|[A-Za-z])\s*)?(?:[:–—-]\s*(.+))?$/i);
      const passageHeader = heading.match(/^Passage\s+(\d+)(?:\s*[:–—-]\s*(.+))?$/i);
      if (groupHeader || passageHeader) {
        if (!lastSection) { unassigned++; issues.push(issue('warning', `${location}：题组标题没有明确科目，未猜测 Reading 或 Listening。`, location)); continue; }
        const label = groupHeader ? groupHeader[2] || heading : passageHeader[2] || heading;
        const hint = taskType(label) || current?.typeHint || null;
        startGroup(lastSection, label, location, hint);
        if (passageHeader) { mode = 'passage'; active = { object: current.group, field: 'passage' }; }
        continue;
      }
      const metadata = heading.match(/^(Title|Rights|License)\s*:\s*(.*)$/i);
      if (metadata) {
        if (metadata[1].toLowerCase() === 'title' && !suppliedTitle) pack.title = metadata[2];
        if (['rights', 'license'].includes(metadata[1].toLowerCase())) pack.rights = metadata[2];
        active = undefined;
        continue;
      }
      const passageLabel = heading.match(/^(Passage|Transcript)\s*:\s*(.*)$/i);
      if (passageLabel) {
        if (!current) { unassigned++; issues.push(issue('warning', `${location}：材料缺少明确科目标题，保留在来源面板。`, location)); continue; }
        if (current.questions.length) { issues.push(issue('error', `${location}：题目之后出现新材料，但没有明确的新题组标题，未合并到前一篇材料。`, location)); mode = 'unassigned'; active = undefined; question = undefined; continue; }
        mode = 'passage'; question = undefined; active = { object: current.group, field: 'passage' };
        if (passageLabel[2]) append(current.group, 'passage', passageLabel[2]);
        continue;
      }
      if (/^Questions?(?:\s+\d+\s*[-–]\s*\d+)?\s*:?$/i.test(heading)) { mode = current ? 'questions' : 'none'; question = undefined; active = undefined; continue; }
      const answerKey = heading.match(/^(?:Answer\s+key|Correct\s+answers|Answers)\s*(?::\s*(.*))?$/i);
      if (answerKey) { mode = 'answer-key'; active = undefined; question = undefined; addKeys(answerKey[1] || '', location); continue; }
      const mediaLabel = heading.match(/^(?:(Group|Question)\s+)?(Audio|Image)\s*:\s*(.*)$/i);
      if (mediaLabel) { attachMedia(mediaLabel[1]?.toLowerCase(), mediaLabel[2].toLowerCase(), mediaLabel[3], location); active = undefined; continue; }
      const timingLabel = heading.match(/^(?:(Group|Question)\s+)?(Preparation\s+time|Prep\s+time|Response\s+time|Answer\s+time|Time\s+limit)\s*:\s*(.*)$/i);
      if (timingLabel) {
        const unitValue = timingLabel[3].match(/^(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m)\.?$/i);
        const seconds = unitValue ? Number(unitValue[1]) * (/^m/i.test(unitValue[2]) ? 60 : 1) : NaN;
        if (!current || !Number.isInteger(seconds) || seconds < 0 || seconds > 7200) issues.push(issue('warning', `${location}：计时没有明确有效的秒或分钟单位，未推算。`, location));
        else {
          const prepare = /^(?:Preparation|Prep)/i.test(timingLabel[2]);
          const explicitScope = timingLabel[1]?.toLowerCase();
          if (explicitScope === 'question' && !question) issues.push(issue('warning', `${location}：题目计时缺少所属题目，未自动关联。`, location));
          else if (explicitScope === 'group' || !question) current[prepare ? 'defaultPrepare' : 'defaultTime'] = seconds;
          else { question[prepare ? 'prepare' : 'time'] = seconds; touch(location); }
        }
        active = undefined;
        continue;
      }
      const typeLabel = heading.match(/^(?:Task(?:\s+type)?|Question\s+type)\s*:\s*(.+)$/i);
      if (typeLabel) {
        if (current) current.typeHint = taskType(typeLabel[1]) || 'unsupported';
        if (current?.typeHint === 'unsupported') issues.push(issue('error', `${location}：尚不支持明确标注的题型“${typeLabel[1]}”，不会改判为其他题型。`, location));
        question = undefined; active = undefined;
        continue;
      }
      const instructions = heading.match(/^Instructions?\s*:\s*(.*)$/i);
      if (instructions) {
        if (current) { current.instructions.push(instructions[1]); append(current.group, 'passage', raw); }
        else unassigned++;
        active = undefined;
        continue;
      }
      if (mode === 'answer-key') { addKeys(trimmed, location); continue; }
      const numbered = trimmed.match(/^(?:(Question|Q)\s*)?(\d{1,4})\s*[.):]\s*(.*)$/i);
      if (numbered && current && (mode !== 'passage' || numbered[1])) {
        startQuestion(Number(numbered[2]), numbered[3], location);
        continue;
      }
      const option = trimmed.match(/^(?:([A-Z])[.)]|\(([A-Z])\))\s+(.+)$/);
      if (option && question && mode === 'questions') {
        const item = { id: option[1] || option[2], text: option[3] };
        question.options.push(item); active = { object: item, field: 'text' }; touch(location);
        continue;
      }
      const localAnswer = heading.match(/^(?:Correct\s+answer|Answer)\s*:\s*(.*)$/i);
      if (localAnswer) {
        if (question) { question.answerCandidates.push({ answer: localAnswer[1].trim(), location }); touch(location); }
        else issues.push(issue('warning', `${location}：答案没有明确所属编号题目，未自动关联。`, location));
        active = undefined;
        continue;
      }
      const targetSentence = heading.match(/^(?:Target\s+sentence|Repeat\s+text)\s*:\s*(.*)$/i);
      if (targetSentence) {
        if (question && question.typeHint === 'listen_repeat') question.answerCandidates.push({ answer: targetSentence[1], location });
        else issues.push(issue('warning', `${location}：目标原句缺少明确的跟读题目，未自动关联。`, location));
        active = undefined;
        continue;
      }
      const explanation = heading.match(/^Explanation\s*:\s*(.*)$/i);
      if (explanation) {
        if (question) { append(question, 'explanation', explanation[1]); active = { object: question, field: 'explanation' }; touch(location); }
        else { unassigned++; active = undefined; }
        continue;
      }
      if (/^(?:Sample\s+answer|Model\s+answer|Matching|True\s*(?:\/|or)\s*False|Select\s+all\s+that\s+apply)\b/i.test(heading)) {
        issues.push(issue('warning', `${location}：此文档块尚不支持自动整理，已保留原文。`, location));
        if (/^(?:Matching|True\s*(?:\/|or)\s*False|Select\s+all)/i.test(heading) && current) current.typeHint = 'unsupported';
        active = undefined;
        mode = 'unassigned';
        continue;
      }
      if (active) { append(active.object, active.field, raw); touch(location); }
      else if (current && ['preamble', 'passage'].includes(mode) && ['reading', 'listening'].includes(current.group.section)) {
        append(current.group, 'passage', raw); active = { object: current.group, field: 'passage' };
      } else unassigned++;
    }
  }

  for (const record of records) {
    const group = record.group;
    group.passage = group.passage.trim();
    const counts = new Map();
    for (const q of record.questions) counts.set(q.number, (counts.get(q.number) || 0) + 1);
    for (const number of counts.keys()) if (counts.get(number) > 1) issues.push(issue('error', `${group.title} 内的原题号 ${number} 重复，局部答案表的关联不明确；请拆分题组或修正编号。`, `groups.${group.id}`));
    for (const key of record.keys) if (!counts.has(key.number)) issues.push(issue('warning', `${key.location}：答案表的题号 ${key.number} 在当前题组中不存在，未关联到其他题组。`, key.location));
    let untimed = false;
    for (const q of record.questions) {
      q.prompt = q.prompt.trim();
      q.explanation = q.explanation.trim();
      q.options = q.options.map(option => ({ id: option.id, text: option.text.trim() }));
      const hasChoices = q.options.length > 0;
      let type = q.typeHint;
      const multiAnswer = /\b(?:choose|select|pick)\s+(?:any\s+)?(?:two|three|2|3|all|more\s+than\s+one)\b|\bmultiple\s+(?:answers|responses)\b|\bselect\s+all\s+that\s+apply\b/i.test([q.prompt, group.title, ...record.instructions].join('\n'));
      if (!type && hasChoices && ['reading', 'listening'].includes(group.section)) type = 'single_choice';
      if (!type && /_{2,}/.test(q.prompt) && ['reading', 'listening'].includes(group.section)) type = 'fill_blank';
      const incompatibleChoices = hasChoices && !['single_choice', 'sentence_order'].includes(type);
      if (!q.prompt || !TYPES.has(type) || incompatibleChoices || (type === 'single_choice' && multiAnswer)) {
        issues.push(issue('error', `${q.firstLocation}：原题号 ${q.number} 的题型或边界不明确/尚不支持，未猜测加入练习。请对照来源手动整理。`, q.firstLocation));
        continue;
      }
      const candidates = [...q.answerCandidates, ...(counts.get(q.number) === 1 ? record.keys.filter(key => key.number === q.number) : [])];
      const uniqueAnswers = [...new Set(candidates.map(candidate => candidate.answer.trim()).filter(answer => answer && !/^(?:\?|N\/?A|not\s+(?:given|provided)|unknown|-)$/i.test(answer)))];
      let answer = null;
      if (uniqueAnswers.length > 1) issues.push(issue('error', `${q.firstLocation}：原题号 ${q.number} 有相互冲突的答案键，已保留为未评分。`, q.firstLocation));
      else if (uniqueAnswers.length === 1) {
        const key = uniqueAnswers[0];
        if (type === 'single_choice') {
          const letter = key.match(/^([A-Z])[.)]?$/)?.[1];
          if (letter && q.options.some(option => option.id === letter)) answer = letter;
          else issues.push(issue('error', `${q.firstLocation}：答案键无法对应当前题目的单个选项，已保留为未评分。`, q.firstLocation));
        } else if (type === 'fill_blank' || type === 'listen_repeat') answer = key;
        else if (type === 'sentence_order') {
          const ids = key.split(/\s*(?:→|>|,|\|)\s*|\s+/).filter(Boolean);
          if (ids.length === q.options.length && new Set(ids).size === ids.length && ids.every(id => q.options.some(option => option.id === id))) answer = ids;
          else issues.push(issue('error', `${q.firstLocation}：排序答案未完整且唯一地对应原文片段，已保留为未评分。`, q.firstLocation));
        } else issues.push(issue('warning', `${q.firstLocation}：主观题的答案表不作为标准答案，已保留在来源面板。`, q.firstLocation));
      }
      if (['single_choice', 'fill_blank', 'sentence_order'].includes(type) && answer === null) issues.push(issue('warning', `${group.title} · 原题号 ${q.number} 没有可确认的本题答案键，将保留为未评分。`, q.firstLocation));
      if (type === 'listen_repeat' && answer === null) issues.push(issue('warning', `${q.firstLocation}：跟读题没有明确目标原句，可记录练习但不能请求逐句对比反馈。`, q.firstLocation));
      const time = q.time ?? record.defaultTime ?? 0;
      if (q.time === undefined && record.defaultTime === undefined) untimed = true;
      group.questions.push({
        id: `q${++totalQuestions}`, type, prompt: q.prompt, options: q.options, answer, explanation: q.explanation,
        audio: q.audio, image: q.image, timeLimitSeconds: time, prepareSeconds: q.prepare ?? record.defaultPrepare ?? 0,
        source: `${q.firstLocation} · 原题号 ${q.number}${q.lastLocation !== q.firstLocation ? `；续至 ${q.lastLocation}` : ''}`,
      });
    }
    if (untimed) issues.push(issue('warning', `${group.title} 的部分题目没有明确计时，草稿暂设为不计时，请按需要修改。`, `groups.${group.id}`));
    if (group.section === 'listening' && !group.audio && !group.questions.some(q => q.audio)) issues.push(issue('warning', `${group.title} 没有明确的音频引用；不会根据文件顺序自动配对。`, `groups.${group.id}.audio`));
    if (group.questions.length || group.passage || group.audio || group.image) pack.groups.push(group);
  }
  if (unassigned && recognized) issues.push(issue('warning', `有 ${unassigned} 行文字未归入常见练习文档字段，已保留在来源面板，请检查是否遗漏题目或说明。`, 'sources'));
  if (totalQuestions) {
    issues.push(issue('warning', '已按常见练习文档格式整理。请复核题目边界、组内编号、局部答案表、计时和媒体关联；不支持任意版式。', 'pack'));
  }
  return { pack, issues, method: totalQuestions ? 'worksheet' : 'source-only', recognized };
}

function verifyDraftMedia(pack, media, originalText, { ai = false } = {}) {
  const issues = [];
  const available = new Set(media.map(item => item.name));
  const verifiedDirections = new Set(matchExamDirections(pack, media.map(item => item.name)).matches.map(match => `${match.groupId}\0${match.direction.audio}`));
  for (let gi = 0; gi < (pack.groups || []).length; gi++) {
    const group = pack.groups[gi];
    if (!group || typeof group !== 'object') continue;
    const targets = [{ item: group, at: `groups.${gi}` }, ...(Array.isArray(group.questions) ? group.questions : []).map((question, qi) => ({ item: question, at: `groups.${gi}.questions.${qi}` })), ...(Array.isArray(group.directions) ? group.directions : []).map((direction, di) => ({ item: direction, at: `groups.${gi}.directions.${di}` }))];
    for (const { item, at } of targets) {
      if (!item || typeof item !== 'object') continue;
      for (const field of ['audio', 'image']) {
        if (!item[field]) continue;
        if (typeof item[field] !== 'string') { issues.push(issue('error', '媒体引用须为相对文件名。', `${at}.${field}`)); continue; }
        if (ai && !originalText.includes(item[field]) && !(at.includes('.directions.') && verifiedDirections.has(`${group.id}\0${item[field]}`))) { item[field] = null; issues.push(issue('warning', 'AI 给出的媒体关联未在原文中找到，已清除，请手动确认关联。', `${at}.${field}`)); continue; }
        let normalized;
        try { normalized = safeName(item[field]); } catch { issues.push(issue('error', '媒体引用不是安全的相对文件名。', `${at}.${field}`)); continue; }
        item[field] = normalized;
        if (!available.has(normalized)) issues.push(issue('error', `找不到明确引用的媒体文件：${normalized}。请补选文件或修正引用。`, `${at}.${field}`));
      }
    }
  }
  const referenced = new Set(collectMediaPaths({ ...pack, groups: (pack.groups || []).filter(group => group && typeof group === 'object').map(group => ({ ...group, questions: Array.isArray(group.questions) ? group.questions.filter(Boolean) : [] })) }));
  for (const file of media) if (!referenced.has(file.name)) issues.push(issue('warning', `${file.name} 尚未明确关联题目；不会按文件顺序自动配对。`, file.name));
  return issues;
}

function verifyAiFidelity(pack, chunks) {
  const issues = [];
  if (!pack || typeof pack !== 'object' || !Array.isArray(pack.groups)) throw inputError('AI 未返回可检查的练习草稿。');
  const raw = chunks.map(chunk => chunk.text).join('\n\n');
  const normalized = evidenceText(raw);
  let offset = 0;
  const chunkRanges = chunks.map(chunk => { const range = { ...chunk, start: offset, end: offset + chunk.text.length }; offset = range.end + 2; return range; });
  const explicitAnswers = [...raw.matchAll(/^[ \t]*(?:@answer[ \t]*:?[ \t]*|(?:correct\s+answer|answer|答案|正确答案)\s*[:：][ \t]*)([^\r\n]*)/gim)]
    .map(match => ({ answer: evidenceText(match[1]), position: evidenceText(raw.slice(0, match.index)).length, name: chunkRanges.find(chunk => match.index >= chunk.start && match.index <= chunk.end)?.name }));
  const sourceNames = [...new Set(chunks.map(chunk => chunk.name))];
  const sourceEvidence = sourceNames.map(name => ({ name, text: evidenceText(chunks.filter(chunk => chunk.name === name).map(chunk => chunk.text).join('\n\n')) }));
  const conventionalEvidence = parseConventionalWorksheet(chunks).pack.groups.flatMap(group => group.questions.map(question => ({ group, question })));
  const questions = pack.groups.filter(group => group && Array.isArray(group.questions)).flatMap(group => group.questions).filter(q => q && typeof q.prompt === 'string' && q.prompt.trim());
  const promptPositions = questions.map(q => {
    const prompt = evidenceText(q.prompt);
    const start = normalized.indexOf(prompt);
    const matchingSources = sourceEvidence.filter(source => source.text.includes(prompt));
    // Repeated identical prompts have ambiguous answer associations.
    return { question: q, start, name: matchingSources.length === 1 ? matchingSources[0].name : null, unique: start >= 0 && normalized.indexOf(prompt, start + 1) < 0 };
  });
  const checkCopy = (value, at) => {
    if (value && (typeof value !== 'string' || !normalized.includes(evidenceText(value)))) issues.push(issue('error', 'AI 草稿的这段文字无法在原文中逐字核对，请对照来源修正。', at));
  };
  for (let gi = 0; gi < pack.groups.length; gi++) {
    const group = pack.groups[gi];
    if (!group || !Array.isArray(group.questions)) { issues.push(issue('error', 'AI 草稿的题组结构无效。', `groups.${gi}`)); continue; }
    if(!group.questions.some(question=>question?.interaction&&hasReadingInteractionEvidence(group.passage,question.interaction,raw))) checkCopy(group.passage, `groups.${gi}.passage`);
    for (let qi = 0; qi < group.questions.length; qi++) {
      const q = group.questions[qi];
      if (!q || typeof q !== 'object') { issues.push(issue('error', 'AI 草稿题目结构无效。', `groups.${gi}.questions.${qi}`)); continue; }
      const at = `groups.${gi}.questions.${qi}`;
      checkCopy(q.prompt, `${at}.prompt`);
      checkCopy(q.sentenceFrame, `${at}.sentenceFrame`);
      for (let oi = 0; oi < (Array.isArray(q.options) ? q.options.length : 0); oi++) checkCopy(q.options[oi]?.text, `${at}.options.${oi}.text`);
      const matchingOriginals = conventionalEvidence.filter(original =>
        original.group.section === group.section && typeof q.prompt === 'string' &&
        evidenceText(original.question.prompt) === evidenceText(q.prompt) &&
        evidenceText(original.group.passage) === evidenceText(typeof group.passage === 'string' ? group.passage : ''));
      const original = matchingOriginals.length === 1 ? matchingOriginals[0].question : null;
      const originalOptions = original ? JSON.stringify(original.options.map(option => ({ id: option.id, text: evidenceText(option.text) }))) : null;
      const candidateOptions = Array.isArray(q.options) ? JSON.stringify(q.options.map(option => ({ id: option?.id, text: typeof option?.text === 'string' ? evidenceText(option.text) : '' }))) : null;
      const optionMappingMatches = !original || originalOptions === candidateOptions;
      if (!optionMappingMatches) issues.push(issue('error', 'AI 草稿的选项标签、顺序或文字对应与原文题目不同，请对照来源修正。', `${at}.options`));
      if (q.answer !== null && q.answer !== undefined) {
        const candidate = Array.isArray(q.answer) ? q.answer.join(' | ') : q.answer;
        const position = promptPositions.find(item => item.question === q);
        const nextPrompt = position?.unique ? Math.min(...promptPositions.filter(item => item.start > position.start).map(item => item.start), Infinity) : -1;
        const originalAnswer = original && (Array.isArray(original.answer) ? original.answer.join(' | ') : original.answer);
        const conventionalKey = typeof originalAnswer === 'string' && typeof candidate === 'string' && evidenceText(originalAnswer) === evidenceText(candidate);
        const inlineKey = position?.unique && position.name && typeof candidate === 'string' && explicitAnswers.some(item => item.name === position.name && item.position > position.start && item.position < nextPrompt && item.answer === evidenceText(candidate));
        const correspondingKey = optionMappingMatches && (original ? conventionalKey : inlineKey);
        if (!correspondingKey) {
          q.answer = null;
          issues.push(issue('warning', 'AI 草稿中的答案无法对应原文明示的答案键，已清空并保留为未评分。', `${at}.answer`));
        }
      }
      if (q.explanation && (typeof q.explanation !== 'string' || !normalized.includes(evidenceText(q.explanation)))) { q.explanation = ''; issues.push(issue('warning', 'AI 生成的解析无法在来源中找到，已清空。', `${at}.explanation`)); }
      // AI-provided page numbers are not evidence. Rebuild provenance only from
      // the local extraction result; ambiguous or cross-page matches stay clear.
      const matches = typeof q.prompt === 'string' && q.prompt.trim() ? chunks.filter(chunk => evidenceText(chunk.text).includes(evidenceText(q.prompt))) : [];
      if (original) q.source = original.source;
      else if (matches.length === 1) {
        const chunk = matches[0];
        const exactIndex = chunk.text.indexOf(q.prompt);
        q.source = exactIndex >= 0 ? sourceLocation(chunk, chunk.text.slice(0, exactIndex).split('\n').length) : `${chunk.name}${chunk.page ? ` · 第 ${chunk.page} 页` : ''}${chunk.paragraph ? ` · 第 ${chunk.paragraph} 段` : ''} · 行位置待复核`;
      } else q.source = `来源位置待复核 · ${sourceNames.join('、')}`;
    }
  }
  if (!questions.length) issues.push(issue('error', 'AI 草稿没有可核对的题目，请对照原文补充后再导入。', 'groups'));
  if (pack.rights && !normalized.includes(evidenceText(pack.rights))) pack.rights = '';
  issues.push(issue('warning', 'AI 仅生成待复核草稿；题目边界、顺序、题型、计时和来源位置均需逐项确认。', 'pack'));
  return issues;
}

export async function extractMaterialSources({ files = [], text = '', title = '', signal } = {}) {
  if (!Array.isArray(files) || files.length > 1200) throw inputError('一次处理最多 1200 个文件。');
  if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS) throw inputError('粘贴文字过长，请拆分后导入。');
  if (typeof title !== 'string' || title.length > 300) throw inputError('资料标题过长。');
  const decoded = files.map(decodeFile);
  if (decoded.reduce((sum, file) => sum + file.buffer.length, 0) > MAX_TOTAL_BYTES) throw inputError('本次导入文件总大小不得超过 80 MB。');
  const seen = new Set();
  for (const file of decoded) {
    signal?.throwIfAborted();
    const nameKey = file.name.toLowerCase();
    if (seen.has(nameKey)) throw inputError(`出现重名文件：${file.name}，请重命名后再导入。`);
    seen.add(nameKey);
  }
  const chunks = [];
  const media = [];
  const issues = [];
  const derivedFiles = [];
  if (text.trim()) chunks.push({ name: '粘贴文字', text: normalText(text), kind: 'text' });
  for (const file of decoded) {
    const extension = path.posix.extname(file.name).toLowerCase();
    if (MEDIA[extension]) { media.push({ name: file.name, mime: MEDIA[extension] }); continue; }
    if (['.txt', '.md', '.markdown'].includes(extension)) chunks.push({ name: file.name, text: normalText(decodeText(file.buffer, file.name)), kind: 'text' });
    else if (extension === '.pdf' || extension === '.docx') {
      const result = extension === '.pdf' ? await extractPdf(file.buffer, file.name) : await extractDocx(file.buffer, file.name, { signal });
      chunks.push(...result.chunks);
      issues.push(...result.issues);
      for (const derived of result.derivedFiles || []) {
        const existing = decoded.find(file => file.name.toLowerCase() === derived.name.toLowerCase()) || derivedFiles.find(file => file.name.toLowerCase() === derived.name.toLowerCase());
        if (existing && existing.data !== derived.data) throw inputError(`派生题面图像与已选择的文件重名且内容不同：${derived.name}`);
        if (existing) for (const chunk of result.chunks) for (const image of chunk.images || []) if (image.name.toLowerCase() === derived.name.toLowerCase()) image.name = existing.name;
        if (!existing) derivedFiles.push(derived);
      }
    } else issues.push(issue('error', `${file.name} 不是支持的文字、PDF、DOCX 或媒体格式；原生题包请使用 JSON 或 ZIP 导入。`, file.name));
  }
  if (chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) > MAX_TEXT_CHARS) throw inputError('本次提取文字过多，请分批导入。');
  if (!chunks.some(chunk => chunk.text.trim())) issues.push(issue('error', '没有可提取的文字。扫描 PDF 需先做 OCR；音频与图片需要通过题目清单明确关联。', 'sources'));
  const sourceNames = [...new Set(chunks.map(chunk => chunk.name))];
  const sources = sourceNames.map(name => ({ name, text: markedSource(chunks.filter(chunk => chunk.name === name)) }));
  for (const file of derivedFiles) media.push({ name: file.name, mime: 'image/png' });
  if (decoded.reduce((sum, file) => sum + file.buffer.length, 0) + derivedFiles.reduce((sum, file) => sum + Buffer.byteLength(file.data, 'base64'), 0) > MAX_TOTAL_BYTES) throw inputError('文档与派生题面图像总大小超过 80 MB，请分批导入。');
  const documentLayout = projectDocumentLayout(chunks);
  return { chunks, projectedChunks: projectDocumentChunks(chunks, documentLayout), documentLayout, media, issues, sources, derivedFiles, files: [...decoded.map(({ name, data }) => ({ name, data })), ...derivedFiles] };
}

export async function buildDraftFromSources(inspected, {title = '', useAI = false, consent = false,expectedBinding,signal} = {}, models) {
  const {chunks, media, sources} = inspected;
  const issues = [...inspected.issues];
  const documentLayout = inspected.documentLayout || projectDocumentLayout(chunks);
  const projectedChunks = inspected.projectedChunks || projectDocumentChunks(chunks, documentLayout);
  const recognition = [];
  let result;
  if (useAI) {
    if (consent !== true) throw inputError('请先同意把本次提取的文字发送给所选模型。文件二进制内容不会自动发送。');
    if (!models?.structure) throw inputError('AI 结构整理尚不可用。可关闭 AI 选项后使用固定模板。');
    models.assertBinding?.(expectedBinding);
    const response = await models.structure({ text: sources.map(source => source.text).join('\n\n'), title: title.trim(), mediaNames: media.map(file => file.name), consent,expectedBinding,signal });
    const pack = structuredClone(response.pack ?? response);
    const fidelityIssues = verifyAiFidelity(pack, chunks);
    result = { pack, issues: [...(Array.isArray(response.issues) ? response.issues : []), ...fidelityIssues], method: 'ai-draft' };
  } else {
    // The workbook profile has proven glyph/line geometry rules; retain its
    // source stream. Other adapters consume the independent region projection.
    for (const [parser, input, profile] of [[parseTstDocument, chunks, 'workbook'], [parseExamDocument, projectedChunks, 'modular']]) {
      const candidate = parser(input, { title: title.trim(), mediaNames: media.map(file => file.name) });
      if (!candidate) { recognition.push({ profile, state: 'unrecognized' }); continue; }
      const state = candidate.pack.groups.some(g => g.questions.length) ? 'recognized' : 'recognized_empty';
      recognition.push({ profile, state });
      if (state === 'recognized') { result = candidate; break; }
      issues.push(...candidate.issues, issue('warning', '已识别文档结构但未恢复题目；保留来源并继续受限模板解析。', 'sources'));
    }
    if (!result) result = parseTemplate(projectedChunks, title.trim());
    if (result.method === 'source-only') {
      const conventional = parseConventionalWorksheet(projectedChunks, title.trim());
      // Single-task banks and pasted web text carry no whole-worksheet
      // headings; keep whichever reader recovers more questions net of errors.
      const grammar = parseTaskGrammar(projectedChunks, { title: title.trim() });
      const score = candidate => candidate.pack.groups.reduce((sum, group) => sum + group.questions.length, 0) - candidate.issues.filter(item => item.severity === 'error').length;
      recognition.push({ profile: 'task-grammar', state: grammar?.recognized ? 'recognized' : 'unrecognized' });
      if (conventional.method === 'worksheet' && !(grammar?.recognized && score(grammar) > score(conventional))) result = conventional;
      else if (grammar?.recognized) result = grammar;
      else if (conventional.recognized) result.issues.push(...conventional.issues);
    }
  }
  issues.push(...result.issues, ...verifyDraftMedia(result.pack, media, chunks.map(chunk => chunk.text).join('\n\n'), { ai: useAI }));
  return { pack: result.pack, issues, sources, media, method: result.method, recognition, documentLayout, fieldEvidence: mapDocumentFields(result.pack, documentLayout), files: inspected.files };
}

export async function extractDraft(input = {}, models) {
  if(input.useAI)models?.assertBinding?.(input.expectedBinding);
  const inspected = await extractMaterialSources(input);
  return buildDraftFromSources(inspected, input, models);
}
