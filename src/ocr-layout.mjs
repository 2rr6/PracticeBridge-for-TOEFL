// Turns OCR evidence for one page into the same positioned text chunk that the
// PDF text layer produces, so scanned pages go through the ordinary document
// readers. Repairs are limited to exam structure that has a fixed printed form
// (question labels, option letters, answer-key rows and blank runs); body text
// is never rewritten. Every repair and every low-confidence word is recorded.

const LOW_CONFIDENCE = 60;
const LABEL = /^(Questions?|Passage|Item|Set|Part|Module|Task|Section)(\d{1,3}(?:[-–]\d{1,3})?[.:]?)$/i;
const KEY_TOKEN = /^(\d{1,3})[.)]([A-Ea-e08]|Cc|cc)$/;
const OPTION_JOINED = /^\(?([A-E])[.)]([A-Za-z'"‘“].*)$/;
// Task directions printed in official 2026 tests (lines seen in at least two).
// A line that equals one of them once spaces are ignored is restored to it.
const DIRECTIONS = ["Answer questions about academic passages.","Answer questions about announcements and","Answer questions about announcements and academic","Answer questions about everyday reading material.","Answer questions about short conversations.","Answer questions from the interviewer Take an Interview","Build a Sentence","Build a Sentence Create a grammatical sentence.","Choose the best response.","Complete the Words Fill in the missing letters in a paragraph.","Fill in the missing letters in the paragraph.","Listen and Choose a","Listen and Repeat","Listen and Repeat Listen and repeat what you heard","Listen to a conversation.","Listen to a talk in a chemistry class.","Listen to a talk in a neuroscience class.","Listen to a talk in an economics class.","Listen to a talk in an environmental science class.","Listen to an announcement in a classroom.","Listen to an announcement in a student lounge.","Listen to an announcement on a campus radio station.","Listen to an announcement on the campus radio station.","Listen to announcements","Make a contribution to the discussion in your own words.","Make an appropriate sentence.","Read a notice.","Read an Academic","Read an Academic Passage","Read an Academic Passage Answer questions about academic passages.","Read an advertisement.","Read an email.","Read in Daily Life","Read in Daily Life Answer questions about everyday reading material.","Select the best response to the question or statement.","Take an Interview","Take an Interview Answer questions from the interviewer","Write an Email","Write an Email Write an email using information provided.","Write an email using information provided.","Write as much as you can and in complete sentences.","Write for an Academic","Write for an Academic Discussion","You will have 7 minutes to write the email.","You will read some information and use the information to write an email."];
const squash = text => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const DIRECTION_BY_KEY = new Map(DIRECTIONS.map(line => [squash(line), line]));
const LEADING_JOIN = /^(Fill)(in)$|^(Listen)(to|and)$|^(Read)(an?|in)$|^(Answer)(questions)$|^(Make)(an?)$|^(Choose)(the|a)$|^(Write)(an?|for|as)$|^(Take)(an)$|^(Build)(a)$|^(Complete)(the)$/;
const KEY_MIN_CONFIDENCE = 50;
const KEY_LETTER = { A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', 0: 'D', O: 'D', o: 'D', 8: 'B', Cc: 'C', cc: 'C' };

const splitWord = (word, parts) => {
  // Divide the box in proportion to characters; each part keeps the word's confidence.
  const total = parts.reduce((n, p) => n + p.length, 0) || 1, width = word.bbox.x1 - word.bbox.x0;
  let x = word.bbox.x0;
  return parts.map(text => { const w = width * text.length / total, box = { ...word.bbox, x0: x, x1: x + w }; x += w; return { ...word, text, bbox: box }; });
};

function groupLines(words) {
  const lines = new Map();
  for (const word of words) {
    if (!word.text || !word.text.trim()) continue;
    const key = Number.isInteger(word.line) ? word.line : Math.round((word.bbox.y0 + word.bbox.y1) / 2 / 12);
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ ...word, text: word.text.trim() });
  }
  return [...lines.values()].map(line => line.sort((a, b) => a.bbox.x0 - b.bbox.x0))
    .sort((a, b) => Math.min(...a.map(w => w.bbox.y0)) - Math.min(...b.map(w => w.bbox.y0)) || a[0].bbox.x0 - b[0].bbox.x0);
}

function repairLine(line, repairs) {
  let out = [];
  for (let word of line) {
    const label = LABEL.exec(word.text);
    if (label) { out.push(...splitWord(word, [label[1], label[2]])); repairs.push({ kind: 'label_spacing', from: word.text }); continue; }
    const key = KEY_TOKEN.exec(word.text);
    if (key) { out.push(...splitWord(word, [key[1] + '.', key[2]])); repairs.push({ kind: 'key_spacing', from: word.text }); continue; }
    // "3.6 words" is item 3 with a six-word count, and "6words" is "6 words".
    const counted = out.length === 0 && line[1]?.text && /^words?$/i.test(line[1].text) ? /^(\d{1,3}\.)(\d{1,2})$/.exec(word.text) : null;
    if (counted) { out.push(...splitWord(word, [counted[1], counted[2]])); repairs.push({ kind: 'label_spacing', from: word.text }); continue; }
    const glued = /^(\d{1,2})(words?)$/i.exec(word.text);
    if (glued) { out.push(...splitWord(word, [glued[1], glued[2]])); repairs.push({ kind: 'count_spacing', from: word.text }); continue; }
    const option = out.length === 0 ? OPTION_JOINED.exec(word.text) : null;
    if (option) { out.push(...splitWord(word, [option[1] + '.', option[2]])); repairs.push({ kind: 'option_spacing', from: word.text }); continue; }
    // Hyphen blanks: touching hyphens are often read as one long dash. Inside a
    // blank an em dash stands for two hyphens and an en dash for one.
    if (/^[A-Za-z]*[-_]*[—–][-—–_]*[,.;:!?]?$/.test(word.text) && /[A-Za-z]|^[-—–]+$/.test(word.text)) {
      const text = word.text.replace(/—/g, '--').replace(/–/g, '-');
      repairs.push({ kind: 'blank_dash', from: word.text, to: text });
      word = { ...word, text };
    }
    // A blank ends where letters resume: "fr__therec_" is "fr__" then "therec_".
    const parts = /_[,.;:!?]?[A-Za-z]/.test(word.text) ? word.text.split(/(?<=_[,.;:!?]?)(?=[A-Za-z])/) : null;
    if (parts?.length > 1) { out.push(...splitWord(word, parts)); repairs.push({ kind: 'blank_split', from: word.text }); continue; }
    out.push(word);
  }
  // Blank runs: "care ___ _" and "rec_ __" keep their underscore count but
  // become one token attached to the stem, as printed. Trailing punctuation
  // ("_,") stays after the run. A Build a Sentence frame ("The ____ ____
  // fantastic.") is mostly separate slots, and each slot must stay a word.
  const slots = out.filter(word => /^_{3,}[,.;:!?]?$/.test(word.text)).length;
  const frame = slots >= 2 && slots / out.length >= 0.4;
  const merged = [];
  for (const word of out) {
    const previous = merged.at(-1), height = word.bbox.y1 - word.bbox.y0;
    if (previous && !frame && /^_+[,.;:!?]?$/.test(word.text) && /[A-Za-z_]$/.test(previous.text) && word.bbox.x0 - previous.bbox.x1 < Math.max(8, height * 1.2) && /_/.test(previous.text + word.text)) {
      merged[merged.length - 1] = { ...previous, text: previous.text + word.text, bbox: { ...previous.bbox, x1: word.bbox.x1 }, confidence: Math.min(previous.confidence ?? 100, word.confidence ?? 100) };
      repairs.push({ kind: 'blank_join', from: previous.text + ' ' + word.text });
      continue;
    }
    merged.push(word);
  }
  const first = merged[0] && LEADING_JOIN.exec(merged[0].text);
  if (first) { const parts = first.slice(1).filter(Boolean); merged.splice(0, 1, ...splitWord(merged[0], parts)); repairs.push({ kind: 'direction_spacing', from: parts.join('') }); }
  const direction = merged.length && DIRECTION_BY_KEY.get(squash(merged.map(w => w.text).join('')));
  if (direction && direction !== merged.map(w => w.text).join(' ')) {
    const whole = { ...merged[0], bbox: { ...merged[0].bbox, x1: merged.at(-1).bbox.x1 }, confidence: Math.min(...merged.map(w => w.confidence ?? 100)) };
    repairs.push({ kind: 'direction_spacing', from: merged.map(w => w.text).join(' '), to: direction });
    return splitWord(whole, direction.split(' '));
  }
  return merged;
}

const lineText = line => line.map(w => w.text).join(' ');

// "What time does it start2": a question sentence's final mark read as 2.
const QUESTION_START = /^(?:What|Where|When|Why|Who|Whom|Whose|Which|How|Do|Does|Did|Can|Could|Will|Would|Should|Is|Are|Was|Were|Have|Has|May)$/;
function repairQuestionMark(line, repairs) {
  const last = line.at(-1);
  if (line.length >= 3 && QUESTION_START.test(line[0].text) && /^[A-Za-z]{2,}2$/.test(last.text)) {
    repairs.push({ kind: 'question_mark', from: last.text });
    line[line.length - 1] = { ...last, text: last.text.slice(0, -1) + '?' };
  }
}

function repairQuestionLabels(lines, repairs) {
  // "Question" whose number was lost: the neighbouring labels give it.
  const labels = lines.map((line, index) => ({ line, index, m: /^Question$/.test(line[0]?.text || '') ? (line.length === 1 ? null : /^\d{1,3}$/.test(line[1].text) ? Number(line[1].text) : undefined) : undefined })).filter(item => item.m !== undefined);
  labels.forEach((item, i) => {
    if (item.m !== null) return;
    const before = labels[i - 1]?.m, after = labels[i + 1]?.m;
    const number = Number.isInteger(after) ? after - 1 : Number.isInteger(before) ? before + 1 : null;
    if (!Number.isInteger(number) || number < 1 || Number.isInteger(before) && before !== number - 1) return;
    repairs.push({ kind: 'question_number', from: 'Question', to: 'Question ' + number });
    item.line.push({ ...item.line[0], text: String(number), bbox: { ...item.line[0].bbox, x0: item.line[0].bbox.x1, x1: item.line[0].bbox.x1 + 12 }, repaired: true });
    item.m = number;
  });
}

function repairOptionLabels(lines, repairs) {
  // "(A)" printed labels often lose a bracket: "A)", "(A", "A]". Restore the
  // page's own style only when that style is already used on the page.
  const printed = lines.filter(line => /^\([A-E]\)$/.test(line[0]?.text || '')).length;
  if (printed < 2) return;
  for (const line of lines) {
    const m = /^[([{]?([A-E])[)\]}]?$/.exec(line[0]?.text || '');
    if (!m || line.length < 2 || line[0].text === '(' + m[1] + ')' || /^[A-E]$/.test(line[0].text) && !/^[A-Z(]/.test(line[1].text)) continue;
    repairs.push({ kind: 'option_label', from: line[0].text, to: '(' + m[1] + ')' });
    line[0] = { ...line[0], text: '(' + m[1] + ')' };
  }
}

function repairOptionRuns(lines, repairs) {
  // "A reversible" is an option only when neighbouring lines are lettered options.
  const letterOf = line => { const m = /^\(?([A-E])[.)]?$/.exec(line[0]?.text || ''); return m ? m[1] : null; };
  const explicit = line => /^\(?[A-E][.)]$/.test(line[0]?.text || '');
  for (let i = 0; i < lines.length; i++) {
    const letter = letterOf(lines[i]);
    if (!letter || explicit(lines[i]) || lines[i].length < 2) continue;
    const near = lines.slice(Math.max(0, i - 3), i + 4).filter((l, j) => l !== lines[i] && explicit(l)).length;
    if (near >= 2) { repairs.push({ kind: 'option_letter', from: lineText(lines[i]) }); lines[i][0] = { ...lines[i][0], text: letter + '.' }; }
  }
}

const DIGIT = { l: '1', I: '1', i: '1', '|': '1', O: '0', o: '0', S: '5', s: '5' };
const keyNumber = text => { const core = text.replace(/[.)]$/, ''); if (!/^[0-9lIi|OoSs]{1,3}$/.test(core) || !/[0-9]/.test(core) && !/^(?:ill|Il|lI|II|ll)$/.test(core)) return null; const n = Number([...core].map(c => DIGIT[c] ?? c).join('')); return Number.isInteger(n) ? n : null; };

function repairAnswerKey(lines, pageText, repairs, strict = true) {
  // A key row is a question number followed by a short answer; one or two
  // stray marks after it (table rule residue) are dropped and recorded.
  if (/answers*key/i.test(pageText)) for (const line of lines) if (line.length > 1 && /^[|[]{}]+$/.test(line[0].text)) { repairs.push({ kind: 'key_noise', from: line[0].text }); line.shift(); }
  const rows = [];
  for (const line of lines) {
    if (line.length < 2 || keyNumber(line[0].text) === null || line[1].text.length > 12) continue;
    const tail = line.slice(2);
    if (tail.length && !(tail.length <= 2 && tail.every(w => w.text.length <= 2 && !/^[A-E]$/.test(w.text)))) continue;
    if (tail.length) { repairs.push({ kind: 'key_residue', from: lineText(line) }); line.splice(2); }
    rows.push(line);
  }
  if (!(/answer\s*key|answers\b/i.test(pageText) || rows.length >= 5)) return;
  // Around the rows, a garbled "Question Number / Answer" header and the
  // remains of erased rules are not answers; they would otherwise be read as
  // unplaceable key lines or appended to the last answer.
  const firstRow = lines.indexOf(rows[0]);
  lines.forEach((line, index) => {
    if (!line.length || rows.includes(line)) return;
    const text = lineText(line), letters = text.replace(/[^A-Za-z]/g, '').length;
    const header = index < firstRow && !/\d/.test(text) && /estion|umber|nswer/i.test(text) && !/answer\s*key/i.test(text) && squash(text).length <= 30;
    // A lone letter or word can be an answer; only fragment runs and rule marks are residue.
    const residue = /[[\]|{}]/.test(text) && letters < text.replace(/\s/g, '').length * 0.6 || line.length >= 2 && !line.some(w => /[A-Za-z]{3,}/.test(w.text)) && !/\d/.test(text);
    if (header || residue) { repairs.push({ kind: header ? 'key_header' : 'key_noise', from: text }); line.splice(0); }
  });
  const numbers = rows.map(line => keyNumber(line[0].text));
  for (let i = 0; i < rows.length; i++) {
    const expected = i > 0 ? numbers[i - 1] + 1 : null;
    // Both neighbours agree on the count, so the middle number is known.
    if (expected !== null && numbers[i] !== expected && i + 1 < rows.length && numbers[i + 1] === expected + 1) numbers[i] = expected;
    const text = String(numbers[i]) + (rows[i][0].text.endsWith('.') ? '.' : '');
    if (text !== rows[i][0].text) { repairs.push({ kind: 'key_number', from: rows[i][0].text, to: text }); rows[i][0] = { ...rows[i][0], text, repaired: true }; }
  }
  // Letter answers only where the rows are lettered at all.
  const lettered = rows.filter(line => /^[A-E]$/.test(line[1].text)).length;
  if (lettered >= Math.max(2, rows.length / 3)) for (const line of rows) {
    const raw = line[1].text, letter = KEY_LETTER[raw], confidence = line[1].confidence ?? 100;
    // Without a proofreading pass, only unambiguous shapes are kept. In the
    // scan benchmarks a C read as "c"/"Cc" at any confidence and an "8" were
    // always right, while "0" stood for C or D and "a" for C.
    if (strict && letter && !(/^[A-E]$/.test(raw) && confidence >= KEY_MIN_CONFIDENCE || /^(?:c|Cc|cc|8)$/.test(raw))) {
      repairs.push({ kind: 'key_withheld', from: lineText(line), confidence: Math.round(confidence) });
      line[1] = { ...line[1], text: '[?]', repaired: true };
      continue;
    }
    if (letter && letter !== raw) { repairs.push({ kind: 'key_letter', from: lineText(line), to: letter }); line[1] = { ...line[1], text: letter, repaired: true }; }
  }
}

/**
 * evidence: projected OCR evidence (words with pixel boxes and Tesseract line
 * indexes). pagePoints: the page size in PDF points, used so layout thresholds
 * mean the same thing as for a text-layer PDF.
 */
export function ocrEvidenceToChunk(evidence, { name, page, pagePoints } = {}) {
  const dims = evidence?.source?.pageDimensions || { width: evidence?.source?.width, height: evidence?.source?.height };
  const offset = evidence?.source?.pixelRect || { x: 0, y: 0 };
  const points = pagePoints || { width: 612, height: 612 * dims.height / dims.width };
  const scale = dims.width / points.width;
  const repairs = [];
  let lines = groupLines(evidence?.words || []).map(line => repairLine(line, repairs));
  for (const line of lines) repairQuestionMark(line, repairs);
  repairQuestionLabels(lines, repairs);
  repairOptionLabels(lines, repairs);
  repairOptionRuns(lines, repairs);
  repairAnswerKey(lines, lines.map(lineText).join('\n'), repairs, evidence?.proofread !== true);
  lines = lines.filter(line => line.length);
  const items = [], lowConfidence = [];
  lines.forEach((line, index) => {
    // Runs split at wide gaps, like separate text items in a PDF table row.
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const x0 = Math.min(...run.map(w => w.bbox.x0)) + offset.x, x1 = Math.max(...run.map(w => w.bbox.x1)) + offset.x;
      const y0 = Math.min(...run.map(w => w.bbox.y0)) + offset.y, y1 = Math.max(...run.map(w => w.bbox.y1)) + offset.y;
      const height = (y1 - y0) / scale, x = x0 / scale, y = points.height - y1 / scale;
      items.push({ str: lineText(run), x, y, width: (x1 - x0) / scale, height, hasEOL: false, fontName: 'ocr', line: index + 1, transform: [height, 0, 0, height, x, y], ocrConfidence: Math.min(...run.map(w => w.confidence ?? 0)) });
      run = [];
    };
    for (const word of line) {
      const previous = run.at(-1), height = word.bbox.y1 - word.bbox.y0;
      if (previous && word.bbox.x0 - previous.bbox.x1 > Math.max(24 * scale, height * 2)) flush();
      run.push(word);
      if (Number.isFinite(word.confidence) && word.confidence < LOW_CONFIDENCE && /[A-Za-z0-9]/.test(word.text)) lowConfidence.push({ line: index + 1, text: word.text, confidence: Math.round(word.confidence) });
    }
    flush();
    items.at(-1).hasEOL = true;
  });
  return {
    name, page, kind: 'pdf', text: lines.map(lineText).join('\n'),
    layout: { width: points.width, height: points.height, transform: [1, 0, 0, -1, 0, points.height], rotation: 0, items },
    links: [], images: [],
    ocr: { lowConfidence, repairs, confidence: evidence?.confidence ?? null, mode: evidence?.recognitionMode || 'auto', proofread: evidence?.proofread === true,
      // Pixel box of each text line on the page picture, for showing the original.
      lineBoxes: lines.map(line => ({ x0: Math.min(...line.map(w => w.bbox.x0)) + offset.x, y0: Math.min(...line.map(w => w.bbox.y0)) + offset.y, x1: Math.max(...line.map(w => w.bbox.x1)) + offset.x, y1: Math.max(...line.map(w => w.bbox.y1)) + offset.y })) },
  };
}
