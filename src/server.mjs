import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeArchive } from './archive/zip-adapter.mjs';
import { createModels } from './models.mjs';
import { createMaterialToolRuntime } from './material-tool-runtime.mjs';
import { createMaterialJobs,validateMaterialJobs,rebaseMaterialJobs,snapshotMaterialJobs } from './material-jobs.mjs';
import { createMaterialJobSource } from './material-job-source.mjs';
import { extractDraft } from './importer.mjs';
import { createMaterialInbox, MATERIAL_LIMITS,modelBindingValue } from './materials.mjs';
import { createMaterialProcessing } from './material-processing.mjs';
import { createCandidateRepository, assessCandidate,materialSourceRevision } from './material-candidates.mjs';
import {createWorkerHost} from './workers/host.mjs';
import {createMediaWorker} from './workers/media.mjs';
import { derivedMappings } from './asr-checks.mjs';
import { createMaterialCompiler } from './material-compiler.mjs';
import {inspectProcessingSnapshot,readProcessingBytes,processingManifest,validateProcessingManifest,writeProcessingFiles,createMaterialJobSnapshotInspector} from './processing-backup.mjs';
import {
  LIMITS, InputError, decodeUpload, readZip, identifyMedia, prepareImportFiles, filesFromUploads,
  validatePackage, collectMediaPaths, contentHash, canonicalJSON, createPackageZip,
} from './package.mjs';
import { createStore, assertStateShape, newId, now, runtimeLibrary, normalizedAnswer, gradeAnswer } from './store.mjs';
import { buildExamPlan } from './exam-plan.mjs';
import { isExamSession, snapshotForAttempt as questionSnapshot, createExamSession, patchExamSession, commitExamModule, examSessionView, pauseExamSession, normalizeRunContext, restoreExamSession, validateExamRunContexts } from './exam-session.mjs';
import { createExamOverlay, validateExamOverlayReferences } from './exam-overlay.mjs';
import { createExamChat } from './exam-chat-context.mjs';
import { createAssistantMemory, exportConfirmedPreferences, restorePreferencePolicy } from './assistant-memory.mjs';
import { createOcrService } from './ocr-service.mjs';
import {createMaterialOcr} from './material-ocr.mjs';
import {createFeedbackQueue} from './feedback-queue.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const inspectMaterialJobs=createMaterialJobSnapshotInspector({validateJobs:validateMaterialJobs});
const BODY_LIMIT = Math.ceil(LIMITS.uploadBytes / 3) * 4 + 2 * 1024 * 1024;
const RESPONSE_EPOCH=Symbol('current workspace epoch');
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function textValue(value, label, max = 200000, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new InputError(`${label}无效、为空或超过长度限制。`);
  return value;
}
function integer(value, label, fallback = 0, max = 86400) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > max) throw new InputError(`${label}应为 0 至 ${max} 的整数。`);
  return value;
}
function dateValue(value, label, fallback = now()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new InputError(`${label}不是有效日期。`);
  return new Date(value).toISOString();
}
function modeValue(value) {
  if (!['practice', 'exam'].includes(value)) throw new InputError('练习模式必须为 practice 或 exam。');
  return value;
}
function booleanValue(value, label, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new InputError(`${label}必须为 true 或 false。`);
  return value;
}
function findLibrary(state, id) {
  const library = state.libraries.find(item => item.libraryId === id);
  if (!library) throw new InputError('找不到此练习包。', 404);
  return library;
}
function findAttempt(state, id) {
  const attempt = state.attempts.find(item => item.id === id);
  if (!attempt) throw new InputError('找不到此作答记录。', 404);
  return attempt;
}
function publicAttempt(attempt) {
  const { submissionId, submissionHash, ...result } = attempt;
  return result;
}
function publicJob(job) {
  const { request, ...result } = job;
  return result;
}
function modelBinding(models) {
  if(typeof models.binding==='function')return models.binding();
  const settings = models.publicSettings();
  return {
    provider: settings.provider || 'none', baseUrl: settings.baseUrl || '', model: settings.model || '',
    timeoutSeconds: settings.timeoutSeconds ?? null, maxOutputTokens: settings.maxOutputTokens ?? null,
  };
}
async function publicLibrary(library, overlays, materials = []) {
  const runtime = runtimeLibrary(library);
  const projection = await overlays.project(library, runtime, materials);
  return { ...runtime, examPlan: buildExamPlan(projection.pack, { mediaCatalog: projection.mediaCatalog }), mediaUrls: { ...Object.fromEntries(Object.entries(library.mediaMap).map(([name, id]) => [name, `/api/media/${id}`])), ...projection.mediaUrls }, extraMedia: projection.extraMedia, examProjectionVersion: projection.projectionVersion };
}
async function publicState(state, models, inbox, writerToken, overlays) {
  return {
    libraries: await Promise.all(state.libraries.map(library => publicLibrary(library, overlays, state.materials || []))),
    attempts: state.attempts.map(publicAttempt),
    sessions: state.sessions.map(session => isExamSession(session) ? examSessionView(session, { writerToken }) : session),
    jobs: state.jobs.map(publicJob),
    settings: models.publicSettings(),
    materials: inbox.list(),
    workspaceEpoch: state.workspaceEpoch,
  };
}
function submissionInput(body) {
  const submissionId = textValue(body.submissionId, '提交标识', 128, true);
  if (!/^[A-Za-z0-9_.:-]+$/.test(submissionId)) throw new InputError('提交标识包含不支持的字符。');
  return {
    libraryId: textValue(body.libraryId, '练习包标识', 128, true),
    questionId: textValue(body.questionId, '题目标识', 128, true),
    answer: normalizedAnswer(body.answer),
    recordingId: body.recordingId ? textValue(body.recordingId, '录音标识', 128, true) : null,
    transcript: textValue(body.transcript, '转写文字'),
    transcriptConfirmed: booleanValue(body.transcriptConfirmed, '转写确认'),
    mode: modeValue(body.mode),
    assisted: booleanValue(body.assisted, '辅助标记'),
    durationSeconds: integer(body.durationSeconds, '作答时长'),
    submissionId,
  };
}

function sanitizeSession(body, state, previous = null) {
  const libraryId = body.libraryId ?? previous?.libraryId;
  const groupId = body.groupId ?? previous?.groupId;
  const library = findLibrary(state, libraryId);
  const group = library.originalPack.groups.find(item => item.id === groupId);
  if (!group) throw new InputError('找不到此题组。', 404);
  const mode = modeValue(body.mode ?? previous?.mode);
  if (previous && (libraryId !== previous.libraryId || groupId !== previous.groupId || mode !== previous.mode)) throw new InputError('续做记录不能更换题组或模式，请新建练习。');
  const incoming = body.answers ?? previous?.answers ?? {};
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming) || JSON.stringify(incoming).length > 2 * 1024 * 1024) throw new InputError('续做答案格式无效或内容过大。');
  const answers = {};
  const questionIds = new Set(group.questions.map(item => item.id));
  for (const [qid, value] of Object.entries(incoming)) {
    if (!questionIds.has(qid)) throw new InputError('续做答案引用了题组以外的题目。');
    if (typeof value === 'string' || Array.isArray(value)) { answers[qid] = normalizedAnswer(value); continue; }
    if (!value || typeof value !== 'object') throw new InputError('续做答案格式无效。');
    const recordingId = value.recordingId || null;
    const recording = recordingId ? state.recordings[recordingId] : null;
    if (recordingId && !recording) throw new InputError('请先保存录音，再保存续做记录。');
    const attemptId = value.attemptId || null;
    if (attemptId) {
      const saved = findAttempt(state, attemptId);
      if (saved.libraryId !== libraryId || saved.questionId !== qid) throw new InputError('续做记录与作答记录的题目不一致。');
    }
    answers[qid] = {
      answer: normalizedAnswer(value.answer),
      recordingId,
      recordingUrl: recording ? `/api/media/${recording.mediaId}` : null,
      transcript: textValue(value.transcript, '转写文字'),
      transcriptConfirmed: booleanValue(value.transcriptConfirmed, '转写确认'),
      submissionId: textValue(value.submissionId, '提交标识', 128),
      attemptId,
    };
  }
  return {
    id: previous?.id || newId(),
    libraryId,
    groupId,
    mode,
    answers,
    currentIndex: integer(body.currentIndex, '当前题目位置', previous?.currentIndex || 0, group.questions.length - 1),
    startedAt: previous?.startedAt || dateValue(body.startedAt, '开始时间'),
    remainingSeconds: integer(body.remainingSeconds, '剩余时间', previous?.remainingSeconds ?? group.questions.reduce((total, q) => total + q.timeLimitSeconds + q.prepareSeconds, 0), 864000),
    assisted: Boolean(previous?.assisted) || booleanValue(body.assisted, '辅助标记'),
    updatedAt: now(),
  };
}

function sanitizeEvaluation(value, attempt, request = {}) {
  if (!value || typeof value !== 'object') throw new InputError('模型未返回可用的反馈。', 502);
  const list = (input, label) => {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 40) throw new InputError(`模型返回的${label}格式无效。`, 502);
    return input.map(item => textValue(item, label, 10000));
  };
  const transcript = request.transcript ?? attempt.transcript;
  const transcriptConfirmed = request.transcriptConfirmed ?? attempt.transcriptConfirmed;
  const answerText = Array.isArray(attempt.answer) ? attempt.answer.join(' ') : attempt.answer;
  const quoteSource = [answerText, transcriptConfirmed ? transcript : ''].filter(Boolean);
  const corrections = [];
  if (value.corrections !== undefined && (!Array.isArray(value.corrections) || value.corrections.length > 60)) throw new InputError('模型返回的修改建议格式无效。', 502);
  let omitted = 0;
  for (const item of value.corrections || []) {
    const quote = textValue(item?.quote, '反馈引文', 10000);
    if (!quote || !quoteSource.some(source => source.includes(quote))) { omitted += 1; continue; }
    corrections.push({
      quote,
      issue: textValue(item.issue, '问题说明', 10000),
      suggestion: textValue(item.suggestion, '修改建议', 10000),
      category: ['error', 'development', 'optional', 'uncertain'].includes(item.category) ? item.category : 'uncertain',
    });
  }
  const limitations = list(value.limitations, '反馈限制');
  if (omitted) limitations.push(`已移除 ${omitted} 条无法在本次作答中核实的引文建议。`);
  if (attempt.questionSnapshot.section === 'speaking') limitations.push('本次反馈仅基于确认后的文字转写，不能判断发音、语调或实际口语流利度。');
  const repeat = attempt.questionSnapshot.type === 'listen_repeat';
  return {
    id: newId(),
    createdAt: now(),
    provider: textValue(value.provider, '模型提供方', 100),
    model: textValue(value.model, '模型名称', 200),
    summary: textValue(value.summary, '反馈摘要', 20000, true),
    strengths: list(value.strengths, '优点'),
    corrections,
    revisedAnswer: repeat ? attempt.questionSnapshot.answer : textValue(value.revisedAnswer, '修改稿', 100000),
    modelAnswer: repeat ? '' : textValue(value.modelAnswer, '示范回答', 100000),
    nextSteps: list(value.nextSteps, '下一步建议'),
    limitations: [...new Set(limitations)],
    inputTranscript: transcript,
    inputTranscriptConfirmed: transcriptConfirmed,
  };
}

function abortableModelReply(work,signal){
  signal.throwIfAborted();let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
  const cancel=()=>rejectAbort(signal.reason||new DOMException('Aborted','AbortError'));
  signal.addEventListener('abort',cancel,{once:true});
  return Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return work();}),aborted]).finally(()=>signal.removeEventListener('abort',cancel));
}

async function buildBackup(state, store, inbox, { signal, includeConfirmedPreferences=false } = {}) {
  state=snapshotMaterialJobs(state);
  const processing=await inspectProcessingSnapshot(state,{readBytes:ref=>readProcessingBytes(store.dataDir,ref),signal,inspectJobs:inspectMaterialJobs});
  const entries = [];
  const cleanState = {
    schemaVersion: 2,
    workspaceEpoch:state.workspaceEpoch,
    libraries: state.libraries,
    attempts: state.attempts,
    sessions: state.sessions,
    jobs: state.jobs,
    recordings: state.recordings,
    blobs: {...state.blobs,...Object.fromEntries(processing.blobInfo)},
    materials: state.materials || [],
    candidateSets:state.candidateSets||{},
    importReceipts:state.importReceipts||{},
    materialJobs:state.materialJobs||{},
    ...(state.materialExecutionLedger===undefined?{}:{materialExecutionLedger:state.materialExecutionLedger}),
    confirmedPreferences: exportConfirmedPreferences(state,{includeConfirmedPreferences}),
  };
  const manifest = Buffer.from(JSON.stringify({ kind: 'practicebridge-backup', version: 2, createdAt: now(), state: cleanState,processingArtifacts:processingManifest(processing.files) }, null, 2));
  if (manifest.length > LIMITS.fileBytes) throw new InputError('记录已超过备份的单文件大小限制。');
  entries.push({ name: 'practicebridge-backup.json', bytes: manifest });
  let total = manifest.length;
  const blobIds = Object.keys(cleanState.blobs);
  const originals = await inbox.backupFiles(state.materials);
  if (blobIds.length + originals.size + processing.files.size + 1 > LIMITS.zipEntries) throw new InputError('文件数量超过备份限制。');
  for (const id of blobIds) {
    const bytes = await store.readBlob(id);
    if(bytes.length!==cleanState.blobs[id].size||crypto.createHash('sha256').update(bytes).digest('hex')!==id)throw new InputError('备份媒体缺失或完整性校验失败。');
    total += bytes.length;
    if (total > LIMITS.expandedBytes) throw new InputError('备份数据超过首版 160 MB 解压后大小限制。');
    entries.push({ name: `blobs/${id}`, bytes });
  }
  for (const [name, bytes] of originals) {
    total += bytes.length;
    if (total > LIMITS.expandedBytes) throw new InputError('备份数据超过 160 MB 解压后大小限制。');
    entries.push({ name, bytes });
  }
  for(const [ref,bytes] of processing.files){
    total+=bytes.length;if(total>LIMITS.expandedBytes)throw new InputError('包含候选历史和派生证据后，备份超过 160 MB 容量；未遗漏文件生成备份。');
    entries.push({name:`processing-artifacts/${ref}`,bytes});
  }
  const result = (await writeArchive({ entries, signal, budget: { maxCompressedBytes: LIMITS.backupBytes, maxEntryBytes: LIMITS.zipBytes } })).buffer;
  if (result.length > LIMITS.backupBytes) throw new InputError('备份压缩后超过 160 MB 大小限制。');
  return result;
}

async function validateBackup(bytes, inbox, { signal } = {}) {
  const files = await readZip(bytes, { signal, allowInputOriginals: true, maxCompressedBytes: LIMITS.backupBytes });
  let parsed;
  try { parsed = JSON.parse(files.get('practicebridge-backup.json')?.toString('utf8') || ''); }
  catch { throw new InputError('ZIP 不包含可读取的 PracticeBridge 备份清单。'); }
  if (parsed.kind !== 'practicebridge-backup' || ![1,2].includes(parsed.version)) throw new InputError('不支持此备份格式。');
  if(Object.keys(parsed).some(key=>!['kind','version','createdAt','state',...(parsed.version===2?['processingArtifacts']:[])].includes(key)))throw new InputError('备份清单包含未知字段。');
  dateValue(parsed.createdAt,'备份日期');
  const input = parsed.state;
  const stateFields=['schemaVersion','libraries','attempts','sessions','jobs','recordings','blobs','materials','confirmedPreferences',...(parsed.version===2?['workspaceEpoch','candidateSets','importReceipts','materialJobs','materialExecutionLedger']:[])];
  if(!input||Object.keys(input).some(key=>!stateFields.includes(key))||input.schemaVersion!==parsed.version)throw new InputError('备份状态版本或字段无效。');
  if(parsed.version===2&&(['workspaceEpoch','materials','candidateSets','importReceipts','materialJobs'].some(key=>!Object.hasOwn(input,key))||['candidateSets','importReceipts','materialJobs'].some(key=>!input[key]||typeof input[key]!=='object'||Array.isArray(input[key]))))throw new InputError('新版备份缺少完整的候选、收据或作业索引。');
  if(parsed.version===1&&(input.materials||[]).some(m=>m.candidateSummary))throw new InputError('旧版备份缺少候选引用，不能完整恢复。');
  assertStateShape(input);
  const processingFiles=parsed.version===2?validateProcessingManifest(parsed.processingArtifacts,files):new Map();
  if (input.libraries.length > 1000 || input.attempts.length > 50000 || input.sessions.length > 1000 || input.jobs.length > 50000) throw new InputError('备份记录数量超过首版限制。');
  const { materials, originals } = inbox.prepareRestore(input.materials, files);
  for (const material of materials) if (['analyzing', 'converting'].includes(material.status)) {
    material.status = 'interrupted'; material.error = '恢复备份后未自动重发请求；请按需手动继续处理。';
  }
  const state = { schemaVersion: 2,workspaceEpoch:input.workspaceEpoch||newId(),libraries: [], attempts: [], sessions: [], jobs: [], recordings: {}, blobs: {}, materials,candidateSets:structuredClone(input.candidateSets||{}),importReceipts:structuredClone(input.importReceipts||{}),materialJobs:structuredClone(input.materialJobs||{}) };
  if(input.materialExecutionLedger!==undefined)state.materialExecutionLedger=structuredClone(input.materialExecutionLedger);
  if(input.confirmedPreferences!==undefined){
    restorePreferencePolicy({},input.confirmedPreferences);
    state.confirmedPreferences=structuredClone(input.confirmedPreferences);
  }
  const mimeExtensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/mp4': '.m4a' };
  const blobFiles = new Map();
  for (const [id, info] of Object.entries(input.blobs)) {
    if (!HASH_PATTERN.test(id) || !info || info.id !== id || !mimeExtensions[info.mime]) throw new InputError('备份含有无效的媒体记录。');
    const data = files.get(`blobs/${id}`);
    if (!data || data.length !== info.size || crypto.createHash('sha256').update(data).digest('hex') !== id || identifyMedia(`media${mimeExtensions[info.mime]}`, data)?.mime !== info.mime) throw new InputError('备份媒体缺失、损坏或类型不一致。');
    state.blobs[id] = { id, size: data.length, mime: info.mime };
    blobFiles.set(id, data);
  }
  if (files.size !== blobFiles.size + originals.size + processingFiles.size + 1) throw new InputError('备份包含未声明的文件。');
  const libraryIds = new Set();
  const hashes = new Set();
  for (const library of input.libraries) {
    if (!library || !ID_PATTERN.test(library.libraryId) || libraryIds.has(library.libraryId) || !library.mediaMap || Array.isArray(library.mediaMap)) throw new InputError('备份中的练习包标识或媒体映射无效。');
    const mediaFiles = new Map();
    for (const [name, id] of Object.entries(library.mediaMap)) {
      if (!blobFiles.has(id)) throw new InputError('备份中的练习包引用了缺失媒体。');
      mediaFiles.set(name, blobFiles.get(id));
    }
    const validated = validatePackage(library.originalPack, mediaFiles);
    if (validated.issues.some(item => item.severity === 'error') || canonicalJSON(validated.pack) !== canonicalJSON(library.originalPack)) throw new InputError('备份中的练习包未通过结构校验。');
    if (canonicalJSON(collectMediaPaths(validated.pack)) !== canonicalJSON(Object.keys(library.mediaMap).sort())) throw new InputError('备份中的媒体映射与练习包引用不一致。');
    const expectedHash = contentHash(validated.pack, library.mediaMap);
    if (expectedHash !== library.contentHash || hashes.has(expectedHash)) throw new InputError('备份中的练习包内容标识不一致或重复。');
    libraryIds.add(library.libraryId);
    hashes.add(expectedHash);
    state.libraries.push({ libraryId: library.libraryId, importedAt: dateValue(library.importedAt, '导入日期'), contentHash: expectedHash, originalPack: validated.pack, mediaMap: library.mediaMap,...(library.lineage!==undefined?{lineage:structuredClone(library.lineage)}:{}) });
  }
  for (const [id, recording] of Object.entries(input.recordings)) {
    if (!ID_PATTERN.test(id) || recording?.id !== id || !state.blobs[recording.mediaId] || !state.blobs[recording.mediaId].mime.startsWith('audio/') || identifyMedia(recording.name, blobFiles.get(recording.mediaId))?.kind !== 'audio') throw new InputError('备份中的录音记录无效。');
    state.recordings[id] = { id, mediaId: recording.mediaId, name: textValue(recording.name, '录音名称', 400, true), createdAt: dateValue(recording.createdAt, '录音日期') };
  }
  const attempts = new Set();
  const submissions = new Set();
  const priorQuestions = new Set();
  for (const raw of input.attempts) {
    if (!raw || !ID_PATTERN.test(raw.id) || attempts.has(raw.id)) throw new InputError('备份中的作答标识无效或重复。');
    const submitted = submissionInput(raw);
    if (submissions.has(submitted.submissionId)) throw new InputError('备份包含重复提交标识。');
    const library = findLibrary(state, submitted.libraryId);
    const snapshot = questionSnapshot(library, submitted.questionId);
    const hash = crypto.createHash('sha256').update(canonicalJSON(submitted)).digest('hex');
    if (raw.sourceHash !== library.contentHash || canonicalJSON(raw.questionSnapshot) !== canonicalJSON(snapshot) || raw.submissionHash !== hash || canonicalJSON(raw.objective) !== canonicalJSON(gradeAnswer(snapshot, submitted.answer))) throw new InputError('备份中的作答原题、答案或判分记录不一致。');
    const recording = submitted.recordingId ? state.recordings[submitted.recordingId] : null;
    if (submitted.recordingId && !recording) throw new InputError('备份中的作答引用了缺失录音。');
    const recordingUrl = recording ? `/api/media/${recording.mediaId}` : null;
    if (raw.recordingUrl !== recordingUrl) throw new InputError('备份中的录音链接与本次作答不一致。');
    const key = `${submitted.libraryId}/${submitted.questionId}`;
    const kind = priorQuestions.has(key) ? 'retry' : 'first';
    if (raw.kind !== kind || !Array.isArray(raw.evaluations) || raw.evaluations.length > 100) throw new InputError('备份中的作答序号或反馈格式不一致。');
    const evaluationIds = new Set();
    for (const evaluation of raw.evaluations) {
      if (!evaluation || !ID_PATTERN.test(evaluation.id) || evaluationIds.has(evaluation.id)) throw new InputError('备份含有无效反馈标识。');
      evaluationIds.add(evaluation.id);
      // Reapply output rules while preserving the original evaluation identity and date.
      const checked = sanitizeEvaluation(evaluation, raw, { transcript: textValue(evaluation.inputTranscript, '反馈转写'), transcriptConfirmed: booleanValue(evaluation.inputTranscriptConfirmed, '反馈转写确认') });
      checked.id = evaluation.id;
      checked.createdAt = dateValue(evaluation.createdAt, '反馈日期');
      if (canonicalJSON(checked) !== canonicalJSON(evaluation)) throw new InputError('备份反馈未通过引文与题型约束校验。');
    }
    attempts.add(raw.id);
    submissions.add(submitted.submissionId);
    priorQuestions.add(key);
    state.attempts.push({ ...submitted, id: raw.id, sourceHash: library.contentHash, questionSnapshot: snapshot, recordingUrl, kind, createdAt: dateValue(raw.createdAt, '作答日期'), objective: gradeAnswer(snapshot, submitted.answer), evaluations: raw.evaluations, reviewed: booleanValue(raw.reviewed, '复习标记'), submissionHash: hash, ...(raw.runContext === undefined ? {} : { runContext: normalizeRunContext(raw.runContext) }) });
  }
  const sessionIds = new Set();
  for (const raw of input.sessions) {
    if (!ID_PATTERN.test(raw?.id) || sessionIds.has(raw.id)) throw new InputError('备份包含无效或重复的续做记录。');
    const session = isExamSession(raw) ? restoreExamSession(raw, state, { snapshotTime: parsed.createdAt }) : sanitizeSession(raw, state);
    session.id = raw.id;
    if (!isExamSession(raw)) session.updatedAt = dateValue(raw.updatedAt, '续做日期');
    sessionIds.add(raw.id);
    state.sessions.push(session);
  }
  validateExamRunContexts(state);
  await validateExamOverlayReferences(state, originals, { signal });
  const jobIds = new Set();
  for (const raw of input.jobs) {
    if (!raw || !ID_PATTERN.test(raw.id) || jobIds.has(raw.id) || !attempts.has(raw.attemptId) || !['queued', 'running', 'completed', 'failed', 'interrupted'].includes(raw.status)) throw new InputError('备份包含无效反馈任务。');
    const job = { id: raw.id, attemptId: raw.attemptId, status: raw.status, createdAt: dateValue(raw.createdAt, '任务日期') };
    if (raw.completedAt) job.completedAt = dateValue(raw.completedAt, '任务完成日期');
    if (raw.error) job.error = textValue(raw.error, '任务错误', 20000);
    if (raw.request) job.request = { transcript: textValue(raw.request.transcript, '任务转写'), transcriptConfirmed: booleanValue(raw.request.transcriptConfirmed, '任务转写确认') };
    if (raw.modelBinding) job.modelBinding=modelBindingValue(raw.modelBinding);
    if (['queued', 'running'].includes(job.status)) { job.status = 'interrupted'; job.error = '恢复备份后未自动重发请求；请按需手动重新分析。'; }
    jobIds.add(job.id);
    state.jobs.push(job);
  }
  for (const material of materials) if (material.libraryId && !libraryIds.has(material.libraryId)) throw new InputError('备份材料引用了缺失的练习包。');
  const processing=await inspectProcessingSnapshot(state,{readBytes:ref=>processingFiles.get(ref),signal,inspectJobs:inspectMaterialJobs});
  if(processing.files.size!==processingFiles.size||[...processing.blobInfo].some(([ref,info])=>!state.blobs[ref]||canonicalJSON(state.blobs[ref])!==canonicalJSON(info)))throw new InputError('备份包含未引用的处理产物，或候选引用了缺失媒体。');
  return { state, blobFiles, originals,processingFiles };
}

async function readJSON(request, maxBytes = BODY_LIMIT) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new InputError('此接口仅接受 application/json。', 415);
  const declared = Number(request.headers['content-length'] || 0);
  if (!Number.isFinite(declared) || declared > maxBytes) { request.resume(); throw new InputError('请求过大；请减少同时导入的文件。', 413); }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new InputError('请求过大；请减少同时导入的文件。', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not object');
    return body;
  } catch { throw new InputError('请求 JSON 格式无效。'); }
}
function sendJSON(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  if(response[RESPONSE_EPOCH])response.setHeader('X-PracticeBridge-Epoch',response[RESPONSE_EPOCH]());
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  response.end(data);
}
function sendDownload(response, bytes, filename) {
  if (response.destroyed || response.writableEnded) return;
  if(response[RESPONSE_EPOCH])response.setHeader('X-PracticeBridge-Epoch',response[RESPONSE_EPOCH]());
  response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="practicebridge.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' });
  response.end(bytes);
}
function sendMedia(request, response, bytes, mime, {cacheControl='private, max-age=31536000, immutable'}={}) {
  const headers = { 'Content-Type': mime, 'Cache-Control': cacheControl, 'Accept-Ranges': 'bytes' };
  let start = 0, end = bytes.length - 1, status = 200;
  if (request.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!range || (!range[1] && !range[2])) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); return response.end(); }
    if (!range[1]) start = Math.max(0, bytes.length - Number(range[2]));
    else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= bytes.length || end < start) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); return response.end(); }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
  }
  headers['Content-Length'] = end - start + 1;
  response.writeHead(status, headers);
  return response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
}

export async function startServer({ dataDir = path.join(PROJECT_DIR, 'data'), port = 0, host = '127.0.0.1', models: suppliedModels, secretStore,asrWorkerFactory,ocrAdapter } = {}) {
  if (host !== '127.0.0.1') throw new InputError('此应用仅允许绑定本机地址 127.0.0.1。');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new InputError('端口号无效。');
  const store = await createStore({ dataDir });
  const models = suppliedModels || createModels({ dataDir: store.dataDir, secretStore, assertRequestScope:()=>store.assertEpoch(store.captureEpoch()) });
  await models.ready;
  const bootToken = crypto.randomBytes(32).toString('hex');
  const inbox = createMaterialInbox({ store });
  const examOverlay = createExamOverlay({ inbox });
  let closing = false;
  let restoring=false;
  const controlWrites=new Set();
  const controlWrite=async work=>{
    store.assertEpoch(store.captureEpoch());
    if(restoring)throw new InputError('工作区正在恢复；本次配置未保存。',503);
    const lease={};controlWrites.add(lease);
    try{return await work();}finally{controlWrites.delete(lease);}
  };
  let writerToken = newId();
  const assistantMemory=await createAssistantMemory({store,getEpoch:()=>writerToken});
  const examChat=createExamChat({readState:()=>store.read(),models,getWriterToken:()=>writerToken,memory:assistantMemory});
  const ocr = createOcrService({dataDir:store.dataDir,getEpoch:()=>store.getWorkspaceEpoch()});
  let actualPort;
  const drafts = new Map();
  const requireWriterToken = body => {
    if (body.writerToken !== writerToken) throw new InputError('工作区已重新打开或恢复备份，请刷新后继续；旧页面不能覆盖当前练习。', 409);
    const { writerToken: _token, ...input } = body;
    return input;
  };
  const existing = store.read();
  if (existing.jobs.some(job => ['queued', 'running'].includes(job.status)) || (existing.materials || []).some(item => ['analyzing', 'converting'].includes(item.status))) await store.transact(state => {
    for (const job of state.jobs) if (['queued', 'running'].includes(job.status)) {
      job.status = 'interrupted';
      job.error = '应用上次关闭时任务未完成；为避免重复请求，请按需手动重新分析。';
    }
    for (const material of state.materials || []) if (['analyzing', 'converting'].includes(material.status)) {
      material.status = 'interrupted'; material.error = '应用上次关闭时材料处理未完成；原文件已保留，请按需手动继续。';
    }
  });
  const ensureDraft = id => {
    const draft = drafts.get(id);
    if (!draft || Date.now() - draft.createdAt > 60 * 60 * 1000) { drafts.delete(id); throw new InputError('此审阅页面已过期，请从材料库重新打开草稿。', 404); }
    if (draft.materialId && inbox.get(draft.materialId).updatedAt !== draft.materialRevision) throw new InputError('这批材料已有更新，请从材料库重新打开最新草稿。', 409);
    return draft;
  };
  const previewShape = (draftId, draft, validated) => ({
    draftId, pack: validated.pack, materialId: draft.materialId || null,
    issues: [...new Map([...draft.sourceIssues, ...validated.issues].filter(issue => !(issue.path === 'rights' && issue.severity === 'warning')).map(issue => [JSON.stringify(issue), issue])).values()],
    sources: draft.sources, media: validated.media, method: draft.method,
    canCommit: ![...draft.sourceIssues, ...validated.issues].some(issue => issue.severity === 'error'),
  });
  const registerDraft = ({ pack, ...input }) => {
    store.assertEpoch(store.captureEpoch());
    if (drafts.size >= 10) drafts.delete(drafts.keys().next().value);
    const draftId = newId();
    const draft = { createdAt: Date.now(), sources: [], sourceIssues: [], ...input };
    if (draft.materialId && !draft.materialRevision) draft.materialRevision = inbox.get(draft.materialId).updatedAt;
    drafts.set(draftId, draft);
    return previewShape(draftId, draft, validatePackage(pack, draft.files));
  };
  const candidateRepository=createCandidateRepository({store});
  const materialCompiler=createMaterialCompiler({store,repository:candidateRepository});
  const nativeMediaProbes=new Set();let nativeMediaTerminationFailure=null;
  const probeMedia=(asset,{materialId,expectedEpoch,sourceRevision,signal}={})=>{
    const configuration=materialToolRuntime.view().media;
    if(!configuration?.confirmed)throw Object.assign(new InputError('本机媒体探测未配置；不会自动寻找或下载工具。',503),{code:'MEDIA_HELPER_UNSUPPORTED'});
    const check=()=>{signal?.throwIfAborted();store.assertEpoch(expectedEpoch);if(materialSourceRevision(inbox.get(materialId))!==sourceRevision)throw new InputError('原材料已改变，旧的媒体探测未采用。',409);};check();
    const jobId='native-media-'+newId(),directory=path.join(store.dataDir,'tool-staging','native-media'),filename=path.join(directory,jobId),budget={timeoutMs:15000,maxOutputBytes:16*1024*1024,maxDurationSeconds:7200},host=createWorkerHost({executablePaths:[configuration.ffmpegPath,configuration.ffprobePath]});
    const pending=(async()=>{let staged=false;try{
      if(!Buffer.isBuffer(asset.bytes)||asset.bytes.length>80*1024*1024||crypto.createHash('sha256').update(asset.bytes).digest('hex')!==asset.originalAssetId)throw new InputError('媒体探测输入字节或预算无效。',400);
      await fs.mkdir(directory,{recursive:true});const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new InputError('媒体探测暂存目录无效。',500);check();await fs.writeFile(filename,asset.bytes,{flag:'wx'});staged=true;check();
      const worker=createMediaWorker({...configuration,artifactDir:directory,resolveAsset:async()=>{check();return {path:filename,name:asset.originalName,size:asset.bytes.length,hash:asset.originalAssetId};},spawnProcess:host.spawnProcess});
      const result=await host.run({jobId,signal,budget:{...budget,maxMemoryBytes:768*1024*1024}},()=>worker.runMaterialTool({jobId,expectedEpoch,sourceRevision,toolId:'media.probe',inputAssetIds:[asset.originalAssetId],parameters:{},budget,cancelToken:signal}));check();return {...result.evidence[0],actualEngine:result.actualEngine,actualDevice:result.actualDevice};
    }catch(error){if(error.code==='worker_termination_unconfirmed')nativeMediaTerminationFailure=error;throw error;}
    finally{if(staged)await fs.unlink(filename).catch(error=>{if(error.code!=='ENOENT')throw error;});}})();
    nativeMediaProbes.add(pending);void pending.finally(()=>nativeMediaProbes.delete(pending)).catch(()=>{});return pending;
  };
  const drainNativeMedia=async()=>{while(nativeMediaProbes.size)await Promise.allSettled([...nativeMediaProbes]);if(nativeMediaTerminationFailure)throw nativeMediaTerminationFailure;};
  const materialProcessing = createMaterialProcessing({ inbox, models, registerDraft, candidateRepository, getWorkspaceEpoch:()=>store.captureEpoch(),probeMedia });
  let materialJobs=null;
  const ocrHumanContext=Object.freeze({});
  const materialOcr=createMaterialOcr({store,repository:candidateRepository,getJobs:()=>materialJobs,ocrService:ocr,authorizeHuman:context=>context===ocrHumanContext});
  const materialToolRuntime=await createMaterialToolRuntime({store,inbox,repository:candidateRepository,getJobs:()=>materialJobs,asrWorkerFactory,ocrAdapter:ocrAdapter||materialOcr.adapter});
  const materialToolsView=async()=>{
    const view=materialToolRuntime.view();
    if(!ocrAdapter){const status=await ocr.status();view.ocr.available=status.enabled===true;view.tools=view.tools.map(tool=>tool.toolId.startsWith('document.')?{...tool,available:status.enabled===true}:tool);}
    return view;
  };
  const asr=materialToolRuntime.asr;
  const materialJobSource=createMaterialJobSource({store,inbox,repository:candidateRepository,materialProcessing,probeMedia});
  if(typeof models.prepareStructured==='function'){
    materialJobs=createMaterialJobs({store,models,repository:candidateRepository,...materialJobSource,tools:materialToolRuntime.tools});
    await materialJobs.ready;
  }
  const feedbackQueue=createFeedbackQueue({store,getBinding:()=>modelBinding(models),request:input=>models.feedback(input),evaluate:sanitizeEvaluation,now});
  const runQueue=()=>closing||restoring?Promise.resolve():feedbackQueue.run();
  const archiveOperations=new Set();
  const drainArchives=async(except,reason)=>{
    const previous=[...archiveOperations].filter(operation=>operation!==except);
    for(const operation of previous)operation.controller.abort(new InputError(reason,409));
    await Promise.allSettled(previous.map(operation=>operation.done));
  };

  const server = http.createServer(async (request, response) => {
    response[RESPONSE_EPOCH]=()=>store.getWorkspaceEpoch();
    const archiveCancellation = new AbortController(), archiveSignal = archiveCancellation.signal;
    let archiveOperation;
    request.once('aborted', () => archiveCancellation.abort());
    response.once('close', () => { if (!response.writableFinished) archiveCancellation.abort(); });
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', CSP);
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    try {
      const validHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!validHosts.includes(request.headers.host)) throw new InputError('拒绝非本机应用的 Host 请求。', 403);
      const origin = request.headers.origin;
      if (origin && !validHosts.some(value => origin === `http://${value}`)) throw new InputError('拒绝跨站请求。', 403);
      if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) throw new InputError('拒绝来自其他站点的请求。', 403);
      if (closing) throw new InputError('应用正在关闭。', 503);
      const requestUrl = new URL(request.url, `http://127.0.0.1:${actualPort}`);
      const pathname = decodeURIComponent(requestUrl.pathname);
      const write = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method);
      if (write && request.headers['x-practicebridge'] !== '1') throw new InputError('缺少应用请求标识。', 403);
      if (pathname === '/api/bootstrap' && request.method === 'GET') {
        if (request.headers['x-practicebridge'] !== '1' || !(origin === `http://${request.headers.host}` || request.headers['sec-fetch-site'] === 'same-origin')) throw new InputError('请从本机应用页面初始化连接。', 403);
        return sendJSON(response, 200, { bootToken,workspaceEpoch:store.getWorkspaceEpoch() });
      }
      if (write) {
        const token = request.headers['x-practicebridge-token'];
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(bootToken))) throw new InputError('应用连接已过期，请刷新页面。', 403);
      }
      const requestEpoch=write?request.headers['x-practicebridge-epoch']:(request.headers['x-practicebridge-epoch']??store.getWorkspaceEpoch());
      store.assertEpoch(requestEpoch);
      if(write&&restoring)throw new InputError('工作区正在恢复；本次操作未执行。',503);
      return await store.withEpoch(requestEpoch,async()=>{
      const body = write ? await readJSON(request,pathname==='/api/restore'?Math.ceil(LIMITS.backupBytes/3)*4+2*1024*1024:BODY_LIMIT) : null;
      store.assertEpoch(requestEpoch);
      const archiveRequest=pathname==='/api/backup'||pathname==='/api/restore'||pathname==='/api/import/preview'||/^\/api\/library\/[^/]+\/export$/.test(pathname);
      if(closing&&archiveRequest)throw new InputError('应用正在关闭；本次导入或导出未执行。',503);
      if(restoring&&(write||archiveRequest))throw new InputError('工作区正在恢复；本次操作未执行。',503);
      if(archiveRequest){
        let finish;const done=new Promise(resolve=>{finish=resolve;});
        archiveOperation={controller:archiveCancellation,done,finish};archiveOperations.add(archiveOperation);
      }
      const receivedAtMs = Date.now();
      const route = pathname.split('/').filter(Boolean);

      if(request.method==='GET'&&pathname==='/api/ocr/status')return sendJSON(response,200,await ocr.status());
      if(request.method==='POST'&&pathname==='/api/ocr/configure')return sendJSON(response,200,await controlWrite(()=>ocr.configure(body)));
      if(request.method==='POST'&&pathname==='/api/ocr/install')return sendJSON(response,202,await controlWrite(()=>ocr.start('install',body)));
      if(request.method==='POST'&&pathname==='/api/ocr/selftest')return sendJSON(response,202,await controlWrite(()=>ocr.start('selftest',body)));
      if(request.method==='POST'&&pathname==='/api/ocr/cancel')return sendJSON(response,200,await ocr.cancel(body));

      if (request.method === 'GET' && pathname === '/api/state') {
        for (let attempt = 0; attempt < 3; attempt++) {
          const capturedEpoch = writerToken;
          const result = await publicState(store.read(), models, inbox, capturedEpoch, examOverlay);
          if (capturedEpoch === writerToken) return sendJSON(response, 200, result);
        }
        throw new InputError('工作区刚刚更新，请刷新后继续。', 409);
      }

      if (request.method === 'POST' && pathname === '/api/materials') return sendJSON(response, 200, { material: await inbox.receive(body) });
      if (route[0] === 'api' && route[1] === 'materials' && route.length >= 3) {
        const id = route[2];
        if(route[3]==='ocr'){
          if(request.method==='GET'&&route.length===4)return sendJSON(response,200,await materialOcr.summary({materialId:id}));
          if(request.method==='POST'&&route.length===5&&route[4]==='author')return sendJSON(response,200,await materialOcr.openAuthor({...body,materialId:id},ocrHumanContext));
          if(['GET','HEAD'].includes(request.method)&&route.length===6&&route[4]==='image'){const media=await materialOcr.readImage({materialId:id,reviewToken:route[5]},ocrHumanContext);return sendMedia(request,response,media.bytes,media.mime,{cacheControl:media.cacheControl});}
          if(request.method==='POST'&&route.length===6&&route[4]==='author'&&route[5]==='close')return sendJSON(response,200,await materialOcr.closeAuthor({...body,materialId:id},ocrHumanContext));
          if(request.method==='POST'&&route.length===5&&route[4]==='review')return sendJSON(response,200,await materialOcr.review({...body,materialId:id},ocrHumanContext));
        }
        if(request.method==='GET'&&route.length===4&&route[3]==='candidates'){
          const snapshot=store.read(),loaded=await candidateRepository.load(id,{state:snapshot}),author=requestUrl.searchParams.get('author')==='1';
          const candidates=loaded.candidates.map(candidate=>{
            const assessment=assessCandidate(candidate,loaded.artifactIndex,1,{workspaceEpoch:snapshot.workspaceEpoch});
            const common={candidateId:candidate.candidateId,revision:candidate.revision,taskKind:candidate.taskKind,answerType:candidate.answerType,originalOrdinalInTask:candidate.originalOrdinalInTask,sourceQuestionNumber:candidate.sourceQuestionNumber,readiness:assessment.capabilities,blockingIssues:assessment.blockingIssues,warnings:assessment.warnings};
            return author?{...candidate,...common,mappings:derivedMappings(candidate,loaded.artifactIndex,{workspaceEpoch:snapshot.workspaceEpoch})}:common;
          });
          return sendJSON(response,200,{materialId:id,sourceRevision:loaded.sourceRevision,revision:loaded.revision,expectedEpoch:snapshot.workspaceEpoch,candidates,...(author?{artifactIndex:loaded.artifactIndex}:{})});
        }
        if(request.method==='POST'&&route.length===4&&route[3]==='compile')return sendJSON(response,200,await materialCompiler.compilePracticeSubset({...body,materialId:id}));
        if(request.method==='POST'&&route.length===6&&route[3]==='candidates'&&route[5]==='patch'){
          if(Object.keys(body).some(key=>!['expectedRevision','expectedEpoch','fields','mapping','reviewFields'].includes(key)))throw new InputError('候选编辑包含不支持的字段。');
          return sendJSON(response,200,{candidate:await candidateRepository.patchCandidate({...body,materialId:id,candidateId:route[4],actor:'user'})});
        }
        if(['GET','HEAD'].includes(request.method)&&route.length===6&&route[3]==='candidates'&&route[4]==='media'){
          const loaded=await candidateRepository.load(id),asset=loaded.artifactIndex[route[5]];if(asset?.kind!=='media')throw new InputError('找不到此材料的媒体。',404);return sendMedia(request,response,await store.readBlob(asset.value.blob.id),asset.value.blob.mime);
        }
        if(route[3]==='jobs'){
          if(request.method==='GET'&&route.length===4)return sendJSON(response,200,{available:Boolean(materialJobs),expectedEpoch:store.read().workspaceEpoch,binding:modelBinding(models),jobs:materialJobs?.list({materialId:id})||[],toolState:await materialToolsView(),...await materialToolRuntime.describeMaterial(id)});
          if(!materialJobs)throw new InputError('当前模型适配器尚未提供有预算的分块作业接口。',503);
          if(request.method==='POST'&&route.length===5&&route[4]==='prepare')return sendJSON(response,200,await materialJobs.prepare({...body,materialId:id}));
          if(request.method==='POST'&&route.length===5&&route[4]==='start')return sendJSON(response,202,{job:await materialJobs.start({...body,materialId:id})});
          const job=materialJobs.view(route[4]);if(job.materialId!==id)throw new InputError('作业不属于这批材料。',404);
          if(request.method==='GET'&&route.length===5)return sendJSON(response,200,{job});
          if(request.method==='POST'&&route.length===6&&['cancel','continue'].includes(route[5])){
            if(!Object.hasOwn(body??{},'expectedGeneration'))throw new InputError('缺少本次作业确认版本，请重新打开作业。',428);
            if(!Number.isSafeInteger(body.expectedGeneration)||body.expectedGeneration<1)throw new InputError('作业确认版本须为正整数。',400);
          }
          if(request.method==='POST'&&route.length===6&&route[5]==='cancel')return sendJSON(response,200,{job:await materialJobs.cancel({jobId:job.jobId,expectedEpoch:body.expectedEpoch,expectedGeneration:body.expectedGeneration})});
          if(request.method==='POST'&&route.length===6&&route[5]==='continue')return sendJSON(response,202,{job:await materialJobs.continue({...body,jobId:job.jobId})});
        }
        if(request.method==='GET'&&route.length===4&&route[3]==='tool-evidence')return sendJSON(response,200,{expectedEpoch:store.read().workspaceEpoch,evidence:await materialToolRuntime.evidence(id,{author:requestUrl.searchParams.get('author')==='1'})});
        if(request.method==='POST'&&route.length===5&&route[3]==='tool-evidence'&&route[4]==='retract')return sendJSON(response,200,await materialJobSource.retractEvidence({...body,materialId:id}));
        if(['GET','HEAD'].includes(request.method)&&route.length===5&&route[3]==='tool-media'){const asset=await materialToolRuntime.readMaterialAsset(id,route[4]);return sendMedia(request,response,asset.bytes,asset.mime);}
        if (request.method === 'GET' && route.length === 3) return sendJSON(response, 200, { material: inbox.get(id) });
        if (request.method === 'POST' && route.length === 4 && route[3] === 'assess') return sendJSON(response, 200, await materialProcessing.assess(id, { consent: body.consent === true, useAI: body.useAI !== false,expectedBinding:body.expectedBinding }));
        if (request.method === 'POST' && route.length === 4 && route[3] === 'convert') return sendJSON(response, 200, await materialProcessing.convert(id, { consent: body.consent === true, useAI: body.useAI !== false,expectedBinding:body.expectedBinding }));
        if (request.method === 'GET' && route.length === 4 && route[3] === 'draft') return sendJSON(response, 200, await materialProcessing.openDraft(id));
        if (request.method === 'GET' && route.length === 5 && route[3] === 'originals') {
          const material = inbox.get(id);
          const index = Number(route[4]);
          if (!Number.isInteger(index) || index < 0 || index >= material.files.length) throw new InputError('找不到此原文件。', 404);
          const file = (await inbox.loadFiles(id))[index];
          const bytes = Buffer.from(file.data, 'base64');
          response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="original"; filename*=UTF-8''${encodeURIComponent(path.posix.basename(file.name))}`, 'Cache-Control': 'no-store' });
          return response.end(bytes);
        }
      }

      if (request.method === 'POST' && pathname === '/api/import/preview') {
        const useAI=body.useAI===true,expectedBinding=structuredClone(body.expectedBinding);
        if(useAI)models.assertBinding?.(expectedBinding);
        const capturedEpoch = writerToken;
        if (drafts.size >= 10) drafts.delete(drafts.keys().next().value);
        const uploads = body.files ?? [];
        const prepared = await prepareImportFiles(uploads, { signal: archiveSignal });
        const native = prepared.native;
        let result;
        let mediaFiles;
        let sourceIssues = [];
        if (native) { result = native; mediaFiles = native.files; }
        else {
          const loose = [...prepared.files].map(([name, bytes]) => ({ name, data: bytes.toString('base64') }));
          const importModels={structure:options=>abortableModelReply(()=>models.structure({...options,signal:archiveSignal}),archiveSignal)};
          result = await extractDraft({ files: loose, text: textValue(body.text, '导入原文', 1500000), title: textValue(body.title, '练习包标题', 300), useAI,consent: body.consent === true, expectedBinding,signal: archiveSignal }, importModels);
          mediaFiles = filesFromUploads(result.files || loose);
          sourceIssues = (result.issues || []).filter(item => item && ['error', 'warning'].includes(item.severity)).map(item => ({ severity: item.severity, message: textValue(item.message, '导入提示', 20000), path: textValue(item.path, '导入提示位置', 1000) }));
        }
        archiveSignal.throwIfAborted();
        if (closing || capturedEpoch !== writerToken) throw new InputError('工作区已更新，请重新导入材料。', 409);
        const draft = { createdAt: Date.now(), files: mediaFiles, sources: result.sources || [], method: result.method || 'manual', sourceIssues };
        const validated = validatePackage(result.pack, mediaFiles);
        const draftId = newId();
        drafts.set(draftId, draft);
        return sendJSON(response, 200, previewShape(draftId, draft, validated));
      }
      if (request.method === 'POST' && pathname === '/api/import/validate') {
        const draft = ensureDraft(body.draftId);
        const validated = validatePackage(body.pack, draft.files);
        // Extraction errors can be resolved by explicit user editing; retain their context as warnings.
        const editedDraft = { ...draft, sourceIssues: draft.sourceIssues.map(issue => ({ ...issue, severity: 'warning' })) };
        if (draft.materialId) {
          const updated = await inbox.update(draft.materialId, { draft: { pack: validated.pack, issues: [...editedDraft.sourceIssues, ...validated.issues], sources: editedDraft.sources, method: editedDraft.method } }, { expectedUpdatedAt: draft.materialRevision, isCurrent: () => drafts.get(body.draftId) === draft });
          editedDraft.materialRevision = updated.updatedAt;
        }
        drafts.set(body.draftId, editedDraft);
        return sendJSON(response, 200, previewShape(body.draftId, editedDraft, validated));
      }
      if (request.method === 'POST' && pathname === '/api/import/commit') {
        const draft = ensureDraft(body.draftId);
        if(draft.materialId&&store.read().candidateSets?.[draft.materialId])throw new InputError('请从集中校对页选择候选版本并加入可用部分。',409);
        const validated = validatePackage(body.pack, draft.files);
        if (validated.issues.some(item => item.severity === 'error')) throw new InputError('练习包仍有阻止导入的问题，请修正后重新校验。');
        if (body.acknowledged !== true) throw new InputError('请确认已核对题目内容与媒体关联。');
        const savedMaterialDraft = { pack: validated.pack, issues: draft.sourceIssues, sources: draft.sources, method: draft.method };
        if (draft.materialId && Buffer.byteLength(JSON.stringify({ ...inbox.get(draft.materialId), draft: savedMaterialDraft })) > MATERIAL_LIMITS.metadataBytes) throw new InputError('材料草稿超过保存容量，请拆分为较小练习包。');
        const mediaMap = {};
        const blobs = [];
        for (const name of collectMediaPaths(validated.pack)) {
          const info = await store.writeBlob(draft.files.get(name), identifyMedia(name, draft.files.get(name)).mime);
          mediaMap[name] = info.id;
          blobs.push(info);
        }
        const hash = contentHash(validated.pack, mediaMap);
        let committedMaterialRevision;
        const library = await store.transact(state => {
          // Restoring a backup clears all ephemeral draft handles. Recheck the
          // captured handle inside the transaction, even when restored entity
          // IDs and timestamps equal the values from the old workspace.
          if (drafts.get(body.draftId) !== draft) throw new InputError('此草稿页面已失效，请从材料库重新打开最新草稿。', 409);
          const found = state.libraries.find(item => item.contentHash === hash);
          const added = found || { libraryId: newId(), importedAt: now(), contentHash: hash, originalPack: validated.pack, mediaMap };
          if (!found) {
            for (const info of blobs) state.blobs[info.id] = info;
            state.libraries.push(added);
          }
          if (draft.materialId) {
            const material = (state.materials || []).find(item => item.id === draft.materialId);
            if (!material) throw new InputError('此材料已不在当前材料库中，请重新打开后再确认。', 409);
            if (material.updatedAt !== draft.materialRevision) throw new InputError('这批材料已有更新，请从材料库重新打开最新草稿。', 409);
            material.status = 'imported'; material.libraryId = added.libraryId; material.updatedAt = new Date(Math.max(Date.now(), Date.parse(material.updatedAt) + 1)).toISOString();
            material.draft = savedMaterialDraft;
            committedMaterialRevision = material.updatedAt;
          }
          return added;
        });
        if (committedMaterialRevision) drafts.set(body.draftId, { ...draft, materialRevision: committedMaterialRevision });
        const committedEpoch = writerToken;
        const visibleLibrary = await publicLibrary(library, examOverlay, store.read().materials || []);
        if (committedEpoch !== writerToken) throw new InputError('工作区已更新，请从题库重新打开。', 409);
        return sendJSON(response, 200, { library: visibleLibrary });
      }

      if (request.method === 'GET' && route.length === 4 && route[0] === 'api' && route[1] === 'library' && route[3] === 'export') {
        const library = findLibrary(store.read(), route[2]);
        const files = new Map();
        for (const [name, id] of Object.entries(library.mediaMap)) files.set(name, await store.readBlob(id));
        return sendDownload(response, await createPackageZip(library.originalPack, files, { signal: archiveSignal }), `${library.originalPack.id}-${library.originalPack.version}.zip`);
      }
      if (request.method === 'GET' && pathname === '/api/backup') return sendDownload(response, await buildBackup(store.read(), store, inbox, { signal: archiveSignal,includeConfirmedPreferences:requestUrl.searchParams.get('includeConfirmedPreferences')==='true' }), `PracticeBridge-backup-${new Date().toISOString().slice(0, 10)}.zip`);
      if (request.method === 'POST' && pathname === '/api/restore') {
        const file = decodeUpload(body.file, { maxBytes: LIMITS.backupBytes });
        const validated = await validateBackup(file.bytes, inbox, { signal: archiveSignal });
        archiveSignal.throwIfAborted();
        for (const [id, bytes] of validated.blobFiles) await store.writeBlob(bytes, validated.state.blobs[id].mime);
        await inbox.writeOriginals(validated.originals);
        await writeProcessingFiles(store.dataDir,validated.processingFiles);
        if(restoring||controlWrites.size)throw new InputError('本机配置仍在保存或另一项恢复尚未结束，请稍后恢复。',409);
        restoring=true;let publication;
        try{
          models.cancelRequests?.('workspace_restore');
          await drainArchives(archiveOperation,'工作区正在恢复；旧导入或导出已取消。');
          await materialJobs?.pause({reason:'workspace_restore'});
          await materialToolRuntime.quiesce();
          await materialOcr.quiesce();
          await feedbackQueue.pause('workspace_restore');
          await materialProcessing.pause();
          await drainNativeMedia();
          await ocr.reset();
          await store.transact(state=>{state.sessions=state.sessions.map(session=>isExamSession(session)?pauseExamSession(session):session);});
          publication=await store.beginRestore(requestEpoch);
          const state=publication.snapshot;
          archiveSignal.throwIfAborted();
          await store.writeBackup(await buildBackup(state, store, inbox, { signal: archiveSignal }));
          const restoredMemory=restorePreferencePolicy(state,validated.state.confirmedPreferences);
          const replacement={...validated.state,assistantMemory:restoredMemory};
          delete replacement.confirmedPreferences;
          archiveSignal.throwIfAborted();
          await publication.publish(replacement,{prepareState:next=>rebaseMaterialJobs(next,next.workspaceEpoch,{previous:state})});
          drafts.clear();
          asr.disable();
          examOverlay.clear();
          writerToken = newId();
        }finally{publication?.release();materialProcessing.resume();materialOcr.reset();materialJobs?.resume();feedbackQueue.resume();restoring=false;}
        return sendJSON(response, 200, { restored: true,workspaceEpoch:store.getWorkspaceEpoch() });
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && route.length === 4 && route[0] === 'api' && route[1] === 'exam-media') {
        const media = await examOverlay.readMedia(route[2], route[3]);
        return sendMedia(request, response, media.bytes, media.mime);
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && route.length === 3 && route[0] === 'api' && route[1] === 'media') {
        const id = route[2];
        const info = store.read().blobs[id];
        if (!info || !HASH_PATTERN.test(id)) throw new InputError('找不到此媒体。', 404);
        const bytes = await store.readBlob(id);
        return sendMedia(request, response, bytes, info.mime);
      }

      if (request.method === 'POST' && pathname === '/api/recordings') {
        const file = decodeUpload(body, { maxBytes: LIMITS.recordingBytes });
        const identified = identifyMedia(file.name, file.bytes);
        if (identified?.kind !== 'audio') throw new InputError('录音内容或格式无效；支持 WebM、WAV、MP3、OGG 和 M4A。');
        const blob = await store.writeBlob(file.bytes, identified.mime);
        const recording = await store.transact(state => {
          const uploadId=body.uploadId;
          if(uploadId!==undefined&&!ID_PATTERN.test(uploadId))throw new InputError('录音上传标识无效。');
          if(uploadId&&state.recordings[uploadId]){
            if(state.recordings[uploadId].mediaId!==blob.id)throw new InputError('该录音标识已有不同内容，未覆盖原录音。',409);
            return state.recordings[uploadId];
          }
          const item = { id: uploadId || newId(), mediaId: blob.id, name: file.name, createdAt: now() };
          state.blobs[blob.id] = blob;
          state.recordings[item.id] = item;
          return item;
        });
        return sendJSON(response, 200, { recordingId: recording.id, url: `/api/media/${recording.mediaId}` });
      }
      if (request.method === 'POST' && pathname === '/api/sessions') {
        const creationEpoch = writerToken;
        let projection;
        if (body.sessionVersion === 2) {
          const snapshot = store.read(), library = findLibrary(snapshot, body.libraryId);
          projection = await examOverlay.project(library, runtimeLibrary(library), snapshot.materials || []);
        }
        const session = await store.transact(state => {
          if (body.sessionVersion === 2) {
            if (creationEpoch !== writerToken) throw new InputError('工作区已恢复或重新打开，请刷新后开始练习。', 409);
            return createExamSession(body.writerToken === undefined ? body : requireWriterToken(body), state, { nowMs: receivedAtMs, planBuilder: (_runtime, selectors) => buildExamPlan(projection.pack, { ...selectors, mediaCatalog: projection.mediaCatalog }) });
          }
          const previous = body.sessionId ? state.sessions.find(item => item.id === body.sessionId) : null;
          if (body.sessionId && !previous) throw new InputError('找不到此续做记录。', 404);
          if (isExamSession(previous)) throw new InputError('模块练习请通过带版本校验的草稿接口更新。');
          const updated = sanitizeSession(body, state, previous);
          if (previous) state.sessions[state.sessions.indexOf(previous)] = updated;
          else state.sessions.push(updated);
          return updated;
        });
        return sendJSON(response, 200, { session: isExamSession(session) ? examSessionView(session, { writerToken }) : session });
      }
      if (request.method === 'GET' && route.length === 3 && route[0] === 'api' && route[1] === 'sessions') {
        const session = store.read().sessions.find(item => item.id === route[2]);
        if (!session) throw new InputError('找不到此续做记录。', 404);
        return sendJSON(response, 200, { session: isExamSession(session) ? examSessionView(session, { writerToken }) : session });
      }
      if (request.method === 'PATCH' && route.length === 3 && route[0] === 'api' && route[1] === 'sessions') {
        const session = await store.transact(state => {
          const previous = state.sessions.find(item => item.id === route[2]);
          if (!previous) throw new InputError('找不到此续做记录。', 404);
          if (isExamSession(previous)) return patchExamSession(requireWriterToken(body), state, previous, { nowMs: receivedAtMs });
          if (body.finished === true) { state.sessions = state.sessions.filter(item => item.id !== previous.id); return { ...previous, finished: true }; }
          const updated = sanitizeSession(body, state, previous);
          state.sessions[state.sessions.indexOf(previous)] = updated;
          return updated;
        });
        return sendJSON(response, 200, { session: isExamSession(session) ? examSessionView(session, { writerToken }) : session });
      }

      if (request.method === 'POST' && route.length === 4 && route[0] === 'api' && route[1] === 'sessions' && route[3] === 'commit-module') {
        const result = await store.transact(state => {
          const previous = state.sessions.find(item => item.id === route[2]);
          if (!isExamSession(previous)) throw new InputError('找不到此模块练习。', 404);
          return commitExamModule(requireWriterToken(body), state, previous, { nowMs: receivedAtMs });
        });
        return sendJSON(response, 200, { session: examSessionView(result.session, { writerToken }), attempts: result.attempts.map(publicAttempt), finished: result.finished, replayed: result.replayed });
      }

      if (request.method === 'POST' && pathname === '/api/attempts') {
        const submitted = submissionInput(body);
        const hash = crypto.createHash('sha256').update(canonicalJSON(submitted)).digest('hex');
        const attempt = await store.transact(state => {
          const previous = state.attempts.find(item => item.submissionId === submitted.submissionId);
          if (previous) {
            if (previous.submissionHash !== hash) throw new InputError('相同提交标识已用于不同内容，请刷新后重试。', 409);
            return previous;
          }
          const library = findLibrary(state, submitted.libraryId);
          const snapshot = questionSnapshot(library, submitted.questionId);
          const recording = submitted.recordingId ? state.recordings[submitted.recordingId] : null;
          if (submitted.recordingId && !recording) throw new InputError('录音尚未保存成功，未创建作答记录。');
          const item = {
            ...submitted, id: newId(), questionSnapshot: snapshot, sourceHash: library.contentHash,
            recordingUrl: recording ? `/api/media/${recording.mediaId}` : null,
            kind: state.attempts.some(a => a.libraryId === submitted.libraryId && a.questionId === submitted.questionId) ? 'retry' : 'first',
            createdAt: now(), objective: gradeAnswer(snapshot, submitted.answer), evaluations: [], reviewed: false, submissionHash: hash,
          };
          state.attempts.push(item);
          return item;
        });
        return sendJSON(response, 200, { attempt: publicAttempt(attempt) });
      }
      if (request.method === 'PATCH' && route.length === 3 && route[0] === 'api' && route[1] === 'attempts') {
        if (Object.keys(body).some(key => key !== 'reviewed') || typeof body.reviewed !== 'boolean') throw new InputError('已提交记录不能修改答案或原题；此接口只接受 reviewed 复习标记。');
        const attempt = await store.transact(state => { const item = findAttempt(state, route[2]); item.reviewed = body.reviewed; return item; });
        return sendJSON(response, 200, { attempt: publicAttempt(attempt) });
      }
      if (request.method === 'POST' && route.length === 4 && route[0] === 'api' && route[1] === 'attempts' && route[3] === 'feedback') {
        if (body.consent !== true) throw new InputError('发送作答文字前需要明确同意。');
        models.assertBinding?.(body.expectedBinding);
        const job = await store.transact(state => {
          models.assertBinding?.(body.expectedBinding);
          const attempt = findAttempt(state, route[2]);
          if(state.sessions.some(session=>session.mode==='exam'&&!session.finished&&Object.values(session.answers||{}).some(entry=>entry.attemptId===attempt.id)))throw new InputError('请完成本轮 TEST 后再请求其中作答的 AI 反馈。',403);
          const existingJob = state.jobs.find(item => item.attemptId === attempt.id && ['queued', 'running'].includes(item.status));
          if (existingJob) return existingJob;
          const transcript = body.transcript === undefined ? attempt.transcript : textValue(body.transcript, '转写文字');
          const transcriptConfirmed = body.transcriptConfirmed === undefined ? attempt.transcriptConfirmed : booleanValue(body.transcriptConfirmed, '转写确认');
          if (attempt.questionSnapshot.section === 'speaking' && (!transcript.trim() || !transcriptConfirmed)) throw new InputError('请先填写并确认本次录音的转写文字，再请求口语文字反馈。');
          if (attempt.questionSnapshot.type === 'listen_repeat' && (typeof attempt.questionSnapshot.answer !== 'string' || !attempt.questionSnapshot.answer.trim())) throw new InputError('跟读题缺少核实后的目标原句（answer），无法分析。');
          const item = { id: newId(), attemptId: attempt.id, status: 'queued', createdAt: now(), modelBinding: modelBinding(models), request: { transcript, transcriptConfirmed } };
          state.jobs.push(item);
          return item;
        });
        sendJSON(response, 200, { job: publicJob(job) });
        void runQueue().catch(error => console.error('Feedback queue stopped:', error.message));
        return;
      }
      if(request.method==='GET'&&pathname==='/api/assistant/preferences')return sendJSON(response,200,assistantMemory.preview());
      if(request.method==='POST'&&pathname==='/api/assistant/preferences')return sendJSON(response,200,await assistantMemory.saveConfirmedPreference(body));
      if(request.method==='POST'&&pathname==='/api/assistant/preferences/delete')return sendJSON(response,200,await assistantMemory.deletePreference(body));
      if(request.method==='POST'&&pathname==='/api/chat/exposure')return sendJSON(response,200,examChat.expose(body.context,body.helper));
      if (request.method === 'POST' && pathname === '/api/chat') {
        if (body.consent !== true) throw new InputError('发送聊天内容前需要明确同意。');
        models.assertBinding?.(body.expectedBinding);
        const message = textValue(body.message, '聊天消息', 100000, true);
        if(body.context?.sessionId)return sendJSON(response,200,await examChat.send({...body,message}));
        const history = body.history ?? [];
        if (!Array.isArray(history) || history.length > 40 || JSON.stringify(history).length > 1000000) throw new InputError('聊天历史过长。');
        const checkedHistory = history.map(item => {
          if (!['user', 'assistant'].includes(item?.role)) throw new InputError('聊天历史仅允许 user 和 assistant 消息。');
          return { role: item.role, content: textValue(item.content, '历史消息', 100000) };
        });
        const attempt=body.context?.attemptId?findAttempt(store.read(),body.context.attemptId):null;
        if(attempt&&store.read().sessions.some(session=>session.mode==='exam'&&!session.finished&&Object.values(session.answers||{}).some(entry=>entry.attemptId===attempt.id)))throw new InputError('请完成本轮 TEST 后再讨论其中的作答。',403);
        const context = attempt ? { attemptId: attempt.id, attempt: publicAttempt(attempt) } : undefined;
        return sendJSON(response, 200, await models.chat({ message, history: checkedHistory, consent: true, context,expectedBinding:body.expectedBinding }));
      }
      if (request.method === 'GET' && pathname === '/api/asr') return sendJSON(response, 200, asr.view());
      if (request.method === 'GET' && pathname === '/api/material-tools') return sendJSON(response,200,await materialToolsView());
      if (request.method === 'POST' && pathname === '/api/material-tools/media-configuration') return sendJSON(response,200,await controlWrite(()=>materialToolRuntime.configureMedia(body)));
      if (request.method === 'POST' && pathname === '/api/asr/configure') return sendJSON(response, 200, await controlWrite(()=>asr.configure(body)));
      if (request.method === 'POST' && pathname === '/api/asr/test') return sendJSON(response, 202, asr.selfTest());
      if (request.method === 'POST' && pathname === '/api/asr/cancel') return sendJSON(response, 200, asr.cancel());
      if (request.method === 'POST' && pathname === '/api/asr/disable') return sendJSON(response, 200, asr.disable());
      if (request.method === 'POST' && pathname === '/api/settings') return sendJSON(response, 200, { settings: await controlWrite(()=>models.updateSettings(body)) });
      if (request.method === 'POST' && pathname === '/api/settings/test') {models.assertBinding?.(body.expectedBinding);return sendJSON(response, 200, await models.test({ consent: body.consent === true,expectedBinding:body.expectedBinding }));}

      if (pathname.startsWith('/api/')) throw new InputError('找不到此接口。', 404);
      if (!['GET', 'HEAD'].includes(request.method)) throw new InputError('此请求方法不受支持。', 405);
      const filename = path.resolve(PUBLIC_DIR, `.${pathname === '/' ? '/index.html' : pathname}`);
      const relative = path.relative(PUBLIC_DIR, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new InputError('不允许访问此路径。', 403);
      let real;
      let bytes;
      try {
        real = await fs.realpath(filename);
        const inside = path.relative(await fs.realpath(PUBLIC_DIR), real);
        if (inside.startsWith('..') || path.isAbsolute(inside)) throw new InputError('不允许访问此路径。', 403);
        const stat = await fs.stat(real);
        if (!stat.isFile()) throw new InputError('找不到此页面。', 404);
        bytes = await fs.readFile(real);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new InputError('找不到此页面。', 404);
        throw error;
      }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wav': 'audio/wav' };
      response.writeHead(200, { 'Content-Type': types[path.extname(real)] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      return response.end(request.method === 'HEAD' ? undefined : bytes);
      });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (!response.headersSent) sendJSON(response, Number.isInteger(error.status) ? error.status : 500, { error: error.status ? error.message : '本地操作失败。请检查文件、磁盘空间和应用设置后重试。' });
      else response.destroy();
      if (!error.status) console.error('Local request failed:', error.message);
    }finally{if(archiveOperation){archiveOperations.delete(archiveOperation);archiveOperation.finish();}}
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  actualPort = server.address().port;
  return {
    server,
    url: `http://127.0.0.1:${actualPort}`,
    materialJobs,materialTools:materialToolRuntime,
    async close() {
      if (closing) return;
      closing = true;
      models.cancelRequests?.('application_close');
      await drainArchives(null,'应用正在关闭；导入或导出已取消。');
      await feedbackQueue.pause('application_close');
      await materialJobs?.stop();
      await materialToolRuntime.close();
      await materialOcr.quiesce();
      await ocr.close();
      examOverlay.close();
      await materialProcessing.stop?.();
      await drainNativeMedia();
      await store.transact(state => {
        for (const job of state.jobs) if (['queued', 'running'].includes(job.status)) {
          job.status = 'interrupted'; job.error = '应用关闭时任务未完成；请按需手动重新分析。';
        }
        for (const material of state.materials || []) if (['analyzing', 'converting'].includes(material.status)) {
          material.status = 'interrupted'; material.error = '应用关闭时材料处理未完成；原文件已保留。';
        }
        state.sessions = state.sessions.map(session => isExamSession(session) ? pauseExamSession(session) : session);
      });
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      await store.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = await startServer({ dataDir: process.env.PRACTICEBRIDGE_DATA_DIR || path.join(PROJECT_DIR, 'data'), port: Number(process.env.PORT || 4173) });
  console.log(`PracticeBridge: ${instance.url}`);
  const stop = async () => { await instance.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
