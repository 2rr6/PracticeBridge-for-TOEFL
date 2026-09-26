import {appFetch} from './auth-client.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildExamPageContext, createExamChat, resolveExamPage } from '../src/exam-chat-context.mjs';
import { createModels } from '../src/models.mjs';
import { startServer } from '../src/server.mjs';
import { canonicalJSON } from '../src/package.mjs';
import { createStore } from '../src/store.mjs';
import { createAssistantMemory } from '../src/assistant-memory.mjs';

// All questions, answers, audio bytes and provider replies are authored fixtures.
// Provider traffic is captured by an in-process double; no saved user workspace,
// credentials or real model service is read or contacted.
const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-results/exam-chat-tests');
const answer = text => ({ answer: text, recordingId: null, transcript: '', transcriptConfirmed: false, attemptId: null });
const choice = (id, prompt = `VISIBLE_QUESTION_${id}`) => ({ id, type: 'single_choice', prompt, options: [{ id: 'A', text: 'VISIBLE_OPTION_A' }, { id: 'B', text: 'VISIBLE_OPTION_B' }], answer: 'B', explanation: `HIDDEN_KEY_EXPLANATION_${id}`, transcript: `HIDDEN_QUESTION_TRANSCRIPT_${id}`, audio: 'PRIVATE_AUDIO_FILE.wav', image: 'PRIVATE_IMAGE_FILE.png' });
const groupFixtures = () => [
  { id: 'reading', section: 'reading', kind: 'read_daily', title: 'Original notice', passage: 'VISIBLE_READING_PASSAGE', transcript: 'HIDDEN_GROUP_TRANSCRIPT', questions: [choice('r1'), choice('r2')] },
  { id: 'words', section: 'reading', kind: 'complete_words', screen: 'all_questions', title: 'Original word completion', passage: 'VISIBLE_WORD_PASSAGE ca_ ma_', questions: [{ id: 'w1', type: 'fill_blank', prompt: 'Complete the word.', answer: 'HIDDEN_WORD_KEY_ONE' }, { id: 'w2', type: 'fill_blank', prompt: 'Complete another word.', answer: 'HIDDEN_WORD_KEY_TWO' }] },
  { id: 'sentence', section: 'writing', kind: 'build_sentence', title: 'Original sentence', passage: '', questions: [{ id: 's1', type: 'sentence_order', prompt: 'What does she do?\nShe _____ _____ .', sentenceFrame: 'She _____ _____ .', options: [{ id: 'A', text: 'reads' }, { id: 'B', text: 'carefully' }, { id: 'C', text: 'read' }], answer: ['A', 'B'], explanation: 'HIDDEN_SENTENCE_EXPLANATION' }] },
  { id: 'email', section: 'writing', kind: 'write_email', title: 'Original email', passage: '', questions: [{ id: 'e1', type: 'email', prompt: 'Write an Email\nYou will have 7 minutes to write the email.\nVISIBLE_EMAIL_INSTRUCTIONS\nYour Response:\nTo: friend@example.invalid\nSubject: Shared books', answer: 'HIDDEN_EMAIL_REFERENCE', explanation: 'HIDDEN_EMAIL_EXPLANATION' }] },
  { id: 'response', section: 'listening', kind: 'listen_response', title: 'Original response', passage: 'HIDDEN_LISTENING_PASSAGE', transcript: 'HIDDEN_LISTENING_TRANSCRIPT', audio: 'PRIVATE_AUDIO_FILE.wav', presentation: { questionPromptVisibility: 'review' }, questions: [choice('l1', 'HIDDEN_AUDIO_UTTERANCE_l1'), choice('l2', 'HIDDEN_AUDIO_UTTERANCE_l2')] },
  { id: 'conversation', section: 'listening', kind: 'listen_conversation', title: 'Original conversation', passage: 'HIDDEN_CONVERSATION_PASSAGE', transcript: 'HIDDEN_CONVERSATION_TRANSCRIPT', audio: 'PRIVATE_AUDIO_FILE.wav', questions: [choice('c1', 'VISIBLE_LISTENING_QUESTION')] },
  { id: 'repeat', section: 'speaking', kind: 'listen_repeat', title: 'Original repetition', passage: 'HIDDEN_SPEAKING_PASSAGE', transcript: 'HIDDEN_SPEAKING_TRANSCRIPT', questions: [{ id: 'p1', type: 'listen_repeat', prompt: 'HIDDEN_REPEAT_PROMPT', answer: 'HIDDEN_REPEAT_REFERENCE', transcript: 'HIDDEN_REPEAT_TRANSCRIPT', audio: 'PRIVATE_AUDIO_FILE.wav' }] },
  { id: 'interview', section: 'speaking', kind: 'interview', title: 'Original interview', passage: '', questions: [{ id: 'i1', type: 'interview', prompt: 'HIDDEN_INTERVIEW_PROMPT', answer: 'HIDDEN_INTERVIEW_REFERENCE', audio: 'PRIVATE_AUDIO_FILE.wav' }] },
];
function pageHarness(groupId = 'reading', responder = async () => ({ reply: 'Synthetic reply.', provider: 'mock', model: 'fixture' })) {
  const groups = groupFixtures(), group = groups.find(item => item.id === groupId), moduleId = `${group.section}-main`;
  const task = { id: groupId, groupId, kind: group.kind, questionIds: group.questions.map(question => question.id), screen: group.screen || 'one_question', presentation: group.presentation || {}, directions: [{ text: 'VISIBLE_DIRECTIONS_ONE', audio: 'PRIVATE_DIRECTIONS.wav' }, { text: 'VISIBLE_DIRECTIONS_TWO', audio: 'PRIVATE_DIRECTIONS_TWO.wav' }] };
  const module = { id: moduleId, title: 'Original module', tasks: [task], instructions: { text: 'VISIBLE_MODULE_INSTRUCTIONS' }, navigation: { review: 'module' } };
  const library = { libraryId: crypto.randomUUID(), contentHash: 'f'.repeat(64), originalPack: { groups } };
  const run = { sessionVersion: 2, id: crypto.randomUUID(), libraryId: library.libraryId, sourceHash: library.contentHash, mode: 'practice', revision: 4, assisted: true, finished: false, planSnapshot: { version: 1, id: 'original-set', sections: [{ id: group.section, section: group.section, modules: [module] }] }, cursor: { sectionId: group.section, moduleId, taskId: groupId, questionId: group.questions[0].id, phase: 'response', phaseIndex: 0 }, answers: {}, marked: {} };
  const state = { libraries: [library], sessions: [run], attempts: [] }, calls = []; let writerToken = crypto.randomUUID();
  const models = { chat: async input => { calls.push(structuredClone(input)); return responder(input, calls.length); } };
  const service = createExamChat({ readState: () => structuredClone(state), models, getWriterToken: () => writerToken });
  const ref = () => ({ writerToken, sessionId: run.id, expectedRevision: run.revision, moduleId: run.cursor.moduleId, taskId: run.cursor.taskId, questionId: run.cursor.questionId, phase: run.cursor.phase, phaseIndex: run.cursor.phaseIndex });
  return { state, run, group, task, module, library, calls, service, ref, rotate: () => { writerToken = crypto.randomUUID(); }, page: helper => buildExamPageContext(resolveExamPage(state, ref(), writerToken), helper), send: (extra = {}) => service.send({ message: 'Explain the visible original exercise.', requestId: crypto.randomUUID(), context: ref(), ...extra }) };
}
const noSecrets = value => { const json = JSON.stringify(value); assert.doesNotMatch(json, /HIDDEN_|PRIVATE_.*FILE|PRIVATE_DIRECTIONS/); };

test('actual request bodies drop preference-derived old answers when disabled or deleted',async t=>{
  const dataDir=await directory();t.after(()=>removeDirectory(dataDir));const store=await createStore({dataDir}),requests=[];
  const h=pageHarness(),memory=await createAssistantMemory({store,getEpoch:()=>h.ref().writerToken});
  const models=createModels({dataDir,fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'OLD_MEMORY_ANSWER_SENTINEL'}}]}));}});
  await models.updateSettings({provider:'compatible',baseUrl:'http://127.0.0.1:12345',model:'synthetic-memory',maxOutputTokens:1000,timeoutSeconds:5});
  let p=memory.preview();p=await memory.saveConfirmedPreference({profileId:p.profileId,expectedEpoch:p.expectedEpoch,expectedRevision:p.memoryRevision,key:'feedbackStyle',value:'brief',confirmed:true});
  const service=createExamChat({readState:()=>structuredClone(h.state),getWriterToken:()=>h.ref().writerToken,models,memory});
  const expectedBinding=models.binding();
  const send=(include,conversationId)=>service.send({context:h.ref(),message:'Explain this notice.',requestId:crypto.randomUUID(),conversationId,expectedBinding,memory:{include,profileId:p.profileId,memoryRevision:p.memoryRevision,expectedEpoch:p.expectedEpoch}});
  const included=await send(true);assert.match(JSON.stringify(requests[0]),/反馈详略：简要/);
  await send(false,included.conversationId);assert.doesNotMatch(JSON.stringify(requests[1]),/OLD_MEMORY_ANSWER_SENTINEL|反馈详略：简要/);
  await send(true,included.conversationId);assert.doesNotMatch(JSON.stringify(requests[2]),/OLD_MEMORY_ANSWER_SENTINEL/);
  p=await memory.deletePreference({profileId:p.profileId,expectedEpoch:p.expectedEpoch,expectedRevision:p.memoryRevision,preferenceId:p.preferences[0].memoryId});
  const deleted=await send(true,included.conversationId);assert.notEqual(deleted.conversationId,included.conversationId);assert.doesNotMatch(JSON.stringify(requests[3]),/OLD_MEMORY_ANSWER_SENTINEL|反馈详略：简要/);
});

test('revocation between completed recall and model dispatch refuses the stale snapshot',async t=>{
  const dataDir=await directory();t.after(()=>removeDirectory(dataDir));const store=await createStore({dataDir});
  const h=pageHarness(),memory=await createAssistantMemory({store,getEpoch:()=>h.ref().writerToken});
  let p=memory.preview();p=await memory.saveConfirmedPreference({profileId:p.profileId,expectedEpoch:p.expectedEpoch,expectedRevision:p.memoryRevision,key:'feedbackStyle',value:'brief',confirmed:true});
  let calls=0;const delayedMemory={...memory,readAllowedPreferences:async input=>{const result=await memory.readAllowedPreferences(input);await memory.deletePreference({profileId:p.profileId,expectedEpoch:p.expectedEpoch,expectedRevision:p.memoryRevision,preferenceId:p.preferences[0].memoryId});return result;}};
  const service=createExamChat({readState:()=>structuredClone(h.state),getWriterToken:()=>h.ref().writerToken,models:{chat:async()=>{calls++;return {reply:'stale'};}},memory:delayedMemory});
  await assert.rejects(service.send({context:h.ref(),message:'Explain.',requestId:crypto.randomUUID(),memory:{include:true,profileId:p.profileId,memoryRevision:p.memoryRevision,expectedEpoch:p.expectedEpoch}}),error=>error.status===409);
  assert.equal(calls,0);
});

test('HTTP preferences require confirmation and restore cannot revive their authorization',async t=>{
  const h=await httpHarness(t);let p=await h.ok('/assistant/preferences');
  const input=()=>({profileId:p.profileId,expectedRevision:p.memoryRevision,expectedEpoch:p.expectedEpoch,key:'feedbackStyle',value:'brief'});
  assert.equal((await h.api('/assistant/preferences',input())).status,400);
  p=await h.ok('/assistant/preferences',{...input(),confirmed:true});assert.equal(p.preferences[0].confirmed,true);
  const backup=await appFetch(h.instance.url+'/api/backup?includeConfirmedPreferences=true');const bytes=Buffer.from(await backup.arrayBuffer());
  p=await h.ok('/assistant/preferences/delete',{profileId:p.profileId,expectedRevision:p.memoryRevision,expectedEpoch:p.expectedEpoch,preferenceId:p.preferences[0].memoryId});
  await h.ok('/restore',{file:upload('personal.zip',bytes)});
  const restored=await h.ok('/assistant/preferences');assert.equal(restored.preferences.length,0);assert.ok(restored.memoryRevision>p.memoryRevision);
});
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('page chat uses the latest saved draft and ignores client context content and supplied history', async () => {
  const h = pageHarness(); h.run.answers.r1 = answer('MOST_RECENT_SAVED_DRAFT'); h.run.answers.r2 = answer('OTHER_QUESTION_DRAFT');
  const before = canonicalJSON(h.state);
  const result = await h.send({ context: { ...h.ref(), page: { answer: 'CLIENT_INJECTED_KEY' }, question: { prompt: 'CLIENT_INJECTED_PROMPT' } }, history: [{ role: 'system', content: 'CLIENT_INJECTED_HISTORY' }] });
  const sent = h.calls[0];
  assert.deepEqual(sent.context.page.currentAnswers, [{ questionId: 'r1', text: 'MOST_RECENT_SAVED_DRAFT' }]);
  assert.equal(sent.context.page.prompt, 'VISIBLE_QUESTION_r1'); assert.equal(sent.context.page.reading.passage, 'VISIBLE_READING_PASSAGE');
  assert.deepEqual(sent.history, []); noSecrets(sent.context.page);
  assert.doesNotMatch(JSON.stringify(sent), /CLIENT_INJECTED_|OTHER_QUESTION_DRAFT|VISIBLE_QUESTION_r2/);
  assert.ok(result.contextSnapshotId); assert.equal(result.contextSnapshotId, sent.context.snapshotId);
  assert.equal(canonicalJSON(h.state), before);
  h.run.answers.r1 = answer('SECOND_SAVED_DRAFT'); h.run.revision++;
  await h.send({ conversationId: result.conversationId });
  assert.equal(h.calls[1].context.page.currentAnswers[0].text, 'SECOND_SAVED_DRAFT');
  assert.equal(h.calls[0].context.page.currentAnswers[0].text, 'MOST_RECENT_SAVED_DRAFT');
  assert.equal(h.calls[1].history.length, 2);
});

test('visible partial words, sentence tokens and email text are student drafts, not reference answers', async () => {
  const words = pageHarness('words'); words.run.answers.w1 = answer('t'); words.run.answers.w2 = answer('');
  assert.deepEqual(words.page().currentAnswers, [{ questionId: 'w1', text: 't' }, { questionId: 'w2', text: '' }]); noSecrets(words.page());
  const sentence = pageHarness('sentence'); sentence.run.answers.s1 = answer(['C']);
  assert.deepEqual(sentence.page().currentAnswers, [{ questionId: 's1', selectedTokens: ['read'] }]);
  assert.equal(sentence.page().sentenceFrame, 'She _____ _____ .'); noSecrets(sentence.page());
  const email = pageHarness('email'); email.run.answers.e1 = answer('Hi, these are the newest unfinished lines.');
  assert.equal(email.page().email.instructions, 'VISIBLE_EMAIL_INSTRUCTIONS');
  assert.equal(email.page().email.to, 'friend@example.invalid'); assert.equal(email.page().email.subject, 'Shared books');
  assert.equal(email.page().currentAnswers[0].text, 'Hi, these are the newest unfinished lines.'); noSecrets(email.page());
});

test('listening and speaking pages omit hidden utterances, keys, transcripts and media bytes', () => {
  for (const groupId of ['response', 'conversation', 'repeat', 'interview']) {
    const h = pageHarness(groupId), qid = h.run.cursor.questionId;
    h.run.answers[qid] = { ...answer(''), recordingId: 'PRIVATE_STUDENT_RECORDING_ID', transcript: 'PRIVATE_STUDENT_TRANSCRIPT', transcriptConfirmed: true };
    const page = h.page(); noSecrets(page);
    assert.equal(page.media.hasAudio, true);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE_STUDENT_/);
    if (['repeat', 'interview'].includes(groupId)) assert.deepEqual(page.currentAnswers, [{ questionId: qid, hasSavedRecording: true }]);
    if (groupId === 'response') assert.equal(page.prompt, 'Choose the best response.');
    if (groupId === 'conversation') assert.equal(page.prompt, 'VISIBLE_LISTENING_QUESTION');
  }
});

test('instructions, directions and stimulus snapshots contain only their displayed text', () => {
  const h = pageHarness('response'); h.run.answers.l1 = answer('A');
  h.run.cursor.phase = 'instructions'; let page = h.page();
  assert.equal(page.instructions.text, 'VISIBLE_MODULE_INSTRUCTIONS'); assert.equal(page.currentAnswers, undefined); assert.equal(page.options, undefined); noSecrets(page);
  h.run.cursor.phase = 'directions'; h.run.cursor.phaseIndex = 1; page = h.page();
  assert.equal(page.instructions, 'VISIBLE_DIRECTIONS_TWO'); assert.doesNotMatch(JSON.stringify(page), /VISIBLE_DIRECTIONS_ONE/); assert.equal(page.currentAnswers, undefined); noSecrets(page);
  h.run.cursor.phase = 'stimulus'; page = h.page(); assert.equal(page.instructions, 'Listen carefully.'); assert.equal(page.prompt, undefined); assert.equal(page.options, undefined); noSecrets(page);
});

test('writing review describes Time Remaining while reading review does not invent an answered empty array', () => {
  const writing = pageHarness('sentence'); writing.run.cursor.phase = 'review';
  assert.match(writing.page().review.instructions, /Time Remaining/); assert.equal(writing.page().review.questions, undefined); noSecrets(writing.page());
  const reading = pageHarness('words'); reading.run.cursor.phase = 'review'; reading.run.answers.w1 = answer([]); reading.run.answers.w2 = answer('t');
  assert.deepEqual(reading.page().review.questions.map(row => [row.id, row.answered]), [['w1', false], ['w2', true]]); noSecrets(reading.page());
});

test('only an explicitly exposed helper includes its material and closing it starts a clean history', async () => {
  const h = pageHarness('response', async input => ({ reply: input.context.page.openTranscriptPanel || (input.context.page.openReferencePanel ? 'HIDDEN_KEY_WAS_DISCLOSED_IN_THIS_REPLY' : 'Visible-only reply.') }));
  let receipt = await h.send(); noSecrets(h.calls.at(-1).context.page);
  h.service.expose(h.ref(), 'answers'); receipt = await h.send({ conversationId: receipt.conversationId });
  assert.equal(h.calls.at(-1).context.page.openReferencePanel.length, 2);
  assert.match(JSON.stringify(h.calls.at(-1).context.page.openReferencePanel), /HIDDEN_KEY_EXPLANATION_l1/);
  assert.equal(h.calls.at(-1).context.page.openTranscriptPanel, undefined);
  h.service.expose(h.ref(), 'answers'); const samePanel = await h.send({ conversationId: receipt.conversationId });
  assert.equal(samePanel.conversationId, receipt.conversationId); assert.equal(h.calls.at(-1).history.length, 2);
  h.service.expose(h.ref(), null); const hidden = await h.send({ conversationId: samePanel.conversationId });
  assert.notEqual(hidden.conversationId, samePanel.conversationId); assert.deepEqual(h.calls.at(-1).history, []); noSecrets(h.calls.at(-1).context.page);
  h.service.expose(h.ref(), 'transcript'); const shown = await h.send({ conversationId: hidden.conversationId });
  assert.match(h.calls.at(-1).context.page.openTranscriptPanel, /HIDDEN_LISTENING_TRANSCRIPT/); assert.match(h.calls.at(-1).context.page.openTranscriptPanel, /HIDDEN_QUESTION_TRANSCRIPT_l1/);
  assert.equal(h.calls.at(-1).context.page.openReferencePanel, undefined);
  h.service.expose(h.ref(), null); await h.send({ conversationId: shown.conversationId });
  assert.deepEqual(h.calls.at(-1).history, []); noSecrets(h.calls.at(-1).context.page);
});

test('a delayed reply belongs to its original question snapshot and cannot enter the new question history', async () => {
  const gate = defer(), entered = defer();
  const h = pageHarness('reading', async (input, index) => { if (index === 1) { entered.resolve(); return gate.promise; } return { reply: 'Only the second question was discussed.' }; });
  h.run.answers.r1 = answer('FIRST_QUESTION_SAVED'); const first = h.send(); await entered.promise;
  h.run.cursor.questionId = 'r2'; h.run.answers.r2 = answer('SECOND_QUESTION_SAVED'); h.run.revision++;
  const second = await h.send(); assert.deepEqual(h.calls[1].history, []);
  gate.resolve({ reply: 'FIRST_QUESTION_LATE_REPLY' }); const old = await first;
  assert.notEqual(old.scopeKey, second.scopeKey); assert.notEqual(old.conversationId, second.conversationId);
  assert.equal(h.calls[0].context.page.currentAnswers[0].text, 'FIRST_QUESTION_SAVED');
  assert.equal(h.calls[1].context.page.currentAnswers[0].text, 'SECOND_QUESTION_SAVED');
  await h.send({ conversationId: second.conversationId });
  assert.doesNotMatch(JSON.stringify(h.calls[2]), /FIRST_QUESTION_/);
});

test('forged or stale page identifiers fail before a model call, and restore rejects an in-flight reply', async () => {
  const h = pageHarness();
  for (const altered of [{ phase: 'review' }, { expectedRevision: 3 }, { questionId: 'r2' }, { taskId: 'other' }, { moduleId: 'other' }, { writerToken: 'expired' }]) {
    await assert.rejects(h.send({ context: { ...h.ref(), ...altered } }), error => error.status === 409);
  }
  assert.equal(h.calls.length, 0);
  h.run.assisted = false; assert.throws(() => h.service.expose(h.ref(), 'answers'), error => error.status === 403);
  const gate = defer(), entered = defer();
  const delayed = pageHarness('reading', async () => { entered.resolve(); return gate.promise; });
  const pending = delayed.send(); await entered.promise; delayed.rotate(); gate.resolve({ reply: 'An expired reply.' });
  await assert.rejects(pending, error => error.status === 409);
});

async function directory() { await fs.mkdir(TEST_ROOT, { recursive: true }); return fs.mkdtemp(path.join(TEST_ROOT, 'run-')); }
async function removeDirectory(dataDir) { const full = path.resolve(dataDir); assert.equal(path.dirname(full), TEST_ROOT); assert.ok(path.basename(full).startsWith('run-')); await fs.rm(full, { recursive: true, force: true }); }

test('the actual model adapter sends the page as quoted user material with the latest answer and no tools', async t => {
  const dataDir = await directory(); t.after(() => removeDirectory(dataDir)); const requests = [];
  const models = createModels({ dataDir, fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'A local model double response.' } }] }), { status: 200 }); } });
  await models.updateSettings({ provider: 'compatible', baseUrl: 'https://models.example.invalid', model: 'synthetic-unit-model', timeoutSeconds: 5, maxOutputTokens: 1000 });
  const h = pageHarness('email'); h.run.answers.e1 = answer('WIRE_LATEST_SAVED_TEXT');
  await models.chat({ message: 'Help with this draft.', context: { page: h.page(), snapshotId: crypto.randomUUID() }, history: [{ role: 'user', content: 'An earlier original question.' }], consent: true });
  assert.equal(requests.length, 1); const body = requests[0].body;
  assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none');
  assert.equal(body.messages[0].role, 'system'); assert.equal(body.messages[1].role, 'user');
  assert.match(body.messages[1].content, /WIRE_LATEST_SAVED_TEXT/); assert.match(body.messages[1].content, /currentAnswers/); assert.match(body.messages[1].content, /音频和图片没有发送/);
  noSecrets(body.messages[1].content); assert.equal(body.messages.at(-1).content, 'Help with this draft.');
});

const wave = (sample = 0) => { const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40); bytes.writeInt16LE(sample, 44); return bytes; };
const upload = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });
const httpPack = () => ({ schemaVersion: 1, examContractVersion: 1, minReaderVersion: '0.3.0', id: 'original-exam-chat-http', version: '1', title: 'Original chat HTTP material', groups: ['one', 'two'].map((word, index) => ({ id: word, section: 'reading', taskKind: 'read_daily', title: `Original notice ${word}`, passage: `VISIBLE_PASSAGE_${word}`, questions: [{ id: `q${index + 1}`, type: 'single_choice', prompt: `VISIBLE_PROMPT_${word}`, answer: 'B', explanation: `HIDDEN_EXPLANATION_${word}`, transcript: `HIDDEN_TRANSCRIPT_${word}`, options: [{ id: 'A', text: 'Visible choice one.' }, { id: 'B', text: 'Visible choice two.' }], source: 'Original unit test material.' }] })), examSets: [{ id: 'http-set', title: 'Original two-module set', sections: [{ id: 'reading', section: 'reading', title: 'Reading', modules: ['one', 'two'].map((id, index) => ({ id: `reading-${id}`, title: `Reading module ${index + 1}`, sourceNumber: index + 1, taskIds: [id] })) }] }] });
async function httpHarness(t) {
  const dataDir = await directory(), calls = [], feedbackCalls = [];
  const models = { publicSettings: () => ({ provider: 'mock', model: 'fixture', capabilities: { chat: true, feedback: true } }), chat: async input => { calls.push(structuredClone(input)); return { reply: 'An original local HTTP reply.', provider: 'mock', model: 'fixture' }; }, feedback: async input => { feedbackCalls.push(input); return { summary: 'A local feedback double.', strengths: [], corrections: [], revisedAnswer: '', modelAnswer: '', nextSteps: [], limitations: [], provider: 'mock', model: 'fixture' }; } };
  const h = { dataDir, models, calls, feedbackCalls, instance: await startServer({ dataDir, models }) };
  t.after(async () => { await h.instance.close(); await removeDirectory(dataDir); });
  h.api = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await appFetch(h.instance.url + '/api' + route, { method, headers: { 'X-PracticeBridge': '1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
  h.ok = async (...args) => { const result = await h.api(...args); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  h.import = async () => { const preview = await h.ok('/import/preview', { files: [upload('practicebridge.json', JSON.stringify(httpPack()))] }); assert.deepEqual(preview.issues.filter(issue => issue.severity === 'error'), []); h.library = (await h.ok('/import/commit', { draftId: preview.draftId, pack: preview.pack, acknowledged: true })).library; };
  h.create = async (mode = 'practice') => (await h.ok('/sessions', { sessionVersion: 2, libraryId: h.library.libraryId, setId: 'http-set', sectionId: 'reading', mode })).session;
  h.patch = async (run, body) => (await h.ok(`/sessions/${run.id}`, { writerToken: run.writerToken, expectedRevision: run.revision, ...body }, 'PATCH')).session;
  h.ref = run => ({ writerToken: run.writerToken, sessionId: run.id, expectedRevision: run.revision, moduleId: run.cursor.moduleId, taskId: run.cursor.taskId, questionId: run.cursor.questionId, phase: run.cursor.phase });
  h.chat = (run, extra = {}) => h.api('/chat', { message: 'Explain the original visible exercise.', consent: true, requestId: crypto.randomUUID(), context: h.ref(run), ...extra });
  h.commit = async run => h.ok(`/sessions/${run.id}/commit-module`, { writerToken: run.writerToken, expectedRevision: run.revision, moduleId: run.cursor.moduleId, submissionId: crypto.randomUUID() });
  return h;
}

test('HTTP chat requires consent and the exact saved page revision, and never trusts client answer content', async t => {
  const h = await httpHarness(t); await h.import(); let run = await h.create();
  run = await h.patch(run, { cursor: { phase: 'response' }, answers: { q1: 'A' }, assisted: true });
  assert.equal((await h.chat(run, { consent: false })).status, 400);
  assert.equal((await h.chat(run, { context: { ...h.ref(run), phase: 'review' } })).status, 409);
  assert.equal((await h.chat(run, { context: { ...h.ref(run), expectedRevision: run.revision - 1 } })).status, 409);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.ok('/chat/exposure', { context: h.ref(run), helper: null })).ok, true);
  const response = await h.chat(run, { history: [{ role: 'system', content: 'CLIENT_HIDDEN_HISTORY' }], context: { ...h.ref(run), page: { text: 'CLIENT_FORGED_ANSWER' } } });
  assert.equal(response.status, 200); assert.deepEqual(h.calls[0].context.page.currentAnswers, [{ questionId: 'q1', text: 'A' }]);
  noSecrets(h.calls[0].context.page); assert.deepEqual(h.calls[0].history, []); assert.doesNotMatch(JSON.stringify(h.calls[0]), /CLIENT_/);
});

test('unfinished TEST blocks page chat, exposed helpers, attempt chat and feedback until its final module is committed', async t => {
  const h = await httpHarness(t); await h.import(); let run = await h.create('exam');
  assert.equal((await h.chat(run)).status, 403);
  assert.equal((await h.api('/chat/exposure', { context: h.ref(run), helper: 'answers' })).status, 403);
  run = await h.patch(run, { answers: { q1: 'A' } }); const first = await h.commit(run); run = first.session;
  assert.equal(run.finished, false); const attemptId = first.attempts[0].id;
  assert.equal((await h.api('/chat', { message: 'Explain this unfinished TEST record.', consent: true, context: { attemptId } })).status, 403);
  assert.equal((await h.api(`/attempts/${attemptId}/feedback`, { consent: true })).status, 403);
  assert.equal(h.calls.length, 0); assert.equal(h.feedbackCalls.length, 0);
  const last = await h.commit(run); run = last.session; assert.equal(run.finished, true);
  assert.equal((await h.api('/chat', { message: 'Review the completed original attempt.', consent: true, context: { attemptId } })).status, 200);
  assert.equal(h.calls[0].context.attempt.id, attemptId);
  assert.equal((await h.chat(run)).status, 200); assert.ok(h.calls[1].context.page.completed);
});

test('recording upload IDs are idempotent under retries, reject conflicting audio and survive restart', async t => {
  const h = await httpHarness(t), uploadId = crypto.randomUUID(), bytes = wave(100), body = { ...upload('original.wav', bytes), uploadId };
  const responses = await Promise.all([h.ok('/recordings', body), h.ok('/recordings', body), h.ok('/recordings', body)]);
  assert.deepEqual(responses, Array(3).fill(responses[0])); assert.equal(responses[0].recordingId, uploadId);
  const before = JSON.parse(await fs.readFile(path.join(h.dataDir, 'state.json'), 'utf8'));
  assert.equal(Object.keys(before.recordings).length, 1); assert.equal(Object.keys(before.blobs).length, 1);
  const media = Buffer.from(await (await appFetch(h.instance.url + responses[0].url)).arrayBuffer()); assert.deepEqual(media, bytes);
  const conflict = await h.api('/recordings', { ...upload('different.wav', wave(200)), uploadId }); assert.equal(conflict.status, 409);
  const malformed = await h.api('/recordings', { ...body, uploadId: 'invalid' }); assert.equal(malformed.status, 400);
  const after = JSON.parse(await fs.readFile(path.join(h.dataDir, 'state.json'), 'utf8')); assert.equal(canonicalJSON(after), canonicalJSON(before));
  await h.instance.close(); h.instance = await startServer({ dataDir: h.dataDir, models: h.models });
  assert.deepEqual(await h.ok('/recordings', body), responses[0]);
  const restarted = JSON.parse(await fs.readFile(path.join(h.dataDir, 'state.json'), 'utf8')); assert.equal(canonicalJSON(restarted.recordings), canonicalJSON(before.recordings));
  assert.equal(Object.keys(restarted.recordings).length, 1); assert.equal(h.calls.length, 0); assert.equal(h.feedbackCalls.length, 0);
});
