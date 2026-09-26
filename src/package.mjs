import crypto from 'node:crypto';
import path from 'node:path';
import { readArchive, writeArchive, collectEntry } from './archive/zip-adapter.mjs';
import { normalizeExamExtensions } from './exam-plan.mjs';
import { detectMediaContent, formatExtensions } from './media-manifest.mjs';
import { validateV2Structure } from './package-schema.mjs';

export const LIMITS = Object.freeze({
  fileBytes: 25 * 1024 * 1024,
  documentBytes: 64 * 1024 * 1024,
  uploadBytes: 80 * 1024 * 1024,
  zipBytes: 80 * 1024 * 1024,
  backupBytes: 160 * 1024 * 1024,
  expandedBytes: 160 * 1024 * 1024,
  zipEntries: 1200,
  manifestBytes: 8 * 1024 * 1024,
  recordingBytes: 25 * 1024 * 1024,
});

export const inputFileLimit = name => /\.zip$/i.test(name || '') ? LIMITS.zipBytes : /\.(pdf|docx)$/i.test(name || '') ? LIMITS.documentBytes : LIMITS.fileBytes;

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'InputError';
    this.status = status;
  }
}

export function safeRelativeName(value) {
  if (typeof value !== 'string' || !value || value.length > 400 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new InputError('文件名无效或过长。');
  }
  const name = value.replaceAll('\\', '/');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || /[?#:]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new InputError(`不允许绝对路径或路径跳转：${value}`);
  }
  return name;
}

export function decodeUpload(file, { maxBytes = LIMITS.fileBytes } = {}) {
  if (!file || typeof file !== 'object' || typeof file.data !== 'string') throw new InputError('上传文件必须包含名称和 base64 内容。');
  const name = safeRelativeName(file.name);
  if (file.data.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new InputError(`文件过大：${name}`);
  if (!file.data || file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new InputError(`文件编码无效：${name}`);
  const bytes = Buffer.from(file.data, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== file.data) throw new InputError(`文件编码无效或文件过大：${name}`);
  return { name, bytes };
}

const foldedName = name => name.normalize('NFC').toLocaleLowerCase('en-US');

export async function readZipContents(bytes, { maxExpandedBytes = LIMITS.expandedBytes, maxEntries = LIMITS.zipEntries, allowInputOriginals = false, maxCompressedBytes = LIMITS.zipBytes, signal, usage } = {}) {
  const files = new Map(); let expandedBytes = 0, entryCount = 0;
  try {
    for await (const entry of readArchive({ inputRef: bytes, signal, budget: { maxCompressedBytes, maxExpandedBytes, maxEntries, usage,
      maxEntryBytes: name => allowInputOriginals && /^input-blobs\/[a-f0-9]{64}$/.test(name) ? LIMITS.zipBytes : /\.(pdf|docx)$/i.test(name) ? LIMITS.documentBytes : LIMITS.fileBytes,
    } })) {
      entryCount++;
      const data = await collectEntry(entry);
      if (entry.kind === 'directory') continue;
      files.set(entry.name, data); expandedBytes += data.length;
    }
  } catch (error) { if (error?.name === 'AbortError') throw error; throw new InputError(error.message); }
  return { files, expandedBytes, entryCount };
}

export async function readZip(bytes, options = {}) {
  return (await readZipContents(bytes, options)).files;
}

/** One receipt/inspection uses one session across strict recognition and its
 * ordinary-material fallback. Successes and failures are both cached, and
 * failed decompression remains charged to the same actual-byte ledger.
 */
export function createArchiveSession({ looseBytes = 0, looseEntries = 0, signal, maxExpandedBytes = LIMITS.expandedBytes, maxEntries = LIMITS.zipEntries } = {}) {
  const cache = new Map(), usage = { expandedBytes: looseBytes, entries: looseEntries };
  return {
    get usage() { return { ...usage }; },
    read(file) {
      const key = `${file.name}\0${crypto.createHash('sha256').update(file.bytes).digest('hex')}`;
      if (!cache.has(key)) cache.set(key, readZipContents(file.bytes, { signal, usage, maxExpandedBytes, maxEntries }));
      return cache.get(key);
    },
  };
}

export function identifyMedia(name, bytes) {
  const ext = path.extname(name).toLowerCase();
  const detected = detectMediaContent(bytes);
  return detected && formatExtensions(detected.format).includes(ext) ? { kind: detected.kind, mime: detected.mime } : null;
}

const ORDINARY_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.pdf', '.docx',
  '.mp3', '.wav', '.ogg', '.m4a', '.webm', '.mp4', '.png', '.jpg', '.jpeg', '.webp', '.gif',
]);

/** Decode uploads once, expand ZIPs in memory, then identify the native package route. */
export async function prepareImportFiles(uploadedFiles = [], { signal, archiveSession } = {}) {
  if (!Array.isArray(uploadedFiles) || uploadedFiles.length > 200) throw new InputError('请选择不超过 200 个文件。');
  const decoded = uploadedFiles.map(file => decodeUpload(file, { maxBytes: inputFileLimit(file?.name) }));
  if (decoded.reduce((total, file) => total + file.bytes.length, 0) > LIMITS.uploadBytes) throw new InputError('同时上传的文件总大小不能超过 80 MB。');
  const uploadNames = new Set();
  for (const file of decoded) {
    const key = foldedName(file.name);
    if (uploadNames.has(key)) throw new InputError(`重复文件名：${file.name}`);
    uploadNames.add(key);
  }
  const files = new Map();
  const existingNames = new Set();
  const jsonNames = [];
  let nativeArchive = false;
  const looseFiles = decoded.filter(file => !/\.zip$/i.test(file.name));
  const archives = archiveSession ?? createArchiveSession({ looseBytes: looseFiles.reduce((total, file) => total + file.bytes.length, 0), looseEntries: looseFiles.length, signal });
  const addFile = (name, bytes) => {
    const key = foldedName(name);
    if (existingNames.has(key)) throw new InputError(`重复文件名：${name}；请为重名材料改名后再导入。`);
    existingNames.add(key);
    files.set(name, bytes);
  };
  for (const file of decoded.filter(file => /\.zip$/i.test(file.name))) {
    const contents = await archives.read(file);
    if (!contents.files.size) throw new InputError(`ZIP 内没有可导入的文件：${file.name}`);
    const manifests = [...contents.files.keys()].filter(name => path.posix.basename(name).toLowerCase() === 'practicebridge.json');
    if (manifests.length > 1) throw new InputError('请选择一个练习包清单；ZIP 内有多个 practicebridge.json。');
    const manifestName = manifests[0];
    const prefix = manifestName?.includes('/') ? manifestName.slice(0, manifestName.lastIndexOf('/') + 1) : '';
    if (prefix && [...contents.files.keys()].some(name => !name.startsWith(prefix))) {
      throw new InputError('练习包清单 practicebridge.json 应位于 ZIP 根目录，或与全部材料一起位于同一个外层文件夹。');
    }
    for (const [originalName, bytes] of contents.files) {
      const name = prefix ? originalName.slice(prefix.length) : originalName;
      const extension = path.posix.extname(name).toLowerCase();
      if (extension === '.json' && !manifestName) {
        throw new InputError(`ZIP 内的 JSON 练习包缺少 practicebridge.json 清单：${file.name}。普通资料 ZIP 可包含 PDF、DOCX、文字与配套媒体。`);
      }
      addFile(name, bytes);
      if (originalName === manifestName) { jsonNames.push(name); nativeArchive = true; }
    }
  }
  for (const file of looseFiles) {
    addFile(file.name, file.bytes);
    if (/\.json$/i.test(file.name)) jsonNames.push(file.name);
  }
  for (const name of files.keys()) {
    const extension = path.posix.extname(name).toLowerCase();
    if (extension !== '.json' && !ORDINARY_EXTENSIONS.has(extension)) {
      throw new InputError(`不支持导入此文件：${name}。请选择 PDF、DOCX、文字、音频或图片；ZIP 内不能再嵌套 ZIP。`);
    }
  }
  if (!jsonNames.length) return { native: null, files };
  if (jsonNames.length > 1) throw new InputError('请选择一个练习包 JSON；媒体可同时选择。');
  const manifestName = jsonNames[0];
  if (files.get(manifestName).length > LIMITS.manifestBytes) throw new InputError('练习包清单过大。');
  let pack;
  try { pack = JSON.parse(files.get(manifestName).toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new InputError('练习包 JSON 无法解析，请检查括号、引号和逗号。'); }
  const native = { pack, files, sources: [{ name: manifestName, text: JSON.stringify(pack, null, 2) }], method: nativeArchive ? 'native-zip' : 'native-json' };
  return { native, files };
}

export async function parseNativeImport(uploadedFiles = []) {
  return (await prepareImportFiles(uploadedFiles)).native;
}

export function filesFromUploads(files = []) {
  if (!Array.isArray(files) || files.length > 200) throw new InputError('上传文件数量过多。');
  const map = new Map();
  const names = new Set();
  let total = 0;
  for (const file of files) {
    const decoded = decodeUpload(file, {maxBytes:inputFileLimit(file?.name)});
    if (names.has(decoded.name.toLowerCase())) throw new InputError(`重复文件名：${decoded.name}`);
    names.add(decoded.name.toLowerCase());
    total += decoded.bytes.length;
    if (total > LIMITS.uploadBytes) throw new InputError('同时上传的文件总大小不能超过 80 MB。');
    map.set(decoded.name, decoded.bytes);
  }
  return map;
}

const SECTIONS = new Set(['reading', 'listening', 'speaking', 'writing']);
const TYPES = new Set(['single_choice', 'fill_blank', 'sentence_order', 'email', 'discussion', 'interview', 'listen_repeat']);
const OBJECTIVE = new Set(['single_choice', 'fill_blank', 'sentence_order']);
const DEFAULT_TIME = { single_choice: 60, fill_blank: 60, sentence_order: 60, email: 420, discussion: 600, interview: 45, listen_repeat: 15 };

export function validatePackage(input, files = new Map()) {
  const issues = [];
  const issue = (severity, message, itemPath) => issues.push({ severity, message, path: itemPath });
  const object = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if(object.schemaVersion===2)issues.push(...validateV2Structure(object));
  const knownKeys=(value,allowed,at)=>{if(object.schemaVersion===2&&value&&typeof value==='object')for(const key of Object.keys(value))if(!allowed.includes(key))issue('error',`v2 不支持字段：${key}。`,`${at}.${key}`);};
  knownKeys(object,['schemaVersion','id','version','title','description','rights','groups','examContractVersion','minReaderVersion','examSets','coverageV1'],'pack');
  const string = (value, itemPath, { required = false, max = 200000 } = {}) => {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') { issue('error', '此项必须是文字。', itemPath); return ''; }
    if (value.length > max) issue('error', '此项文字过长。', itemPath);
    if (required && !value.trim()) issue('error', '此项不能为空。', itemPath);
    return value.slice(0, max);
  };
  const id = (value, itemPath) => {
    const text = string(value, itemPath, { required: true, max: 128 }).trim();
    if (text && !/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,127}$/u.test(text)) issue('error', 'ID 仅允许文字、数字、句点、冒号、短横线和下划线。', itemPath);
    return text;
  };
  const mediaPath = (value, itemPath, kind) => {
    if (value === undefined || value === null || value === '') return null;
    let name;
    try { name = safeRelativeName(value); } catch (error) { issue('error', error.message, itemPath); return typeof value === 'string' ? value : null; }
    if (!files.has(name)) issue('error', `找不到明确引用的媒体：${name}`, itemPath);
    else {
      const detected = identifyMedia(name, files.get(name));
      if (!detected || detected.kind !== kind) issue('error', `媒体内容与文件类型不符或格式不受支持：${name}`, itemPath);
      if (files.get(name).length > LIMITS.fileBytes) issue('error', `媒体文件过大：${name}`, itemPath);
    }
    return name;
  };
  const timing = (value, fallback, itemPath) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (!Number.isInteger(value) || value < 0 || value > 7200) { issue('error', '时间必须为 0 至 7200 之间的整数秒。', itemPath); return fallback; }
    return value;
  };
  if (![1,2].includes(object.schemaVersion)) issue('error', '仅支持 schemaVersion: 1 或 2 的练习包。', 'schemaVersion');
  const pack = {
    schemaVersion: object.schemaVersion===2?2:1,
    id: id(object.id, 'id'),
    version: string(object.version, 'version', { required: true, max: 80 }).trim(),
    title: string(object.title, 'title', { required: true, max: 300 }).trim(),
    description: string(object.description, 'description'),
    rights: string(object.rights, 'rights', { max: 10000 }),
    groups: [],
  };
  if(object.schemaVersion===2&&object.coverageV1!==undefined){const coverage=object.coverageV1;if(!coverage||typeof coverage!=='object'||Array.isArray(coverage)||Object.keys(coverage).some(k=>!['materialCoverage','examCompleteness','selectionCoverage'].includes(k))||!['partial','complete','unknown'].includes(coverage.materialCoverage)||!['partial','complete','unknown'].includes(coverage.examCompleteness)||!['selected-only','complete','unknown'].includes(coverage.selectionCoverage))issue('error','材料完整性标记无效。','coverageV1');else pack.coverageV1=structuredClone(coverage);}
  if (!Array.isArray(object.groups) || !object.groups.length || object.groups.length > 100) issue('error', '练习包应包含 1 至 100 个题组。', 'groups');
  const groupIds = new Set();
  const questionIds = new Set();
  let questionCount = 0;
  for (const [gi, rawGroup] of (Array.isArray(object.groups) ? object.groups.slice(0, 100) : []).entries()) {
    const g = rawGroup && typeof rawGroup === 'object' && !Array.isArray(rawGroup) ? rawGroup : {};
    const gp = `groups[${gi}]`;
    knownKeys(g,['id','section','title','passage','audio','image','questions','taskKind','transcript','presentation','timing','directions','inlineBlanks'],gp);
    const group = {
      id: id(g.id, `${gp}.id`),
      section: SECTIONS.has(g.section) ? g.section : 'reading',
      title: string(g.title, `${gp}.title`, { required: true, max: 300 }).trim(),
      passage: string(g.passage, `${gp}.passage`, { max: 500000 }),
      audio: mediaPath(g.audio, `${gp}.audio`, 'audio'),
      image: mediaPath(g.image, `${gp}.image`, 'image'),
      questions: [],
    };
    if (!SECTIONS.has(g.section)) issue('error', 'section 必须为 reading、listening、speaking 或 writing。', `${gp}.section`);
    if (groupIds.has(group.id)) issue('error', '题组 ID 重复。', `${gp}.id`);
    groupIds.add(group.id);
    if (!Array.isArray(g.questions) || !g.questions.length) issue('error', '每个题组至少需要一道题。', `${gp}.questions`);
    questionCount += Array.isArray(g.questions) ? g.questions.length : 0;
    for (const [qi, rawQuestion] of (Array.isArray(g.questions) ? g.questions.slice(0, 1000) : []).entries()) {
      const q = rawQuestion && typeof rawQuestion === 'object' && !Array.isArray(rawQuestion) ? rawQuestion : {};
      const qp = `${gp}.questions[${qi}]`;
      knownKeys(q,['id','type','prompt','options','answer','explanation','audio','image','timeLimitSeconds','prepareSeconds','source','sentenceFrame','answerSlots','localNumber','ordinalInTask','transcript','interaction','sourcePositionV1','candidateLineageV1'],qp);
      const type = TYPES.has(q.type) ? q.type : 'single_choice';
      const hasPassageInteraction = type === 'single_choice' && q.interaction && typeof q.interaction === 'object' && !Array.isArray(q.interaction) && ['sentence_select', 'sentence_insert'].includes(q.interaction.kind);
      const question = {
        id: id(q.id, `${qp}.id`),
        type,
        prompt: string(q.prompt, `${qp}.prompt`, { required: true, max: 100000 }),
        options: [],
        answer: null,
        explanation: string(q.explanation, `${qp}.explanation`),
        audio: mediaPath(q.audio, `${qp}.audio`, 'audio'),
        image: mediaPath(q.image, `${qp}.image`, 'image'),
        timeLimitSeconds: timing(q.timeLimitSeconds, DEFAULT_TIME[type], `${qp}.timeLimitSeconds`),
        prepareSeconds: timing(q.prepareSeconds, 0, `${qp}.prepareSeconds`),
        source: string(q.source, `${qp}.source`),
      };
      if(object.schemaVersion===2){
        const position=q.sourcePositionV1;
        if(!position||typeof position!=='object'||Array.isArray(position)||Object.keys(position).some(k=>!['sourceTaskId','originalOrdinalInTask'].includes(k))||typeof position.sourceTaskId!=='string'||!position.sourceTaskId||position.sourceTaskId.length>300||!(position.originalOrdinalInTask===null||Number.isInteger(position.originalOrdinalInTask)&&position.originalOrdinalInTask>0&&position.originalOrdinalInTask<=1000))issue('error','v2 题目需要完整的原始位置契约。',`${qp}.sourcePositionV1`);
        else question.sourcePositionV1=structuredClone(position);
        const lineage=q.candidateLineageV1;
        if(lineage!==undefined){if(!lineage||typeof lineage!=='object'||Object.keys(lineage).some(k=>!['candidateId','revision','adaptationKind','parentCandidateId'].includes(k))||typeof lineage.candidateId!=='string'||!Number.isInteger(lineage.revision)||lineage.revision<1||!(lineage.adaptationKind===null||typeof lineage.adaptationKind==='string')||!(lineage.parentCandidateId===null||typeof lineage.parentCandidateId==='string'))issue('error','候选来源契约无效。',`${qp}.candidateLineageV1`);else question.candidateLineageV1=structuredClone(lineage);}
      }
      if (type === 'sentence_order' && (q.answerSlots !== undefined || q.sentenceFrame !== undefined)) {
        const slots = q.answerSlots;
        const frame = string(q.sentenceFrame, "sentenceFrame", {required:true,max:10000});
        if (!Number.isInteger(slots) || slots < 1 || slots > 30 || (frame.match(/_{2,}/g)||[]).length !== slots) issue('error', '组句空位数量必须与句框中标记的空位一致。', qp + '.answerSlots');
        else {question.sentenceFrame=frame;question.answerSlots=slots;}
      }
      if (!TYPES.has(q.type)) issue('error', '不支持的题型。', `${qp}.type`);
      if (questionIds.has(question.id)) issue('error', '整个练习包内的题目 ID 必须唯一。', `${qp}.id`);
      questionIds.add(question.id);
      const optionIds = new Set();
      if (q.options !== undefined && !(hasPassageInteraction && q.options === null) && !Array.isArray(q.options)) issue('error', 'options 必须为数组。', `${qp}.options`);
      if (Array.isArray(q.options) && q.options.length > 30) issue('error', '每题最多 30 个选项。', `${qp}.options`);
      for (const [oi, rawOption] of (Array.isArray(q.options) ? q.options.slice(0, 30) : []).entries()) {
        const option = { id: id(rawOption?.id, `${qp}.options[${oi}].id`), text: string(rawOption?.text, `${qp}.options[${oi}].text`, { required: true, max: 20000 }) };
        if (optionIds.has(option.id)) issue('error', '选项 ID 重复。', `${qp}.options[${oi}].id`);
        optionIds.add(option.id);
        question.options.push(option);
      }
      if (['single_choice', 'sentence_order'].includes(type) && !hasPassageInteraction && question.options.length < 2) issue('error', '选择或排序题至少需要两个选项。', `${qp}.options`);
      if (type === 'sentence_order' && question.answerSlots > question.options.length) issue('error', '组句空位不能多于可选词块。', `${qp}.answerSlots`);
      if (q.answer !== undefined && q.answer !== null && q.answer !== '') {
        if (typeof q.answer === 'string') question.answer = string(q.answer, `${qp}.answer`);
        else if (Array.isArray(q.answer) && q.answer.length <= 100 && q.answer.every(a => typeof a === 'string')) question.answer = q.answer.map(a => string(a, `${qp}.answer`));
        else issue('error', 'answer 必须是文字、文字数组或 null。', `${qp}.answer`);
      }
      if (type === 'single_choice' && Array.isArray(question.answer) && question.answer.length === 1) question.answer = question.answer[0];
      const hasAnswer = typeof question.answer === 'string' ? Boolean(question.answer.trim()) : Array.isArray(question.answer) && question.answer.some(a => a.trim());
      if (OBJECTIVE.has(type) && !hasAnswer) {
        question.answer = null;
        issue('warning', '缺少标准答案；此题可练习但不会判分。', `${qp}.answer`);
      } else if (type === 'single_choice' && hasAnswer && !hasPassageInteraction && (typeof question.answer !== 'string' || !optionIds.has(question.answer))) {
        issue('error', '选择题标准答案必须是存在的选项 ID。', `${qp}.answer`);
      } else if (type === 'sentence_order' && hasAnswer && (!Array.isArray(question.answer) || question.answer.length !== (question.answerSlots ?? question.options.length) || new Set(question.answer).size !== question.answer.length || question.answer.some(a => !optionIds.has(a)))) {
        issue('error', '排序题标准答案必须不重复地对应全部空位；未声明空位数时须使用全部选项。', `${qp}.answer`);
      }
      if (type === 'listen_repeat') {
        if (question.answer === null || (typeof question.answer === 'string' && !question.answer.trim())) issue('warning', '跟读题缺少核实后的目标原句（answer）；可录音练习，但不能生成跟读反馈。', `${qp}.answer`);
        else if (typeof question.answer !== 'string') issue('error', '跟读题的 answer 必须是一段准确的目标原句文字。', `${qp}.answer`);
      }
      group.questions.push(question);
    }
    pack.groups.push(group);
  }
  if (questionCount > 1000) issue('error', '一个练习包最多包含 1000 道题。', 'groups');
  normalizeExamExtensions(object, pack, { issue, mediaPath });
  if(object.schemaVersion===2)issues.push(...validateV2Structure(pack,{normalized:true}));
  const media = [...files].flatMap(([name, bytes]) => {
    const identified = identifyMedia(name, bytes);
    return identified ? [{ name, mime: identified.mime }] : [];
  });
  return { pack, issues, media };
}

function visitPackageMedia(pack, visit) {
  for (const group of pack.groups || []) {
    for (const field of ['audio', 'image']) if (group[field]) visit(group, field);
    for (const question of group.questions || []) for (const field of ['audio', 'image']) if (question[field]) visit(question, field);
    for (const direction of group.directions || []) if (direction.audio) visit(direction, 'audio');
  }
  for (const set of pack.examSets || []) for (const section of set.sections || []) for (const module of section.modules || []) if (module.instructions?.audio) visit(module.instructions, 'audio');
}

export function collectMediaPaths(pack) {
  const result = new Set();
  visitPackageMedia(pack, (object, field) => result.add(object[field]));
  return [...result].sort();
}

export function mapPackageMedia(pack, map) {
  const result = structuredClone(pack);
  visitPackageMedia(result, (object, field) => { object[field] = map(object[field]); });
  return result;
}

export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function contentHash(pack, mediaMap) {
  return crypto.createHash('sha256').update(canonicalJSON({ pack, mediaMap })).digest('hex');
}

export async function createPackageZip(pack, files, { signal } = {}) {
  if(pack.schemaVersion===2){const issues=validateV2Structure(pack,{normalized:true});if(issues.length)throw new InputError(issues.map(issue=>`${issue.path}: ${issue.message}`).join('\n'));}
  const entries = [];
  entries.push({ name: 'practicebridge.json', bytes: Buffer.from(JSON.stringify(pack, null, 2)) });
  for (const name of collectMediaPaths(pack)) {
    if (!files.has(name)) throw new InputError(`导出时找不到媒体：${name}`, 500);
    entries.push({ name: safeRelativeName(name), bytes: files.get(name) });
  }
  return (await writeArchive({ entries, signal })).buffer;
}
