import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAsrWorker, validateAsrConfiguration } from './workers/asr.mjs';
import { InputError } from './package.mjs';

/** Local host configuration lives outside state.json and backup manifests. */
export async function createAsrProvider({ dataDir, workerFactory = createAsrWorker, ...adapters }) {
  const directory = path.join(dataDir, 'asr-host');
  const filename = path.join(directory, 'configuration.json');
  let configuration = null, active = null, generation = 0, saving = false;
  let status = { state: 'disabled', detail: '可选本地转写尚未启用。' };
  try {
    const value = JSON.parse(await fs.readFile(filename, 'utf8'));
    configuration = validateAsrConfiguration({ ...value, confirmed: true });
    configuration.confirmed = false;
    status = { state: 'unconfirmed', detail: '已保存路径仅作提示；本次运行须重新确认后才能执行。' };
  } catch (error) { if (error.code !== 'ENOENT') status = { state: 'unconfirmed', detail: '已有转写配置无法确认，请重新选择。' }; }
  const view = () => ({ configuration: configuration ? structuredClone(configuration) : null, ...structuredClone(status), running: Boolean(active), networkPolicy: '仅读取本地模型，不主动请求网络；未验证操作系统网络隔离。' });
  function cancel() { generation++; active?.controller.abort(); active = null; status = { state: configuration?.confirmed ? 'configured' : 'disabled', detail: '转写已取消，已有原件与证据保留。' }; return view(); }
  async function configure(input) {
    if (saving) throw new InputError('配置正在保存，请稍后重试。', 409);
    const next = validateAsrConfiguration(input);
    cancel(); const saveGeneration = generation; saving = true;
    const staged = path.join(directory, `.configuration-${crypto.randomUUID()}.tmp`);
    try { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(staged, JSON.stringify({ ...next, confirmed: false }), { flag: 'wx' }); await fs.rename(staged, filename); }
    finally { saving = false; await fs.unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    if (generation !== saveGeneration) throw new InputError('保存期间转写已停用或取消；请重新确认配置。', 409);
    configuration = next;
    status = { state: 'configured', detail: '已确认本次配置；请运行实际自检。不会安装或下载模型。' };
    return view();
  }
  function disable() { cancel(); if (configuration) configuration.confirmed = false; status = { state: 'disabled', detail: '本地转写已停用；播放、录音和题库仍可使用。' }; return view(); }
  function selfTest() {
    if (saving) throw new InputError('请等待本地转写配置保存完成。', 409);
    if (!configuration?.confirmed) throw new InputError('请先确认本次本地转写配置。', 409);
    if (active) throw new InputError('已有本地转写正在运行，请等待或取消。', 409);
    const currentGeneration = ++generation, controller = new AbortController();
    const worker = workerFactory({ configuration, ...adapters });
    active = { controller }; status = { state: 'testing', detail: '正在校验完整模型并实际执行一秒合成静音；这不是准确率测试。' };
    active.promise = worker.selfTest(controller.signal).then(result => {
      if (generation !== currentGeneration) return;
      active = null; status = { state: 'ready', detail: '本地推理自检完成。下列设备与精度来自实际加载模型；未证明语音准确率。', result };
    }, error => {
      if (generation !== currentGeneration) return;
      active = null; status = { state: 'unavailable', detail: error instanceof InputError ? error.message : '本地转写不可用，请检查配置。', errorCode: error.code || 'selftest_failed' };
    });
    return view();
  }
  async function runMaterialTool(input) {
    if (typeof adapters.assertCurrent !== 'function') throw new InputError('本地转写尚未连接材料版本校验。', 503);
    if (status.state !== 'ready' || !configuration?.confirmed) throw new InputError('本地转写须先通过当前配置自检。', 409);
    if (active) throw new InputError('已有本地转写正在运行。', 409);
    const currentGeneration = ++generation, controller = new AbortController();
    const abort = () => controller.abort(); input.cancelToken?.addEventListener('abort', abort, { once: true });
    if (input.cancelToken?.aborted) controller.abort();
    const readyStatus = structuredClone(status);
    active = { controller };
    try {
      const worker = workerFactory({ configuration, ...adapters, assertCurrent: async request => { if (generation !== currentGeneration || controller.signal.aborted) throw new InputError('转写配置或作业已改变。', 409); await adapters.assertCurrent?.(request); } });
      return await worker.runMaterialTool({ ...input, cancelToken: controller.signal });
    } finally { input.cancelToken?.removeEventListener('abort', abort); if (generation === currentGeneration) { active = null; status = readyStatus; } }
  }
  return { view, configure, selfTest, cancel, disable, runMaterialTool, close: cancel };
}
