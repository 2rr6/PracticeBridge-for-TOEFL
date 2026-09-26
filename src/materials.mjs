import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from './store.mjs';
import { InputError, LIMITS, safeRelativeName, inputFileLimit } from './package.mjs';

export const MATERIAL_LIMITS = Object.freeze({ records: 1000, files: 200, textChars: 500000, metadataBytes: 8 * 1024 * 1024 });
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STATUSES = new Set(['received', 'analyzing', 'assessed', 'needs_information', 'unsupported', 'converting', 'draft_ready', 'imported', 'failed', 'interrupted']);
const MUTABLE = new Set(['status', 'analysis', 'draft', 'issues', 'error', 'libraryId', 'processor', 'modelBinding']);
const RECORD_FIELDS = new Set(['id', 'title', 'status', 'createdAt', 'updatedAt', 'files', 'text', 'candidateSummary', ...MUTABLE]);
const FILE_FIELDS = new Set(['id', 'name', 'size', 'mime']);
const MIME = Object.freeze({
  '.zip': 'application/zip', '.json': 'application/json', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => { throw new InputError(message); };
const stringValue = (value, label, max, { nullable = false, required = false } = {}) => {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label}无效或过长。`);
  return value;
};
const dateValue = value => {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) fail('材料记录日期无效。');
  return value;
};
const idValue = (value, label = '材料标识', nullable = false) => {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label}无效。`);
  return value;
};

function boundedJSON(value, label, { object = false, array = false, maxBytes = MATERIAL_LIMITS.metadataBytes } = {}) {
  if (value === undefined || value === null) return null;
  if ((object && !plainObject(value)) || (array && !Array.isArray(value))) fail(`${label}格式无效。`);
  let count = 0;
  const seen = new Set();
  const visit = (item, depth = 0) => {
    if (++count > 200000 || depth > 40) fail(`${label}结构过大或过深。`);
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { if (item.length > maxBytes) fail(`${label}过大。`); return; }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!Array.isArray(item) && !plainObject(item)) fail(`${label}必须是可保存的 JSON。`);
    if (seen.has(item)) fail(`${label}包含循环引用。`);
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label}包含无效字段。`);
      visit(child, depth + 1);
    }
    seen.delete(item);
  };
  visit(value);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maxBytes) fail(`${label}超过大小限制。`);
  return JSON.parse(serialized);
}

/** Closed, nonsecret persistence projection; legacy five-field records remain readable. */
export function modelBindingValue(value) {
  if (value === undefined || value === null) return null;
  const extended=['structuredOutputMode','bindingRevision','credentialVersion'];
  const allowed = new Set(['provider', 'baseUrl', 'model', 'timeoutSeconds', 'maxOutputTokens',...extended]);
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.has(key))) fail('材料的模型标识无效；不能保存密钥或额外配置。');
  const result = {
    provider: stringValue(value.provider ?? '', '模型提供方', 100),
    baseUrl: stringValue(value.baseUrl ?? '', '模型地址', 3000),
    model: stringValue(value.model ?? '', '模型名称', 200),
    timeoutSeconds: value.timeoutSeconds ?? null,
    maxOutputTokens: value.maxOutputTokens ?? null,
  };
  if (result.baseUrl) {
    let url;
    try { url = new URL(result.baseUrl); } catch { fail('材料的模型地址无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('材料的模型地址无效。');
  }
  for (const [field, max] of [['timeoutSeconds', 600], ['maxOutputTokens', 200000]]) {
    if (result[field] !== null && (!Number.isInteger(result[field]) || result[field] < 1 || result[field] > max)) fail('材料的模型标识数值无效。');
  }
  if(extended.some(key=>Object.hasOwn(value,key))){
    if(!extended.every(key=>Object.hasOwn(value,key))||!['none','openai','compatible','codex'].includes(result.provider)||!['json_schema','json_object'].includes(value.structuredOutputMode)||!['bindingRevision','credentialVersion'].every(key=>typeof value[key]==='string'&&UUID.test(value[key])))fail('材料的非秘密模型绑定版本无效；不能省略部分确认字段。');
    for(const key of extended)result[key]=value[key];
  }
  return result;
}

function fileDescriptor(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !FILE_FIELDS.has(key)) || typeof value.id !== 'string' || !HASH.test(value.id)) fail('材料原文件标识无效。');
  const name = safeRelativeName(value.name);
  const max = inputFileLimit(name);
  if (!Number.isInteger(value.size) || value.size < 0 || value.size > max) fail('材料原文件大小无效。');
  if (typeof value.mime !== 'string' || value.mime.length > 200 || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(value.mime)) fail('材料原文件类型标记无效。');
  return { id: value.id, name, size: value.size, mime: value.mime };
}

function normalizeRecord(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !RECORD_FIELDS.has(key))) fail('材料记录格式无效。');
  if (!STATUSES.has(value.status)) fail('材料处理状态无效。');
  if (!Array.isArray(value.files) || value.files.length > MATERIAL_LIMITS.files) fail('材料原文件数量无效。');
  const files = value.files.map(fileDescriptor);
  if (files.reduce((sum, file) => sum + file.size, 0) > LIMITS.uploadBytes) fail('材料原文件总大小超过 80 MB。');
  const text = stringValue(value.text ?? '', '材料文字', MATERIAL_LIMITS.textChars);
  if (!files.length && !text.trim()) fail('材料记录缺少原文件或文字。');
  const record = {
    id: idValue(value.id), title: stringValue(value.title, '材料标题', 300, { required: true }), status: value.status,
    createdAt: dateValue(value.createdAt), updatedAt: dateValue(value.updatedAt), files, text,
    analysis: boundedJSON(value.analysis, '材料分析', { object: true }),
    draft: boundedJSON(value.draft, '材料草稿', { object: true }),
    issues: boundedJSON(value.issues ?? [], '材料问题', { array: true, maxBytes: 1024 * 1024 }),
    error: stringValue(value.error, '材料错误信息', 20000, { nullable: true }),
    libraryId: idValue(value.libraryId, '材料对应题库标识', true),
    processor: stringValue(value.processor, '材料处理方式', 100, { nullable: true }),
    modelBinding: modelBindingValue(value.modelBinding),
  };
  if(value.candidateSummary!==undefined){const summary=value.candidateSummary;if(!plainObject(summary)||Object.keys(summary).some(key=>!['total','answerable','pending'].includes(key))||!['total','answerable','pending'].every(key=>Number.isInteger(summary[key])&&summary[key]>=0&&summary[key]<=1000)||summary.answerable+summary.pending!==summary.total)fail('候选摘要无效。');record.candidateSummary={...summary};}
  if (Buffer.byteLength(JSON.stringify(record)) > MATERIAL_LIMITS.metadataBytes) fail('材料记录超过 8 MB 大小限制。');
  return record;
}

function normalizeRecords(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MATERIAL_LIMITS.records) fail('材料记录数量无效。');
  const result = values.map(normalizeRecord);
  const ids = new Set();
  for (const item of result) {
    if (ids.has(item.id.toLowerCase())) fail('材料记录标识重复。');
    ids.add(item.id.toLowerCase());
  }
  return result;
}

function decodeOriginal(file) {
  if (!plainObject(file) || typeof file.data !== 'string') fail('原文件必须包含名称和 base64 内容。');
  const name = safeRelativeName(file.name);
  const maxBytes = inputFileLimit(name);
  if (file.data.length > Math.ceil(maxBytes / 3) * 4 + 4) fail(`原文件过大：${name}`);
  if (file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) fail(`原文件编码无效：${name}`);
  const bytes = Buffer.from(file.data, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== file.data) fail(`原文件编码无效或过大：${name}`);
  return { name, bytes, id: hash(bytes), mime: MIME[path.posix.extname(name).toLowerCase()] || 'application/octet-stream' };
}

const publicRecord = record => {
  let analysis = null;
  if (record.analysis) {
    analysis = {};
    if (typeof record.analysis.summary === 'string') analysis.summary = record.analysis.summary.slice(0, 10000);
    if (typeof record.analysis.status === 'string') analysis.status = record.analysis.status.slice(0, 100);
    if (typeof record.analysis.canCreateDraft === 'boolean') analysis.canCreateDraft = record.analysis.canCreateDraft;
  }
  return {
    id: record.id, title: record.title, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
    files: record.files, textLength: record.text.length, analysis, error: record.error, libraryId: record.libraryId,
    ...(record.candidateSummary?{candidateSummary:record.candidateSummary}:{}),
  };
};

/** Local receipt of originals is independent of any parser or model call. */
export function createMaterialInbox({ store }) {
  if (!store || typeof store.dataDir !== 'string' || typeof store.read !== 'function' || typeof store.transact !== 'function') throw new TypeError('createMaterialInbox requires a store.');
  const originalDir = path.join(path.resolve(store.dataDir), 'input-blobs');
  const records = () => normalizeRecords(store.read().materials);
  const get = id => {
    if (typeof id !== 'string' || !UUID.test(id)) throw new InputError('找不到指定材料。', 404);
    const item = records().find(record => record.id === id);
    if (!item) throw new InputError('找不到指定材料。', 404);
    return item;
  };
  const ensureDirectory = async create => {
    try {
      const stat = await fs.lstat(originalDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new InputError('材料原文件存储位置异常。', 500);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) throw new InputError('材料原文件存储目录不存在。', 404);
      await fs.mkdir(originalDir, { recursive: true });
      const stat = await fs.lstat(originalDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new InputError('材料原文件存储位置异常。', 500);
    }
  };
  const readOriginal = async descriptor => {
    const checked = fileDescriptor(descriptor);
    await ensureDirectory(false);
    try {
      const destination = path.join(originalDir, checked.id);
      const stat = await fs.lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== checked.size) throw new InputError('材料原文件大小或存储位置异常。', 500);
      const bytes = await fs.readFile(destination);
      if (bytes.length !== checked.size || hash(bytes) !== checked.id) throw new InputError('材料原文件完整性校验失败。', 500);
      return bytes;
    } catch (error) {
      if (error.code === 'ENOENT') throw new InputError('材料原文件不存在。', 404);
      throw error;
    }
  };
  const writeOriginals = async originals => {
    if (!(originals instanceof Map) || originals.size > LIMITS.zipEntries) fail('原文件集合无效或过大。');
    const pending = [];
    let total = 0;
    for (const [id, data] of originals) {
      if (typeof id !== 'string' || !HASH.test(id) || !Buffer.isBuffer(data) || data.length > LIMITS.zipBytes || hash(data) !== id) fail('待保存原文件的内容标识无效。');
      total += data.length;
      if (total > LIMITS.expandedBytes) fail('待保存原文件总大小超过限制。');
      pending.push([id, Buffer.from(data)]);
    }
    if (!pending.length) return;
    await ensureDirectory(true);
    for (const [id, bytes] of pending) {
      const destination = path.join(originalDir, id);
      try {
        const stat = await fs.lstat(destination);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length) throw new InputError('现有材料原文件不可替换，完整性检查失败。', 500);
        if (hash(await fs.readFile(destination)) !== id) throw new InputError('现有材料原文件完整性校验失败。', 500);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomicWrite(destination, bytes);
      }
    }
  };
  const receive = async ({ files = [], text = '', title = '' } = {}) => {
    if (!Array.isArray(files) || files.length > MATERIAL_LIMITS.files) fail('一次最多接收 200 个原文件。');
    const checkedText = stringValue(text, '材料文字', MATERIAL_LIMITS.textChars);
    const checkedTitle = stringValue(title, '材料标题', 300).trim();
    if (!files.length && !checkedText.trim()) fail('请选择原文件或粘贴材料文字。');
    if (records().length >= MATERIAL_LIMITS.records) fail('材料收件箱已达到 1000 条记录限制。');
    const decoded = files.map(decodeOriginal);
    if (decoded.reduce((sum, file) => sum + file.bytes.length, 0) > LIMITS.uploadBytes) fail('本次原文件总大小不能超过 80 MB。');
    const timestamp = new Date().toISOString();
    const record = normalizeRecord({
      id: crypto.randomUUID(), title: checkedTitle || (decoded[0] ? path.posix.basename(decoded[0].name).slice(0, 300) : '文本材料'),
      status: 'received', createdAt: timestamp, updatedAt: timestamp,
      files: decoded.map(file => ({ id: file.id, name: file.name, size: file.bytes.length, mime: file.mime })),
      text: checkedText, analysis: null, draft: null, issues: [], error: null, libraryId: null, processor: null, modelBinding: null,
    });
    await writeOriginals(new Map(decoded.map(file => [file.id, file.bytes])));
    return store.transact(state => {
      state.materials ??= [];
      if (!Array.isArray(state.materials) || state.materials.length >= MATERIAL_LIMITS.records) fail('材料收件箱记录无效或已满。');
      state.materials.push(record);
      return record;
    });
  };
  const update = async (id, patch, { expectedUpdatedAt, isCurrent } = {}) => {
    get(id);
    if (!plainObject(patch) || Object.keys(patch).some(key => !MUTABLE.has(key))) fail('只能更新材料处理状态，原文件和来源记录不可修改。');
    const copied = boundedJSON(patch, '材料更新', { object: true });
    return store.transact(state => {
      if (isCurrent && !isCurrent()) throw new InputError('此草稿页面已失效，请从材料库重新打开；当前编辑内容未覆盖已保存材料。', 409);
      const index = (state.materials || []).findIndex(record => record.id === id);
      if (index < 0) throw new InputError('找不到指定材料。', 404);
      if (expectedUpdatedAt !== undefined && state.materials[index].updatedAt !== expectedUpdatedAt) throw new InputError('这批材料已有更新，请从材料库重新打开最新草稿。', 409);
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(state.materials[index].updatedAt) + 1)).toISOString();
      const next = normalizeRecord({ ...state.materials[index], ...copied, updatedAt });
      state.materials[index] = next;
      return next;
    });
  };
  const loadFiles = async id => {
    const item = get(id);
    const result = [];
    for (const file of item.files) result.push({ name: file.name, data: (await readOriginal(file)).toString('base64') });
    return result;
  };
  const backupFiles = async materialRecords => {
    const entries = normalizeRecords(materialRecords);
    const result = new Map();
    let total = 0;
    for (const record of entries) for (const file of record.files) {
      const key = `input-blobs/${file.id}`;
      if (result.has(key)) {
        if (result.get(key).length !== file.size) fail('材料记录与原文件大小不一致。');
        continue;
      }
      total += file.size;
      if (total > LIMITS.expandedBytes || result.size >= LIMITS.zipEntries) fail('材料原文件超过备份大小或数量限制。');
      result.set(key, await readOriginal(file));
    }
    return result;
  };
  const prepareRestore = (materialRecords, zipFiles) => {
    const materials = normalizeRecords(materialRecords);
    if (!(zipFiles instanceof Map)) fail('备份原文件集合无效。');
    const originals = new Map();
    let total = 0;
    for (const record of materials) for (const file of record.files) {
      const data = zipFiles.get(`input-blobs/${file.id}`);
      if (!Buffer.isBuffer(data) || data.length !== file.size || hash(data) !== file.id) fail('备份材料原文件缺失或完整性校验失败。');
      if (originals.has(file.id)) continue;
      total += data.length;
      if (total > LIMITS.expandedBytes || originals.size >= LIMITS.zipEntries) fail('备份材料原文件超过大小或数量限制。');
      originals.set(file.id, Buffer.from(data));
    }
    for (const name of zipFiles.keys()) {
      if (typeof name !== 'string' || safeRelativeName(name) !== name) fail('备份文件名无效。');
      if (name.startsWith('input-blobs/') && (!/^input-blobs\/[a-f0-9]{64}$/.test(name) || !originals.has(name.slice('input-blobs/'.length)))) fail('备份包含未声明或路径无效的材料原文件。');
    }
    return { materials, originals };
  };
  return { list: () => records().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRecord), get, receive, update, loadFiles, backupFiles, prepareRestore, writeOriginals };
}
