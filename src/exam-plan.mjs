import { createHash } from 'node:crypto';
import path from 'node:path';

export const EXAM_TASK_KINDS = Object.freeze([
  'complete_words', 'read_daily', 'read_academic', 'listen_response',
  'listen_conversation', 'listen_announcement', 'listen_talk', 'build_sentence',
  'write_email', 'academic_discussion', 'listen_repeat', 'interview',
]);
const KINDS = new Set(EXAM_TASK_KINDS);
const SECTIONS = new Set(['reading', 'listening', 'writing', 'speaking']);
const KIND_TYPE = Object.freeze({ complete_words: 'fill_blank', read_daily: 'single_choice', read_academic: 'single_choice', listen_response: 'single_choice', listen_conversation: 'single_choice', listen_announcement: 'single_choice', listen_talk: 'single_choice', build_sentence: 'sentence_order', write_email: 'email', academic_discussion: 'discussion', listen_repeat: 'listen_repeat', interview: 'interview' });
const KIND_SECTION = Object.freeze(Object.fromEntries(EXAM_TASK_KINDS.map(kind => [kind, kind.startsWith('read_') || kind === 'complete_words' ? 'reading' : ['listen_response', 'listen_conversation', 'listen_announcement', 'listen_talk'].includes(kind) ? 'listening' : ['build_sentence', 'write_email', 'academic_discussion'].includes(kind) ? 'writing' : 'speaking'])));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
const titleFor = section => ({ reading: 'Reading', listening: 'Listening', writing: 'Writing', speaking: 'Speaking' })[section] || section;
const plainIssue = (severity, message, at = '') => ({ severity, message, path: at });
const planError = message => Object.assign(new Error(message), { name: 'InputError', status: 400 });
const unknownTiming = scope => ({ scope, durationSeconds: null, prepareSeconds: null, basis: 'unknown', source: '' });
const emptyInstructions = () => ({ text: '', audio: null, source: '', basis: 'user', verifiedContent: false });
const safePlanId = (prefix, value) => `${prefix}-${hash(value).slice(0, 24)}`;
const sectionClockScope = section => section === 'reading' ? 'module' : section === 'listening' || section === 'speaking' ? 'question' : 'none';
const sectionNavigation = section => section === 'reading' ? { back: 'module', review: 'module', lockOnAdvance: true } : section === 'listening' || section === 'speaking' ? { back: 'none', review: 'none', lockOnAdvance: true } : { back: 'task', review: 'task', lockOnAdvance: true };

function sourceNumber(question) {
  if (Number.isInteger(question.localNumber) && question.localNumber > 0) return question.localNumber;
  const explicit = String(question.source || '').match(/原题号\s+(\d+)/);
  return explicit ? Number(explicit[1]) : null;
}

/** Recognize our earlier converter's full ID/provenance contract, not titles alone. */
export function isLegacyModularExam(pack) {
  if (!record(pack) || !/^exam-[a-f0-9]{16}$/.test(pack.id || '') || !Array.isArray(pack.groups) || !pack.groups.length) return false;
  let hasModule = false;
  return pack.groups.every(group => {
    const match = String(group.id || '').match(/^(reading|listening)-m(\d+)-g\d+$|^(writing|speaking)-g\d+$/);
    if (!match || group.section !== (match[1] || match[3]) || !Array.isArray(group.questions) || !group.questions.length) return false;
    if (match[2]) hasModule = true;
    return group.questions.every(question => {
      if (!/\.pdf\s*·\s*第\s+\d+\s+页\s*·\s*第\s+\d+\s+行/i.test(question.source || '')) return false;
      if (match[2]) return new RegExp(`^${group.section}-m${match[2]}-q\\d+$`).test(question.id || '') && sourceNumber(question) !== null;
      return new RegExp(`^${group.section}-(?:sentence|email|discussion|repeat|interview)-q\\d+$`).test(question.id || '');
    });
  }) && hasModule;
}

function kindFor(group, question = group.questions?.[0], known = false) {
  if (KINDS.has(group.taskKind)) return group.taskKind;
  const type = question?.type;
  if (type === 'fill_blank') return 'complete_words';
  if (type === 'sentence_order') return 'build_sentence';
  if (type === 'email') return 'write_email';
  if (type === 'discussion') return 'academic_discussion';
  if (type === 'listen_repeat') return 'listen_repeat';
  if (type === 'interview') return 'interview';
  if (group.section === 'reading') return known && !/\bRead (?:a|an)\b/i.test(group.title || '') ? 'read_academic' : 'read_daily';
  if (group.section === 'listening') {
    if (known && /\bconversation\b/i.test(group.title || '')) return 'listen_conversation';
    if (known && /\bannouncement\b/i.test(group.title || '')) return 'listen_announcement';
    if (known && /\b(?:talk|podcast)\b/i.test(group.title || '')) return 'listen_talk';
    return 'listen_response';
  }
  return 'read_daily';
}

/** Exact paragraph anchors; no answer text is used to discover the positions. */
export function createInlineBlanks(group, { allowHyphens = false } = {}) {
  if (typeof group?.passage !== 'string' || !Array.isArray(group.questions) || !group.questions.length || !group.questions.every(question => question.type === 'fill_blank')) return null;
  const pattern = allowHyphens ? /([A-Za-z]+)((?:\s*[_-])+(?![A-Za-z]))/g : /([A-Za-z]*)((?:[ \t]*_)+)/g;
  const matches = [...group.passage.matchAll(pattern)];
  if (matches.length !== group.questions.length) return null;
  const anchors = matches.map((match, index) => ({
    questionId: group.questions[index].id,
    localNumber: sourceNumber(group.questions[index]),
    prefixStart: match.index, prefixEnd: match.index + match[1].length,
    start: match.index + match[1].length, end: match.index + match[0].length,
    missingLetterCount: (match[2].match(/[_-]/g) || []).length,
    prefix: match[1], rawGap: match[2], source: group.questions[index].source || '',
  }));
  if (anchors.some(anchor => !anchor.missingLetterCount || anchor.missingLetterCount > 100)) return null;
  return { textField: 'passage', offsetUnit: 'utf16', answerMode: 'missing_letters', textHash: hash(group.passage), anchors };
}

function moduleNumberFor(pack, group) {
  const declared = [];
  for (const set of pack.examSets || []) for (const section of set.sections || []) for (const module of section.modules || []) if (module.taskIds?.includes(group.id) && section.section === group.section) declared.push(module.sourceNumber);
  if (declared.length) return new Set(declared).size === 1 ? declared[0] : null;
  const match = isLegacyModularExam(pack) ? group.id.match(/^(?:reading|listening)-m(\d+)-g\d+$/) : null;
  return match ? Number(match[1]) : null;
}

/** Match instructions only when section, source module, task and range agree. */
export function matchExamDirections(pack, mediaCatalog = []) {
  const issues = [];
  const candidates = [];
  const known = isLegacyModularExam(pack);
  for (const supplied of Array.isArray(mediaCatalog) ? mediaCatalog : []) {
    const item = typeof supplied === 'string' ? { name: supplied } : supplied;
    if (!record(item) || typeof item.name !== 'string' || !/\.(?:ogg|mp3|wav|m4a|mp4|webm)$/i.test(item.name)) continue;
    const stem = path.posix.basename(item.name.replaceAll('\\', '/')).replace(/\.[^.]+$/, '');
    const listening = stem.match(/^Listening(?:[ _-]*Module)?[ _-]*(\d+)[ _-]+(.+?)[ _-]+Directions[ _-]*(\d+)[-–](\d+)$/i);
    const speaking = stem.match(/^Speaking[ _-]+(Listen[ _-]+Repeat|Interview)[ _-]+Directions$/i);
    let matches = [];
    if (listening) {
      const label = listening[2].replace(/[_-]/g, ' ').toLowerCase().trim();
      const kind = /^conversations?$/.test(label) ? 'listen_conversation' : /^announcements?$/.test(label) ? 'listen_announcement' : /^academic talks?$/.test(label) ? 'listen_talk' : null;
      if (kind) matches = (pack.groups || []).filter(group => group.section === 'listening' && kindFor(group, undefined, known) === kind && moduleNumberFor(pack, group) === Number(listening[1]) && group.questions?.length === Number(listening[4]) - Number(listening[3]) + 1 && group.questions.every((question, index) => sourceNumber(question) === Number(listening[3]) + index));
    } else if (speaking) {
      const kind = /^interview$/i.test(speaking[1]) ? 'interview' : 'listen_repeat';
      matches = (pack.groups || []).filter(group => group.section === 'speaking' && kindFor(group, undefined, known) === kind);
    } else continue;
    if (matches.length !== 1) {
      issues.push(plainIssue('warning', `${item.name} 的任务说明音频未能唯一对应科目、模块、任务与题号范围，未自动关联。`, item.name)); continue;
    }
    candidates.push({ groupId: matches[0].id, direction: { id: safePlanId('direction', `${matches[0].id}\0${item.name}`), text: '', audio: typeof item.url === 'string' ? item.url : item.name, source: item.name, basis: 'filename', verifiedContent: false } });
  }
  const count = new Map();
  for (const candidate of candidates) count.set(candidate.groupId, (count.get(candidate.groupId) || 0) + 1);
  const matches = candidates.filter(candidate => {
    if (count.get(candidate.groupId) === 1) return true;
    issues.push(plainIssue('warning', `${candidate.direction.source} 与其他文件同时对应同一任务说明，未自动选择。`, candidate.direction.source)); return false;
  });
  return { matches, issues };
}

function documentTiming(group, kind) {
  const text = [group.passage, group.transcript, ...(group.questions || []).map(question => question.prompt)].filter(Boolean).join('\n');
  const source = group.questions?.[0]?.source || '';
  if (kind === 'write_email' || kind === 'academic_discussion') {
    const minutes = text.match(/You will have\s+(\d+)\s+minutes?\s+to\s+write/i);
    const seconds = minutes ? Number(minutes[1]) * 60 : null;
    return { ...unknownTiming('task'), durationSeconds: seconds && seconds <= 7200 ? seconds : null, basis: seconds ? 'document' : 'unknown', source: seconds ? source : '' };
  }
  if (kind === 'build_sentence') return unknownTiming('task');
  if (kind === 'listen_repeat' || kind === 'interview') {
    const zero = /No time for preparation will be provided\./i.test(text);
    return { ...unknownTiming('question'), prepareSeconds: zero ? 0 : null, basis: zero ? 'document' : 'unknown', source: zero ? source : '' };
  }
  return unknownTiming('inherit_module');
}

function instructionPrefix(group, kind) {
  const source = group.questions?.[0]?.source || '';
  const passage = group.passage || '';
  if (['complete_words', 'write_email', 'academic_discussion'].includes(kind)) {
    const first = String(group.questions?.[0]?.prompt || '').split('\n')[0];
    return { ...emptyInstructions(), text: first, source, basis: 'document' };
  }
  if (['build_sentence', 'listen_repeat', 'interview'].includes(kind)) return { ...emptyInstructions(), text: passage, source, basis: 'document' };
  const first = passage.split('\n')[0];
  return { ...emptyInstructions(), text: /^(?:Read (?:a|an)|Listen to (?:a|an)|Choose the best response)\b/i.test(first) ? first : '', source, basis: 'document' };
}

function readingDocument(group, kind) {
  if (!['read_daily', 'read_academic'].includes(kind) || !group.passage?.trim()) return null;
  const lines = group.passage.split('\n');
  const first = lines[0];
  const cue = /^Read (?:a|an)\b/i.test(first) ? lines.shift() : '';
  const format = kind === 'read_academic' ? 'academic' : /email/i.test(cue) ? 'email' : /social media/i.test(cue) ? 'social_post' : /notice/i.test(cue) ? 'notice' : 'plain';
  const blocks = [];
  const rows = [];
  if (format === 'email') while (lines.length) {
    const field = lines[0].match(/^(To|From|Date|Subject):\s*(.*)$/i);
    if (!field) break;
    rows.push([field[1], field[2]]); lines.shift();
  }
  if (rows.length) blocks.push({ kind: 'table', rows });
  let title = '';
  if (!rows.length && lines[0] && lines[0].length <= 180 && !/[.!?]$/.test(lines[0])) {
    title = lines.shift(); blocks.push({ kind: 'heading', text: title });
  }
  const body = lines.join('\n').trim();
  if (body) blocks.push({ kind: 'paragraph', text: body });
  return blocks.length ? { kind: format, title, blocks } : null;
}

function emailPresentation(question) {
  const text = question.prompt || '';
  const to = text.match(/^To:\s*(.+)$/mi)?.[1];
  const subject = text.match(/^Subject:\s*(.+)$/mi)?.[1];
  if (to === undefined || subject === undefined) return null;
  const beforeResponse = text.split(/^Your Response:\s*$/mi)[0].trim();
  const lines = beforeResponse.split('\n');
  const timeIndex = lines.findIndex(line => /^You will have\s+\d+\s+minutes?\s+to\s+write/i.test(line));
  return { to, subject, instructions: timeIndex >= 0 ? lines.slice(0, timeIndex + 1).join('\n') : '', body: (timeIndex >= 0 ? lines.slice(timeIndex + 1).join('\n') : beforeResponse).trim() };
}

function layoutLines(chunk) {
  if (!record(chunk.layout) || !Array.isArray(chunk.layout.items)) return null;
  const lines = [];
  for (const item of chunk.layout.items) {
    if (typeof item.str !== 'string' || !item.str.trim() || !Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
    let line = lines.find(candidate => Math.abs(candidate.y - item.y) < 2);
    if (!line) { line = { x: item.x, y: item.y, items: [] }; lines.push(line); }
    line.x = Math.min(line.x, item.x); line.items.push(item);
  }
  return lines.sort((a, b) => b.y - a.y).map(line => ({ x: line.x, y: line.y, text: line.items.sort((a, b) => a.x - b.x).map(item => item.str.trim()).join(' ') }));
}

/** Uses paragraph geometry plus the printed task directions, never prose sentiment. */
function discussionPresentation(group, chunks) {
  const q = group.questions?.[0];
  if (!q) return null;
  const candidates = chunks.filter(chunk => /^Write for an Academic Discussion\s*$/mi.test(chunk.text) && normalized(chunk.text).includes(normalized(q.prompt)));
  if (candidates.length !== 1) return null;
  const lines = layoutLines(candidates[0]);
  if (!lines) return null;
  const endInstruction = lines.findIndex(line => /^An effective response will contain at least\s+\d+\s+words\.$/i.test(line.text));
  if (endInstruction < 0) return null;
  const body = lines.slice(endInstruction + 1).filter(line => !/^(?:.+?\s+)?(?:Practice|Sample|Mock)\s+Test\s+\d+\s+\d+$/i.test(line.text));
  if (body.length < 5) return null;
  const left = body[0].x;
  const firstStudent = body.findIndex(line => line.x - left >= 24);
  if (firstStudent < 1 || body.slice(0, firstStudent).some(line => Math.abs(line.x - left) > 3)) return null;
  const studentLines = body.slice(firstStudent);
  if (studentLines.some(line => Math.abs(line.x - studentLines[0].x) > 3)) return null;
  const distances = studentLines.slice(1).map((line, index) => studentLines[index].y - line.y).filter(gap => gap > 0).sort((a, b) => a - b);
  const leading = distances[Math.floor(distances.length / 2)];
  if (!leading || leading > 35) return null;
  const posts = [];
  for (let index = 0; index < studentLines.length; index++) {
    const line = studentLines[index];
    if (!posts.length || studentLines[index - 1].y - line.y > leading * 1.55) posts.push({ speaker: `Student ${posts.length + 1}`, text: '' });
    const post = posts.at(-1); post.text += `${post.text ? '\n' : ''}${line.text}`;
  }
  if (posts.length !== 2) return null;
  const prompt = body.slice(0, firstStudent).map(line => line.text).join('\n');
  const instructions = lines.slice(0, endInstruction + 1).map(line => line.text).join('\n');
  if (![prompt, instructions, ...posts.map(post => post.text)].every(text => normalized(candidates[0].text).includes(normalized(text)))) return null;
  return { prompt, posts, instructions };
}

function moduleInstructions(chunks, section, number) {
  const pattern = new RegExp(`^${titleFor(section)} Section${number === null ? '' : `, Module ${number}`}\\s*$`, 'mi');
  const chunk = chunks.find(item => pattern.test(item.text) && !/^Answer Key\s*$/mi.test(item.text));
  if (!chunk) return emptyInstructions();
  const lines = chunk.text.split('\n').filter(line => !pattern.test(line) && !/^(?:.+?\s+)?(?:Practice|Sample|Mock)\s+Test\s+\d+\s+\d+$/i.test(line.trim()));
  return { text: lines.join('\n').trim(), audio: null, source: `${chunk.name} · 第 ${chunk.page} 页`, basis: 'document', verifiedContent: false };
}

function knownHierarchy(pack, chunks = []) {
  const sections = [];
  for (const group of pack.groups) {
    let section = sections.find(item => item.section === group.section);
    if (!section) { section = { id: group.section, section: group.section, title: titleFor(group.section), modules: [] }; sections.push(section); }
    const match = group.id.match(/^(?:reading|listening)-m(\d+)-g\d+$/);
    const number = match ? Number(match[1]) : null;
    const id = match ? `${group.section}-m${number}` : `${group.section}-main`;
    let module = section.modules.find(item => item.id === id);
    if (!module) {
      const instructions = moduleInstructions(chunks, group.section, number);
      const scope = sectionClockScope(group.section);
      const navigation = sectionNavigation(group.section);
      module = { id, title: number === null ? titleFor(group.section) : `${titleFor(group.section)} · Module ${number}`, sourceNumber: number, timing: { ...unknownTiming(scope), basis: instructions.text ? 'document' : 'unknown', source: instructions.source }, navigation, instructions, taskIds: [] };
      section.modules.push(module);
    }
    module.taskIds.push(group.id);
  }
  return [{ id: safePlanId('set', pack.id), title: pack.title, sections }];
}

/** Enrich only a newly produced converter draft; caller decides whether to persist. */
export function addExamDocumentMetadata(input, { chunks = [], mediaCatalog = [] } = {}) {
  const pack = structuredClone(input);
  const issues = [];
  if (!pack.groups?.length) return { pack, issues };
  for (const group of pack.groups) {
    const kind = kindFor(group, undefined, true);
    const directions = instructionPrefix(group, kind);
    group.taskKind = kind;
    group.presentation = { screen: kind === 'complete_words' ? 'all_questions' : 'one_question', passageVisibility: group.section === 'listening' ? 'review' : 'attempt', questionPromptVisibility: kind === 'listen_response' || kind === 'interview' ? 'review' : 'attempt', ...(group.presentation || {}) };
    group.timing ||= documentTiming(group, kind);
    group.directions ||= directions.text ? [{ id: safePlanId('direction-text', group.id), ...directions }] : [];
    group.questions.forEach((question, index) => { question.localNumber = sourceNumber(question); question.ordinalInTask = index + 1; });
    if (kind === 'complete_words') {
      const inline = createInlineBlanks(group, { allowHyphens: true });
      if (inline) group.inlineBlanks = inline;
      else issues.push(plainIssue('error', `${group.title} 的段落空位无法逐一定位，不能生成同屏补字任务。`, `${group.id}.inlineBlanks`));
    }
    const document = readingDocument(group, kind);
    if (document) group.presentation.document = document;
    if (kind === 'write_email') {
      const email = emailPresentation(group.questions[0]);
      if (email) group.presentation.email = email;
    }
    if (kind === 'academic_discussion') {
      const discussion = discussionPresentation(group, chunks);
      if (discussion) group.presentation.discussion = discussion;
      else issues.push(plainIssue('warning', `${group.title} 未取得可核对的发言布局，保留完整文字；不会凭段落内容猜测教授与学生的角色边界。`, `${group.id}.presentation.discussion`));
    }
    if (group.section === 'listening') {
      group.transcript ||= group.passage;
      group.passage = '';
    }
    if (kind === 'listen_response' || kind === 'interview') for (const question of group.questions) {
      question.transcript ||= question.prompt;
      question.prompt = kind === 'listen_response' ? directions.text || 'Choose the best response.' : 'Take an Interview';
    }
    if (kind === 'listen_repeat') for (const question of group.questions) question.transcript = typeof question.answer === 'string' ? question.answer : '';
  }
  pack.examSets = knownHierarchy(pack, chunks);
  pack.examContractVersion = 1;
  pack.minReaderVersion = pack.schemaVersion===2?'0.5.0':'0.3.0';
  const matched = matchExamDirections(pack, mediaCatalog);
  issues.push(...matched.issues);
  for (const { groupId, direction } of matched.matches) {
    pack.groups.find(group => group.id === groupId).directions.push(direction);
    issues.push(plainIssue('warning', `${direction.source} 已依文件名关联到任务说明阶段，尚未试听核实。`, `${groupId}.directions`));
  }
  return { pack, issues };
}

function effectiveTiming(value, inherited) {
  if (!record(value) || value.scope === 'inherit_module') return { ...(inherited || unknownTiming('none')) };
  return { scope: ['module', 'task', 'question', 'none'].includes(value.scope) ? value.scope : 'none', durationSeconds: Number.isInteger(value.durationSeconds) && value.durationSeconds > 0 ? value.durationSeconds : null, prepareSeconds: Number.isInteger(value.prepareSeconds) && value.prepareSeconds >= 0 ? value.prepareSeconds : null, basis: ['document', 'user', 'preset', 'unknown'].includes(value.basis) ? value.basis : 'unknown', source: typeof value.source === 'string' ? value.source : '' };
}

function genericHierarchy(pack) {
  const sections = [];
  for (const group of pack.groups || []) {
    let section = sections.find(item => item.section === group.section);
    if (!section) { section = { id: group.section, section: group.section, title: titleFor(group.section), modules: [] }; sections.push(section); }
    section.modules.push({ id: safePlanId('legacy-module', group.id), title: group.title, sourceNumber: null, taskIds: [group.id], timing: unknownTiming(sectionClockScope(group.section)), navigation: sectionNavigation(group.section), instructions: emptyInstructions() });
  }
  return [{ id: safePlanId('legacy-set', pack.id || pack.title || 'practice'), title: pack.title || 'Practice', sections }];
}

/** Pure runtime projection. Legacy normalized JSON and its content hash stay intact. */
export function buildExamPlan(input, { setId, sectionId, groupId, mediaCatalog = [] } = {}) {
  if (!record(input) || !Array.isArray(input.groups) || !input.groups.length) throw planError('练习包没有可运行的题目。');
  let pack = input;
  const known = isLegacyModularExam(input);
  if (!Array.isArray(input.examSets) && known) pack = addExamDocumentMetadata(input, { mediaCatalog }).pack;
  const sets = Array.isArray(pack.examSets) && pack.examSets.length ? pack.examSets : genericHierarchy(pack);
  const set = setId ? sets.find(candidate => candidate.id === setId) : sets[0];
  if (!set) throw planError('找不到指定的练习套题。');
  const byGroup = new Map(pack.groups.map(group => [group.id, group]));
  const overlays = matchExamDirections(pack, mediaCatalog).matches;
  const sections = [];
  const moduleIds = new Set();
  const taskIds = new Set();
  const questionIds = new Set();
  for (const rawSection of set.sections || []) {
    if (sectionId && rawSection.id !== sectionId && rawSection.section !== sectionId) continue;
    const section = { id: rawSection.id, section: rawSection.section, title: rawSection.title || titleFor(rawSection.section), modules: [] };
    for (const rawModule of rawSection.modules || []) {
      const selected = (rawModule.taskIds || []).map(id => byGroup.get(id)).filter(group => group && (!groupId || group.id === groupId));
      if (!selected.length) continue;
      if (moduleIds.has(rawModule.id)) throw planError('练习计划中的模块 ID 重复。');
      moduleIds.add(rawModule.id);
      const module = { id: rawModule.id, title: rawModule.title || section.title, sourceNumber: rawModule.sourceNumber ?? null, timing: effectiveTiming(rawModule.timing), navigation: structuredClone(rawModule.navigation || { back: 'task', review: 'task', lockOnAdvance: false }), instructions: { ...emptyInstructions(), ...structuredClone(rawModule.instructions || {}) }, tasks: [] };
      let number = 0;
      for (const group of selected) {
        const segments = [];
        for (const question of group.questions || []) {
          const kind = kindFor(group, question, known);
          if (!segments.length || segments.at(-1).kind !== kind) segments.push({ kind, questions: [] });
          segments.at(-1).questions.push(question);
        }
        for (let si = 0; si < segments.length; si++) {
          const segment = segments[si];
          for (const question of segment.questions) {
            if (questionIds.has(question.id)) throw planError('同一次练习计划不能重复引用同一个题目 ID。');
            questionIds.add(question.id);
          }
          const id = segments.length === 1 ? group.id : safePlanId('task', `${group.id}\0${si}`);
          if (taskIds.has(id)) throw planError('练习计划中的任务 ID 重复。');
          taskIds.add(id);
          const presentation = { screen: 'one_question', passageVisibility: 'attempt', questionPromptVisibility: 'attempt', ...structuredClone(group.presentation || {}) };
          const subset = { ...group, questions: segment.questions };
          const inline = group.inlineBlanks ? structuredClone(group.inlineBlanks) : segment.kind === 'complete_words' ? createInlineBlanks(subset, { allowHyphens: known }) : null;
          if (inline && segments.length > 1) inline.anchors = inline.anchors.filter(anchor => segment.questions.some(question => question.id === anchor.questionId));
          if (inline) presentation.screen = 'all_questions';
          else if (presentation.screen === 'all_questions' && segment.kind === 'complete_words') presentation.screen = 'one_question';
          const directions = structuredClone(group.directions || []);
          for (const overlay of overlays.filter(item => item.groupId === group.id)) if (!directions.some(direction => direction.audio === overlay.direction.audio || direction.source === overlay.direction.source)) directions.push(overlay.direction);
          const timing = effectiveTiming(group.timing || documentTiming(subset, segment.kind), module.timing);
          module.tasks.push({ id, kind: segment.kind, groupId: group.id, questionIds: segment.questions.map(question => question.id), ...(pack.schemaVersion===2?{sourcePositionsV1:Object.fromEntries(segment.questions.map(question=>[question.id,structuredClone(question.sourcePositionV1)]))}:{}), screen: presentation.screen, numberStart: number + 1, numberEnd: number + segment.questions.length, timing, directions, inlineBlanks: inline, presentation });
          number += segment.questions.length;
        }
      }
      section.modules.push(module);
    }
    if (section.modules.length) sections.push(section);
  }
  if (!sections.length) throw planError('指定科目或题组没有可运行的任务。');
  return { version: 1, id: set.id, title: set.title || pack.title, ...(pack.coverageV1?{coverageV1:structuredClone(pack.coverageV1)}:{}), sections };
}

/** Normalize only explicitly present v0.3 metadata. Never enrich a legacy pack. */
export function normalizeExamExtensions(rawPack, pack, { issue, mediaPath }) {
  const has = (object, key) => Object.hasOwn(object || {}, key);
  const object = (value, allowed, at) => {
    if (!record(value)) { issue('error', '此机考配置必须是对象，不能为 null。', at); return {}; }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) issue('error', `不支持的机考配置字段：${key}。`, `${at}.${key}`);
    return value;
  };
  const text = (value, at, { required = false, max = 100000 } = {}) => {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string') { issue('error', '此项必须是文字。', at); return ''; }
    if (value.length > max) issue('error', '此项文字过长。', at);
    if (required && !value.trim()) issue('error', '此项不能为空。', at);
    return value.slice(0, max);
  };
  const id = (value, at) => {
    const result = text(value, at, { required: true, max: 128 }).trim();
    if (result && !/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,127}$/u.test(result)) issue('error', '机考 ID 包含不支持的字符。', at);
    return result;
  };
  const integer = (value, at, { min = 0, max = 1000, nullable = false, fallback = null } = {}) => {
    if (nullable && value === null) return null;
    if (!Number.isSafeInteger(value) || value < min || value > max) { issue('error', `此项必须是 ${min} 至 ${max} 之间的整数${nullable ? '或 null' : ''}。`, at); return fallback; }
    return value;
  };
  const enumeration = (value, choices, at, fallback) => {
    if (!choices.includes(value)) { issue('error', `此项必须为 ${choices.join('、')} 之一。`, at); return fallback ?? choices[0]; }
    return value;
  };
  const list = (value, at, { min = 0, max = 100 } = {}) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) { issue('error', `此项应为包含 ${min} 至 ${max} 项的数组。`, at); return Array.isArray(value) ? value.slice(0, max) : []; }
    return value;
  };
  const timing = (value, at, inherit = false) => {
    const v = object(value, ['scope', 'durationSeconds', 'prepareSeconds', 'basis', 'source'], at);
    const scope = enumeration(v.scope, [...(inherit ? ['inherit_module'] : []), 'module', 'task', 'question', 'none'], `${at}.scope`, 'none');
    if (scope === 'inherit_module') {
      if (v.durationSeconds !== undefined && v.durationSeconds !== null) issue('error', '继承模块计时不能另设时长。', `${at}.durationSeconds`);
      if (v.prepareSeconds !== undefined && v.prepareSeconds !== null) issue('error', '继承模块计时不能另设准备时间。', `${at}.prepareSeconds`);
      return { scope: 'inherit_module', durationSeconds: null, prepareSeconds: null, basis: has(v, 'basis') ? enumeration(v.basis, ['document', 'user', 'preset', 'unknown'], `${at}.basis`, 'unknown') : 'unknown', source: text(v.source, `${at}.source`, { max: 10000 }) };
    }
    const durationSeconds = integer(v.durationSeconds, `${at}.durationSeconds`, { min: 1, max: 7200, nullable: true });
    const prepareSeconds = v.prepareSeconds === undefined ? null : integer(v.prepareSeconds, `${at}.prepareSeconds`, { min: 0, max: 7200, nullable: true });
    const basis = enumeration(v.basis, ['document', 'user', 'preset', 'unknown'], `${at}.basis`, 'unknown');
    if (scope === 'none' && durationSeconds !== null) issue('error', '不计时配置的 durationSeconds 必须为 null。', `${at}.durationSeconds`);
    if (basis === 'unknown' && (durationSeconds !== null || prepareSeconds !== null)) issue('error', '未知来源的计时不能声称具体秒数。', at);
    return { scope, durationSeconds, prepareSeconds, basis, source: text(v.source, `${at}.source`, { max: 10000 }) };
  };
  const navigation = (value, at) => {
    const v = object(value, ['back', 'review', 'lockOnAdvance'], at);
    if (typeof v.lockOnAdvance !== 'boolean') issue('error', 'lockOnAdvance 必须为 true 或 false。', `${at}.lockOnAdvance`);
    return { back: enumeration(v.back, ['module', 'task', 'none'], `${at}.back`, 'none'), review: enumeration(v.review, ['module', 'task', 'none'], `${at}.review`, 'none'), lockOnAdvance: v.lockOnAdvance === true };
  };
  const direction = (value, at, withId = true, allowEmpty = false) => {
    const v = object(value, [...(withId ? ['id'] : []), 'text', 'audio', 'source', 'basis', 'verifiedContent'], at);
    const result = {
      ...(withId ? { id: id(v.id, `${at}.id`) } : {}),
      text: text(v.text, `${at}.text`), audio: mediaPath(v.audio, `${at}.audio`, 'audio'),
      source: text(v.source, `${at}.source`, { max: 10000 }),
      basis: v.basis === undefined ? 'user' : enumeration(v.basis, ['document', 'filename', 'user'], `${at}.basis`, 'user'),
      verifiedContent: v.verifiedContent === true,
    };
    if (v.verifiedContent !== undefined && typeof v.verifiedContent !== 'boolean') issue('error', 'verifiedContent 必须为 true 或 false。', `${at}.verifiedContent`);
    if (!allowEmpty && !result.text.trim() && !result.audio) issue('error', '任务说明至少需要文字或音频。', at);
    if (result.basis === 'filename' && result.verifiedContent) issue('error', '文件名关联不能同时声称已核实音频内容。', `${at}.verifiedContent`);
    return result;
  };
  const presentation = (value, at) => {
    const v = object(value, ['screen', 'passageVisibility', 'questionPromptVisibility', 'document', 'email', 'discussion'], at);
    const result = {};
    if (has(v, 'screen')) result.screen = enumeration(v.screen, ['all_questions', 'one_question'], `${at}.screen`, 'one_question');
    for (const field of ['passageVisibility', 'questionPromptVisibility']) if (has(v, field)) result[field] = enumeration(v[field], ['attempt', 'review'], `${at}.${field}`, 'attempt');
    if (has(v, 'document')) {
      const d = object(v.document, ['kind', 'title', 'blocks'], `${at}.document`);
      result.document = { kind: enumeration(d.kind, ['notice', 'email', 'social_post', 'academic', 'plain'], `${at}.document.kind`, 'plain'), title: text(d.title, `${at}.document.title`, { max: 300 }), blocks: list(d.blocks, `${at}.document.blocks`, { min: 1, max: 100 }).map((block, index) => {
        const bp = `${at}.document.blocks[${index}]`;
        const b = object(block, block?.kind === 'table' ? ['kind', 'rows'] : ['kind', 'text'], bp);
        const kind = enumeration(b.kind, ['heading', 'paragraph', 'table'], `${bp}.kind`, 'paragraph');
        if (kind === 'table') return { kind, rows: list(b.rows, `${bp}.rows`, { min: 1, max: 100 }).map((row, ri) => list(row, `${bp}.rows[${ri}]`, { min: 1, max: 20 }).map((cell, ci) => text(cell, `${bp}.rows[${ri}][${ci}]`, { max: 20000 }))) };
        return { kind, text: text(b.text, `${bp}.text`, { required: true }) };
      }) };
    }
    if (has(v, 'email')) {
      const e = object(v.email, ['to', 'subject', 'instructions', 'body'], `${at}.email`);
      result.email = { to: text(e.to, `${at}.email.to`, { required: true, max: 2000 }), subject: text(e.subject, `${at}.email.subject`, { required: true, max: 1000 }) };
      for (const field of ['instructions', 'body']) if (has(e, field)) result.email[field] = text(e[field], `${at}.email.${field}`);
    }
    if (has(v, 'discussion')) {
      const d = object(v.discussion, ['prompt', 'posts', 'instructions'], `${at}.discussion`);
      result.discussion = { prompt: text(d.prompt, `${at}.discussion.prompt`, { required: true }), posts: list(d.posts, `${at}.discussion.posts`, { min: 1, max: 50 }).map((post, index) => {
        const pp = `${at}.discussion.posts[${index}]`;
        const p = object(post, ['speaker', 'text'], pp);
        return { speaker: text(p.speaker, `${pp}.speaker`, { required: true, max: 300 }), text: text(p.text, `${pp}.text`, { required: true }) };
      }) };
      if (has(d, 'instructions')) result.discussion.instructions = text(d.instructions, `${at}.discussion.instructions`);
    }
    return result;
  };
  const inlineBlanks = (value, group, at) => {
    const v = object(value, ['textField', 'offsetUnit', 'answerMode', 'textHash', 'anchors'], at);
    if (v.textField !== 'passage') issue('error', '补字锚点只能引用同一题组的 passage。', `${at}.textField`);
    if (v.offsetUnit !== 'utf16') issue('error', '补字位置必须使用 UTF-16 半开区间。', `${at}.offsetUnit`);
    if (v.answerMode !== 'missing_letters') issue('error', '补字作答必须明确使用 missing_letters。', `${at}.answerMode`);
    const computedHash = hash(group.passage);
    if (v.textHash !== undefined && (typeof v.textHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.textHash) || v.textHash !== computedHash)) issue('error', '补字段落的哈希不匹配；文字发生变化后必须重新定位空位。', `${at}.textHash`);
    const seen = new Set();
    let previousEnd = 0;
    const anchors = list(v.anchors, `${at}.anchors`, { min: 1, max: 1000 }).map((anchor, index) => {
      const ap = `${at}.anchors[${index}]`;
      const a = object(anchor, ['questionId', 'localNumber', 'prefixStart', 'prefixEnd', 'start', 'end', 'missingLetterCount', 'prefix', 'rawGap', 'source'], ap);
      const result = { questionId: id(a.questionId, `${ap}.questionId`), localNumber: integer(a.localNumber, `${ap}.localNumber`, { min: 1, max: 10000, nullable: true }), prefixStart: integer(a.prefixStart, `${ap}.prefixStart`, { max: 500000, fallback: 0 }), prefixEnd: integer(a.prefixEnd, `${ap}.prefixEnd`, { max: 500000, fallback: 0 }), start: integer(a.start, `${ap}.start`, { max: 500000, fallback: 0 }), end: integer(a.end, `${ap}.end`, { max: 500000, fallback: 0 }), missingLetterCount: integer(a.missingLetterCount, `${ap}.missingLetterCount`, { min: 1, max: 100, fallback: 1 }), prefix: text(a.prefix, `${ap}.prefix`, { max: 1000 }), rawGap: text(a.rawGap, `${ap}.rawGap`, { required: true, max: 10000 }), source: text(a.source, `${ap}.source`, { max: 10000 }) };
      if (!(result.prefixStart <= result.prefixEnd && result.prefixEnd === result.start && result.start < result.end && result.end <= group.passage.length && result.prefixStart >= previousEnd)) issue('error', '补字区间越界、交叠或未按段落顺序排列。', ap);
      if (group.passage.slice(result.prefixStart, result.prefixEnd) !== result.prefix || group.passage.slice(result.start, result.end) !== result.rawGap) issue('error', '补字固定前缀或空白区间与原段落不一致。', ap);
      if (!/^[\s_-]+$/.test(result.rawGap) || (result.rawGap.match(/[_-]/g) || []).length !== result.missingLetterCount) issue('error', '空白标记数量与 missingLetterCount 不一致。', ap);
      const question = group.questions.find(item => item.id === result.questionId);
      if (!question || question.type !== 'fill_blank') issue('error', '补字锚点必须对应当前题组的一道 fill_blank 题。', `${ap}.questionId`);
      if (seen.has(result.questionId)) issue('error', '同一道补字题不能对应多个空位。', `${ap}.questionId`);
      seen.add(result.questionId);
      if (question?.localNumber !== undefined && question.localNumber !== result.localNumber) issue('error', '补字锚点的原题号与对应题目不一致。', `${ap}.localNumber`);
      const answers = question?.answer === null || question?.answer === undefined ? [] : Array.isArray(question.answer) ? question.answer : [question.answer];
      if (answers.some(answer => typeof answer !== 'string' || !/^\p{L}+$/u.test(answer) || [...answer].length !== result.missingLetterCount)) issue('error', '补字答案应只包含缺少的字母，且长度必须等于空白数量。', `${ap}.missingLetterCount`);
      previousEnd = result.end;
      return result;
    });
    if (group.questions.some(question => question.type !== 'fill_blank' || !seen.has(question.id)) || seen.size !== group.questions.length) issue('error', '同屏补字段落必须逐一覆盖当前题组的全部题目。', at);
    return { textField: 'passage', offsetUnit: 'utf16', answerMode: 'missing_letters', textHash: computedHash, anchors };
  };
  const interaction = (value, group, question, at) => {
    const v = object(value, ['kind', 'textField', 'offsetUnit', 'textHash', 'candidates', 'sentence'], at);
    const kind = enumeration(v.kind, ['sentence_select', 'sentence_insert'], `${at}.kind`, 'sentence_select');
    if (group.section !== 'reading' || !['read_daily', 'read_academic'].includes(group.taskKind) || question.type !== 'single_choice') issue('error', '正文点句/插句交互只能用于阅读任务的 single_choice 题。', at);
    if (v.textField !== 'passage' || v.offsetUnit !== 'utf16') issue('error', '阅读交互必须引用 group.passage 的 UTF-16 半开区间。', at);
    if (!group.passage.trim()) issue('error', '点句/插句交互缺少不可变的正文文字。', `${at}.textField`);
    if (/<\/?sentence-(?:insert|click)\b/i.test(group.passage)) issue('error', '请先把来源页面的交互标签转换为纯正文和位置，不能直接导入带标签的 HTML。', `${at}.textField`);
    const computedHash = hash(group.passage);
    if (v.textHash !== undefined && (typeof v.textHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.textHash) || v.textHash !== computedHash)) issue('error', '阅读交互的正文哈希不匹配，需重新定位候选位置。', `${at}.textHash`);
    const ids = new Set();
    let previousStart = -1, previousEnd = 0;
    const candidates = list(v.candidates, `${at}.candidates`, { min: kind === 'sentence_insert' ? 4 : 2, max: kind === 'sentence_insert' ? 4 : 30 }).map((candidate, index) => {
      const cp = `${at}.candidates[${index}]`;
      const c = object(candidate, ['id', 'start', 'end'], cp);
      const result = { id: id(c.id, `${cp}.id`), start: integer(c.start, `${cp}.start`, { max: 500000, fallback: 0 }), end: integer(c.end, `${cp}.end`, { max: 500000, fallback: 0 }) };
      if (ids.has(result.id)) issue('error', '候选位置的 ID 不能重复。', `${cp}.id`);
      ids.add(result.id);
      if (result.start <= previousStart || result.end > group.passage.length || result.start > group.passage.length || (kind === 'sentence_select' && (result.start >= result.end || result.start < previousEnd || !group.passage.slice(result.start, result.end).trim())) || (kind === 'sentence_insert' && result.start !== result.end)) issue('error', '候选位置越界、重复、交叠、顺序错误或不符合点句/插句类型。', cp);
      // A UTF-16 offset may be between characters, but never inside a surrogate pair.
      for (const offset of [result.start, result.end]) if (offset > 0 && offset < group.passage.length && /[\uD800-\uDBFF]/.test(group.passage[offset - 1]) && /[\uDC00-\uDFFF]/.test(group.passage[offset])) issue('error', '候选位置不能切断一个 Unicode 字符。', cp);
      previousStart = result.start; previousEnd = result.end;
      return result;
    });
    if (question.answer !== null && (typeof question.answer !== 'string' || !ids.has(question.answer))) issue('error', '阅读交互的标准答案必须是一个有效候选位置 ID。', `${at}.answer`);
    if (question.options.length && (question.options.length !== candidates.length || question.options.some(option => !ids.has(option.id)))) issue('error', '非空 options 的 ID 必须与候选位置完整一致。', `${at}.candidates`);
    const result = { kind, textField: 'passage', offsetUnit: 'utf16', textHash: computedHash, candidates };
    if (has(v, 'sentence')) {
      result.sentence = text(v.sentence, `${at}.sentence`, { required: true });
      if (kind !== 'sentence_insert') issue('error', 'sentence 仅用于保存插句题的待插入原句。', `${at}.sentence`);
    }
    return result;
  };

  if (has(rawPack, 'examContractVersion')) {
    if (rawPack.examContractVersion !== 1) issue('error', '当前仅支持 examContractVersion: 1。', 'examContractVersion');
    pack.examContractVersion = 1;
  }
  if (has(rawPack, 'minReaderVersion')) {
    if (rawPack.minReaderVersion !== (rawPack.schemaVersion===2?'0.5.0':'0.3.0')) issue('error', '此机考格式的最低读取版本不匹配。', 'minReaderVersion');
    pack.minReaderVersion = rawPack.schemaVersion===2?'0.5.0':'0.3.0';
  }
  for (const [gi, group] of pack.groups.entries()) {
    const raw = record(rawPack.groups?.[gi]) ? rawPack.groups[gi] : {};
    const gp = `groups[${gi}]`;
    for (const [qi, question] of group.questions.entries()) {
      const q = record(raw.questions?.[qi]) ? raw.questions[qi] : {};
      const qp = `${gp}.questions[${qi}]`;
      if (has(q, 'localNumber')) question.localNumber = integer(q.localNumber, `${qp}.localNumber`, { min: 1, max: 10000, nullable: true });
      if (has(q, 'ordinalInTask')) {
        question.ordinalInTask = integer(q.ordinalInTask, `${qp}.ordinalInTask`, { min: 1, max: 1000 });
        if (question.ordinalInTask !== qi + 1) issue('error', 'ordinalInTask 必须与题组中的实际题目顺序一致。', `${qp}.ordinalInTask`);
      }
      if (has(q, 'transcript')) question.transcript = text(q.transcript, `${qp}.transcript`);
    }
    if (has(raw, 'taskKind')) {
      group.taskKind = enumeration(raw.taskKind, EXAM_TASK_KINDS, `${gp}.taskKind`, 'read_daily');
      if (group.section !== KIND_SECTION[group.taskKind] || group.questions.some(question => question.type !== KIND_TYPE[group.taskKind])) issue('error', 'taskKind 的科目或底层题型与题组内容不一致。', `${gp}.taskKind`);
    }
    if (has(raw, 'transcript')) group.transcript = text(raw.transcript, `${gp}.transcript`, { max: 500000 });
    if (has(raw, 'presentation')) group.presentation = presentation(raw.presentation, `${gp}.presentation`);
    if (has(raw, 'timing')) group.timing = timing(raw.timing, `${gp}.timing`, true);
    if (has(raw, 'directions')) {
      const ids = new Set();
      group.directions = list(raw.directions, `${gp}.directions`).map((value, index) => {
        const result = direction(value, `${gp}.directions[${index}]`);
        if (ids.has(result.id)) issue('error', '同一任务的说明 ID 不能重复。', `${gp}.directions[${index}].id`);
        ids.add(result.id); return result;
      });
    }
    if (has(raw, 'inlineBlanks')) group.inlineBlanks = inlineBlanks(raw.inlineBlanks, group, `${gp}.inlineBlanks`);
    for (const [qi, question] of group.questions.entries()) {
      const q = record(raw.questions?.[qi]) ? raw.questions[qi] : {};
      if (has(q, 'interaction')) question.interaction = interaction(q.interaction, group, question, `${gp}.questions[${qi}].interaction`);
    }
    if (group.taskKind === 'complete_words' && !group.inlineBlanks) issue('error', 'complete_words 任务必须提供可核对的 inlineBlanks。', `${gp}.inlineBlanks`);
    if (group.inlineBlanks && group.presentation?.screen === 'one_question') issue('error', '同屏补字任务的 presentation.screen 应为 all_questions。', `${gp}.presentation.screen`);
    if (group.presentation?.email && group.taskKind !== 'write_email') issue('error', 'email 呈现只能用于 write_email 任务。', `${gp}.presentation.email`);
    if (group.presentation?.discussion && group.taskKind !== 'academic_discussion') issue('error', 'discussion 呈现只能用于 academic_discussion 任务。', `${gp}.presentation.discussion`);
  }
  if (!has(rawPack, 'examSets')) return;
  if (rawPack.examContractVersion !== 1 || rawPack.minReaderVersion !== (rawPack.schemaVersion===2?'0.5.0':'0.3.0')) issue('error', '机考套题需要已支持的执行契约与最低读取版本。', 'examSets');
  const setIds = new Set();
  const allReferencedGroups = new Set();
  pack.examSets = list(rawPack.examSets, 'examSets', { min: 1, max: 100 }).map((rawSet, si) => {
    const sp = `examSets[${si}]`;
    const s = object(rawSet, ['id', 'title', 'sections'], sp);
    const set = { id: id(s.id, `${sp}.id`), title: text(s.title, `${sp}.title`, { required: true, max: 300 }), sections: [] };
    if (setIds.has(set.id)) issue('error', '套题 ID 重复。', `${sp}.id`);
    setIds.add(set.id);
    const sectionIds = new Set(), kinds = new Set(), moduleIds = new Set(), groupRefs = new Set(), questionRefs = new Set();
    set.sections = list(s.sections, `${sp}.sections`, { min: 1, max: 4 }).map((rawSection, sci) => {
      const scp = `${sp}.sections[${sci}]`;
      const sc = object(rawSection, ['id', 'section', 'title', 'modules'], scp);
      const section = { id: id(sc.id, `${scp}.id`), section: enumeration(sc.section, [...SECTIONS], `${scp}.section`, 'reading'), title: text(sc.title, `${scp}.title`, { required: true, max: 300 }), modules: [] };
      if (sectionIds.has(section.id) || kinds.has(section.section)) issue('error', '同一套题不能重复定义科目 ID 或科目种类。', scp);
      sectionIds.add(section.id); kinds.add(section.section);
      section.modules = list(sc.modules, `${scp}.modules`, { min: 1, max: 100 }).map((rawModule, mi) => {
        const mp = `${scp}.modules[${mi}]`;
        const m = object(rawModule, ['id', 'title', 'sourceNumber', 'taskIds', 'timing', 'navigation', 'instructions'], mp);
        const module = { id: id(m.id, `${mp}.id`), title: text(m.title, `${mp}.title`, { required: true, max: 300 }), sourceNumber: integer(m.sourceNumber, `${mp}.sourceNumber`, { min: 1, max: 10000, nullable: true }), taskIds: [] };
        if (moduleIds.has(module.id)) issue('error', '同一套题中的模块 ID 必须全局唯一。', `${mp}.id`);
        moduleIds.add(module.id);
        if (has(m, 'timing')) module.timing = timing(m.timing, `${mp}.timing`);
        if (has(m, 'navigation')) module.navigation = navigation(m.navigation, `${mp}.navigation`);
        if (has(m, 'instructions')) module.instructions = direction(m.instructions, `${mp}.instructions`, false, true);
        const localNumbers = new Set();
        module.taskIds = list(m.taskIds, `${mp}.taskIds`, { min: 1, max: 100 }).map((rawId, ti) => {
          const taskId = id(rawId, `${mp}.taskIds[${ti}]`);
          const group = pack.groups.find(group => group.id === taskId);
          if (!group) { issue('error', '任务引用不存在。', `${mp}.taskIds[${ti}]`); return taskId; }
          if (group.section !== section.section) issue('error', '任务所属科目与模块科目不一致。', `${mp}.taskIds[${ti}]`);
          if (!group.taskKind) issue('error', '机考套题引用的题组必须声明 taskKind。', `${mp}.taskIds[${ti}]`);
          if (groupRefs.has(taskId)) issue('error', '同一套题不能多次引用同一任务。', `${mp}.taskIds[${ti}]`);
          groupRefs.add(taskId); allReferencedGroups.add(taskId);
          for (const question of group.questions) {
            if (questionRefs.has(question.id)) issue('error', '同一套题不能重复引用同一道原子题，否则作答记录会覆盖。', `${mp}.taskIds[${ti}]`);
            questionRefs.add(question.id);
            if (question.localNumber !== undefined && question.localNumber !== null) {
              if (localNumbers.has(question.localNumber)) issue('error', '同一模块的原题号重复。', `${mp}.taskIds[${ti}]`);
              localNumbers.add(question.localNumber);
            }
          }
          return taskId;
        });
        return module;
      });
      return section;
    });
    return set;
  });
  for (const [gi, group] of pack.groups.entries()) if (!allReferencedGroups.has(group.id)) issue('error', '此任务未被任何机考套题引用。', `groups[${gi}].id`);
}
