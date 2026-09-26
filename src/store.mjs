import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { InputError, mapPackageMedia } from './package.mjs';
import { assertMemoryShape } from './assistant-memory.mjs';
import {synchronizeExecutionLedger,validateExecutionLedger} from './material-execution-ledger.mjs';

export const emptyState = () => ({ schemaVersion: 2, workspaceEpoch: crypto.randomUUID(), libraries: [], attempts: [], sessions: [], jobs: [], recordings: {}, blobs: {}, materials: [], candidateSets: {}, importReceipts: {} });
export const newId = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

const WINDOWS_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_BACKOFF_MS = [20, 40, 80, 160, 320];

export async function atomicWrite(filename, bytes, {
  rename = fs.rename,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  platform = process.platform,
} = {}) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${newId()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    // Windows readers or scanners may briefly hold the destination open. Retry
    // only this already-prepared rename, with 620 ms of bounded backoff. Never
    // delete the destination, recreate the temporary file, or repeat a mutation.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, filename);
        break;
      } catch (error) {
        if (platform !== 'win32' || !WINDOWS_RENAME_ERRORS.has(error.code) || attempt >= RENAME_BACKOFF_MS.length) throw error;
        await sleep(RENAME_BACKOFF_MS[attempt]);
      }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export function assertStateShape(state) {
  assertMemoryShape(state?.assistantMemory);
  validateExecutionLedger(state?.materialExecutionLedger);
  if (!state || ![1,2].includes(state.schemaVersion) || !['libraries', 'attempts', 'sessions', 'jobs'].every(key => Array.isArray(state[key])) || (state.materials !== undefined && !Array.isArray(state.materials)) || !state.recordings || Array.isArray(state.recordings) || !state.blobs || Array.isArray(state.blobs) || (state.schemaVersion===2 && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(state.workspaceEpoch||''))) {
    throw new InputError('本地记录格式无效；原文件已保留，请从有效备份恢复。');
  }
}

export async function createStore({ dataDir, atomicWriter = atomicWrite }) {
  const root = path.resolve(dataDir);
  const filename = path.join(root, 'state.json');
  await fs.mkdir(path.join(root, 'blobs'), { recursive: true });
  let state, originalBytes;
  try {
    originalBytes = await fs.readFile(filename);
    state = JSON.parse(originalBytes.toString('utf8'));
    assertStateShape(state);
  } catch (error) {
    if (error.code === 'ENOENT') {
      state = emptyState();
      await atomicWriter(filename, JSON.stringify(state, null, 2));
    } else {
      throw new InputError('无法读取本地记录；原文件已保留，未创建空白记录覆盖它。', 500);
    }
  }
  if (state.schemaVersion===1) {
    const hash=crypto.createHash('sha256').update(originalBytes).digest('hex');
    const snapshot=path.join(root,'upgrades',`before-0.5.0-${hash}.json`);
    try {
      const stat=await fs.lstat(snapshot);
      if(!stat.isFile()||stat.isSymbolicLink()||!(await fs.readFile(snapshot)).equals(originalBytes))throw new InputError('升级前快照完整性异常；原记录未升级。',500);
    } catch(error) {
      if(error.code!=='ENOENT')throw error;
      await atomicWriter(snapshot,originalBytes);
    }
    if(!(await fs.readFile(snapshot)).equals(originalBytes))throw new InputError('升级前快照校验失败；原记录未升级。',500);
    const upgraded={...state,schemaVersion:2,workspaceEpoch:newId(),candidateSets:state.candidateSets||{},importReceipts:state.importReceipts||{}};
    assertStateShape(upgraded);
    await atomicWriter(filename,JSON.stringify(upgraded,null,2));
    state=upgraded;
  }
  let tail = Promise.resolve();
  const contexts=new AsyncLocalStorage();
  let restoreBarrier=null;
  const assertEpoch=expectedEpoch=>{
    if(expectedEpoch===undefined||expectedEpoch===null||expectedEpoch==='')throw new InputError('缺少工作区版本，请重新打开页面。',428);
    if(typeof expectedEpoch!=='string'||expectedEpoch!==state.workspaceEpoch)throw new InputError('工作区已恢复或更新；旧页面不能继续写入，请重新打开。',409);
  };
  const captureEpoch=()=>contexts.getStore()?.expectedEpoch??state.workspaceEpoch;
  const transact = (mutator,{expectedEpoch=captureEpoch(),restorePermit}={}) => {
    const operation = tail.then(async () => {
      assertEpoch(expectedEpoch);
      if(restoreBarrier&&restorePermit!==restoreBarrier)throw new InputError('工作区正在恢复；本次写入未执行。',503);
      const draft = structuredClone(state);
      const result = await mutator(draft);
      synchronizeExecutionLedger(draft,{previous:state,restoring:restorePermit!==undefined});
      assertStateShape(draft);
      if(draft.schemaVersion!==2)throw new InputError('升级后的工作区不能降为旧版写入格式。',409);
      await atomicWriter(filename, JSON.stringify(draft, null, 2));
      state = draft;
      return structuredClone(result);
    });
    tail = operation.catch(() => {});
    return operation;
  };
  const withEpoch=(expectedEpoch,work)=>{assertEpoch(expectedEpoch);return contexts.run(Object.freeze({expectedEpoch}),work);};
  const beginRestore=async expectedEpoch=>{
    assertEpoch(expectedEpoch);
    if(restoreBarrier)throw new InputError('另一项恢复正在进行。',409);
    const permit=Symbol('workspace restore');restoreBarrier=permit;
    try {await tail;assertEpoch(expectedEpoch);}catch(error){if(restoreBarrier===permit)restoreBarrier=null;throw error;}
    let published=false,released=false;
    return {
      snapshot:structuredClone(state),expectedEpoch,
      async publish(replacement,{prepareState}={}){
        if(released||published||restoreBarrier!==permit)throw new InputError('恢复发布许可已经结束。',409);
        const result=await transact(draft=>{
          if(released||restoreBarrier!==permit)throw new InputError('恢复发布许可已经结束。',409);
          const next={...structuredClone(replacement),schemaVersion:2,workspaceEpoch:newId()};
          const epoch=next.workspaceEpoch;
          if(prepareState!==undefined){
            if(typeof prepareState!=='function')throw new InputError('恢复准备函数无效。',500);
            const prepared=prepareState(next);
            if(prepared&&typeof prepared.then==='function'){
              // Reject the asynchronous contract without leaving a rejected
              // return value able to terminate the host as an unhandled rejection.
              void Promise.resolve(prepared).catch(()=>{});
              throw new InputError('恢复发布只允许同步准备。',500);
            }
            if(next.workspaceEpoch!==epoch)throw new InputError('恢复准备不能覆盖本次工作区版本。',500);
          }
          assertStateShape(next);
          for(const key of Object.keys(draft))delete draft[key];
          Object.assign(draft,next);
          return {workspaceEpoch:next.workspaceEpoch};
        },{expectedEpoch,restorePermit:permit});
        published=true;return result;
      },
      release(){released=true;if(restoreBarrier===permit)restoreBarrier=null;},
    };
  };
  return {
    dataDir: root,
    read: () => structuredClone(state),
    transact,
    withEpoch, captureEpoch, assertEpoch, beginRestore,
    getWorkspaceEpoch:()=>state.workspaceEpoch,
    async writeBlob(bytes, mime) {
      const id = crypto.createHash('sha256').update(bytes).digest('hex');
      const destination = path.join(root, 'blobs', id);
      try {
        const stat = await fs.lstat(destination);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new InputError('媒体存储位置异常。', 500);
        const existing = await fs.readFile(destination);
        if (!existing.equals(bytes)) throw new InputError('媒体完整性校验失败。', 500);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomicWriter(destination, bytes);
      }
      return { id, mime, size: bytes.length };
    },
    async readBlob(id) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new InputError('媒体 ID 无效。', 404);
      const destination = path.join(root, 'blobs', id);
      try {
        const stat = await fs.lstat(destination);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new InputError('媒体文件不可用。', 404);
        const bytes = await fs.readFile(destination);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== id) throw new InputError('媒体文件完整性校验失败。', 500);
        return bytes;
      } catch (error) {
        if (error.code === 'ENOENT') throw new InputError('媒体文件不存在。', 404);
        throw error;
      }
    },
    async writeBackup(bytes) {
      const name = `before-restore-${new Date().toISOString().replaceAll(':', '-')}-${newId().slice(0, 8)}.zip`;
      await atomicWriter(path.join(root, 'backups', name), bytes);
      return name;
    },
    close: () => tail,
  };
}

export function runtimeLibrary(library) {
  return {
    ...mapPackageMedia(library.originalPack, name => `/api/media/${library.mediaMap[name]}`),
    libraryId: library.libraryId,
    importedAt: library.importedAt,
    contentHash: library.contentHash,
  };
}

export function questionSnapshot(library, questionId) {
  const runtime = runtimeLibrary(library);
  for (const group of runtime.groups) {
    const question = group.questions.find(q => q.id === questionId);
    if (question) return {
      ...structuredClone(question),
      groupId: group.id,
      groupTitle: group.title,
      section: group.section,
      passage: group.passage,
      groupAudio: group.audio,
      groupImage: group.image,
    };
  }
  throw new InputError('在指定的练习包中找不到此题。', 404);
}

export function normalizedAnswer(answer) {
  if (answer === undefined || answer === null) return '';
  if (typeof answer === 'string' && answer.length <= 200000) return answer;
  if (Array.isArray(answer) && answer.length <= 100 && answer.every(item => typeof item === 'string' && item.length <= 20000)) return [...answer];
  throw new InputError('答案应为文字或文字数组，且不能超过大小限制。');
}

export function gradeAnswer(question, submitted) {
  const objective = ['single_choice', 'fill_blank', 'sentence_order'].includes(question.type);
  const expected = question.answer;
  const hasKey = typeof expected === 'string' ? Boolean(expected.trim()) : Array.isArray(expected) && expected.some(item => item.trim());
  if (!objective || !hasKey) return { status: 'unscored', correct: null, total: null };
  const answered = typeof submitted === 'string' ? Boolean(submitted.trim()) : Array.isArray(submitted) && submitted.some(item => item.trim());
  if (!answered) return { status: 'unanswered', correct: 0, total: 1 };
  let correct = false;
  if (question.type === 'single_choice') {
    correct = typeof submitted === 'string' && submitted === expected;
  } else if (question.type === 'fill_blank') {
    // Deliberately preserve punctuation. Only case and surrounding/repeated whitespace are normalized.
    const normalize = text => text.trim().replace(/\s+/g, ' ').toLowerCase();
    correct = typeof submitted === 'string' && (Array.isArray(expected) ? expected : [expected]).some(answer => normalize(answer) === normalize(submitted));
  } else if (question.type === 'sentence_order') {
    correct = Array.isArray(submitted) && Array.isArray(expected) && submitted.length === expected.length && expected.every((value, index) => value === submitted[index]);
  }
  return { status: correct ? 'correct' : 'incorrect', correct: correct ? 1 : 0, total: 1 };
}
