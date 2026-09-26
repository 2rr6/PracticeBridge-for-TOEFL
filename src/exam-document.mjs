import { createHash } from 'node:crypto';
import path from 'node:path';
import { addExamDocumentMetadata } from './exam-plan.mjs';
import { coverSentence, inferredFixedText, rejoinSpaces, scannedSentenceLooksWhole, tileInFixedText } from './task-grammar.mjs';

// A deliberately narrow, local converter for a modular practice-document
// layout. These are structural labels, never a bundled question bank. Source
// prose, keys and media names are supplied by the user at import time.
const SECTION = /^(Reading|Listening|Writing|Speaking)\s+Section(?:\s*,\s*Module\s+(\d+))?$/i;
const NUMBERED = /^(\d+)\.\s+(.+)$/;
const OPTION = /^\(([A-Z])\)\s*(.*)$/;
const FILL = /^Fill in the missing letters in the paragraph\.?$/i;
const READ = /^Read (?:a|an) .+\.?$/i;
const LISTEN = /^Listen to (?:a|an) .+\.?$/i;
const TASKS = new Map([
  ['build a sentence', 'sentence_order'], ['write an email', 'email'],
  ['write for an academic discussion', 'discussion'], ['listen and repeat', 'listen_repeat'],
  ['take an interview', 'interview'],
]);
const issue = (severity, message, at = 'sources') => ({ severity, message, path: at });
const clean = value => value.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
const textOf = lines => lines.map(line => line.text).join('\n').trim();
const sectionLabel = value => value[0].toUpperCase() + value.slice(1);
const location = line => `${line.name}${line.page ? ` · 第 ${line.page} 页` : ''} · 第 ${line.line} 行`;
const scopeKey = (section, module) => `${section}:${module ?? ''}`;

function pageLines(chunk) {
  const lines = clean(chunk.text).split('\n').map((text, index) => ({ text: text.trim(), name: chunk.name, page: chunk.page, line: chunk.sourceLineMap?.[index] || index + 1, x: chunk.sourceLineX?.[index] ?? null, ocr: Boolean(chunk.ocr), strict: Boolean(chunk.ocr) && chunk.ocr.proofread !== true }));
  // A footer has the document/test title followed by a page number. Restrict
  // removal to the final non-empty line so a question's content stays intact.
  // OCR often reads the title and the page number as two lines.
  const last = lines.findLastIndex(line => line.text);
  if (last >= 0 && /^(?:.+?\s+)?(?:Practice|Sample|Mock)\s+Test\s+\d+\s+\d+$/i.test(lines[last].text)) lines[last].text = '';
  else if (chunk.ocr && last >= 0) {
    const title = /^\d{1,3}$/.test(lines[last].text) ? lines.findLastIndex((line, i) => i < last && line.text) : last;
    if (title >= 0 && /^(?:.+?\s+)?(?:Practice|Sample|Mock)\s+Test\s+\d+$/i.test(lines[title].text)) lines[title].text = lines[last].text = '';
  }
  return lines;
}

// Missing letters never start a word, so they are lower case: OCR's capital I
// among lower-case letters ("Ived") is an l, and "SO" is "so". An all-capital
// reading with an I could be i or l and is left open.
const missingLetters = answer => {
  if (!answer || !/^[A-Za-z]+$/.test(answer)) return answer;
  if (/[a-z]/.test(answer)) return answer.replace(/I/g, 'l');
  if (answer.includes('I')) return null;
  // A lone capital may be a choice letter that reached the wrong row.
  if (answer.length === 1) return null;
  return answer.toLowerCase();
};

// Drops extra OCR blanks so the rest line up with the keyed answer lengths.
// Returns null unless one choice fits strictly better than every other.
function alignBlanks(blanks, answers) {
  const extra = blanks.length - answers.length;
  if (extra < 1 || extra > 3) return null;
  const printed = blanks.map(blank => (blank[2].match(/[_-]/g) || []).length);
  const costs = [];
  const choose = (start, dropped) => {
    if (dropped.length === extra) {
      const kept = blanks.map((_, i) => i).filter(i => !dropped.includes(i));
      costs.push({ kept, cost: kept.reduce((sum, i, j) => sum + (printed[i] === answers[j].length ? 0 : 1), 0) });
      return;
    }
    for (let i = start; i < blanks.length; i++) choose(i + 1, [...dropped, i]);
  };
  choose(0, []);
  costs.sort((a, b) => a.cost - b.cost);
  if (costs.length > 1 && costs[0].cost === costs[1].cost) return null;
  return costs[0].kept.map(i => blanks[i]);
}

function recognizes(chunks) {
  if (!chunks.length || !chunks.every(chunk => chunk.kind === 'pdf' && Number.isInteger(chunk.page))) return false;
  const lines = chunks.flatMap(chunk => clean(chunk.text).split('\n').map(line => line.trim()));
  const sections = new Set(lines.map(line => line.match(SECTION)?.[1].toLowerCase()).filter(Boolean));
  const modules = lines.filter(line => line.match(SECTION)?.[2]);
  const tasks = lines.filter(line => FILL.test(line) || TASKS.has(line.toLowerCase()));
  return sections.size >= 2 && modules.length >= 2 && tasks.length >= 2 && lines.some(line => /^Answer Key$/i.test(line));
}

function readKeys(pages, issues) {
  const keys = new Map();
  const answerPages = new Set();
  for (let pi = 0; pi < pages.length; pi++) {
    const lines = pages[pi];
    if (!lines.some(line => /^Answer Key$/i.test(line.text))) continue;
    answerPages.add(pi);
    const heading = lines.map(line => line.text.match(SECTION)).find(Boolean);
    if (!heading) { issues.push(issue('error', '答案页缺少明确的科目和模块标题，未跨页猜测答案归属。', location(lines[0]))); continue; }
    const section = heading[1].toLowerCase();
    const module = heading[2] ? Number(heading[2]) : null;
    if (['reading', 'listening'].includes(section) && module === null) {
      issues.push(issue('error', '答案页缺少明确模块编号，未把答案关联到其他模块。', location(lines[0]))); continue;
    }
    const scope = scopeKey(section, module);
    if (!keys.has(scope)) keys.set(scope, new Map());
    let entry;
    for (const line of lines) {
      if (!line.text || SECTION.test(line.text) || /^(?:Answer Key|Question(?:\s+Number)?(?:\s+Answer)?|Number(?:\s+Answer)?|Answer)$/i.test(line.text)) continue;
      const match = line.text.match(/^(\d+)[.)]?\s+(.+)$/);
      if (match) {
        entry = { number: Number(match[1]), answer: match[2], line };
        const entries = keys.get(scope).get(entry.number) || [];
        entries.push(entry);
        keys.get(scope).set(entry.number, entries);
      } else if (entry) entry.answer += `\n${line.text}`;
      else issues.push(issue('error', '答案表的行边界无法确定，原文保留在来源中。', location(line)));
    }
  }
  return { keys, answerPages };
}

const tokens = value => (value.normalize('NFC').replaceAll('’', "'").toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*|[^\s]/gu) || []);

function orderedAnswer(frame, options, answer) {
  const parts = frame.split(/_{2,}/).map(tokens);
  const target = tokens(answer);
  const optionTokens = options.map(option => tokens(option.text));
  const solutions = [];
  let steps = 0;
  const begins = (at, words) => words.every((word, index) => target[at + index] === word);
  const visit = (slot, at, used, ids) => {
    if (++steps > 20000 || solutions.length > 1 || !begins(at, parts[slot])) return;
    at += parts[slot].length;
    if (slot === parts.length - 1) { if (at === target.length) solutions.push(ids); return; }
    for (let oi = 0; oi < options.length; oi++) {
      if (!used.has(oi) && optionTokens[oi].length && begins(at, optionTokens[oi])) {
        visit(slot + 1, at + optionTokens[oi].length, new Set([...used, oi]), [...ids, options[oi].id]);
      }
    }
  };
  visit(0, 0, new Set(), []);
  return steps <= 20000 && solutions.length === 1 ? solutions[0] : null;
}

function mediaEvidence(names) {
  return names.flatMap(name => {
    if (typeof name !== 'string') return [];
    if (!/\.(?:mp3|wav|ogg|oga|opus|m4a|mp4|webm)$/i.test(name)) return [];
    const base = path.posix.basename(name.replaceAll('\\', '/')).replace(/\.[^.]+$/, '');
    if (/directions?/i.test(base)) return [];
    const listening = base.match(/^Listening(?:[ _-]*Module)?[ _-]*(\d+)[ _-]+(.+?)[ _-]+Questions?[ _-]*(\d+)(?:[-–](\d+))?$/i);
    if (listening) {
      const descriptor = listening[2].replace(/[_-]/g, ' ').toLowerCase().trim();
      const category = /^question\s+response$/.test(descriptor) ? 'response' : /^conversations?$/.test(descriptor) ? 'conversation' : /^announcements?$/.test(descriptor) ? 'announcement' : /^academic\s+talks?$/.test(descriptor) ? 'talk' : null;
      if (category) return [{ name, section: 'listening', module: Number(listening[1]), category, first: Number(listening[3]), last: Number(listening[4] || listening[3]) }];
    }
    const speaking = base.match(/^Speaking[ _-]+(Listen[ _-]+Repeat|Interview)[ _-]+Questions?[ _-]*(\d+)$/i);
    if (speaking) return [{ name, section: 'speaking', module: null, category: /^interview$/i.test(speaking[1]) ? 'interview' : 'listen_repeat', first: Number(speaking[2]), last: Number(speaking[2]) }];
    return [];
  }).filter(item => item.first > 0 && item.last >= item.first);
}

/** Return null unless this is a confidently recognized modular PDF layout. */
export function parseExamDocument(chunks, { title = '', mediaNames = [] } = {}) {
  if (!Array.isArray(chunks)) return null;
  const documents = new Map();
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.name !== 'string' || typeof chunk.text !== 'string') return null;
    const list = documents.get(chunk.name) || [];
    list.push(chunk);
    documents.set(chunk.name, list);
  }
  const supported = [...documents].filter(([, pages]) => recognizes(pages));
  if (!supported.length) return null;
  const issues = [];
  if (supported.length > 1) return {
    pack: { schemaVersion: 1, id: 'exam-documents-review', version: '1.0.0', title: title || '待确认的分模块练习资料', description: '', rights: '', groups: [] },
    issues: [issue('error', '一次仅能按此版式转换一份分模块 PDF；请选择一份主文档，避免混合不同试卷的题号与答案。')], method: 'exam-document',
  };
  const [name, documentChunks] = supported[0];
  for (const [otherName, otherChunks] of documents) if (otherName !== name && otherChunks.some(chunk => chunk.text.trim())) issues.push(issue('error', `附加文档 ${otherName} 尚未转换；请单独处理或确认其内容后再导入。`, otherName));
  const pages = documentChunks.map(pageLines);
  const { keys, answerPages } = readKeys(pages, issues);
  const hash = createHash('sha256').update(documentChunks.map(chunk => chunk.text).join('\n')).digest('hex').slice(0, 16);
  const cover = pages[0].filter(line => line.text).map(line => line.text);
  const titleIndex = cover.findIndex(line => /^(?:Practice|Sample|Mock)\s+Test\s+\d+$/i.test(line));
  const detectedTitle = titleIndex >= 0 ? cover.slice(Math.max(0, titleIndex - 1), titleIndex + 1).join(' ') : '待确认的分模块练习资料';
  const pack = { schemaVersion: 1, id: `exam-${hash}`, version: '1.0.0', title: title.trim() || detectedTitle, description: '从本地分模块练习文档转换的待复核草稿。科目、模块、原题号与答案来源分开保留。', rights: '', groups: [] };
  let section;
  let module = null;
  let current;
  let question;
  let activeOption;
  let fill;
  let writingTask;
  let speakingTask;
  const groups = [];
  const seenQuestions = new Set();
  const usedKeys = new Map();
  const unassigned = [];
  const lastNumbers = new Map();
  // Forward view over body pages, used to tell a question stem (followed by
  // lettered options) from numbered prose such as a notice's rule list.
  const flat = pages.flatMap((lines, pi) => answerPages.has(pi) ? [] : lines);
  const position = new Map(flat.map((line, index) => [line, index]));
  const opensBlock = value => NUMBERED.test(value) || FILL.test(value) || READ.test(value) || LISTEN.test(value) || /^Choose the best response\.?$/i.test(value) || TASKS.has(value.toLowerCase());
  function followingOption(line, { sameIndent = false } = {}) {
    for (let index = position.get(line) + 1; index < flat.length; index++) {
      const next = flat[index];
      if (!next.text || SECTION.test(next.text)) continue;
      if (OPTION.test(next.text)) return next;
      if (opensBlock(next.text)) return null;
      if (sameIndent && !(Number.isFinite(next.x) && Math.abs(next.x - line.x) <= 3)) return null;
    }
    return null;
  }
  // Some PDFs draw list numbers as graphics, leaving only the stem text. Such a
  // stem sits at the hanging indent, to the right of its own options.
  // Indentation is not always consistent, so a line that directly follows the
  // previous question's options and precedes a fresh "(A)" also counts.
  function unnumberedStem(line, previousOptions = []) {
    if (!Number.isFinite(line.x) || OPTION.test(line.text) || opensBlock(line.text) || /^[A-Z][\w .'-]{0,30}:\s/.test(line.text)) return false;
    const option = followingOption(line, { sameIndent: true });
    if (!option || !Number.isFinite(option.x)) return false;
    if (line.x - option.x >= 8) return true;
    let before = position.get(line) - 1;
    while (before >= 0 && (!flat[before].text || SECTION.test(flat[before].text))) before--;
    return line.x >= option.x && option.text.match(OPTION)[1] === 'A' && previousOptions.some(o => o.id === 'A') && before >= 0 && OPTION.test(flat[before].text);
  }

  function newGroup(label, category, line) {
    question = null; activeOption = null;
    const scope = `${section}${module === null ? '' : `-m${module}`}`;
    const serial = groups.filter(group => group.scope === scope).length + 1;
    current = { id: `${scope}-g${serial}`, section, title: `${sectionLabel(section)}${module === null ? '' : ` · Module ${module}`} · ${label}`, passage: '', audio: null, image: null, questions: [], scope, module, category, line, passageLines: [] };
    groups.push(current);
    return current;
  }

  function baseQuestion(number, type, line, { numbered = true } = {}) {
    const tag = type === 'sentence_order' ? 'sentence' : type === 'listen_repeat' ? 'repeat' : type;
    const id = `${current.scope}${['reading', 'listening'].includes(section) ? '' : `-${tag}`}-q${number}`;
    if (seenQuestions.has(id)) issues.push(issue('error', `${current.title} 的原题号 ${number} 重复，请复核模块和题目边界。`, location(line)));
    seenQuestions.add(id);
    if (['reading', 'listening'].includes(section)) lastNumbers.set(scopeKey(section, module), number);
    const label = numbered === 'inferred' ? `原题号 ${number}（PDF 文字层缺少题号，按前一题顺序推定）` : numbered ? `原题号 ${number}` : `${tag} 原文顺序第 ${number} 条（原文未编号）`;
    return {
      id, type, prompt: '', options: [], answer: null, explanation: '', audio: null, image: null,
      timeLimitSeconds: 0, prepareSeconds: 0,
      source: `${location(line)} · ${sectionLabel(section)}${module === null ? '' : ` Section, Module ${module}`} · ${label}`,
      number, sourceNumbered: numbered !== false, firstLine: line, lastLine: line, promptLines: [],
    };
  }

  function peekKey(number) {
    const unique = [...new Set((keys.get(scopeKey(section, module))?.get(number) || []).map(entry => entry.answer.replace(/\s+/g, ' ').trim()))];
    return unique.length === 1 ? unique[0] : null;
  }

  function keyFor(q) {
    const scope = scopeKey(section, module);
    const candidates = keys.get(scope)?.get(q.number) || [];
    if (!usedKeys.has(scope)) usedKeys.set(scope, new Set());
    usedKeys.get(scope).add(q.number);
    const unique = [...new Set(candidates.map(entry => entry.answer.replace(/\s+/g, ' ').trim()))];
    if (unique.length > 1) {
      issues.push(issue('error', `${q.source} 的答案键相互冲突，未自动判定答案。`, `${q.id}.answer`)); return null;
    }
    if (!unique.length) { issues.push(issue('warning', `${q.source} 没有明确的本题答案键，保留为未评分。`, `${q.id}.answer`)); return null; }
    q.source += `；答案来自 ${location(candidates[0].line)}`;
    return unique[0];
  }

  function finishQuestion() {
    if (!question) return;
    question.prompt = textOf(question.promptLines);
    if (question.type === 'single_choice') {
      for (const option of question.options) option.text = option.text.trim();
      const answer = keyFor(question);
      if (answer !== null) {
        const id = answer.match(/^([A-Z])[.)]?$/)?.[1];
        if (id && question.options.filter(option => option.id === id).length === 1) question.answer = id;
        else issues.push(issue('error', `${question.source} 的答案无法唯一对应本题选项。`, `${question.id}.answer`));
      }
      if (question.options.length < 2 || new Set(question.options.map(option => option.id)).size !== question.options.length) issues.push(issue('error', `${question.source} 的选择题选项不完整或有重复。`, `${question.id}.options`));
      if (/\b(?:choose|select)\s+(?:two|three|all|2|3)\b/i.test(question.prompt)) issues.push(issue('error', `${question.source} 要求多项回答，当前单选题不能完整表示，请先手动转换。`, `${question.id}.type`));
    } else if (question.type === 'sentence_order') {
      const lines = question.promptLines;
      const frameIndex = lines.findIndex(line => /_{2,}/.test(line.text));
      const optionIndex = lines.findIndex((line, index) => index > frameIndex && line.text.includes('/'));
      // A scanned slot line can be unreadable while the tiles and the keyed
      // sentence are not. The frame is then the keyed sentence with the tiles
      // taken out, and the question says so.
      const tileIndex = frameIndex < 0 ? lines.findIndex((line, index) => index > 0 && line.text.split('/').length >= 3) : -1;
      const inferred = tileIndex > 0 ? (() => {
        let fragments = textOf(lines.slice(tileIndex)).split(/\s*\/\s*/).map(value => value.replace(/\s+/g, ' ').trim());
        const keyed = keys.get(scopeKey(section, module))?.get(question.number) || [];
        let answers = [...new Set(keyed.map(entry => entry.answer.replace(/\s+/g, ' ').trim()))];
        if (answers.length === 1 && lines.some(line => line.ocr)) ({ fragments, answer: answers[0] } = rejoinSpaces(fragments, answers[0]));
        const cover = answers.length === 1 && fragments.every(Boolean) ? coverSentence(answers[0], fragments) : null;
        const strict = lines.some(line => line.strict);
        return cover && !tileInFixedText(cover, fragments) && (!strict || scannedSentenceLooksWhole(answers[0], fragments, cover.order.length) && !inferredFixedText(cover)) ? { fragments, cover, answer: answers[0] } : null;
      })() : null;
      if (inferred) {
        question.sentenceFrame = inferred.cover.frame;
        question.answerSlots = inferred.cover.order.length;
        question.options = inferred.fragments.map((text, index) => ({ id: `F${index + 1}`, text }));
        question.prompt = textOf(lines.slice(0, 1));
        const answer = keyFor(question);
        question.answer = inferred.cover.order.map(index => question.options[index].id);
        question.explanation = answer ? inferred.answer : '';
        question.source += '；句子框架由答案与词块推定（原文空位行无法识别）';
        issues.push(issue('warning', `${question.source}：原文的空位行无法识别，已用答案句减去词块推定固定文字，请对照原文核对。`, question.id));
      } else if (frameIndex < 0 || optionIndex < 0) {
        issues.push(issue('error', `${question.source} 的句子空位或词块边界不明确，请对照原文补充。`, question.id));
      } else {
        question.sentenceFrame = textOf(lines.slice(frameIndex, optionIndex));
        question.answerSlots = (question.sentenceFrame.match(/_{2,}/g) || []).length;
        const fragments = textOf(lines.slice(optionIndex)).split(/\s*\/\s*/).map(value => value.replace(/\s+/g, ' ').trim());
        question.options = fragments.map((text, index) => ({ id: `F${index + 1}`, text }));
        question.prompt = textOf(lines.slice(0, optionIndex));
        const compatible = question.answerSlots >= 1 && question.answerSlots <= question.options.length && question.options.length <= 30 && fragments.every(Boolean);
        if (!compatible) issues.push(issue('error', `${question.source} 的词块数与空位数不相容。`, question.id));
        const answer = keyFor(question);
        if (answer !== null) {
          question.answer = compatible ? orderedAnswer(question.sentenceFrame, question.options, answer) : null;
          if (question.answer && lines.some(line => line.strict) && !scannedSentenceLooksWhole(answer, fragments, question.answer.length)) {
            question.answer = null;
            issues.push(issue('error', `${question.source} 是扫描页，本机识别的答案句或词块不完整，已留空；连接 AI 看图校对后可以补全。`, `${question.id}.answer`));
          } else if (!question.answer) issues.push(issue('error', `${question.source} 的完整答案不能唯一拆成原文词块及固定文字，已保留为未评分。`, `${question.id}.answer`));
          question.explanation = answer;
        }
      }
    } else if (question.type === 'listen_repeat') {
      // A sentence to repeat never ends in a comma; OCR reads the period so.
      question.answer = question.promptLines.some(line => line.ocr) ? question.prompt.replace(/[,;]$/, '.') : question.prompt;
      question.prompt = 'Listen carefully and repeat what you heard.\n\n请先播放材料，再复述原句。';
    }
    if (question.lastLine.page !== question.firstLine.page) question.source += `；题目续至 ${location(question.lastLine)}`;
    current.questions.push(question);
    question = null; activeOption = null;
  }

  function finishFill() {
    if (!fill) return;
    const passage = textOf(fill.lines);
    const printedBlanks = [...passage.matchAll(/([A-Za-z]+)((?:\s*[_-])+(?![A-Za-z]))/g)];
    let blanks = printedBlanks;
    const expected = fill.range ? fill.range[1] - fill.range[0] + 1 : 0;
    // OCR miscounts dashes, so on scanned pages the answer key decides each
    // blank's length, and an extra blank is dropped only when exactly one
    // choice lines the blanks up with the key.
    const scanned = fill.lines.some(line => line.ocr);
    const keyed = scanned && expected ? Array.from({ length: expected }, (_, i) => missingLetters(peekKey(fill.range[0] + i))) : [];
    if (scanned && expected && blanks.length > expected && keyed.every(answer => answer && /^[A-Za-z]+$/.test(answer))) blanks = alignBlanks(blanks, keyed) || blanks;
    if (!expected || blanks.length !== expected) {
      issues.push(issue('error', `${location(fill.line)} 的缺字题范围与空白数量不一致（题号范围 ${expected || '未识别'}，空白 ${blanks.length}），未猜测编号；完整段落保留在来源中。`, location(fill.line)));
      fill = null; return;
    }
    newGroup(fill.label, 'fill', fill.line);
    current.passage = passage;
    const counts = [];
    for (let bi = 0; bi < blanks.length; bi++) {
      const blank = blanks[bi];
      const number = fill.range[0] + bi;
      const lineOffset = passage.slice(0, blank.index).split('\n').length - 1;
      const blankLine = fill.lines[lineOffset] || fill.line;
      const q = baseQuestion(number, 'fill_blank', blankLine);
      const printed = (blank[2].match(/[_-]/g) || []).length;
      // OCR miscounts a gap by one; a larger difference means the key row
      // itself does not belong here, and the length check then refuses it.
      const count = scanned && /^[A-Za-z]+$/.test(keyed[bi] || '') && Math.abs(keyed[bi].length - printed) <= 1 ? keyed[bi].length : printed;
      counts.push(count);
      if (count !== printed) q.source += `；扫描页上的空白数 ${printed} 按答案改为 ${count}`;
      q.prompt = `${fill.label}\n\n原题号 ${number}：${blank[1]}${'_'.repeat(count)}\n只填写缺少的 ${count} 个字母，不填写完整单词。`;
      const keyText = keyFor(q), answer = scanned ? missingLetters(keyText) : keyText;
      if (keyText !== null && answer === null) issues.push(issue('error', `${q.source} 是扫描页，答案“${keyText}”的大小写或字母无法确定，已留空；连接 AI 看图校对后可以补全。`, `${q.id}.answer`));
      if (answer !== null) {
        if (/^[A-Za-z]+$/.test(answer) && answer.length === count) q.answer = answer;
        else issues.push(issue('error', `${q.source} 的答案长度或形式与缺少字母不符，未猜测完整单词。`, `${q.id}.answer`));
      }
      current.questions.push(q);
    }
    // The paragraph shows the corrected blanks; a dropped blank becomes "[?]"
    // so it no longer reads as a gap.
    if (scanned) {
      let text = '', at = 0;
      for (const match of printedBlanks) {
        const bi = blanks.indexOf(match), start = match.index + match[1].length;
        text += passage.slice(at, start) + (bi < 0 ? '[?]' : match[2].trim()[0].repeat(counts[bi]));
        at = start + match[2].length;
      }
      current.passage = text + passage.slice(at);
    }
    fill = null;
  }

  function finishWritingTask() {
    if (!writingTask) return;
    const q = baseQuestion(1, writingTask.type, writingTask.line, { numbered: false });
    q.prompt = textOf(writingTask.lines);
    const minutes = q.prompt.match(/You will have\s+(\d+)\s+minutes?\s+to\s+write/i);
    if (minutes) q.timeLimitSeconds = Number(minutes[1]) * 60;
    current.questions.push(q);
    writingTask = null;
  }

  function finishBlock() { finishQuestion(); finishFill(); finishWritingTask(); speakingTask = null; }

  for (let pi = 0; pi < pages.length; pi++) {
    if (answerPages.has(pi)) { finishBlock(); current = null; continue; }
    const lines = pages[pi];
    const heading = lines.map(line => line.text.match(SECTION)).find(Boolean);
    // Some layouts repeat the current section/module title on every page. A
    // repeat while a block is open is a running header, not a new module.
    const runningHeader = Boolean(heading && section === heading[1].toLowerCase() && module === (heading[2] ? Number(heading[2]) : null) && (current || fill || writingTask || speakingTask));
    const first = lines.find(line => line.text && !(runningHeader && SECTION.test(line.text)));
    if (!first) continue;
    if (heading && !runningHeader) {
      finishBlock(); current = null;
      section = heading[1].toLowerCase(); module = heading[2] ? Number(heading[2]) : null;
      // Section/module overview pages have no task body. If a new document puts
      // a known task after its heading, it is handled below rather than dropped.
      if (lines.some(line => /Type of Task\s+Description/i.test(line.text))) continue;
      if (!lines.some(line => FILL.test(line.text) || READ.test(line.text) || LISTEN.test(line.text) || NUMBERED.test(line.text) || TASKS.has(line.text.toLowerCase()) || /^Choose the best response\.?$/i.test(line.text))) {
        const body = lines.filter(line => line.text && !SECTION.test(line.text));
        if (body.length && !(module !== null && /\b(?:clock|Next and Back|return to Module)\b/i.test(textOf(body)))) issues.push(issue('error', `${location(first)} 后有尚未识别的任务内容，已保留来源，请对照原文处理。`, location(first)));
        continue;
      }
    }
    if (!section) continue; // Cover page.
    // An unlabelled passage starts on a new page after complete questions. A
    // numbered question/option continuation stays with the existing passage.
    if (section === 'reading' && module !== null && (!heading || runningHeader) && !fill && !FILL.test(first.text) && !READ.test(first.text) && !NUMBERED.test(first.text) && !OPTION.test(first.text) && !unnumberedStem(first) && (!current || current.questions.length + Number(Boolean(question)) > 0)) {
      finishQuestion();
      const label = first.text.length <= 180 ? first.text : 'Passage';
      newGroup(label, 'passage', first);
    }
    for (const line of lines) {
      const value = line.text;
      if (!value || SECTION.test(value)) continue;
      if (FILL.test(value) && section === 'reading') {
        finishBlock(); fill = { label: value, line, range: null, lines: [] }; current = null; continue;
      }
      if ((READ.test(value) && section === 'reading') || (LISTEN.test(value) && section === 'listening') || (/^Choose the best response\.?$/i.test(value) && section === 'listening')) {
        finishBlock();
        const category = section === 'reading' ? 'passage' : /^Choose/i.test(value) ? 'response' : /conversation/i.test(value) ? 'conversation' : /announcement/i.test(value) ? 'announcement' : /talk/i.test(value) ? 'talk' : 'unknown';
        newGroup(value, category, line);
        current.passageLines.push(line);
        continue;
      }
      const type = TASKS.get(value.toLowerCase());
      if (type && (['sentence_order', 'email', 'discussion'].includes(type) ? section === 'writing' : section === 'speaking')) {
        finishBlock();
        newGroup(value, type, line);
        if (['email', 'discussion'].includes(type)) writingTask = { type, line, lines: [line] };
        else if (['listen_repeat', 'interview'].includes(type)) speakingTask = { type, line, count: 0 };
        continue;
      }
      if (fill) {
        const range = value.match(/^\(?Questions?\s+(\d+)\s*[-–]\s*(\d+)\)?$/i);
        if (range) fill.range = [Number(range[1]), Number(range[2])];
        else fill.lines.push(line);
        continue;
      }
      if (writingTask) { writingTask.lines.push(line); continue; }
      if (speakingTask) {
        const speaker = value.match(speakingTask.type === 'listen_repeat' ? /^(?:Trainer|Speaker|Instructor|Guide):\s*(.+)$/i : /^(?:Interviewer|Researcher):\s*(.+)$/i);
        if (speaker) {
          finishQuestion();
          question = baseQuestion(++speakingTask.count, speakingTask.type, line, { numbered: false });
          question.promptLines.push({ ...line, text: speaker[1] });
        } else if (question) { question.promptLines.push(line); question.lastLine = line; }
        else current.passageLines.push(line);
        continue;
      }
      const choiceSection = ['reading', 'listening'].includes(section);
      // Numbered prose inside a passage (rules, steps) has no lettered options.
      const numbered = value.match(NUMBERED) && !(choiceSection && current && !followingOption(line)) ? value.match(NUMBERED) : null;
      if (!numbered && choiceSection && current && !(question && !question.options.length) && unnumberedStem(line, question?.options)) {
        finishQuestion();
        question = baseQuestion((lastNumbers.get(scopeKey(section, module)) || 0) + 1, 'single_choice', line, { numbered: 'inferred' });
        question.promptLines.push(line);
        continue;
      }
      if (numbered) {
        finishQuestion();
        if (!current) {
          issues.push(issue('error', `${location(line)} 的题目缺少明确的题组/材料边界，已保留为待复核题组。`, location(line)));
          newGroup('题组边界待复核', 'unknown', line);
        }
        const qtype = section === 'writing' && current.category === 'sentence_order' ? 'sentence_order' : ['reading', 'listening'].includes(section) ? 'single_choice' : null;
        if (!qtype) { issues.push(issue('error', `${location(line)} 的编号题型尚未支持，原文已保留。`, location(line))); unassigned.push(line); continue; }
        question = baseQuestion(Number(numbered[1]), qtype, line);
        question.promptLines.push({ ...line, text: numbered[2] });
        continue;
      }
      const option = value.match(OPTION);
      if (question?.type === 'single_choice' && option) {
        activeOption = { id: option[1], text: option[2] };
        question.options.push(activeOption); question.lastLine = line; continue;
      }
      if (question) {
        if (activeOption) activeOption.text += `\n${value}`;
        else question.promptLines.push(line);
        question.lastLine = line;
      } else if (current) current.passageLines.push(line);
      else unassigned.push(line);
    }
  }
  finishBlock();

  const evidence = mediaEvidence(mediaNames);
  const questionCounts = new Map();
  for (const group of groups) for (const q of group.questions) questionCounts.set(q.id, (questionCounts.get(q.id) || 0) + 1);
  for (const group of groups) {
    if (!group.passage) group.passage = textOf(group.passageLines);
    if (!group.questions.length) {
      issues.push(issue('error', `${group.title} 没有可确定边界的题目，材料保留在来源中，请复核是否遗漏。`, location(group.line)));
      continue;
    }
    const firstNumber = group.questions[0].number;
    const lastNumber = group.questions.at(-1).number;
    group.title += ` · ${group.questions.every(q => q.sourceNumbered) ? '原题号' : '原文第'} ${firstNumber}${firstNumber === lastNumber ? '' : `–${lastNumber}`}${group.questions.every(q => q.sourceNumbered) ? '' : ' 条'}`;
    for (const q of group.questions) if (questionCounts.get(q.id) > 1) q.answer = null;
    if (['listening', 'speaking'].includes(group.section)) {
      const mappings = group.questions.map(q => ({ q, candidates: evidence.filter(item => item.section === group.section && item.module === group.module && item.category === group.category && item.first <= q.number && item.last >= q.number) }));
      for (const { q, candidates } of mappings) {
        if (candidates.length === 1) q.audio = candidates[0].name;
        else issues.push(issue('warning', `${q.source} ${candidates.length ? '有多个符合科目、模块、题号的媒体，未自动选择' : '没有唯一对应的媒体文件'}；请手动复核关联。`, `${q.id}.audio`));
      }
      const names = new Set(group.questions.map(q => q.audio));
      if (names.size === 1 && !names.has(null) && group.questions.length > 1) {
        group.audio = group.questions[0].audio;
        for (const q of group.questions) q.audio = null;
      }
      const linked = [...new Set([group.audio, ...group.questions.map(q => q.audio)].filter(Boolean))];
      for (const mediaName of linked) issues.push(issue('warning', `${mediaName} 依据文件名中的科目、模块/任务和题号范围关联${group.section === 'speaking' ? '（口语原文未编号，以任务内语句顺序对应文件题号）' : ''}；尚未试听核实，请在确认草稿前检查。`, `${group.id}.audio`));
    }
    for (const q of group.questions) {
      delete q.number; delete q.sourceNumbered; delete q.firstLine; delete q.lastLine; delete q.promptLines;
    }
    for (const field of ['scope', 'module', 'category', 'line', 'passageLines']) delete group[field];
    pack.groups.push(group);
  }
  for (const [scope, entries] of keys) for (const [number, candidates] of entries) if (!usedKeys.get(scope)?.has(number)) issues.push(issue('error', `${location(candidates[0].line)} 的答案题号 ${number} 没有对应到本科目/模块的题目，可能存在尚未转换的题型。`, location(candidates[0].line)));
  if (unassigned.length) issues.push(issue('warning', `${unassigned.length} 行说明或内容未归入题目，已保留在来源中；首处为 ${location(unassigned[0])}。`, 'sources'));
  issues.push(issue('warning', '已按分模块练习文档版式整理。请对照原 PDF 核对段落边界、缺字位置、写作固定文字、讨论发言归属及媒体；此草稿不复制原页面布局。', 'pack'));
  const enriched = addExamDocumentMetadata(pack, { chunks: documentChunks, mediaCatalog: mediaNames });
  issues.push(...enriched.issues);
  for (const set of enriched.pack.examSets || []) for (const section of set.sections) for (const module of section.modules) {
    if (module.timing.durationSeconds === null && ['module', 'question'].includes(module.timing.scope) && module.taskIds.some(id => enriched.pack.groups.find(group => group.id === id)?.timing.scope === 'inherit_module')) issues.push(issue('warning', `${module.title} 未给出${module.timing.scope === 'module' ? '模块总' : '逐题回答'}时长，按文档计时会保持不限时，可另选练习预设。`, `${module.id}.timing`));
  }
  for (const group of enriched.pack.groups) if (['task', 'question'].includes(group.timing?.scope) && group.timing.durationSeconds === null) issues.push(issue('warning', `${group.title} 未给出${group.timing.scope === 'task' ? '任务' : '回答'}时长，按文档计时会保持不限时，可另选练习预设。`, `${group.id}.timing`));
  return { pack: enriched.pack, issues, method: 'exam-document', recognition: enriched.pack.groups.some(g => g.questions.length) ? 'recognized' : 'recognized_empty' };
}
