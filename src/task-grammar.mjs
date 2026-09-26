import { createHash } from 'node:crypto';

// Local reader for single-task TOEFL 2026 practice material: question banks,
// handouts, per-task packs and pasted web text. It recognizes items by the
// task's own features (lettered options, word fragments plus a stated answer,
// an email's recipient and subject, a professor's question) instead of a
// whole-test layout. Answers are only taken from explicit keys in the source.

const issue = (severity, message, at = 'sources') => ({ severity, message, path: at });
const where = line => `${line.name}${line.page ? ` · 第 ${line.page} 页` : ''} · 第 ${line.line} 行`;

const OPTION = /^\(?([A-F])[.)]\s+(\S.*)$/;
const ITEM = /^(?:(?:Question|Item|Example|Prompt)\s+(\d{1,3})\b\s*[.:)]?\s*(.*)|(\d{1,3})[.)]\s+(\S.*))$/i;
const ANCHOR = /^(?:Passage|Recording|Text|Set|Conversation|Lecture|Talk|Announcement)\s+\d{1,3}\s*[:.—–-]\s*(.*)$/i;
const LINK = /^(?:Play|Listen to|Hear) (?:this|the) (?:recording|audio)\b/i;
const META = /·.*\b\d+\s*(?:words?|questions?|sec(?:onds?)?|min(?:utes?)?)\b|\b\d+\s*(?:words?|questions?)\s*·/i;
const INLINE_KEY = /^(?:Correct\s+|Right\s+)?Answers?\s*[:：]\s*\(?([A-F])\)?[.)]?$/i;
const TEXT_KEY = /^(?:(?:Sample|Model|Correct|Suggested)\s+)?Answers?\s*[:：]\s*(\S.*)$/i;
const FRAGMENT_LABEL = /^(?:Arrange (?:these|the) words(?: or phrases)?(?: into a sentence)?|Scrambled words|Word bank|Words)\s*[:：]\s*(.*)$/i;
const CONTEXT_LABEL = /^(?:Speaker|Context|Question|Prompt|Person A|Friend|Classmate)\s*[:：]\s*(.+)$/i;
const SAMPLE_STOP = /^(?:Your (?:email|response|answer|sentence|post|reply)\s*[:：]?|Show (?:sample|model) (?:answer|response)|(?:Sample|Model|Example) (?:answer|response|email|reply)\b|Check answers?$|Reset$)/i;
const KINDS = [
  ['listen_repeat', ['listenandrepeat', 'listenrepeat']],
  ['interview', ['takeaninterview', 'interviewprompt', 'interviewquestion']],
  ['sentence_order', ['buildasentence']],
  ['discussion', ['academicdiscussion']],
  ['email', ['writeanemail', 'emailprompt']],
  ['complete_words', ['completethewords', 'fillinthemissingletters']],
  ['listening', ['listening', 'transcript', 'chooseabestresponse', 'chooseresponse']],
  ['reading', ['reading', 'readindailylife', 'readanacademicpassage']],
  ['speaking', ['speaking']],
  ['writing', ['writing']],
];

const letters = text => text.toLowerCase().replace(/[^a-z]/g, '');
// Decorative headings are often letter-spaced ("A N S W E R K E Y").
const spaced = text => { const words = text.trim().split(/\s+/); return words.length >= 4 && words.filter(word => word.length <= 2).length / words.length >= 0.7; };
// "Writing to: Service Provider" is a field label, not a Writing heading.
const fieldLabel = text => /^[^:：]{1,30}[:：]\s*\S/.test(text) && !/^(?:Task|Section|Part)\s*\d+\s*[:：]/i.test(text);
const headingLike = text => spaced(text) || (/^[A-Z0-9]/.test(text) && text.split(/\s+/).length <= 14 && !/[.?!:,;]$/.test(text) && !OPTION.test(text) && !ITEM.test(text) && !fieldLabel(text));
const GENERIC = new Set(['listening', 'reading', 'speaking', 'writing']);
const SECTION_OF = { sentence_order: 'writing', email: 'writing', discussion: 'writing', listen_repeat: 'speaking', interview: 'speaking', complete_words: 'reading' };
// Generic section words only count in section-style headings, so a passage
// titled "The Science of Listening" does not switch the task type.
const sectionHeading = text => spaced(text) || /\b(?:section|part)\b/i.test(text) || text.split(/\s+/).length <= 4;
const kindOf = text => KINDS.find(([kind, keys]) => keys.some(key => GENERIC.has(kind)
  ? sectionHeading(text) && (letters(text).startsWith(key) || (/\b(?:section|part)\b/i.test(text) && letters(text).includes(key)))
  : letters(text).includes(key)))?.[0] || null;
const keyHeading = text => /^(?:answerkey|answersandexplanations|answers)/.test(letters(text)) || /^answer key\b/i.test(text);

function prepare(chunks) {
  const pages = chunks.map(chunk => String(chunk.text).replace(/\r\n?/g, '\n').split('\n')
    .map((text, index) => ({ text: text.trim(), name: chunk.name, page: chunk.page ?? null, paragraph: chunk.paragraph ?? null, line: chunk.sourceLineMap?.[index] || index + 1 }))
    .filter(line => line.text));
  // Page furniture: short text repeated at the top or bottom of several pages.
  const edgeCount = new Map();
  const structural = text => OPTION.test(text) || ITEM.test(text) || ANCHOR.test(text) || LINK.test(text) || kindOf(text) === 'listen_repeat';
  const edges = lines => [...lines.slice(0, 2), ...lines.slice(-3)];
  for (const lines of pages) for (const key of new Set(edges(lines).filter(line => line.text.length <= 90 && !structural(line.text)).map(line => line.text.replace(/\d+/g, '#')))) edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
  const furniture = new Set([...edgeCount].filter(([, count]) => count >= 3).map(([key]) => key));
  return pages.flatMap(lines => { const edge = new Set(edges(lines)); return lines.filter(line => !(edge.has(line) && furniture.has(line.text.replace(/\d+/g, '#')))); });
}

const tokenize = text => [...text.normalize('NFC').replaceAll('’', "'").matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu)].map(match => ({ text: match[0], lower: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length }));

// Cover the stated answer with the given fragments, in order. Uncovered answer
// words become fixed frame text. The cover that leaves the fewest fixed words
// (then the fewest capitalization mismatches) wins; a tie between different
// covers is ambiguous and yields no answer.
export function coverSentence(answer, fragments) {
  const target = tokenize(answer);
  const parts = fragments.map(text => tokenize(text));
  if (!target.length || parts.some(part => !part.length)) return null;
  let best = null, bestScore = Infinity, steps = 0, ambiguous = false;
  const signature = seq => seq.map(step => step.fragment !== undefined ? `f:${fragments[step.fragment].toLowerCase()}` : `x:${target[step.at].lower}`).join('|');
  const visit = (at, used, seq, fixed, mismatch) => {
    if (++steps > 200000) return;
    const score = fixed * 100 + mismatch;
    if (score > bestScore) return;
    if (at === target.length) {
      if (score < bestScore) { bestScore = score; best = seq; ambiguous = false; }
      else if (signature(seq) !== signature(best)) ambiguous = true;
      return;
    }
    const tried = new Set();
    for (let fi = 0; fi < parts.length; fi++) {
      const key = fragments[fi].toLowerCase();
      if (used.has(fi) || tried.has(key)) continue;
      const part = parts[fi];
      if (!part.every((token, index) => target[at + index]?.lower === token.lower)) continue;
      tried.add(key);
      const cased = part.filter((token, index) => target[at + index].text !== token.text).length;
      visit(at + part.length, new Set([...used, fi]), [...seq, { fragment: fi, at, length: part.length }], fixed, mismatch + cased);
    }
    visit(at + 1, used, [...seq, { at }], fixed + (/[\p{L}\p{N}]/u.test(target[at].text) ? 1 : 0), mismatch);
  };
  visit(0, new Set(), [], 0, 0);
  if (!best || ambiguous || steps > 200000) return null;
  const slots = best.filter(step => step.fragment !== undefined);
  if (slots.length < 2) return null;
  let frame = '', cursor = 0;
  for (const slot of slots) {
    const start = target[slot.at].start, end = target[slot.at + slot.length - 1].end;
    frame += answer.slice(cursor, start) + '_____';
    cursor = end;
  }
  frame += answer.slice(cursor);
  return { frame: frame.replace(/\s+/g, ' ').trim(), order: slots.map(slot => slot.fragment) };
}

// Web Complete the Words pages lose their letter boxes when copied, leaving
// "ro" for "ro___". Only when the same item also prints the full text can the
// gaps be restored: every differing word must be a strict prefix of its full
// form, and nothing else may differ. The missing letters then come from the
// page's own text, not from guessing (the general rule in src/models.mjs:23
// still applies to anything else).
export function gapsFromModel(gapped, full) {
  const tokens = text => [...text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*|\S/g)].map(match => ({ text: match[0], start: match.index }));
  const a = tokens(gapped), b = tokens(full);
  if (!a.length || a.length !== b.length) return null;
  const blanks = [];
  for (let index = 0; index < a.length; index++) {
    if (a[index].text === b[index].text) continue;
    const prefix = a[index].text, word = b[index].text;
    if (!/^[A-Za-z]+$/.test(prefix) || !/^[A-Za-z]+$/.test(word) || prefix.length >= word.length || !word.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    blanks.push({ start: a[index].start, end: a[index].start + prefix.length, prefix, missing: word.slice(prefix.length) });
  }
  if (!blanks.length) return null;
  let passage = '', cursor = 0;
  for (const blank of blanks) { passage += gapped.slice(cursor, blank.end) + '_'.repeat(blank.missing.length); cursor = blank.end; }
  return { passage: passage + gapped.slice(cursor), blanks };
}

export function parseTaskGrammar(chunks, { title = '' } = {}) {
  if (!Array.isArray(chunks) || !chunks.length || chunks.some(chunk => !chunk || typeof chunk.text !== 'string')) return null;
  const lines = prepare(chunks);
  const issues = [];
  const groups = [];
  const keys = [];
  let context = null;
  let contextTitle = '';
  let group = null;
  let item = null;
  let keyMode = false;
  let lastKey = null;
  let loose = null; // the most recent unstructured line and where it went
  let unassigned = 0;
  let skipping = false;

  const newGroup = heading => {
    group = { title: heading || contextTitle, context, passage: [], transcript: [], items: [], listening: context === 'listening', links: [], transcriptMode: false };
    groups.push(group);
    return group;
  };
  const finishItem = () => { item = null; };
  const place = line => {
    if (item) { item.lines.push(line); loose = { line, list: item.lines }; return; }
    if (!group) newGroup('');
    const list = group.transcriptMode ? group.transcript : group.passage;
    list.push(line); loose = { line, list };
  };
  // A title stands on the line just before a metadata or recording-link line.
  const takeTitle = () => {
    if (!loose || loose.list.at(-1) !== loose.line || loose.line.text.split(/\s+/).length > 14) return null;
    loose.list.pop();
    return loose.line;
  };

  for (const line of lines) {
    const text = line.text;
    // A one-line table: "Answer key: 1 A, 2 C".
    const table = text.match(/^(?:Answer key|Answers)\s*[:：]\s*(.+)$/i);
    if (table && /^(?:\d{1,3}\s*[.):-]?\s*[A-F]\b[\s,;]*)+$/i.test(table[1])) {
      finishItem(); loose = null;
      for (const pair of table[1].matchAll(/(\d{1,3})\s*[.):-]?\s*([A-F])\b/gi)) keys.push({ number: Number(pair[1]), value: pair[2].toUpperCase(), line, explanation: [], block: groups.length });
      continue;
    }
    if (keyHeading(text) && (headingLike(text) || /^answers?\s*[:：]?$/i.test(text))) { finishItem(); keyMode = true; lastKey = null; loose = null; continue; }
    if (letters(text).replace(/^the/, '').startsWith('transcript') && (spaced(text) || (headingLike(text) && text.split(/\s+/).length <= 12)) || /^transcript\s*[:：]?$/i.test(text)) {
      finishItem(); if (!group) newGroup('');
      group.transcriptMode = true; group.listening = true; loose = null; continue;
    }
    const anchor = text.match(ANCHOR);
    if (anchor || LINK.test(text) || META.test(text)) {
      keyMode = false; lastKey = null; finishItem();
      const fresh = group && !group.items.length && !group.passage.length && !group.transcript.length;
      if (anchor) newGroup(anchor[1] || text);
      else if (!fresh) newGroup(takeTitle()?.text || '');
      else if (!group) newGroup('');
      if (LINK.test(text)) group.links.push(text.match(/https?:\/\/\S+/)?.[0] || text);
      if (LINK.test(text) || /^recording\b/i.test(text)) group.listening = true;
      loose = null; continue;
    }
    // Rubric notes describe scoring, not the task; skip them until the next item.
    if (headingLike(text) && /rubric|scoringguide/.test(letters(text))) { finishItem(); skipping = true; loose = null; continue; }
    if (skipping && !ITEM.test(text) && !ANCHOR.test(text) && !(headingLike(text) && kindOf(text)) && !keyHeading(text)) { unassigned++; continue; }
    skipping = false;
    if (headingLike(text) && !keyMode) {
      const kind = kindOf(text);
      // "Writing" does not override a more specific Writing task already in force.
      if (kind && GENERIC.has(kind) && SECTION_OF[context] === kind) { loose = null; continue; }
      if (kind) { finishItem(); context = kind; contextTitle = spaced(text) ? contextTitle : text; group = null; loose = null; continue; }
      if (spaced(text)) { loose = null; continue; }
    }
    if (keyMode) {
      const kind = headingLike(text) ? kindOf(text) : null;
      if (kind) { context = kind; lastKey = null; continue; }
      // "3. B", "3 B", or "Item 3" / "Question 3" with the answer on later lines.
      const entry = text.match(/^(\d{1,3})\s*[.):]?\s+(\S.*)$/) || text.match(/^(?:Question|Item)\s+(\d{1,3})\s*[.:)]?\s*()$/i);
      // block = number of groups before this key; keys answer earlier groups.
      if (entry) { lastKey = { number: Number(entry[1]), value: entry[2].trim(), line, explanation: [], block: groups.length }; keys.push(lastKey); continue; }
      if (lastKey) { lastKey.explanation.push(text); continue; }
      if (spaced(text)) continue;
      unassigned++; continue;
    }
    const start = text.match(ITEM);
    if (start) {
      // Two or more loose lines after a complete choice question open a new
      // unlabelled passage rather than extending the last option.
      if (item && item.lines.some(l => OPTION.test(l.text))) {
        const lastOption = item.lines.findLastIndex(l => OPTION.test(l.text));
        const trailing = item.lines.slice(lastOption + 1).filter(l => !INLINE_KEY.test(l.text) && !/^Explanation\s*[:：]/i.test(l.text));
        if (trailing.length >= 2) {
          item.lines.splice(lastOption + 1);
          newGroup(''); group.passage.push(...trailing);
        }
      }
      finishItem();
      if (!group) newGroup('');
      item = { number: Number(start[1] || start[3]), header: (start[2] ?? start[4] ?? '').trim(), line, lines: [], context };
      group.items.push(item); loose = null; continue;
    }
    // Short spoken items end at the next subsection heading ("Medium sentences").
    if (item && ['listen_repeat', 'interview'].includes(item.context) && headingLike(text) && !/^\d+\s+words?$/i.test(text) && item.lines.length) { finishItem(); loose = null; }
    place(line);
  }

  const questions = [];
  const outGroups = [];
  const questionIds = new Set();
  const uniqueId = base => { let id = base, n = 2; while (questionIds.has(id)) id = `${base}-${n++}`; questionIds.add(id); return id; };
  const sourceNote = (line, label) => `${where(line)} · ${label}`;
  const textOf = list => list.map(l => l.text).join('\n').trim();
  const stripStops = list => { const stop = list.findIndex(l => SAMPLE_STOP.test(l.text)); return stop < 0 ? [list, []] : [list.slice(0, stop), list.slice(stop)]; };

  for (const [gi, g] of groups.entries()) {
    const output = new Map();
    const outGroup = (section, kind, heading) => {
      const key = `${section}:${kind}`;
      if (!output.has(key)) {
        const record = { id: `task-g${gi + 1}-${kind}`, section, title: heading || g.title || kind, passage: '', audio: null, image: null, questions: [] };
        output.set(key, record); outGroups.push(record);
      }
      return output.get(key);
    };
    // A single unnumbered writing task spans its group's text.
    if (!g.items.length && ['email', 'discussion'].includes(g.context) && g.passage.length >= 3) {
      const texts = g.passage.map(l => l.text);
      const marked = g.context === 'email' ? texts.some(t => /^(?:To|Writing to|Recipient)\s*[:：]/i.test(t)) : texts.some(t => /^Professor(?:\s*[:：]|$)/i.test(t));
      if (marked) { g.items.push({ number: 1, header: '', line: g.passage[0], lines: g.passage, context: g.context }); g.passage = []; }
    }
    for (const it of g.items) {
      const all = it.header ? [{ ...it.line, text: it.header }, ...it.lines] : it.lines;
      const optionAt = all.findIndex(l => OPTION.test(l.text));
      const optionCount = all.filter(l => OPTION.test(l.text)).length;
      const kind = it.context;
      if (optionCount >= 2) {
        const section = g.listening || kind === 'listening' ? 'listening' : 'reading';
        const target = outGroup(section, 'choice');
        const stem = all.slice(0, optionAt).filter(l => !INLINE_KEY.test(l.text));
        const options = []; const explanation = []; let answer = null; let active = null;
        for (const l of all.slice(optionAt)) {
          const option = l.text.match(OPTION), inline = l.text.match(INLINE_KEY);
          if (option && !options.some(o => o.id === option[1])) { active = { id: option[1], text: option[2] }; options.push(active); }
          else if (inline) { answer = inline[1]; active = null; }
          else if (/^Explanation\s*[:：]/i.test(l.text) || explanation.length) { explanation.push(l.text.replace(/^Explanation\s*[:：]\s*/i, '')); active = null; }
          else if (active) active.text += ` ${l.text}`;
          else explanation.push(l.text);
        }
        const q = { id: uniqueId(`${target.id}-q${it.number}`), type: 'single_choice', prompt: textOf(stem), options, answer: null, explanation: explanation.join('\n'), audio: null, image: null, timeLimitSeconds: 0, prepareSeconds: 0, source: sourceNote(it.line, `原题号 ${it.number}`), _number: it.number, _group: gi, _inline: answer };
        target.questions.push(q); questions.push(q);
        continue;
      }
      const [body, sample] = stripStops(all);
      const modelAt = sample.findIndex(l => /^Show (?:model|sample) answer$/i.test(l.text));
      if ((kind === 'complete_words' || /missing letters/i.test(it.header)) && modelAt >= 0) {
        const gapped = textOf(it.lines.slice(0, it.lines.indexOf(body.at(-1)) + 1)).replace(/\n/g, ' ');
        // The full text may wrap; stop once it is as long as the gapped text so
        // that whatever the page prints next is not taken as part of it.
        const wordsIn = text => (text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*|\S/g) || []).length;
        const fullLines = [];
        for (const l of sample.slice(modelAt + 1)) { if (wordsIn(fullLines.join(' ')) >= wordsIn(gapped)) break; fullLines.push(l.text); }
        const restored = gapsFromModel(gapped, fullLines.join(' '));
        if (!restored) { issues.push(issue('error', `${where(it.line)} 的补字原文与页面给出的完整原文不能逐词对应，未推断缺字；原文已保留。`, where(it.line))); unassigned += all.length; continue; }
        const label = it.header.split(/\.\s+(?=(?:Type|Fill|Complete)\b)/i)[0].replace(/\.$/, '') || 'Complete the Words';
        const record = { id: `task-g${gi + 1}-words-q${it.number}`, section: 'reading', title: label, passage: restored.passage, audio: null, image: null, questions: [] };
        outGroups.push(record);
        restored.blanks.forEach((blank, index) => {
          const q = { id: uniqueId(`${record.id}-b${index + 1}`), type: 'fill_blank', prompt: `${label}\n\n第 ${index + 1} 空：${blank.prefix}${'_'.repeat(blank.missing.length)}\n只填写缺少的 ${blank.missing.length} 个字母，不填写完整单词。`, options: [], answer: blank.missing, explanation: '', audio: null, image: null, timeLimitSeconds: 0, prepareSeconds: 0, source: `${sourceNote(it.line, `原题号 ${it.number} 第 ${index + 1} 空`)}；缺字数由页面给出的完整原文逐词对照得出`, _number: it.number, _group: gi };
          record.questions.push(q); questions.push(q);
        });
        issues.push(issue('warning', `${label} 的空位在复制时丢失，已按页面给出的完整原文逐词对照恢复缺字位置和字母数；请对照原页面确认。`, `${record.id}.passage`));
        continue;
      }
      const joined = textOf(body);
      const fragmentLabel = body.findIndex(l => FRAGMENT_LABEL.test(l.text));
      // "you / which / planning / in Europe": short slash-separated tiles.
      const slashLine = body.findIndex(l => { const parts = l.text.split('/'); return parts.length >= 3 && !/https?:|\d\s*\/|\/\s*\d/.test(l.text) && parts.every(part => { const n = part.trim().split(/\s+/).filter(Boolean).length; return n >= 1 && n <= 5; }); });
      const contextLine = body.find(l => CONTEXT_LABEL.test(l.text)) || body.find(l => /^["“].+["”]$/.test(l.text));
      const textKey = [...body, ...sample].map(l => l.text.match(TEXT_KEY)).find(Boolean);
      const isSentence = kind === 'sentence_order' || fragmentLabel >= 0 || (slashLine >= 0 && textKey);
      if (isSentence) {
        let fragmentText = null;
        if (fragmentLabel >= 0) fragmentText = body[fragmentLabel].text.match(FRAGMENT_LABEL)[1] || body[fragmentLabel + 1]?.text || '';
        else if (slashLine >= 0) fragmentText = body[slashLine].text;
        else {
          // Space-separated word banks follow the conversation line and may
          // wrap; they end at the stated answer or at a finished sentence.
          const from = contextLine ? body.indexOf(contextLine) + 1 : 1;
          const bank = [];
          for (const l of body.slice(from)) { if (TEXT_KEY.test(l.text) || /[.?!:]$/.test(l.text) || fieldLabel(l.text)) break; bank.push(l.text); }
          if (bank.join(' ').split(/\s+/).length >= 3) fragmentText = bank.join(' ').split(/\s+/).join(' / ');
        }
        const fragments = fragmentText ? fragmentText.split(/\s*\/\s*/).map(part => part.trim()).filter(Boolean) : [];
        const promptLine = contextLine || (!it.header && body[0]);
        const promptText = promptLine ? (promptLine.text.match(CONTEXT_LABEL)?.[1] ?? promptLine.text).replace(/^["“]|["”]$/g, '') : it.header;
        // Without a word bank this is not a recognizable item (often a wrapped
        // sentence that happens to start with a number); keep it as source text.
        if (fragments.length < 2) { unassigned += all.length; continue; }
        const target = outGroup('writing', 'sentence', /build a sentence/i.test(g.title) ? g.title : 'Build a Sentence');
        const extras = body.map(l => l.text.match(/^Extra words? (?:not used)?\s*[:：]\s*(.+)$/i)).find(Boolean);
        const explanation = [...body, ...sample].filter(l => /^Explanation\s*[:：]/i.test(l.text)).map(l => l.text.replace(/^Explanation\s*[:：]\s*/i, ''));
        const q = { id: uniqueId(`${target.id}-q${it.number}`), type: 'sentence_order', prompt: promptText || 'Make an appropriate sentence.', options: fragments.map((text, index) => ({ id: `F${index + 1}`, text })), answer: null, explanation: explanation.join('\n'), audio: null, image: null, timeLimitSeconds: 0, prepareSeconds: 0, source: sourceNote(it.line, `原题号 ${it.number}`), _number: it.number, _group: gi, _sentenceKey: textKey?.[1] || null, _extras: extras?.[1] || null };
        target.questions.push(q); questions.push(q);
        continue;
      }
      const recipient = body.some(l => /^(?:To|Writing to|Recipient)\s*[:：]/i.test(l.text)), subject = body.some(l => /^(?:Suggested\s+)?Subject\s*[:：]/i.test(l.text));
      const hasRecipient = (recipient && subject) || (kind === 'email' && (recipient || subject));
      // The professor's post asks something; "Professor: Dr. Lee, PhD" in a syllabus does not.
      const professor = body.some((l, index) => /^Professor(?:\s*[:：]|$)/i.test(l.text) && /\?/.test(body.slice(index, index + 4).map(next => next.text).join(' ')));
      // Speaking and discussion items have few formal markers, so their text
      // must also look like the task; a heading alone never makes a question.
      const wordCount = joined.split(/\s+/).filter(Boolean).length;
      const repeatText = body.map(l => l.text).filter(text => !/^\d+\s+words?$/i.test(text)).join(' ').trim();
      const repeatWords = repeatText.split(/\s+/).length;
      // Repeat targets are statements; a lone question is more likely a discussion prompt.
      const repeatLike = repeatWords >= 3 && repeatWords <= 35 && /[.!]["”]?$/.test(repeatText) && (repeatText.match(/[.?!]["”]?(?:\s|$)/g) || []).length === 1 && !/^[^.?!]{1,40}:/.test(repeatText);
      const type = hasRecipient ? 'email'
        : professor ? 'discussion'
          : kind === 'listen_repeat' && repeatLike ? 'listen_repeat'
            : kind === 'interview' && joined.includes('?') && wordCount <= 80 ? 'interview' : null;
      if (!type || !joined) { unassigned += all.length; continue; }
      const section = ['email', 'discussion'].includes(type) ? 'writing' : 'speaking';
      const label = { email: 'Write an Email', discussion: 'Write for an Academic Discussion', listen_repeat: 'Listen and Repeat', interview: 'Take an Interview' }[type];
      const target = outGroup(section, type, label);
      const q = { id: uniqueId(`${target.id}-q${it.number}`), type, prompt: joined.replace(/^Email Prompt\s*[:：]\s*/i, ''), options: [], answer: null, explanation: textOf(sample.filter(l => !SAMPLE_STOP.test(l.text) || /^(?:Sample|Model)/i.test(l.text))).replace(/^(?:Sample|Model) (?:answer|response|email|reply)\s*[:：]?\s*/i, ''), audio: null, image: null, timeLimitSeconds: 0, prepareSeconds: 0, source: sourceNote(it.line, `原文第 ${it.number} 条`), _number: it.number, _group: gi };
      if (type === 'listen_repeat') {
        q.answer = repeatText; q.prompt = 'Listen carefully and repeat what you heard.\n\n请先播放材料，再复述原句。';
        q.source += '；目标原句取自原文文字';
      }
      target.questions.push(q); questions.push(q);
    }
    // Passage and transcript text shared by this group's choice questions.
    for (const record of output.values()) if (record.questions.some(q => q.type === 'single_choice')) {
      const passage = textOf(g.passage.filter(l => !META.test(l.text)));
      const transcript = textOf(g.transcript);
      record.passage = [passage, transcript].filter(Boolean).join('\n\n');
      if (!record.passage && record.section === 'reading') record.title = g.title || 'Questions';
      if (record.section === 'listening') issues.push(issue('warning', `${record.title} 原文没有随附音频${g.links.length ? `（只有播放链接：${g.links.join('、')}）` : ''}；请补充音频文件后再按听力原题练习。`, `${record.id}.audio`));
    }
    if (!g.items.length) unassigned += g.passage.length + g.transcript.length;
    // The same number twice in one group is a boundary problem; no key is assigned.
    for (const record of output.values()) {
      const seen = new Map();
      for (const q of record.questions) seen.set(q._number, [...(seen.get(q._number) || []), q]);
      for (const [number, list] of seen) if (list.length > 1) {
        for (const q of list) q._duplicate = true;
        issues.push(issue('error', `${record.title} 的原题号 ${number} 重复，未分配答案，请复核题组和题目边界。`, `${record.id}.questions`));
      }
    }
  }

  // Keys: "N. B" answers a choice question, "N. <sentence>" a Build a Sentence
  // item. A key applies to the nearest preceding unkeyed question with that
  // number; the same number twice in that range is left for review.
  for (const key of keys) {
    if (!key.value) {
      // A key whose number stands alone: a lettered option line gives a choice
      // answer (a repeated stem may precede it); otherwise the next line is the
      // full Build a Sentence answer.
      const option = key.explanation.find(text => OPTION.test(text));
      if (option) { key.value = option.match(OPTION)[1]; key.explanation = key.explanation.slice(key.explanation.indexOf(option) + 1); }
      else if (key.explanation.length) key.value = key.explanation.shift();
      else continue;
    }
    const letter = key.value.match(/^\(?([A-F])\)?[.)]?$/);
    const type = letter ? 'single_choice' : 'sentence_order';
    const pool = questions.filter(q => q.type === type && q._number === key.number && q._group < key.block && !q._keyed && !q._duplicate);
    const previousBlock = Math.max(-1, ...keys.filter(other => other.block < key.block).map(other => other.block));
    const recent = pool.filter(q => q._group >= previousBlock);
    const candidates = recent.length ? recent : pool;
    if (candidates.length !== 1) {
      if (candidates.length > 1) issues.push(issue('error', `${where(key.line)} 的答案题号 ${key.number} 对应多道题，未自动判定。`, where(key.line)));
      else issues.push(issue('warning', `${where(key.line)} 的答案题号 ${key.number} 没有对应的题目。`, where(key.line)));
      continue;
    }
    const q = candidates[0];
    q._keyed = true;
    if (letter) q._inline = letter[1];
    else q._sentenceKey = key.value;
    const titleLine = outGroups.find(record => record.questions.includes(q))?.title;
    const note = key.explanation.filter(text => text !== titleLine).join('\n');
    if (note && !q.explanation) q.explanation = note;
    q.source += `；答案来自 ${where(key.line)}`;
  }

  for (const q of questions) {
    if (q.type === 'single_choice') {
      // A multiple-answer item cannot be a single choice; keep it as source text.
      if (/\b(?:choose|select|check|mark)\b[^.?]*\b(?:two|three|all|2|3)\b/i.test(q.prompt)) { issues.push(issue('error', `${q.source} 要求多项回答，当前单选题不能完整表示；原文已保留，未猜测题型。`, `${q.id}.type`)); q._drop = true; continue; }
      if (q._inline && q.options.some(option => option.id === q._inline)) q.answer = q._inline;
      else if (q._inline) issues.push(issue('error', `${q.source} 的答案无法对应本题选项。`, `${q.id}.answer`));
      else issues.push(issue('warning', `${q.source} 没有明确的本题答案键，保留为未评分。`, `${q.id}.answer`));
      if (q.options.length < 2 || q.options.some((option, index) => option.id !== 'ABCDEF'[index])) issues.push(issue('error', `${q.source} 的选项不完整或顺序不连续。`, `${q.id}.options`));
    } else if (q.type === 'sentence_order') {
      const fragments = q.options.map(option => option.text);
      const answer = q._sentenceKey?.replace(/^["“]|["”]$/g, '').trim() || null;
      const cover = answer ? coverSentence(answer, fragments) : null;
      if (cover) {
        q.sentenceFrame = cover.frame; q.answerSlots = cover.order.length;
        q.answer = cover.order.map(index => q.options[index].id); q.explanation = [answer, q.explanation].filter(Boolean).join('\n');
        const unused = q.options.filter((option, index) => !cover.order.includes(index)).map(option => option.text.toLowerCase());
        if (q._extras && q._extras.split(/\s*[,/]\s*/).map(word => word.toLowerCase().trim()).sort().join('|') !== unused.sort().join('|')) issues.push(issue('warning', `${q.source} 标注的多余词与按答案推出的不一致，请核对。`, `${q.id}.answer`));
      } else {
        issues.push(issue('error', `${q.source} ${answer ? '的答案不能唯一拆成给出的词块和固定文字' : '没有明示答案，无法确定句框与空位数'}；原文已保留，请手动补充。`, q.id));
      }
    } else if (['listen_repeat', 'interview'].includes(q.type)) {
      issues.push(issue('warning', `${q.source} 原文没有对应的音频文件；需要补充音频后才能按原题练习，也可以作为文字提示的口语练习。`, `${q.id}.audio`));
    }
    for (const key of Object.keys(q)) if (key.startsWith('_')) delete q[key];
  }

  const kept = outGroups.filter(record => {
    record.questions = record.questions.filter(q => !q._drop && (q.type !== 'sentence_order' || q.sentenceFrame));
    for (const q of record.questions) delete q._drop;
    return record.questions.length;
  });
  const count = kept.reduce((sum, record) => sum + record.questions.length, 0);
  if (!count) return { pack: null, issues, method: 'task-grammar', recognized: false, questionCount: 0 };
  if (unassigned) issues.push(issue('warning', `${unassigned} 行说明或内容未归入题目，已保留在来源中。`, 'sources'));
  issues.push(issue('warning', '已按 TOEFL 题型特征整理。请对照原文核对题组边界、选项、答案对应以及写作和口语题的完整题面。', 'pack'));
  const hash = createHash('sha256').update(chunks.map(chunk => chunk.text).join('\n')).digest('hex').slice(0, 16);
  const pack = { schemaVersion: 1, id: `import-${hash}`, version: '1.0.0', title: title.trim() || '待确认的练习资料', description: '按 TOEFL 题型特征从本地资料整理的待复核草稿。', rights: '', groups: kept };
  return { pack, issues, method: 'task-grammar', recognized: true, questionCount: count };
}
