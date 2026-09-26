import { esc, icon, duration } from './ui.mjs';

import { taskLabels } from './exam-labels.mjs';
export { taskLabels };
export const sectionLabels = Object.freeze({ reading: 'Reading', listening: 'Listening', writing: 'Writing', speaking: 'Speaking' });
export const isSpokenTask = task => ['listen_repeat', 'interview'].includes(task.kind);
export const isListeningTask = task => task.kind.startsWith('listen_') && task.kind !== 'listen_repeat';
export const sentenceSlots = question => question.answerSlots || (question.sentenceFrame?.match(/_{2,}/g) || []).length || question.options?.length || 0;
export const plainParagraphs = text => String(text || '').trim().split(/\n\s*\n/).filter(Boolean).map(p => `<p>${esc(p.replace(/\s*\n\s*/g, ' '))}</p>`).join('');
const lineText = text => esc(String(text || '').replace(/\s*\n\s*/g, ' '));
const passageText = text => String(text || '').split(/\n\s*\n/).map(lineText).join('<br><br>');
function instructionsMarkup(text) {
  const blocks=[];let paragraph=[],bullet=null,items=[];
  const flushParagraph=()=>{if(paragraph.length){blocks.push(`<p>${lineText(paragraph.join(' '))}</p>`);paragraph=[];}};
  const flushList=()=>{if(bullet!==null){items.push(bullet);bullet=null;}if(items.length){blocks.push(`<ul>${items.map(item=>`<li>${lineText(item)}</li>`).join('')}</ul>`);items=[];}};
  for(const raw of String(text||'').replace(/([^\n])\s+[•●]\s*/g,'$1\n• ').split('\n')){const line=raw.trim();if(!line){flushParagraph();flushList();continue;}if(/^[•●]\s*/.test(line)){flushParagraph();if(bullet!==null)items.push(bullet);bullet=line.replace(/^[•●]\s*/,'');continue;}if(/^(?:Write as much|An effective response|Write an email to)\b/i.test(line)){flushParagraph();flushList();}if(bullet!==null)bullet+=' '+line;else paragraph.push(line);}
  flushParagraph();flushList();return blocks.join('');
}

export function answerStatus(question, entry = {}, task) {
  if (entry.attemptId) return 'saved';
  if (['listen_repeat', 'interview'].includes(question.type)) return entry.recordingId ? 'answered' : 'unanswered';
  if (question.type === 'sentence_order') {
    const count = Array.isArray(entry.answer) ? entry.answer.filter(Boolean).length : 0;
    return count === 0 ? 'unanswered' : count === sentenceSlots(question) ? 'answered' : 'partial';
  }
  const value = String(entry.answer || '');
  if (!value.trim()) return 'unanswered';
  const anchor = task?.inlineBlanks?.anchors.find(a => a.questionId === question.id);
  return anchor && value.replace(/\s/g, '').length < anchor.missingLetterCount ? 'partial' : 'answered';
}

export function renderBlocks(blocks) {
  return (blocks || []).map(block => {
    if ((block.kind || block.type) === 'heading') return `<h3>${lineText(block.text)}</h3>`;
    if ((block.kind || block.type) === 'table') return `<table class="exam-source-table">${block.caption ? `<caption>${lineText(block.caption)}</caption>` : ''}<tbody>${(block.rows || []).map((row, i) => `<tr>${row.map(cell => `<${i === 0 && block.headerRow ? 'th' : 'td'}>${lineText(typeof cell === 'string' ? cell : cell.text)}</${i === 0 && block.headerRow ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</tbody></table>`;
    if (block.type === 'list') return `<ul>${(block.items || []).map(item => `<li>${lineText(item)}</li>`).join('')}</ul>`;
    if (block.type === 'image' && block.src) return `<img class="exam-source-image" src="${esc(block.src)}" alt="${esc(block.alt || 'Task illustration')}">`;
    return plainParagraphs(block.text);
  }).join('');
}

export function avatar(label = '', image = null) {
  if (image) return `<img class="exam-avatar" src="${esc(image)}" alt="${esc(label)}">`;
  return `<span class="exam-avatar" aria-hidden="true"><svg viewBox="0 0 80 80" fill="none"><circle cx="40" cy="40" r="39" fill="#e8f0ed"/><circle cx="40" cy="28" r="13" fill="#819e98"/><path d="M14 73c1-22 11-29 26-29s25 7 26 29" fill="#567970"/></svg></span>`;
}

export function renderInlineWords(task, group, answers) {
  const anchors = task.inlineBlanks?.anchors || [];
  if (!anchors.length) return `<section class="exam-unavailable"><h2>Complete the Words</h2><p>这段材料尚缺少可核对的填空位置。请回到材料整理，补齐题目中的空位。</p></section>`;
  let cursor = 0;
  const parts = [];
  for (const anchor of anchors) {
    const prefixStart = Number.isInteger(anchor.prefixStart) ? anchor.prefixStart : anchor.start;
    parts.push(lineText(group.passage.slice(cursor, prefixStart)));
    const value = String(answers[anchor.questionId]?.answer || '');
    const locked = Boolean(answers[anchor.questionId]?.attemptId);
    const prefix = group.passage.slice(prefixStart, anchor.start);
    const suffix = group.passage.slice(anchor.end).match(/^[A-Za-z]+/)?.[0] || '';
    parts.push(`<span class="exam-word" role="group" aria-label="Question ${anchor.localNumber || ''}, ${esc(prefix.trim())}, ${anchor.missingLetterCount} missing letters"><span>${lineText(prefix)}</span><span class="exam-letter-cells">${Array.from({ length: anchor.missingLetterCount }, (_, i) => `<input class="exam-letter" data-qid="${esc(anchor.questionId)}" data-letter-index="${i}" value="${esc(value[i] === ' ' ? '' : value[i] || '')}" aria-label="Question ${anchor.localNumber || ''}, letter ${i + 1} of ${anchor.missingLetterCount}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" inputmode="text" ${locked ? 'disabled' : ''}>`).join('')}</span><span>${esc(suffix)}</span></span>`);
    cursor = anchor.end + suffix.length;
  }
  parts.push(lineText(group.passage.slice(cursor)));
  return `<section class="exam-cloze"><h1>Fill in the missing letters in the paragraph.</h1><p class="exam-letter-hint" id="letter-help">Complete a word to move to the next blank automatically. Use Tab to move between words.</p><div class="exam-cloze-passage" id="inline-passage">${parts.join('')}</div></section>`;
}

function renderChoices(question, entry = {}) {
  return `<fieldset class="exam-options" aria-label="Answer choices">${(question.options || []).map(option => `<label class="exam-option"><input type="radio" name="answer" value="${esc(option.id)}" ${entry.answer === option.id ? 'checked' : ''} ${entry.attemptId ? 'disabled' : ''}><span>${lineText(option.text)}</span></label>`).join('')}</fieldset>`;
}

function readingDocument(task, group, question, entry) {
  const p = task.presentation || {};
  const doc = p.document || p.readingDocument || {};
  const blocks = (doc.blocks || p.blocks || []).filter((block,index)=>!(index===0&&block.kind==='heading'&&block.text===doc.title));
  let content = blocks.length ? renderBlocks(blocks) : plainParagraphs(group.passage);
  if(question.interaction){
    let cursor=0;const chunks=[];const spec=question.interaction;
    for(const candidate of spec.candidates){chunks.push(passageText(group.passage.slice(cursor,candidate.start)));const selected=entry?.answer===candidate.id;chunks.push(`<button class="exam-passage-candidate ${spec.kind==='sentence_insert'?'insert-point':'sentence-choice'} ${selected?'selected':''}" data-candidate="${esc(candidate.id)}" aria-pressed="${selected}" aria-label="${spec.kind==='sentence_insert'?'Insert at':'Select sentence'} ${esc(candidate.id)}" ${entry?.attemptId?'disabled':''}>${spec.kind==='sentence_insert'?selected&&spec.sentence?lineText(spec.sentence):'■':lineText(group.passage.slice(candidate.start,candidate.end))}</button>`);cursor=candidate.end;}
    chunks.push(passageText(group.passage.slice(cursor)));content=`<div class="exam-interactive-passage">${chunks.join('')}</div>`;
  }
  const type = doc.kind || doc.type || p.documentType || 'plain';
  return `<article class="exam-reading-source ${task.kind === 'read_daily' ? 'exam-daily-source' : ''} ${type === 'email' ? 'exam-source-email' : ''}">
    ${doc.title ? `<h2>${lineText(doc.title)}</h2>` : ''}
    ${type === 'email' ? `<div class="exam-source-mailhead">${['from','to','date','subject'].filter(key => doc[key]).map(key => `<p><b>${key[0].toUpperCase() + key.slice(1)}:</b> ${lineText(doc[key])}</p>`).join('')}</div>` : ''}
    ${group.image ? `<img class="exam-source-image" src="${esc(group.image)}" alt="Reading material illustration">` : ''}${content}
  </article>`;
}

function renderReadingChoice(task, group, question, entry) {
  const insert=question.interaction?.sentence, prompt=insert&&question.prompt.trim().endsWith(insert)?question.prompt.trim().slice(0,-insert.length).trim():question.prompt;
  return `<section class="exam-reading-choice"><div class="exam-reading-pane">${readingDocument(task, group, question, entry)}</div><div class="exam-choice-pane"><h1 class="exam-question">${lineText(prompt)}</h1>${insert ? `<p class="exam-insert-sentence">${lineText(insert)}</p>` : ''}${question.image ? `<img class="exam-source-image" src="${esc(question.image)}" alt="Question illustration">` : ''}${question.interaction ? '<p>Select your answer in the passage.</p>' : renderChoices(question, entry)}</div></section>`;
}

export function renderSentence(question, entry = {}, presentation = {}) {
  const parts = (question.sentenceFrame || Array(sentenceSlots(question)).fill('_____').join(' ')).split(/_{2,}/);
  const answer = Array.isArray(entry.answer) ? entry.answer : [];
  const options = question.options || [];
  const frame = parts.map((part, i) => `${lineText(part)}${i < parts.length - 1 ? `<button type="button" class="exam-sentence-slot ${answer[i] ? 'filled' : ''}" data-slot="${i}" data-remove="${i}" aria-label="Word position ${i + 1}${answer[i] ? `, ${esc(options.find(o => o.id === answer[i])?.text || '')}; remove word` : ', empty'}" ${entry.attemptId ? 'disabled' : ''} draggable="${Boolean(answer[i])}">${answer[i] ? lineText(options.find(o => o.id === answer[i])?.text) : '<span aria-hidden="true">&nbsp;</span>'}</button>` : ''}`).join('');
  const prompt = presentation.asker?.text || presentation.asker?.content || question.prompt.replace(question.sentenceFrame || '\0', '').trim();
  return `<section class="exam-sentence"><h1>Make an appropriate sentence.</h1><div class="exam-dialogue"><div class="exam-dialogue-row">${avatar('First speaker', presentation.asker?.image)}<p>${lineText(prompt)}</p></div><div class="exam-dialogue-row">${avatar('Second speaker', presentation.responder?.image)}<div class="exam-sentence-answer" id="ordered-tokens">${frame}</div></div></div><div class="exam-word-bank" id="available-tokens" aria-label="Words to use">${options.map(option => `<button class="exam-word-token ${answer.includes(option.id) ? 'used' : ''}" data-token="${esc(option.id)}" draggable="${!answer.includes(option.id)}" ${answer.includes(option.id) || entry.attemptId ? 'disabled' : ''}>${lineText(option.text)}</button>`).join('')}</div><p class="exam-sr" id="sentence-progress" role="status">${answer.filter(Boolean).length} of ${sentenceSlots(question)} positions filled. Click or drag words into the sentence.</p></section>`;
}

function editor(question, entry, { email = null } = {}) {
  return `${email ? `<p class="exam-response-label">Your Response:</p><div class="exam-email-head">${email.to ? `<p><b>To:</b> ${lineText(email.to)}</p>` : ''}${email.subject ? `<p><b>Subject:</b> ${lineText(email.subject)}</p>` : ''}</div>` : ''}<div class="exam-editor"><div class="exam-editor-tools"><div><button data-edit="cut">Cut</button><button data-edit="paste">Paste</button><button data-edit="undo">Undo</button><button data-edit="redo">Redo</button></div><div class="exam-word-count"><button id="toggle-word-count">Hide Word Count</button><span id="word-count">${String(entry.answer || '').trim().split(/\s+/).filter(Boolean).length}</span></div></div><textarea id="answer-input" aria-label="Your response" maxlength="30000" spellcheck="false" autocorrect="off" autocapitalize="off" ${entry.attemptId ? 'readonly' : ''}>${esc(entry.answer || '')}</textarea></div>`;
}

function emailContent(question, presentation) {
  const supplied = presentation.email || {};
  const to = supplied.to || question.prompt.match(/(?:^|\n)To:\s*([^\n]+)/)?.[1] || '';
  const subject = supplied.subject || question.prompt.match(/(?:^|\n)Subject:\s*([^\n]+)/)?.[1] || '';
  const text = supplied.body || supplied.text || question.prompt.replace(/(?:^|\n)Your Response:[\s\S]*$/i, '').replace(/^[\s\S]*?You will have \d+ minutes? to write the email\.\s*/i,'').replace(/^Write an Email\s*/i, '').trim();
  return { to, subject, text };
}

function renderEmail(task, group, question, entry) {
  const email = emailContent(question, task.presentation || {});
  return `<section class="exam-writing exam-email" aria-label="Write an Email"><div class="exam-writing-directions">${instructionsMarkup(email.text)}</div><div class="exam-writing-response">${editor(question, entry, { email })}</div></section>`;
}

function renderDiscussion(task, group, question, entry) {
  const p = task.presentation || {};
  const discussion = p.discussion || p.academic || {};
  const posts = discussion.posts || discussion.participants || [];
  const instructions = discussion.instructions || '';
  const intro = instructions.includes('Your professor') ? instructions.slice(instructions.indexOf('Your professor')) : instructions.replace(/^Write for an Academic Discussion\s*/i,'');
  const postMarkup = (post, professor = false) => `<article class="exam-discussion-post ${professor ? 'exam-professor-post' : ''}"><div>${avatar(post.speaker || post.name || post.role, post.image)}<strong>${lineText(post.speaker || post.name || post.role)}</strong></div><div>${plainParagraphs(post.text || post.content)}</div></article>`;
  return `<section class="exam-writing exam-discussion" aria-label="Write for an Academic Discussion"><div class="exam-writing-directions">${intro ? instructionsMarkup(intro) : ''}${discussion.prompt ? postMarkup({speaker:'Professor',text:discussion.prompt},true) : !posts.length ? instructionsMarkup(question.prompt.replace(/^Write for an Academic Discussion\s*/i, '')) : ''}</div><div class="exam-writing-response"><div class="exam-student-posts">${posts.map(post => postMarkup(post)).join('')}</div>${editor(question, entry)}</div></section>`;
}

export function mediaMarkup(source, { speaking = false, image = null, mode = 'practice', sourceName = source } = {}) {
  if (!source) return `<div class="exam-media-missing">这道题未附可播放的材料。请回到题库补齐音频。</div>`;
  // A supplied MP4 may contain a video stimulus. The video element also plays audio-only MP4.
  const video = /\.mp4(?:$|\?)/i.test(sourceName);
  return `<div class="exam-stimulus">${image && !video ? `<img class="exam-stimulus-image" src="${esc(image)}" alt="Task illustration">` : ''}${video ? `<video id="prompt-audio" class="exam-stimulus-video" playsinline preload="metadata" src="${esc(source)}" ${mode === 'practice' ? 'controls' : ''}></video>` : `<div class="exam-listen-symbol" aria-hidden="true">${icon(speaking ? 'mic' : 'headphones')}</div><audio id="prompt-audio" preload="metadata" src="${esc(source)}"></audio>`}<div class="exam-audio-player"><button id="play-stimulus" aria-label="Play audio">${icon('play')}</button>${mode==='practice'?'<input id="audio-progress" type="range" min="0" max="1" step="0.001" value="0" aria-label="Playback position">':'<progress id="audio-progress" value="0" max="1" aria-label="Playback progress"></progress>'}<span id="audio-time">00:00 / 00:00</span>${mode==='practice'?'<select id="audio-rate" aria-label="Playback speed"><option value="0.75">0.75×</option><option value="1" selected>1.0×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2.0×</option></select>':''}</div><p id="media-status" class="exam-media-status">Listen carefully.</p></div>`;
}

function renderSpeaking(task, group, question, entry, phase, recording, mode) {
  const image = question.image || group.image;
  return `<section class="exam-speaking"><h1>${task.kind === 'listen_repeat' ? 'Listen and repeat what you hear.' : 'Answer the question.'}</h1>${image ? `<img class="exam-speaking-image" src="${esc(image)}" alt="Task illustration">` : ''}<div class="exam-recorder ${recording?.active ? 'recording' : ''}"><div class="exam-record-symbol">${icon('mic')}</div><div class="exam-record-status" id="record-status">${phase === 'prepare' ? 'Preparation Time' : recording?.saving ? 'Saving your response…' : recording?.active ? 'Recording…' : entry.recordingId ? 'Your response has been saved.' : recording?.exhausted ? 'Response time has ended. Select Next to continue.' : 'Begin speaking when recording starts.'}</div><strong class="exam-record-clock" id="record-duration">${duration(Math.ceil(recording?.remaining || 0))}</strong><progress id="record-progress" max="1" value="0"></progress><button id="record-toggle" class="exam-action" ${mode==='exam'&&entry.recordingId&&!recording?.active?'hidden':''} ${recording?.saving || recording?.pending || (!recording?.active&&recording?.exhausted) ? 'disabled' : ''}>${recording?.active ? 'Stop Recording' : entry.recordingId ? 'Record Again' : 'Start Recording'}</button><button id="record-save-retry" class="exam-action" ${recording?.pending && !recording?.saving ? '' : 'hidden'}>重试保存录音</button></div>${entry.recordingUrl ? `<div class="exam-own-recording"><audio controls src="${esc(entry.recordingUrl)}" aria-label="Your saved response"></audio></div>` : ''}</section>`;
}

function replySpeaker(image) {
  if(image)return `<img class="exam-reply-speaker" src="${esc(image)}" alt="Speaker">`;
  return '<svg class="exam-reply-speaker" viewBox="0 0 260 330" aria-hidden="true"><path d="M41 322l10-129c4-35 39-55 79-55s76 20 80 55l9 129" fill="#728f83"/><path d="M95 133l35 42 35-42-11 54h-48" fill="#f1ede5"/><path d="M111 112h38v43c-10 19-29 19-38 0" fill="#b7c9bf"/><ellipse cx="130" cy="79" rx="48" ry="60" fill="#c7d7ce"/><path d="M83 75C67 3 188-15 180 81l-17-39-61 3" fill="#4b635e"/><path d="M103 238v84M160 238v84" stroke="#5b766b" stroke-width="3"/></svg>';
}

function renderLegacyBlank(group, question, entry) {
  const prompt=String(question.prompt||''),gaps=[...prompt.matchAll(/_{2,}/g)];
  const input=`<input id="answer-input" class="exam-short-answer" type="text" aria-label="Answer" value="${esc(entry.answer||'')}" maxlength="2000" spellcheck="false" autocorrect="off" autocapitalize="off" ${entry.attemptId?'readonly':''}>`;
  const sentence=gaps.length===1?lineText(prompt.slice(0,gaps[0].index))+input+lineText(prompt.slice(gaps[0].index+gaps[0][0].length)):lineText(prompt)+`<p>${input}</p>`;
  return `<section class="exam-legacy-blank">${group.passage?plainParagraphs(group.passage):''}<div class="exam-blank-sentence">${sentence}</div></section>`;
}

export function renderTask({ task, group, question, answers, phase, mode, source, sourceName, direction, recording }) {
  const entry = answers[question.id] || {};
  if (phase === 'directions') return `<section class="exam-direction"><h1>${taskLabels[task.kind]}</h1>${plainParagraphs(direction?.text || task.presentation?.instructions || '')}${source ? mediaMarkup(source, { mode, sourceName }) : '<p>Click Continue to begin.</p>'}</section>`;
  if (phase === 'stimulus') return `<section class="exam-listening"><h1>${task.kind === 'interview' ? 'Listen to the interviewer.' : taskLabels[task.kind]}</h1>${mediaMarkup(source, { speaking: isSpokenTask(task), image: question.image || group.image, mode, sourceName })}</section>`;
  if (task.kind === 'complete_words') return !group.taskKind&&task.screen==='one_question'&&!task.inlineBlanks?renderLegacyBlank(group,question,entry):renderInlineWords(task, group, answers);
  if (['read_daily', 'read_academic'].includes(task.kind)) return renderReadingChoice(task, group, question, entry);
  if (task.kind === 'build_sentence') return renderSentence(question, entry, task.presentation);
  if (task.kind === 'write_email') return renderEmail(task, group, question, entry);
  if (task.kind === 'academic_discussion') return renderDiscussion(task, group, question, entry);
  if (isSpokenTask(task)) return renderSpeaking(task, group, question, entry, phase, recording, mode);
  if(isListeningTask(task))return `<section class="exam-listening exam-reply ${task.kind==='listen_response'?'':'exam-listen-article'}">${task.kind==='listen_response'?'<h1>Choose the best response</h1>':''}<div class="exam-reply-columns"><div class="exam-reply-side">${replySpeaker(question.image||group.image)}${mode==='practice'&&source?mediaMarkup(source,{mode,sourceName}):''}</div><div class="exam-reply-choices">${task.kind==='listen_response'?'':`<h1 class="exam-question">${task.presentation?.questionPromptVisibility==='review'?'Choose the best answer.':lineText(question.prompt)}</h1>`}${renderChoices(question,entry)}</div></div></section>`;
  return `<section class="exam-listening exam-listening-response"><h1 class="exam-question">${task.presentation?.questionPromptVisibility === 'review' || task.kind === 'listen_response' ? 'Choose the best response.' : lineText(question.prompt)}</h1>${renderChoices(question, entry)}</section>`;
}
