import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { detectMediaContent } from '../media-manifest.mjs';
import { InputError } from '../package.mjs';
import { asrDecodedScope } from '../asr-checks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profiles = JSON.parse(await fs.readFile(path.join(ROOT, 'tools/asr-worker/models.json'), 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const absolute = value => typeof value === 'string' && value.length <= 1000 && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value);
const fail = (code, message, status = 400) => { const error = new InputError(message, status); error.code = code; throw error; };
const errorMessages = { model_missing: '模型目录不存在，请重新选择。', model_incomplete: '模型文件不完整（包括 tokenizer.json），请重新选择完整的本地模型。', model_hash_mismatch: '模型文件与固定来源校验值不一致。', runtime_directory_missing: '已配置的运行库目录不存在。', runtime_version_mismatch: '独立环境版本不符合本适配器要求。', runtime_unavailable: '解释器或所需运行库不可用。', gpu_unavailable: '所选 GPU 不可用。', precision_unavailable: '设备不支持选定精度，请显式重新选择。', execution_configuration_mismatch: '实际执行设备或精度与配置不一致，已停止。', out_of_memory: '设备内存不足；未切换 CPU、精度或云端。', inference_failed: '本地转写失败，未切换设备或供应商。', cancelled: '本地转写已取消。', timeout: '本地转写超过本次时间预算。', output_budget: '转写输出超过预算。', memory_budget: '转写进程超过内存预算。', asset_integrity: '音频资产完整性校验失败。', audio_empty: '选定时段没有可解码音频。', audio_budget: '音频超过本次预算。', launch_failed: '本机无法启动所选解释器，请检查路径与运行权限。' };
function workerError(code, status = 422) { return Object.assign(new InputError(code === 'model_unexpected_file' ? '模型目录含有固定清单外的文件，已停止；请重新选择符合固定来源的模型目录。' : errorMessages[code] || '本地转写协议失败。', status), { code }); }

export function resolveAsrScript(projectRoot = ROOT) {
  return path.join(projectRoot.replace(/(^|[\\/])app\.asar(?=$|[\\/])/, '$1app.asar.unpacked'), 'tools/asr-worker/worker.py');
}

export function scrubAsrEnvironment(environment = process.env) {
  const allowed = new Set(['systemroot', 'windir', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all']);
  const result = Object.fromEntries(Object.entries(environment).filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string'));
  return { ...result, PYTHON_MANAGER_AUTOMATIC_INSTALL: '0', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
}

export function validateAsrConfiguration(input) {
  const allowed = new Set(['interpreter', 'modelDirectory', 'modelId', 'device', 'deviceIndex', 'computeType', 'dllDirectories', 'confirmed']);
  if (!plain(input) || Object.keys(input).some(key => !allowed.has(key)) || input.confirmed !== true || !absolute(input.interpreter) || !absolute(input.modelDirectory) || !Object.hasOwn(profiles, input.modelId) || !['cpu', 'cuda'].includes(input.device) || !['int8', 'int8_float32', 'float32', 'float16', 'int8_float16'].includes(input.computeType) || !Array.isArray(input.dllDirectories) || input.dllDirectories.length > 5 || input.dllDirectories.some(value => !absolute(value)) || !Number.isInteger(input.deviceIndex ?? 0) || (input.deviceIndex ?? 0) < 0 || (input.deviceIndex ?? 0) > 15) fail('configuration_invalid', '请明确确认解释器、本地固定来源模型、设备、精度与运行库目录。');
  return { ...structuredClone(input), interpreter: path.resolve(input.interpreter), modelDirectory: path.resolve(input.modelDirectory), deviceIndex: input.deviceIndex ?? 0, dllDirectories: input.dllDirectories.map(value => path.resolve(value)) };
}

export function validateAsrRequest(input) {
  const allowed = new Set(['jobId', 'expectedEpoch', 'sourceRevision', 'toolId', 'inputAssetIds', 'parameters', 'budget', 'cancelToken']);
  if (!plain(input) || Object.keys(input).some(key => !allowed.has(key)) || typeof input.jobId !== 'string' || !input.jobId || input.jobId.length > 200 || !(Number.isInteger(input.expectedEpoch) && input.expectedEpoch >= 0 || typeof input.expectedEpoch === 'string' && input.expectedEpoch.length > 0 && input.expectedEpoch.length <= 200) || !(Number.isInteger(input.sourceRevision) && input.sourceRevision >= 0 || typeof input.sourceRevision === 'string' && /^[a-f0-9]{64}$/.test(input.sourceRevision)) || input.toolId !== 'media.transcribe' || !Array.isArray(input.inputAssetIds) || input.inputAssetIds.length !== 1 || !/^[a-f0-9]{64}$/.test(input.inputAssetIds[0]) || !plain(input.parameters) || Object.keys(input.parameters).some(key => !['startSeconds', 'endSeconds'].includes(key))) fail('request_invalid', '转写请求只允许内部音频资产标识与有界时段。');
  const budget = input.budget;
  if (!plain(budget) || Object.keys(budget).some(key => !['timeoutMs', 'maxOutputBytes', 'maxDurationSeconds', 'maxInputBytes', 'maxMemoryBytes'].includes(key)) || !Number.isInteger(budget.timeoutMs) || budget.timeoutMs < 100 || budget.timeoutMs > 900000 || !Number.isInteger(budget.maxOutputBytes) || budget.maxOutputBytes < 8192 || budget.maxOutputBytes > 1048576 || !Number.isFinite(budget.maxDurationSeconds) || budget.maxDurationSeconds < 1 || budget.maxDurationSeconds > 300 || !Number.isInteger(budget.maxInputBytes) || budget.maxInputBytes < 44 || budget.maxInputBytes > 100 * 1024 * 1024 || (budget.maxMemoryBytes !== undefined && (!Number.isInteger(budget.maxMemoryBytes) || budget.maxMemoryBytes < 128 * 1024 * 1024 || budget.maxMemoryBytes > 12 * 1024 ** 3))) fail('budget_invalid', '转写预算无效。');
  const { startSeconds, endSeconds } = input.parameters;
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(endSeconds) || endSeconds <= startSeconds || endSeconds > 7200 || endSeconds - startSeconds > budget.maxDurationSeconds) fail('range_invalid', '转写时段无效或超出预算。');
  return { ...input, budget: { ...budget, maxMemoryBytes: budget.maxMemoryBytes ?? 12 * 1024 ** 3 } };
}

export function runAsrProcess({ configuration, request, scriptPath = resolveAsrScript(), spawnProcess = spawn, environment = process.env }) {
  return new Promise((resolve, reject) => {
    if (request.cancelToken?.aborted) { reject(workerError('cancelled', 409)); return; }
    const child = spawnProcess(configuration.interpreter, ['-I', '-B', '-u', scriptPath], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...scrubAsrEnvironment(environment), PATH: configuration.dllDirectories.join(path.delimiter) } });
    let done = false, failure = null, size = 0;
    const chunks = [];
    const stop = code => {
      if (done || failure) return;
      failure = workerError(code, code === 'cancelled' ? 409 : code === 'timeout' ? 408 : 422);
      // A Windows venv launcher can have a base-interpreter child. Terminate the
      // owned tree before killing its parent, otherwise the interpreter can orphan.
      if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
        const terminator = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        try {
          const killer = spawn(terminator, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', env: scrubAsrEnvironment(environment) });
          killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} });
          killer.once('close', exitCode => { if (exitCode !== 0) { try { child.kill('SIGKILL'); } catch {} } });
        } catch { try { child.kill('SIGKILL'); } catch {} }
      } else { try { child.kill('SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => stop('timeout'), request.budget.timeoutMs);
    const abort = () => stop('cancelled');
    request.cancelToken?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', bytes => { size += bytes.length; if (size > request.budget.maxOutputBytes) stop('output_budget'); else chunks.push(bytes); });
    child.stderr.on('data', bytes => { size += bytes.length; if (size > request.budget.maxOutputBytes) stop('output_budget'); });
    child.stdin.on('error', () => {});
    child.on('error', () => stop('launch_failed'));
    child.on('close', code => {
      if (done) return; done = true; clearTimeout(timer); request.cancelToken?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code === 72) { reject(workerError('memory_budget')); return; }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(workerError(code ? 'runtime_unavailable' : 'protocol_invalid')); return; }
      if (result.state === 'failed') { reject(workerError(Object.hasOwn(errorMessages, result.errorCode) ? result.errorCode : 'protocol_invalid')); return; }
      const actual = result.actual;
      if (code !== 0 || result.protocolVersion !== 1 || result.state !== 'completed' || !plain(actual) || actual.engine !== 'faster-whisper' || actual.device !== configuration.device || actual.computeType !== configuration.computeType || actual.modelId !== profiles[configuration.modelId].model_id || actual.modelRevision !== profiles[configuration.modelId].revision || !(Array.isArray(actual.deviceIndex) ? actual.deviceIndex : [actual.deviceIndex]).includes(configuration.deviceIndex) || !Array.isArray(result.segments) || result.segments.length > 10000 || result.segments.some(segment => !plain(segment) || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start || typeof segment.text !== 'string' || segment.text.length > 20000) || typeof result.transcript !== 'string' || result.transcript.length > 200000 || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0 || result.durationSeconds > request.budget.maxDurationSeconds + 0.01) { reject(workerError('protocol_invalid')); return; }
      if (result.transcript !== result.segments.map(segment => segment.text).join('').trim() || !plain(actual.versions) || actual.versions['faster-whisper'] !== '1.2.1' || actual.versions.ctranslate2 !== '4.8.2' || actual.versions.av !== '18.1.0' || !Number.isFinite(result.elapsedSeconds) || result.elapsedSeconds < 0 || result.segments.some(segment => !Number.isFinite(segment.avgLogprob) || !Number.isFinite(segment.noSpeechProb) || segment.noSpeechProb < 0 || segment.noSpeechProb > 1 || segment.end > 7230)) { reject(workerError('protocol_invalid')); return; }
      const issues = [];
      const offset = request.parameters?.startSeconds || 0;
      let scope;
      if(request.operation==='transcribe'){try{scope=asrDecodedScope(request.parameters,result.durationSeconds);}catch{reject(workerError('protocol_invalid'));return;}}
      // worker.py emits round(relative timestamp + requested offset, 3).
      // Convert the actual PCM interval into that offset coordinate system,
      // then admit only the nearest-millisecond bin (half a millisecond).
      const decodedStart=scope?.decodedRange.startSeconds??0,decodedEnd=scope?.decodedRange.endSeconds??result.durationSeconds;
      const timestampShift=offset-decodedStart,timestampStart=decodedStart+timestampShift,timestampEnd=decodedEnd+timestampShift;
      const halfTimestampQuantum=0.0005,floatSlack=Number.EPSILON*Math.max(1,Math.abs(timestampStart),Math.abs(timestampEnd))*4;
      if (!result.transcript.trim()) issues.push({ code: 'empty_transcript' });
      if (result.segments.some(segment => segment.start+halfTimestampQuantum+floatSlack<timestampStart || segment.end-halfTimestampQuantum-floatSlack>timestampEnd)) issues.push({ code: 'segment_outside_audio' });
      if (result.segments.some(segment => segment.noSpeechProb > 0.6)) issues.push({ code: 'possible_non_speech' });
      if(scope&&!scope.rangeComplete)issues.push({code:'requested_range_incomplete'});
      // Return only the protocol fields; unexpected Python output cannot smuggle
      // host paths or unrelated data into processing artifacts or the renderer.
      resolve({ protocolVersion: 1, state: scope&&!scope.rangeComplete?'partial':'completed',...(scope||{}), actual: { engine: actual.engine, device: actual.device, deviceIndex: actual.deviceIndex, computeType: actual.computeType, modelId: actual.modelId, modelRevision: actual.modelRevision, versions: { 'faster-whisper': actual.versions['faster-whisper'], ctranslate2: actual.versions.ctranslate2, av: actual.versions.av } }, segments: result.segments.map(({ start, end, text, avgLogprob, noSpeechProb }) => ({ start, end, text, avgLogprob, noSpeechProb })), transcript: result.transcript, durationSeconds: result.durationSeconds, elapsedSeconds: result.elapsedSeconds, issues, sampleKind: request.operation === 'selftest' ? 'generated-silence-capability-test' : 'host-asset', networkPolicy: 'local-files-only-no-active-requests', memoryBoundary: 'sampled-process-watchdog' });
    });
    const { cancelToken: _signal, ...payload } = request;
    child.stdin.end(JSON.stringify({ ...payload, configuration: { ...configuration, profile: profiles[configuration.modelId] } }) + '\n');
  });
}

/** Injectable host-only CAS boundary. No renderer/model paths reach this entry. */
export function createAsrWorker({ configuration, resolveAsset, publishArtifact, artifactDir, assertCurrent, spawnProcess = spawn } = {}) {
  const config = validateAsrConfiguration(configuration);
  const scriptPath = resolveAsrScript();
  async function preflight() {
    for (const [filename, code] of [[config.interpreter, 'launch_failed'], [scriptPath, 'runtime_unavailable']]) {
      let stat; try { stat = await fs.lstat(filename); } catch { throw workerError(code); }
      if (!stat.isFile() || stat.isSymbolicLink()) throw workerError(code);
    }
    let rootStat; try { rootStat = await fs.lstat(config.modelDirectory); } catch { throw workerError('model_missing'); }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw workerError('model_missing');
    for (const file of profiles[config.modelId].files) {
      let stat; try { stat = await fs.lstat(path.join(config.modelDirectory, file.name)); } catch { throw workerError('model_incomplete'); }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes) throw workerError('model_incomplete');
    }
  }
  async function selfTest(cancelToken) {
    await preflight();
    return runAsrProcess({ configuration: config, scriptPath, spawnProcess, request: { operation: 'selftest', budget: { timeoutMs: 180000, maxOutputBytes: 65536, maxInputBytes: 32044, maxDurationSeconds: 1, maxMemoryBytes: 12 * 1024 ** 3 }, cancelToken } });
  }
  async function runMaterialTool(input) {
    const request = validateAsrRequest(input);
    if (typeof resolveAsset !== 'function' || typeof publishArtifact !== 'function' || typeof assertCurrent !== 'function' || !absolute(artifactDir)) fail('host_adapter_missing', '转写尚未连接材料资产与产物存储。', 503);
    await assertCurrent(request); await preflight();
    const asset = await resolveAsset(request.inputAssetIds[0], request);
    if (!plain(asset) || !absolute(asset.path) || asset.hash !== request.inputAssetIds[0]) throw workerError('asset_integrity');
    const stat = await fs.lstat(asset.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > request.budget.maxInputBytes) throw workerError('asset_integrity');
    const bytes = await fs.readFile(asset.path);
    if (bytes.length > request.budget.maxInputBytes || hash(bytes) !== asset.hash) throw workerError('asset_integrity');
    const detected = detectMediaContent(bytes);
    if (detected?.kind !== 'audio' || !['wav', 'mp3', 'ogg', 'webm'].includes(detected.format)) fail('audio_format', '转写只支持独立 WAV、MP3、OGG、WebM 音频。');
    await fs.mkdir(artifactDir, { recursive: true });
    const directory = await fs.lstat(artifactDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw workerError('asset_integrity');
    const staged = path.join(artifactDir, `.asr-input-${crypto.randomUUID()}`);
    try {
      await fs.writeFile(staged, bytes, { flag: 'wx' });
      const result = await runAsrProcess({ configuration: config, scriptPath, spawnProcess, request: { operation: 'transcribe', inputPath: staged, inputAssetId: asset.hash, inputFormat: detected.ffmpegFormat, parameters: request.parameters, budget: request.budget, cancelToken: request.cancelToken } });
      if (request.cancelToken?.aborted) throw workerError('cancelled', 409);
      await assertCurrent(request);
      const output = Buffer.from(JSON.stringify({ ...result, originalAssetId: asset.hash, sourceRevision: request.sourceRevision, timeRange: request.parameters }));
      if (output.length > request.budget.maxOutputBytes) throw workerError('output_budget');
      // Adapter must atomically apply the guard with reference publication.
      const ref = await publishArtifact({ bytes: output, hash: hash(output), mime: 'application/json', kind: 'asr-segments', parentHash: asset.hash, request });
      return { artifactRefs: [ref], evidence: [{ originalAssetId: asset.hash, originalHash: asset.hash, contentCheckState: 'notChecked', kind: 'transcribed', artifactRef: ref,requestedRange:result.requestedRange,decodedRange:result.decodedRange,rangeComplete:result.rangeComplete,rangePrecision:result.rangePrecision }], issues: result.issues || [], actualEngine: result.actual.engine, actualDevice: result.actual.device, actual: result.actual, state: result.state };
    } finally { await fs.unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { selfTest, runMaterialTool, preflight };
}
