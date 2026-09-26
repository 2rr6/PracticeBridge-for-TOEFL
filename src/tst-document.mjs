import { createHash } from 'node:crypto';
import path from 'node:path';
import { createInlineBlanks } from './exam-plan.mjs';

// A structural adapter for a publisher's modular paper workbook. It contains
// no publisher questions, keys, transcripts, page numbers or media filenames.
// Source PDF link annotations and already supplied files are the only audio
// mapping evidence; this module never downloads anything.
const SECTION = /For the TOEFL\s*®?\s*(Reading|Listening|Writing|Speaking)\s+Section/i;
const NUMBER = /^(\d+)\s*\.\s*(.*)$/;
const CHOICE = /^([A-Da-d])\s*\.\s+(.+)$/;
const MODULE = /^Module\s+(\d+)$/i;
const KEY_MODULE = /^Module\s+(\d+)\s*:\s*Answer Key$/i;
const FILL = /^Fill in the missing letters in the paragraph\.?$/i;
const GAP = /([A-Za-z]+)((?:\s*_)+)/g;
const MARKED_GAP = /([A-Za-z]+)\{([A-Za-z]+)\}/g;
const TASK = new Map([
  ['build a sentence', 'build_sentence'], ['write an email', 'write_email'],
  ['write for an academic discussion', 'academic_discussion'],
  ['listen and repeat', 'listen_repeat'], ['take an interview', 'interview'],
]);
const TYPE = { complete_words: 'fill_blank', read_daily: 'single_choice', read_academic: 'single_choice', listen_response: 'single_choice', listen_conversation: 'single_choice', listen_announcement: 'single_choice', listen_talk: 'single_choice', build_sentence: 'sentence_order', write_email: 'email', academic_discussion: 'discussion', listen_repeat: 'listen_repeat', interview: 'interview' };
const clean = value => String(value || '').normalize('NFKC').replace(/[\u200b\ufeff]/g, '').replace(/\r\n?/g, '\n');
const norm = value => clean(value).replace(/\s+/g, ' ').trim();
const evidenceNorm = value => norm(value).replace(/\s+([,.;:!?])/g, '$1');
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const label = section => ({ reading: 'Reading', listening: 'Listening', writing: 'Writing', speaking: 'Speaking' })[section];
const issue = (severity, message, at = 'sources') => ({ severity, message, path: at });
const location = line => `${line.name} · 第 ${line.page} 页 · 第 ${line.line} 行`;
const trimLines = lines => {
  const first = lines.findIndex(line => line.text);
  return first < 0 ? [] : lines.slice(first, lines.findLastIndex(line => line.text) + 1);
};
const textOf = lines => trimLines(lines).map(line => line.text).join('\n');
const timing = (scope, durationSeconds = null, source = '', prepareSeconds = null) => ({ scope, durationSeconds, prepareSeconds, basis: source ? 'document' : 'unknown', source });
const navigation = section => section === 'reading' ? { back: 'module', review: 'module', lockOnAdvance: true } : section === 'writing' ? { back: 'task', review: 'task', lockOnAdvance: true } : { back: 'none', review: 'none', lockOnAdvance: true };
const scope = (section, module) => `${section}:${module ?? ''}`;

function preparePage(chunk) {
  const section = norm(chunk.text).match(SECTION)?.[1].toLowerCase();
  const lines = clean(chunk.text).split('\n').map((raw, index) => {
    const positioned = (chunk.layout?.items || []).filter(item => item.line === index + 1);
    return {
      name: chunk.name, page: chunk.page, line: index + 1, text: raw.trim(),
      x: positioned.length ? Math.min(...positioned.map(item => item.x)) : null,
      y: positioned.length ? positioned[0].y : null,
      height: positioned.length ? Math.max(...positioned.map(item => item.height || 0)) : null,
      fonts: [...new Set(positioned.map(item => item.fontName).filter(Boolean))],
    };
  });
  const last = lines.findLastIndex(line => line.text);
  if (last >= 0 && /^\d+(?:\s+\d+)*$/.test(lines[last].text)) lines[last].text = '';
  for (const line of lines) if (/^Practice\s+Test\s*#\s*\d+$/i.test(line.text) || /^For the TOEFL\s*®?\s*(?:(?:Reading|Listening|Writing|Speaking)\s+Section)?$/i.test(line.text)) line.text = '';
  return { chunk, section, lines };
}

function recognizes(chunks) {
  if (!chunks.length || chunks.some(chunk => chunk.kind !== 'pdf' || !Number.isInteger(chunk.page))) return false;
  const pages = chunks.map(preparePage);
  const sections = new Set(pages.map(page => page.section).filter(Boolean));
  const lines = pages.flatMap(page => page.lines.map(line => line.text));
  return sections.size >= 2 && lines.filter(line => MODULE.test(line)).length >= 2 &&
    lines.some(line => FILL.test(line)) && lines.some(line => KEY_MODULE.test(line)) &&
    chunks.some(chunk => /^Practice\s+Test\s*#\s*\d+\s*$/mi.test(clean(chunk.text)));
}

function collectSections(chunks) {
  const sections = new Map();
  for (const page of chunks.map(preparePage)) {
    if (!page.section) continue;
    if (!sections.has(page.section)) sections.set(page.section, { section: page.section, front: [], answers: [], inAnswers: false });
    const section = sections.get(page.section);
    if (page.lines.some(line => /^Answer Key$/i.test(line.text) || KEY_MODULE.test(line.text))) section.inAnswers = true;
    section[section.inAnswers ? 'answers' : 'front'].push(page);
  }
  return sections;
}

function paragraphRecords(lines) {
  const result = [];
  for (const line of trimLines(lines)) {
    if (!line.text) { if (result.at(-1)?.length) result.push([]); }
    else { if (!result.length) result.push([]); result.at(-1).push(line); }
  }
  return result.filter(part => part.length);
}

function readObjectiveKeys(section, issues) {
  const choices = new Map(), fills = [], transcripts = new Map();
  let module = null, taskKey = null, block = null;
  const taskHeading = /^(Listen and Choose|Conversation|Announcement|(?:Listen to an )?Academic(?: Talk)?)\s*#\s*(\d+)(\s+Transcript)?$/i;
  const addChoice = entry => {
    const id = `${scope(section.section, entry.module)}:${entry.number}`;
    const entries = choices.get(id) || [];
    entries.push(entry); choices.set(id, entries);
  };
  const finish = () => {
    if (!block) return;
    if (block.kind === 'fill') fills.push({ ...block, text: textOf(block.lines) });
    else if (block.kind === 'transcript') {
      const entries = transcripts.get(block.taskKey) || [];
      entries.push({ text: textOf(block.lines), source: location(block.line) }); transcripts.set(block.taskKey, entries);
    } else {
      const paragraphs = paragraphRecords(block.lines);
      let transcript = '', explanation = textOf(block.lines);
      if (/listen and choose/i.test(block.taskKey || '') && paragraphs.length >= 2) {
        const tail = paragraphs.at(-1);
        const tailFonts = new Set(tail.flatMap(line => line.fonts));
        const bodyFonts = new Set(paragraphs.slice(0, -1).flat(1).flatMap(line => line.fonts));
        const explicit = /^Transcript\s*:/i.test(tail[0].text);
        const distinctType = tailFonts.size && [...tailFonts].every(font => !bodyFonts.has(font));
        if (explicit || distinctType) {
          transcript = textOf(tail).replace(/^Transcript\s*:\s*/i, '');
          explanation = paragraphs.slice(0, -1).map(textOf).join('\n\n');
        } else issues.push(issue('warning', '此短答题的转录段落样式不能唯一核对；完整答案说明仍保留，未猜测音频原话。', location(block.line)));
      }
      addChoice({ ...block, explanation, transcript });
    }
    block = null;
  };
  for (const page of section.answers) for (const line of page.lines) {
    const moduleMatch = line.text.match(KEY_MODULE);
    if (moduleMatch) { finish(); module = Number(moduleMatch[1]); taskKey = null; continue; }
    const taskMatch = line.text.match(taskHeading);
    if (taskMatch) {
      finish(); taskKey = `${scope(section.section, module)}:${taskMatch[1].toLowerCase().replace(/^listen to an /, '')}#${taskMatch[2]}`;
      if (taskMatch[3]) block = { kind: 'transcript', taskKey, line, lines: [] };
      continue;
    }
    if (module === null) continue;
    const range = line.text.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (section.section === 'reading' && range) { finish(); block = { kind: 'fill', module, first: Number(range[1]), last: Number(range[2]), line, lines: [] }; continue; }
    const choice = line.text.match(/^(\d+)\s*\.\s*([A-D])(?:\s*,\s*(.*))?$/);
    if (choice) { finish(); block = { kind: 'choice', module, taskKey, number: Number(choice[1]), answer: choice[2], label: choice[3] || '', line, lines: [] }; continue; }
    if (block) block.lines.push(line);
  }
  finish();
  return { choices, fills, transcripts };
}

function readResponseKeys(section) {
  const keys = new Map(), samples = new Map();
  let kind = null, entry = null, sample = false;
  const finish = () => {
    if (!entry) return;
    const id = `${kind}:${entry.number ?? ''}`;
    const entries = (entry.number === null ? samples : keys).get(id) || [];
    entries.push({ text: textOf(entry.lines), sample: textOf(entry.sampleLines), line: entry.line });
    (entry.number === null ? samples : keys).set(id, entries); entry = null;
  };
  for (const page of section.answers) for (const line of page.lines) {
    const heading = line.text.replace(/\s*[-–]\s*Sample Response$/i, '').toLowerCase();
    if (TASK.has(heading)) {
      finish(); kind = TASK.get(heading); sample = false;
      if (['write_email', 'academic_discussion'].includes(kind)) entry = { number: null, line, lines: [], sampleLines: [] };
      continue;
    }
    if (!kind) continue;
    if (/^Sample Answer$/i.test(line.text)) { sample = true; continue; }
    const match = line.text.match(NUMBER);
    if (match && !['write_email', 'academic_discussion'].includes(kind)) {
      finish(); sample = false; entry = { number: Number(match[1]), line, lines: [{ ...line, text: match[2] }], sampleLines: [] }; continue;
    }
    if (entry) entry[sample ? 'sampleLines' : 'lines'].push(line);
  }
  finish(); return { keys, samples };
}

function uniqueEntry(entries, issues, at, description = '答案') {
  if (!entries?.length) { issues.push(issue('warning', `缺少可核对的${description}，未自动补写。`, at)); return null; }
  if (entries.length !== 1) { issues.push(issue('warning', `${description}出现重复或冲突，未自动选择。`, at)); return null; }
  return entries[0];
}

function sentenceAnswer(frame, options, answer) {
  const tokens = value => norm(value).replaceAll('’', "'").toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*|[^\s]/gu) || [];
  const fixed = frame.split(/_{2,}/).map(tokens), expected = tokens(answer), fragments = options.map(option => tokens(option.text));
  const solutions = []; let visits = 0;
  const starts = (at, words) => words.every((word, index) => expected[at + index] === word);
  const walk = (slot, at, used, ids) => {
    if (++visits > 20000 || solutions.length > 1 || !starts(at, fixed[slot])) return;
    at += fixed[slot].length;
    if (slot === fixed.length - 1) { if (at === expected.length) solutions.push(ids); return; }
    for (const [index, words] of fragments.entries()) if (!used.has(index) && words.length && starts(at, words)) walk(slot + 1, at + words.length, new Set([...used, index]), [...ids, options[index].id]);
  };
  walk(0, 0, new Set(), []);
  return visits <= 20000 && solutions.length === 1 ? solutions[0] : null;
}

function normalizedOffsets(value) {
  let text = ''; const map = [];
  for (let index = 0; index < value.length; index++) {
    if (/\s/.test(value[index])) {
      if (text && !text.endsWith(' ')) { map.push(index); text += ' '; }
    } else { map.push(index); text += value[index]; }
  }
  if (text.endsWith(' ')) { text = text.slice(0, -1); map.pop(); }
  map.push(map.length ? map.at(-1) + 1 : 0);
  return { text, map };
}

function insertionInteraction(group, question, issues) {
  if (!/four locations[\s\S]+sentence best fit\?/i.test(question.prompt)) return;
  const match = question.prompt.match(/^([\s\S]*?sentence best fit\?)\s+([\s\S]+?)\s+(\(A\)[\s\S]+)$/i);
  if (!match) { issues.push(issue('error', '插句题缺少明确的待插句或 A–D 原文位置，未改为普通选择题。', question.id)); return; }
  const markers = [...match[3].matchAll(/\(([A-D])\)/g)];
  if (markers.length !== 4 || markers.map(marker => marker[1]).join('') !== 'ABCD') { issues.push(issue('error', '插句题的位置标签不是唯一的 A–D，未猜测位置。', question.id)); return; }
  const unmarked = match[3].replace(/\(([A-D])\)/g, '');
  const target = norm(unmarked), normalized = normalizedOffsets(group.passage);
  const start = normalized.text.indexOf(target);
  if (!target || start < 0 || normalized.text.indexOf(target, start + 1) >= 0) { issues.push(issue('error', '插句题的标记段落无法唯一对应阅读原文，未猜测段落位置。', question.id)); return; }
  const candidates = markers.map(marker => {
    const offset = norm(match[3].slice(0, marker.index).replace(/\(([A-D])\)/g, '')).length;
    const position = normalized.map[start + offset];
    return { id: marker[1], start: position, end: position };
  });
  question.prompt = `${match[1]}\n\n${match[2].trim()}`;
  question.options = [];
  question.interaction = { kind: 'sentence_insert', textField: 'passage', offsetUnit: 'utf16', textHash: digest(group.passage), sentence: match[2].trim(), candidates };
}

function geometricLines(items) {
  const lines = [];
  for (const item of items) {
    if (!item.str?.trim() || !Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
    let line = lines.find(line => Math.abs(line.y - item.y) < 1.5);
    if (!line) { line = { y: item.y, items: [] }; lines.push(line); }
    line.items.push(item);
  }
  return lines.sort((a, b) => b.y - a.y).map(line => {
    let text = '', last;
    for (const item of line.items.sort((a, b) => a.x - b.x)) {
      const close = last && item.x - (last.x + last.width) >= -0.5 && item.x - (last.x + last.width) <= 0.5;
      if (text && !/\s$/.test(text) && !/^\s/.test(item.str) && !(close && /[A-Za-z]$/.test(text) && /^[A-Za-z]/.test(item.str))) text += ' ';
      text += clean(item.str); last = item;
    }
    return { text: text.trim(), y: line.y, x: Math.min(...line.items.map(item => item.x)), right: Math.max(...line.items.map(item => item.x + item.width)) };
  });
}

function discussionLayout(group, chunks) {
  const pages = chunks.filter(chunk => group._pages.has(chunk.page) && chunk.layout?.items?.length);
  if (pages.length !== 1) return null;
  const page = pages[0], items = page.layout.items;
  const professors = items.filter(item => /^(?:Dr\.|Prof\.|Professor)\s+[\p{L} .’'-]+$/u.test(clean(item.str).trim()) && item.x < page.layout.width * 0.55);
  if (professors.length !== 1) return null;
  const professor = professors[0];
  const rightNames = geometricLines(items.filter(item => item.x > page.layout.width * 0.47 && item.x < page.layout.width * 0.57 && item.y > professor.y))
    .filter(line => /^[\p{Lu}][\p{L}’'-]*(?:\s+[\p{Lu}][\p{L}’'-]*){0,3}$/u.test(line.text));
  if (rightNames.length !== 2) return null;
  const startX = Math.max(...rightNames.map(line => line.right)) + 3;
  const studentLines = geometricLines(items.filter(item => item.x > startX && item.y > professor.y));
  const gaps = studentLines.slice(1).map((line, index) => studentLines[index].y - line.y).filter(gap => gap > 0).sort((a, b) => a - b);
  const leading = gaps[Math.floor(gaps.length / 2)];
  if (!leading || leading > 30) return null;
  const parts = [];
  for (const line of studentLines) {
    if (!parts.length || parts.at(-1).at(-1).y - line.y > leading * 1.65) parts.push([]);
    parts.at(-1).push(line);
  }
  if (parts.length !== 2) return null;
  const posts = parts.map(part => {
    const candidates = rightNames.filter(name => name.y <= part[0].y + leading && name.y >= part.at(-1).y - leading);
    return candidates.length === 1 ? { speaker: candidates[0].text, text: part.map(line => line.text).join('\n') } : null;
  });
  if (posts.some(post => !post) || new Set(posts.map(post => post.speaker)).size !== 2) return null;
  const leftItems = items.filter(item => item.x < page.layout.width * 0.47 && item.y > 65);
  const prompt = geometricLines(leftItems.filter(item => item.y < professor.y)).map(line => line.text).join('\n');
  const instructions = geometricLines(leftItems.filter(item => item.y > professor.y && item.y < studentLines[0].y + 20)).map(line => line.text).join('\n');
  if (!prompt || !/professor|your response/i.test(instructions)) return null;
  return { prompt: `${clean(professor.str)}\n${prompt}`, posts, instructions };
}

function mediaBasename(url) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    const name = decodeURIComponent(path.posix.basename(parsed.pathname));
    return /\.(mp3|wav|ogg|m4a|mp4|webm)$/i.test(name) && !/[\\/\u0000-\u001f]/.test(name) ? name : null;
  } catch { return null; }
}

function readingPageLines(page) {
  const content = page.lines.filter(line => line.text);
  // Reading pages use a single content flow. Some PDFs serialize a framed
  // passage after the questions even though it is printed above them. Reorder
  // only when every content line has an actual baseline; retain original source
  // line identifiers and reconstruct paragraph gaps from those baselines.
  if (!content.length || content.some(line => !Number.isFinite(line.y))) return page.lines;
  content.sort((a, b) => b.y - a.y || a.x - b.x || a.line - b.line);
  const gaps = content.slice(1).map((line, index) => content[index].y - line.y).filter(gap => gap > 1).sort((a, b) => a - b);
  const leading = gaps[Math.floor(gaps.length / 2)] || 14;
  const result = [];
  for (const line of content) {
    if (result.length && result.at(-1).y - line.y > leading * 1.55) result.push({ ...line, text: '' });
    result.push(line);
  }
  return result;
}

function parseFront(section, keys, issues) {
  const groups = []; let module = null, current = null, question = null, activeOption = null, fill = null;
  const startGroup = (kind, title, line) => {
    const prefix = `${section.section}${module === null ? '' : `-m${module}`}`;
    const group = {
      id: `${prefix}-g${groups.filter(group => group._module === module).length + 1}`, section: section.section, title, taskKind: kind,
      passage: '', audio: null, image: null, questions: [],
      _module: module, _line: line, _pages: new Set([line.page]), _passageLines: [], _directionLines: [], _stimulusPage: null,
    };
    groups.push(group); current = group; return group;
  };
  const baseQuestion = (group, number, line) => ({
    id: `${group.section}${group._module === null ? `-${group.taskKind}` : `-m${group._module}`}-q${number ?? 'unumbered'}`,
    type: TYPE[group.taskKind], prompt: '', options: [], answer: null, explanation: '', audio: null, image: null,
    timeLimitSeconds: 0, prepareSeconds: 0, source: `${location(line)} · ${number === null ? '原文未编号' : `原题号 ${number}`}`,
    localNumber: number, ordinalInTask: group.questions.length + 1,
    _line: line, _lines: [], _number: number,
  });
  const finishQuestion = () => {
    if (!question) return;
    question._lines = trimLines(question._lines);
    question.prompt = textOf(question._lines);
    for (const option of question.options) option.text = option.text.trim();
    if (question._lines.at(-1) && question._lines.at(-1).page !== question._line.page) question.source += `；续至第 ${question._lines.at(-1).page} 页`;
    current.questions.push(question); question = null; activeOption = null;
  };
  const finishFill = () => {
    if (!fill) return;
    const lines = trimLines(fill.lines), passage = textOf(lines), gaps = [...passage.matchAll(GAP)];
    current.passage = passage;
    const skeleton = evidenceNorm(passage.replace(GAP, '$1◊'));
    const candidates = keys.fills.filter(key => key.module === current._module && evidenceNorm(key.text.replace(MARKED_GAP, '$1◊')) === skeleton);
    const key = candidates.length === 1 ? candidates[0] : null;
    const marked = key ? [...key.text.matchAll(MARKED_GAP)] : [];
    const hasRange = key && key.first > 0 && key.last - key.first + 1 === gaps.length && marked.length === gaps.length;
    if (!hasRange) issues.push(issue('warning', '缺字段落未找到唯一的同文答案段落与明确题号范围；空位仍从题面定位，答案和原题号留空。', location(fill.line)));
    if (!gaps.length) issues.push(issue('error', '缺字段落没有可定位的字母空位。', location(fill.line)));
    gaps.forEach((gap, index) => {
      const before = passage.slice(0, gap.index).split('\n').length - 1;
      const line = lines[before] || fill.line;
      const number = hasRange ? key.first + index : null;
      const q = baseQuestion(current, number, line);
      if (number === null) q.id = `${current.id}-gap${index + 1}`;
      const count = (gap[2].match(/_/g) || []).length;
      q.prompt = `Fill in the missing letters.\n${gap[1]}${'_'.repeat(count)}`;
      if (hasRange) {
        q.source += `；答案来自 ${location(key.line)}`;
        if (marked[index][1] === gap[1] && marked[index][2].length === count) q.answer = marked[index][2];
        else issues.push(issue('warning', '原答案的前缀或缺字数与题面不一致；保留题面空位，此题未评分。', `${q.id}.answer`));
      }
      current.questions.push(q);
    });
    fill = null;
  };
  const finish = () => { finishQuestion(); finishFill(); };
  for (const page of section.front) {
    const pageLines = section.section === 'reading' ? readingPageLines(page) : page.lines;
    const first = pageLines.find(line => line.text);
    if (!first) continue;
    if (section.section === 'reading' && module !== null && !MODULE.test(first.text) && !FILL.test(first.text) && !/^Read (?:a|an)\b/i.test(first.text) && !NUMBER.test(first.text) && !CHOICE.test(first.text) && !TASK.has(first.text.toLowerCase()) && first.text.length <= 180 && !/[.!?]$/.test(first.text)) {
      finish(); startGroup('read_academic', first.text, first);
    }
    for (const line of pageLines) {
      const value = line.text;
      if (!value) {
        if (fill) fill.lines.push(line);
        else if (question && !activeOption) question._lines.push(line);
        else if (current && !question) current._passageLines.push(line);
        continue;
      }
      const moduleMatch = value.match(MODULE);
      if (moduleMatch && ['reading', 'listening'].includes(section.section)) { finish(); module = Number(moduleMatch[1]); current = null; continue; }
      if (FILL.test(value) && section.section === 'reading' && module !== null) {
        finish(); startGroup('complete_words', value, line); current._directionLines.push(line); fill = { line, lines: [] }; continue;
      }
      const read = /^Read (?:a|an)\b/i.test(value) && section.section === 'reading';
      const listen = /^Listen to (?:a|an)\b/i.test(value) && section.section === 'listening';
      const response = /^Choose the best response\.?$/i.test(value) && section.section === 'listening';
      if (module !== null && (read || listen || response)) {
        finish();
        const kind = read ? /academic/i.test(value) ? 'read_academic' : 'read_daily' : response ? 'listen_response' : /conversation/i.test(value) ? 'listen_conversation' : /announcement/i.test(value) ? 'listen_announcement' : /talk/i.test(value) ? 'listen_talk' : null;
        if (!kind) { issues.push(issue('error', '此听力材料没有可确认的任务类别，已保留来源。', location(line))); current = null; continue; }
        startGroup(kind, value, line); current._directionLines.push(line);
        if (listen) current._stimulusPage = page.chunk;
        continue;
      }
      const kind = TASK.get(value.toLowerCase());
      if (kind && (section.section === 'writing' ? ['build_sentence', 'write_email', 'academic_discussion'].includes(kind) : section.section === 'speaking' && ['listen_repeat', 'interview'].includes(kind))) {
        finish(); startGroup(kind, value, line); current._directionLines.push(line);
        if (['write_email', 'academic_discussion'].includes(kind)) question = baseQuestion(current, null, line);
        continue;
      }
      if (!current) continue;
      current._pages.add(page.chunk.page);
      if (fill) { fill.lines.push(line); continue; }
      if (['write_email', 'academic_discussion'].includes(current.taskKind)) { question._lines.push(line); continue; }
      const numbered = value.match(NUMBER);
      if (numbered) {
        finishQuestion(); question = baseQuestion(current, Number(numbered[1]), line); question._lines.push({ ...line, text: numbered[2] }); continue;
      }
      const option = value.match(CHOICE);
      if (question?.type === 'single_choice' && option) { activeOption = { id: option[1].toUpperCase(), text: option[2] }; question.options.push(activeOption); continue; }
      if (question) {
        if (activeOption) activeOption.text += `\n${value}`;
        else question._lines.push(line);
      } else current._passageLines.push(line);
    }
  }
  finish();
  return groups.filter(group => {
    if (group.questions.length) return true;
    issues.push(issue('error', '已识别的任务没有可确定的题目，材料仍保留在来源中。', location(group._line))); return false;
  });
}

/** Return null for other formats so the existing ETS/template routes remain intact. */
export function parseTstDocument(chunks, { title = '', mediaNames = [] } = {}) {
  if (!Array.isArray(chunks)) return null;
  const documents = new Map();
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.name !== 'string' || typeof chunk.text !== 'string') return null;
    const pages = documents.get(chunk.name) || []; pages.push(chunk); documents.set(chunk.name, pages);
  }
  const supported = [...documents].filter(([, pages]) => recognizes(pages));
  if (!supported.length) return null;
  const issues = [];
  if (supported.length !== 1) return { pack: { schemaVersion: 1, id: 'publisher-documents-review', version: '1.0.0', title: title || '待复核资料', description: '', rights: '', groups: [] }, issues: [issue('error', '此版式一次仅可转换一份主 PDF，避免混合不同试卷的答案和媒体。')], method: 'exam-document' };
  const [name, pages] = supported[0];
  for (const [otherName, other] of documents) if (otherName !== name && other.some(chunk => chunk.text.trim())) issues.push(issue('error', `附加文档 ${otherName} 尚未转换，请单独处理或先核对其内容。`, otherName));
  const documentHash = digest(pages.map(page => page.text).join('\n')).slice(0, 16);
  const heading = pages.map(page => clean(page.text).match(/^Practice\s+Test\s*#\s*\d+\s*$/mi)?.[0].trim()).find(Boolean);
  const pack = { schemaVersion: 1, id: `workbook-${documentHash}`, version: '1.0.0', title: title.trim() || `${heading || 'Modular Practice'} · ${path.posix.basename(name)}`, description: '从本地分科模块式练习文档生成的待复核草稿。原页码、原题号、答案页与音频链接分别保留；源材料中的不一致不会自动改写。', rights: '', groups: [], examContractVersion: 1, minReaderVersion: '0.3.0', examSets: [] };
  const sections = collectSections(pages);
  const hierarchy = [];
  const usedMedia = new Set();
  const mediaFor = (link, at) => {
    const base = mediaBasename(link.url);
    const candidates = mediaNames.filter(name => path.posix.basename(name.replaceAll('\\', '/')).normalize('NFC') === base?.normalize('NFC'));
    if (candidates.length !== 1) { issues.push(issue('warning', `${candidates.length ? '同名媒体不唯一' : '未选择原 PDF 链接对应的媒体'}：${base || link.url}；未按文件顺序猜测。`, at)); return null; }
    usedMedia.add(candidates[0]); return candidates[0];
  };
  for (const sectionName of ['reading', 'listening', 'writing', 'speaking']) {
    const section = sections.get(sectionName);
    if (!section) continue;
    const objective = ['reading', 'listening'].includes(sectionName) ? readObjectiveKeys(section, issues) : { choices: new Map(), fills: [], transcripts: new Map() };
    const responses = ['writing', 'speaking'].includes(sectionName) ? readResponseKeys(section) : { keys: new Map(), samples: new Map() };
    const groups = parseFront(section, objective, issues);
    const modules = new Map();
    const appliedKeys = new Set();
    const overview = section.front.find(page => /Type of Task\s+Description/i.test(norm(textOf(page.lines))));
    const overviewText = overview ? textOf(overview.lines) : '';
    for (const group of groups) {
      if (!group.passage) group.passage = textOf(group._passageLines);
      const originalPassage = group.passage;
      if (sectionName === 'reading' || group.taskKind === 'listen_repeat') {
        const figures = pages.filter(page => group._pages.has(page.page)).flatMap(page => (page.images || []).map(image => ({ ...image, page: page.page })));
        const candidates = figures.filter(image => {
          const firstQuestion = group.questions.filter(q => q._line.page === image.page && Number.isFinite(q._line.y)).sort((a, b) => b._line.y - a._line.y)[0];
          return firstQuestion && image.rect?.[1] > firstQuestion._line.y + (firstQuestion._line.height || 10);
        });
        if (candidates.length === 1 && mediaNames.includes(candidates[0].name)) {
          group.image = candidates[0].name;
          for (const q of group.questions) q.source += `；题面图像来自 ${name} 第 ${candidates[0].page} 页的独立图像对象`;
        } else if (figures.length) issues.push(issue('warning', '题面图像与本题组的版面归属不能唯一确认，原图保留在来源中，请复核。', `${group.id}.image`));
      }
      group.presentation = { screen: group.taskKind === 'complete_words' ? 'all_questions' : 'one_question', passageVisibility: ['listening', 'speaking'].includes(sectionName) ? 'review' : 'attempt', questionPromptVisibility: ['listen_response', 'interview'].includes(group.taskKind) ? 'review' : 'attempt' };
      const directionsText = textOf(group._directionLines) + (['build_sentence', 'listen_repeat', 'interview'].includes(group.taskKind) && originalPassage ? `\n\n${originalPassage}` : '');
      group.directions = directionsText ? [{ id: `${group.id}-directions`, text: directionsText, audio: null, source: location(group._line), basis: 'document', verifiedContent: false }] : [];
      if (['listen_conversation', 'listen_announcement', 'listen_talk'].includes(group.taskKind)) {
        group.directions[0].text = `${group.directions[0].text}\n\n${originalPassage}`.trim();
        const links = (group._stimulusPage?.links || []).filter(link => mediaBasename(link.url));
        if (links.length === 1) { group.audio = mediaFor(links[0], `${group.id}.audio`); group._audioSource = `${name} · 第 ${group._stimulusPage.page} 页 · PDF 音频链接 ${links[0].url}`; }
        else issues.push(issue('warning', '听力材料页没有唯一音频链接，未按文件名或排序猜测。', `${group.id}.audio`));
      }
      const questionLinks = new Set();
      for (const q of group.questions) {
        if (['read_daily', 'read_academic', 'listen_response', 'listen_conversation', 'listen_announcement', 'listen_talk'].includes(group.taskKind)) {
          const keyId = `${scope(sectionName, group._module)}:${q._number}`;
          const key = uniqueEntry(objective.choices.get(keyId), issues, `${q.id}.answer`);
          if (key) { q.answer = key.answer; q.explanation = key.explanation; q.source += `；答案来自 ${location(key.line)}`; q._taskKey = key.taskKey; if (key.transcript) q.transcript = key.transcript; appliedKeys.add(keyId); }
          if (group.taskKind === 'listen_response' && !q.prompt) q.prompt = 'Choose the best response.';
          if (sectionName === 'reading') insertionInteraction(group, q, issues);
          if (!q.interaction && (q.options.length < 2 || new Set(q.options.map(option => option.id)).size !== q.options.length)) issues.push(issue('error', '此题选项缺失或重复，请对照原题确认。', `${q.id}.options`));
          if (q.answer && !q.interaction && !q.options.some(option => option.id === q.answer)) { q.answer = null; issues.push(issue('warning', '答案键不对应本题选项，已保留为未评分。', `${q.id}.answer`)); }
        } else if (group.taskKind === 'build_sentence') {
          const raw = trimLines(q._lines), frameIndex = raw.findIndex(line => /_{2,}/.test(line.text)), optionsIndex = raw.findIndex((line, index) => index > frameIndex && line.text.includes('/'));
          if (frameIndex < 0 || optionsIndex < 0) issues.push(issue('error', '句框或词块边界无法确认，未猜测排序题。', q.id));
          else {
            q.sentenceFrame = textOf(raw.slice(frameIndex, optionsIndex)); q.answerSlots = (q.sentenceFrame.match(/_{2,}/g) || []).length;
            q.options = norm(textOf(raw.slice(optionsIndex))).split(/\s*\/\s*/).map((text, index) => ({ id: `F${index + 1}`, text }));
            q.prompt = textOf(raw.slice(0, frameIndex));
            const key = uniqueEntry(responses.keys.get(`build_sentence:${q._number}`), issues, `${q.id}.answer`);
            if (key) { q.source += `；答案来自 ${location(key.line)}`; q.explanation = key.text; q.answer = sentenceAnswer(q.sentenceFrame, q.options, key.text); if (!q.answer) issues.push(issue('warning', '源材料的完整答案无法唯一填入原句框和词块；未按答案修改空位，此题暂不评分。', `${q.id}.answer`)); }
          }
        } else if (['listen_repeat', 'interview'].includes(group.taskKind)) {
          const key = uniqueEntry(responses.keys.get(`${group.taskKind}:${q._number}`), issues, `${q.id}.transcript`, '题目转录');
          if (key) { q.transcript = key.text; q.source += `；转录来自 ${location(key.line)}`; if (group.taskKind === 'listen_repeat') q.answer = key.text; else q.explanation = key.sample; }
          q.prompt = group.taskKind === 'listen_repeat' ? 'Listen and repeat only once.' : 'Take an Interview';
        }
        if (['listen_response', 'listen_repeat', 'interview'].includes(group.taskKind)) {
          const page = pages.find(page => page.page === q._line.page);
          const links = (page?.links || []).filter(link => mediaBasename(link.url) && Number.isFinite(q._line.y) && link.rect?.length === 4 && link.rect[1] <= q._line.y + (q._line.height || 10) && link.rect[3] >= q._line.y - 2);
          if (links.length === 1) { q.audio = mediaFor(links[0], `${q.id}.audio`); questionLinks.add(links[0].url); q.source += `；本题音频来自原页链接 ${links[0].url}`; }
          else issues.push(issue('warning', '题号与原 PDF 音频图标不能唯一对应，未按文件顺序关联。', `${q.id}.audio`));
        }
        if (group._audioSource) q.source += `；共用材料 ${group._audioSource}`;
      }
      if (group.taskKind === 'listen_repeat') {
        const remaining = pages.filter(page => group._pages.has(page.page)).flatMap(page => (page.links || []).map(link => ({ ...link, page: page.page }))).filter(link => mediaBasename(link.url) && !questionLinks.has(link.url));
        if (remaining.length === 1 && /directions/i.test(mediaBasename(remaining[0].url))) {
          const direction = group.directions[0]; direction.audio = mediaFor(remaining[0], `${group.id}.directions`); direction.source += `；第 ${remaining[0].page} 页 PDF 说明链接 ${remaining[0].url}`;
        }
      }
      if (['listen_conversation', 'listen_announcement', 'listen_talk'].includes(group.taskKind)) {
        const taskKeys = new Set(group.questions.map(q => q._taskKey));
        if (taskKeys.size === 1 && [...taskKeys][0]) {
          const transcript = uniqueEntry(objective.transcripts.get([...taskKeys][0]), issues, `${group.id}.transcript`, '共用材料转录');
          if (transcript) { group.transcript = transcript.text; for (const q of group.questions) q.source += `；共用转录来自 ${transcript.source}`; }
        }
      }
      if (['listening', 'speaking'].includes(sectionName)) group.passage = '';
      if (group.taskKind === 'build_sentence') {
        const match = norm(`${directionsText}\n${overviewText}`).match(/(?:have|given)\s+(\d+)\s+minutes?\s+to complete (?:the )?(?:Build a Sentence|\d+ questions)/i);
        group.timing = timing('task', match ? Number(match[1]) * 60 : null, match ? location(group._line) : '');
        group.passage = '';
      } else if (['write_email', 'academic_discussion'].includes(group.taskKind)) {
        const q = group.questions[0];
        const minutes = norm(q.prompt).match(/(?:have|given)\s+(\d+)\s+minutes?\s+to (?:read and )?write/i);
        group.timing = timing('task', minutes ? Number(minutes[1]) * 60 : null, minutes ? q.source : '');
        const sample = responses.samples.get(`${group.taskKind}:`);
        if (sample?.length === 1) q.explanation = `作者示例回答\n\n${sample[0].text}`;
        if (group.taskKind === 'write_email') {
          const to = q.prompt.match(/^To:\s*(.+)$/mi)?.[1], subject = q.prompt.match(/^Subject:\s*(.+)$/mi)?.[1];
          if (to && subject) group.presentation.email = { to, subject, body: q.prompt.split(/^Your Response:\s*$/mi)[0].trim(), instructions: '' };
          else issues.push(issue('warning', '邮件收件人与主题无法独立核对，保留原题全文。', `${group.id}.presentation.email`));
        } else {
          const discussion = discussionLayout(group, pages);
          if (discussion) group.presentation.discussion = discussion;
          else issues.push(issue('warning', '讨论题的姓名与发言几何布局无法唯一确认，保留原题全文。', `${group.id}.presentation.discussion`));
        }
      } else if (['listen_repeat', 'interview'].includes(group.taskKind)) {
        const noPreparation = /no time for preparation|not be given any time to prepare/i.test(directionsText);
        const seconds = group.taskKind === 'interview' ? norm(directionsText).match(/have\s+(\d+)\s+seconds\s+to respond to each/i)?.[1] : null;
        group.timing = timing('question', seconds ? Number(seconds) : null, seconds || noPreparation ? location(group._line) : '', noPreparation ? 0 : null);
      } else group.timing = timing('inherit_module');
      if (group.taskKind === 'complete_words') {
        group.inlineBlanks = createInlineBlanks(group);
        if (!group.inlineBlanks) issues.push(issue('error', '缺字控件无法对应每一个原文空位。', `${group.id}.inlineBlanks`));
      }
      if (['read_daily', 'read_academic'].includes(group.taskKind) && group.passage) group.presentation.document = { kind: group.taskKind === 'read_academic' ? 'academic' : /email/i.test(group.title) ? 'email' : 'plain', title: '', blocks: [{ kind: 'paragraph', text: group.passage }] };
      if (['read_daily', 'read_academic'].includes(group.taskKind) && !group.passage && !group.image) issues.push(issue('error', '阅读题组缺少可恢复的正文或题面图像，请对照原 PDF 补充。', `${group.id}.passage`));
      // The workbook restarts Speaking numbering for each task. Keep those
      // printed numbers and use unnumbered execution groups, rather than invent
      // printed question 8–11 or violate the module's unique-number contract.
      const internalSpeaking = sectionName === 'speaking' && group._module === null;
      const moduleId = `${sectionName}-${internalSpeaking ? group.taskKind : group._module === null ? 'main' : `m${group._module}`}`;
      if (!modules.has(moduleId)) modules.set(moduleId, { id: moduleId, title: internalSpeaking ? group.title : `${label(sectionName)}${group._module === null ? '' : ` · Module ${group._module}`}`, sourceNumber: group._module, taskIds: [], timing: timing(sectionName === 'reading' ? 'module' : ['listening', 'speaking'].includes(sectionName) ? 'question' : 'none'), navigation: navigation(sectionName), instructions: { text: overviewText, audio: null, source: overview ? `${name} · 第 ${overview.chunk.page} 页` : '', basis: 'document', verifiedContent: false } });
      modules.get(moduleId).taskIds.push(group.id);
      for (const q of group.questions) for (const key of Object.keys(q)) if (key.startsWith('_')) delete q[key];
      for (const key of Object.keys(group)) if (key.startsWith('_')) delete group[key];
      pack.groups.push(group);
    }
    for (const [keyId, keys] of objective.choices) if (!appliedKeys.has(keyId)) issues.push(issue('error', '此答案题号没有对应到本科目与模块的题目，可能存在尚未识别的内容。', location(keys[0].line)));
    if (modules.size) hierarchy.push({ id: sectionName, section: sectionName, title: label(sectionName), modules: [...modules.values()] });
  }
  pack.examSets = [{ id: `set-${documentHash}`, title: pack.title, sections: hierarchy }];
  for (const section of hierarchy) for (const module of section.modules) if (['reading', 'listening'].includes(section.section)) issues.push(issue('warning', '原文没有明确的模块/逐题固定时长；文档计时信息留空，练习可选择软件预设。', `${module.id}.timing`));
  for (const group of pack.groups) if (group.timing.scope === 'question' && group.timing.durationSeconds === null) issues.push(issue('warning', '原文仅给出响应时间范围，未把统一值伪装成逐题时限；练习可选择软件预设。', `${group.id}.timing`));
  issues.push(issue('warning', '已按分科模块式文档转换；请复核源文件不一致提示、题面图片、讨论发言、答案和配套音频。独立题面图像由原 PDF 像素提取，其他页面视觉元素仍在原件中。', 'pack'));
  return { pack, issues, method: 'exam-document', recognition: pack.groups.some(g => g.questions.length) ? 'recognized' : 'recognized_empty' };
}
