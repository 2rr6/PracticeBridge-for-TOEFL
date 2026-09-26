import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { detectMediaContent } from '../media-manifest.mjs';
import { InputError, LIMITS, safeRelativeName } from '../package.mjs';

const HASH = /^[a-f0-9]{64}$/;
const TOOLS = new Set(['media.probe', 'media.playback']);
// These demuxers are self-contained audio containers. Playlist/manifest and
// external-reference formats are deliberately absent from the helper boundary.
const WORKER_FORMATS = new Set(['mp3', 'wav', 'ogg', 'webm']);
const ALLOWED_ENV = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all']);
const PCM_SAMPLE_RATE = 1000;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;
const DURATION_TOLERANCE_SECONDS = 0.1;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function fail(message, status = 400) { throw new InputError(message, status); }

function unsupported(message) {
  const error = new InputError(message, 422);
  error.code = 'MEDIA_HELPER_UNSUPPORTED';
  throw error;
}

function scrubEnvironment(environment) {
  const result = {};
  for (const [key, value] of Object.entries(environment || {})) if (ALLOWED_ENV.has(key.toLocaleLowerCase('en-US')) && typeof value === 'string') result[key] = value;
  return result;
}

function executablePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 1000) throw new TypeError(`${label} must be an absolute host path.`);
  return path.resolve(value);
}

function checkedBudget(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !['timeoutMs', 'maxOutputBytes', 'maxDurationSeconds'].includes(key))) fail('媒体工具预算无效。');
  const budget = { timeoutMs: value.timeoutMs, maxOutputBytes: value.maxOutputBytes, maxDurationSeconds: value.maxDurationSeconds };
  if (!Number.isInteger(budget.timeoutMs) || budget.timeoutMs < 100 || budget.timeoutMs > 15 * 60 * 1000 ||
      !Number.isInteger(budget.maxOutputBytes) || budget.maxOutputBytes < 1024 || budget.maxOutputBytes > LIMITS.fileBytes ||
      !Number.isFinite(budget.maxDurationSeconds) || budget.maxDurationSeconds < 1 || budget.maxDurationSeconds > 7200) fail('媒体工具预算无效。');
  return budget;
}

function checkedRequest(value) {
  if (!plainObject(value)) fail('媒体工具请求无效。');
  const allowed = new Set(['jobId', 'expectedEpoch', 'sourceRevision', 'toolId', 'inputAssetIds', 'parameters', 'budget', 'cancelToken']);
  if (Object.keys(value).some(key => !allowed.has(key)) || typeof value.jobId !== 'string' || !value.jobId || value.jobId.length > 200 ||
      typeof value.expectedEpoch !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.expectedEpoch) || typeof value.sourceRevision !== 'string' || !HASH.test(value.sourceRevision) ||
      !TOOLS.has(value.toolId) || !Array.isArray(value.inputAssetIds) || value.inputAssetIds.length !== 1 || !HASH.test(value.inputAssetIds[0])) fail('媒体工具请求或资产标识无效。');
  if (!plainObject(value.parameters)) fail('媒体工具参数无效。');
  const allowedParameters = value.toolId === 'media.playback' ? new Set(['outputFormat']) : new Set();
  if (Object.keys(value.parameters).some(key => !allowedParameters.has(key))) fail('媒体工具参数不允许包含路径、URL、命令或未知字段。');
  if (value.toolId === 'media.playback' && value.parameters.outputFormat !== 'mp3') fail('媒体播放派生格式参数无效。');
  return { ...value, budget: checkedBudget(value.budget) };
}

function killProcessTree(child, spawnProcess) {
  if (!child?.pid) { try { child?.kill?.('SIGKILL'); } catch {} return; }
  if (process.platform === 'win32') {
    try {
      const killer = spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', env: scrubEnvironment(process.env) });
      killer.on?.('error', () => {});
    } catch {}
    try { child.kill('SIGKILL'); } catch {}
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

function runBoundedProcess({ executable, args, spawnProcess, environment, budget, cancelToken, outputPath = null, outputLimitMessage = '媒体派生输出超过限制。' }) {
  return new Promise((resolve, reject) => {
    if (cancelToken?.aborted) { reject(new InputError('媒体处理已取消。', 409)); return; }
    let child;
    try {
      child = spawnProcess(executable, args, {
        shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'], env: scrubEnvironment(environment),
      });
    } catch (error) { reject(error); return; }
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let finished = false;
    let failure = null;
    const stop = error => {
      if (finished || failure) return;
      failure = error;
      killProcessTree(child, spawnProcess);
    };
    const collect = target => chunk => {
      const bytes = Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > budget.maxOutputBytes) { stop(new InputError('媒体工具输出超过限制。')); return; }
      target.push(bytes);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    child.on('error', error => stop(error));
    const timer = setTimeout(() => stop(new InputError('媒体工具运行超时。', 408)), budget.timeoutMs);
    timer.unref?.();
    const sizeTimer = outputPath ? setInterval(() => {
      try { if (fsSync.statSync(outputPath).size > budget.maxOutputBytes) stop(new InputError(outputLimitMessage, 413)); }
      catch (error) { if (error.code !== 'ENOENT') stop(error); }
    }, 50) : null;
    sizeTimer?.unref?.();
    const abort = () => stop(new InputError('媒体处理已取消。', 409));
    cancelToken?.addEventListener?.('abort', abort, { once: true });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (sizeTimer) clearInterval(sizeTimer);
      cancelToken?.removeEventListener?.('abort', abort);
      if (failure) { reject(failure); return; }
      const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code !== 0) {
        const error = new InputError(`媒体工具未完成（退出码 ${code ?? 'unknown'}）。`, 422);
        error.result = result;
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function probeArguments(detected, inputPath) {
  return [
    '-v', 'error', '-protocol_whitelist', 'file', '-f', detected.ffmpegFormat,
    '-show_entries', 'format=format_name,duration,size:stream=index,codec_name,codec_type,duration', '-of', 'json', inputPath,
  ];
}

function decodeArguments(detected, inputPath, outputPath) {
  return [
    '-hide_banner', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file', '-f', detected.ffmpegFormat, '-i', inputPath,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-ac', '1', '-ar', String(PCM_SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', '-n', outputPath,
  ];
}

function transcodeArguments(detected, inputPath, outputPath) {
  return [
    '-hide_banner', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file', '-f', detected.ffmpegFormat, '-i', inputPath,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', '-n', outputPath,
  ];
}

function parseProbe(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('ffprobe 没有返回有效的媒体信息。', 422); }
  const audio = Array.isArray(value.streams) ? value.streams.find(stream => stream?.codec_type === 'audio') : null;
  const duration = Number(value.format?.duration ?? audio?.duration);
  if (!audio || typeof audio.codec_name !== 'string') fail('媒体中没有可用音轨。', 422);
  if (!Number.isFinite(duration) || duration <= 0) fail('媒体声明时长无法确认。', 422);
  return { codec: audio.codec_name.slice(0, 100), containerDurationSeconds: duration, formatName: String(value.format?.format_name || '').slice(0, 200) };
}

async function checkedAsset(resolveAsset, assetId) {
  const asset = await resolveAsset(assetId);
  if (!plainObject(asset) || !path.isAbsolute(asset.path) || safeRelativeName(asset.name) !== asset.name || asset.hash !== assetId || !Number.isInteger(asset.size) || asset.size < 0 || asset.size > LIMITS.fileBytes) fail('宿主返回的媒体资产无效。', 500);
  const stat = await fs.lstat(asset.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.size) fail('媒体资产路径或大小无效。', 500);
  const bytes = await fs.readFile(asset.path);
  if (bytes.length !== asset.size || sha256(bytes) !== assetId) fail('媒体资产完整性校验失败。', 500);
  const detected = detectMediaContent(bytes);
  if (detected?.kind !== 'audio') fail('媒体资产不是受支持的音频。', 422);
  if (!WORKER_FORMATS.has(detected.format)) unsupported('媒体资产不是 helper 支持的独立音频格式。');
  return { ...asset, path: path.resolve(asset.path), bytes, detected };
}

/** Fixed media helper. Callers provide asset IDs and bounded enums, never paths. */
export function createMediaWorker({ ffprobePath, ffmpegPath, artifactDir, resolveAsset, spawnProcess = spawn, environment = process.env } = {}) {
  const probeExecutable = executablePath(ffprobePath, 'ffprobePath');
  const transcodeExecutable = executablePath(ffmpegPath, 'ffmpegPath');
  const outputDirectory = executablePath(artifactDir, 'artifactDir');
  if (typeof resolveAsset !== 'function' || typeof spawnProcess !== 'function') throw new TypeError('createMediaWorker requires host asset resolution and process spawning.');

  const execute = (executable, args, request, startedAt, outputPath = null, outputLimitMessage) => {
    const timeoutMs = request.budget.timeoutMs - (Date.now() - startedAt);
    if (timeoutMs < 100) fail('媒体工具运行超时。', 408);
    return runBoundedProcess({ executable, args, spawnProcess, environment, budget: { ...request.budget, timeoutMs }, cancelToken: request.cancelToken, outputPath, outputLimitMessage });
  };

  async function ensureOutputDirectory() {
    await fs.mkdir(outputDirectory, { recursive: true });
    const stat = await fs.lstat(outputDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('媒体派生目录无效。', 500);
  }

  async function probe(asset, request, startedAt) {
    const metadata = parseProbe((await execute(probeExecutable, probeArguments(asset.detected, asset.path), request, startedAt)).stdout);
    await ensureOutputDirectory();
    const decodedPath = path.join(outputDirectory, `.decode-${crypto.randomUUID()}.pcm`);
    const decodedLimit = Math.min(request.budget.maxOutputBytes, Math.ceil(request.budget.maxDurationSeconds * PCM_BYTES_PER_SECOND));
    const decodeRequest = { ...request, budget: { ...request.budget, maxOutputBytes: decodedLimit } };
    let actualDurationSeconds;
    try {
      await execute(transcodeExecutable, decodeArguments(asset.detected, asset.path, decodedPath), decodeRequest, startedAt, decodedPath, '媒体实际解码时长超过本次处理预算。');
      const decoded = await fs.lstat(decodedPath);
      if (!decoded.isFile() || decoded.isSymbolicLink()) fail('媒体实际解码输出无效。', 422);
      if (decoded.size > decodedLimit) fail('媒体实际解码时长超过本次处理预算。', 413);
      actualDurationSeconds = decoded.size / PCM_BYTES_PER_SECOND;
    } finally {
      try { await fs.unlink(decodedPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!Number.isFinite(actualDurationSeconds) || actualDurationSeconds <= 0) fail('媒体没有可测量的实际解码范围。', 422);
    if (actualDurationSeconds > request.budget.maxDurationSeconds) fail('媒体实际解码时长超过本次处理预算。', 413);
    if (actualDurationSeconds > metadata.containerDurationSeconds + DURATION_TOLERANCE_SECONDS) fail('媒体声明时长与实际解码范围冲突。', 422);
    const partial = actualDurationSeconds + DURATION_TOLERANCE_SECONDS < metadata.containerDurationSeconds;
    const missingDurationSeconds = partial ? metadata.containerDurationSeconds - actualDurationSeconds : 0;
    return {
      ...metadata,
      durationSeconds: partial ? metadata.containerDurationSeconds : actualDurationSeconds,
      actualDurationSeconds,
      decodeState: partial ? 'partial' : 'playable',
      missingDurationSeconds,
      missingLocationState: partial ? 'unknown' : 'notApplicable',
      missingRanges: [],
    };
  }

  async function runMaterialTool(value) {
    const startedAt = Date.now();
    const request = checkedRequest(value);
    const asset = await checkedAsset(resolveAsset, request.inputAssetIds[0]);
    const metadata = await probe(asset, request, startedAt);
    const evidence = [{
      originalAssetId: asset.hash, originalHash: asset.hash, originalName: asset.name,
      detectedFormat: asset.detected.format, detectedMime: asset.detected.mime, codec: metadata.codec,
      durationSeconds: metadata.durationSeconds, containerDurationSeconds: metadata.containerDurationSeconds,
      actualDurationSeconds: metadata.actualDurationSeconds, decodeState: metadata.decodeState, missingRanges: metadata.missingRanges,
      missingDurationSeconds: metadata.missingDurationSeconds, missingLocationState: metadata.missingLocationState,
      contentCheckState: 'notChecked',
    }];
    if (request.toolId === 'media.probe') return {
      artifactRefs: [], evidence, issues: metadata.decodeState === 'partial' ? [{ code: 'media_decode_partial', missingDurationSeconds: metadata.missingDurationSeconds, missingLocationState: metadata.missingLocationState, missingRanges: [] }] : [],
      actualEngine: 'ffprobe+ffmpeg', actualDevice: 'cpu', state: metadata.decodeState === 'partial' ? 'partial' : 'completed',
    };

    if (metadata.decodeState !== 'playable') return {
      artifactRefs: [], evidence, issues: [{ code: 'media_decode_partial', missingDurationSeconds: metadata.missingDurationSeconds, missingLocationState: metadata.missingLocationState, missingRanges: [] }],
      actualEngine: 'ffprobe+ffmpeg', actualDevice: 'cpu', state: 'partial',
    };

    const estimatedOutputBytes = Math.ceil(metadata.actualDurationSeconds * 128000 / 8 * 1.25) + 65536;
    if (estimatedOutputBytes > request.budget.maxOutputBytes) fail('媒体派生输出预计超过本次预算。', 413);
    const temporary = path.join(outputDirectory, `.media-${crypto.randomUUID()}.tmp`);
    try {
      await execute(transcodeExecutable, transcodeArguments(asset.detected, asset.path, temporary), request, startedAt, temporary);
      const stat = await fs.lstat(temporary);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > request.budget.maxOutputBytes) fail('媒体派生输出大小无效。', 422);
      const bytes = await fs.readFile(temporary);
      const detected = detectMediaContent(bytes);
      if (detected?.format !== 'mp3') fail('媒体派生输出格式无效。', 422);
      const derivedProbe = await probe({ ...asset, path: temporary, bytes, detected }, request, startedAt);
      if (derivedProbe.decodeState !== 'playable' || Math.abs(derivedProbe.actualDurationSeconds - metadata.actualDurationSeconds) > DURATION_TOLERANCE_SECONDS) fail('媒体派生输出与原件实际解码范围不一致。', 422);
      const outputHash = sha256(bytes);
      const destination = path.join(outputDirectory, `${outputHash}.mp3`);
      try {
        const existingStat = await fs.lstat(destination);
        if (!existingStat.isFile() || existingStat.isSymbolicLink()) fail('现有媒体派生文件完整性异常。', 500);
        const existing = await fs.readFile(destination);
        if (sha256(existing) !== outputHash) fail('现有媒体派生文件完整性异常。', 500);
        await fs.unlink(temporary);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.rename(temporary, destination);
      }
      const publishedStat = await fs.lstat(destination);
      if (!publishedStat.isFile() || publishedStat.isSymbolicLink() || publishedStat.size !== bytes.length) fail('媒体派生文件发布校验失败。', 500);
      evidence[0].derivativeRefs = [{ parentHash: asset.hash, recipeVersion: 'ffmpeg-playback-mp3-v1', outputHash, name: `${outputHash}.mp3`, mime: 'audio/mpeg' }];
      return {
        artifactRefs: [{ assetId: outputHash, name: `${outputHash}.mp3`, mime: 'audio/mpeg', size: bytes.length, hostPath: destination, parentHash: asset.hash, recipeVersion: 'ffmpeg-playback-mp3-v1' }],
        evidence, issues: [], actualEngine: 'ffprobe+ffmpeg', actualDevice: 'cpu', state: 'completed',
      };
    } catch (error) {
      try { await fs.unlink(temporary); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError; }
      throw error;
    }
  }

  return { runMaterialTool };
}
