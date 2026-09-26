import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';

import { identifyMedia } from '../src/package.mjs';
import {
  canonicalizeMediaFiles,
  detectMediaContent,
  inspectMediaAsset,
} from '../src/media-manifest.mjs';
import { createMediaWorker } from '../src/workers/media.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function wav() {
  const samples = 800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) bytes.writeInt16LE(Math.round(Math.sin(index / 8) * 4000), 44 + index * 2);
  return bytes;
}

// Self-authored MP3-shaped fixture. Full decoding is supplied separately by the
// probe contract; this fixture contains no user or third-party media.
function mp3() {
  return Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'binary'), Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(128, 0x55)]);
}

test('content detection is independent from the declared extension while formal package validation stays strict', () => {
  const bytes = mp3();
  assert.deepEqual(detectMediaContent(bytes), {
    kind: 'audio', mime: 'audio/mpeg', extension: '.mp3', format: 'mp3', ffmpegFormat: 'mp3', directlyPlayable: true,
  });
  assert.equal(identifyMedia('actually-mp3.ogg', bytes), null);
  assert.deepEqual(identifyMedia('actually-mp3.mp3', bytes), { kind: 'audio', mime: 'audio/mpeg' });
});

test('playable wrong-extension bytes get a correct-extension alias with immutable hash lineage', async () => {
  const bytes = mp3();
  const originalHash = sha256(bytes);
  const inspected = await inspectMediaAsset({ originalAssetId: originalHash, originalName: 'module-a/question-02.ogg', bytes }, {
    probeMedia: async () => ({ decodeState: 'playable', codec: 'mp3', durationSeconds: 1.25 }),
  });
  assert.equal(inspected.originalHash, originalHash);
  assert.equal(inspected.declaredExtension, '.ogg');
  assert.equal(inspected.detectedFormat, 'mp3');
  assert.equal(inspected.declaredFormatState, 'mismatch');
  assert.equal(inspected.decodeState, 'playable');
  assert.equal(inspected.contentCheckState, 'notChecked');

  const result = await canonicalizeMediaFiles(new Map([['module-a/question-02.ogg', bytes]]), {
    probeMedia: async () => ({ decodeState: 'playable', codec: 'mp3', durationSeconds: 1.25 }),
  });
  assert.equal(result.nameMap.get('module-a/question-02.ogg'), 'module-a/question-02.mp3');
  assert.deepEqual(result.files.get('module-a/question-02.mp3'), bytes);
  assert.equal(sha256(bytes), originalHash, 'canonicalization cannot mutate the original bytes');
  assert.equal(result.entries[0].derivativeRefs[0].parentHash, originalHash);
  assert.equal(result.entries[0].derivativeRefs[0].outputHash, originalHash);
  assert.equal(result.entries[0].derivativeRefs[0].recipeVersion, 'playback-alias-v1');
});

test('a failed full probe publishes no alias, while helper absence leaves ordinary correctly named audio usable', async () => {
  const bytes = wav();
  const withoutHelper = await canonicalizeMediaFiles(new Map([['plain.wav', bytes]]));
  assert.equal(withoutHelper.nameMap.get('plain.wav'), 'plain.wav');
  assert.deepEqual(withoutHelper.files.get('plain.wav'), bytes);
  assert.equal(withoutHelper.entries[0].decodeState, 'notChecked');

  const failed = await canonicalizeMediaFiles(new Map([['broken.ogg', mp3()]]), {
    probeMedia: async () => ({ decodeState: 'failed', codec: null, durationSeconds: null }),
  });
  assert.equal(failed.nameMap.has('broken.ogg'), false);
  assert.equal(failed.files.size, 0);
  assert.equal(failed.entries[0].derivativeRefs.length, 0);
});

test('partial decode evidence preserves explicitly located missing ranges and is never published as a complete alias', async () => {
  const bytes = mp3();
  const checked = await canonicalizeMediaFiles(new Map([['partial.ogg', bytes]]), {
    probeMedia: async () => ({ decodeState: 'partial', codec: 'mp3', durationSeconds: 8, missingDurationSeconds: 1.5, missingLocationState: 'known', missingRanges: [{ startSeconds: 6.5, endSeconds: 8 }] }),
  });
  assert.equal(checked.nameMap.has('partial.ogg'), false);
  assert.deepEqual(checked.entries[0].missingRanges, [{ startSeconds: 6.5, endSeconds: 8 }]);
  assert.equal(checked.entries[0].missingLocationState, 'known');
  assert.equal(checked.entries[0].decodeState, 'partial');
});

test('media worker resolves asset IDs through the host and runs fixed local-only arguments with a scrubbed environment', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'practicebridge-media-worker-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const bytes = wav();
  const assetId = sha256(bytes);
  const inputPath = path.join(temp, assetId);
  await fs.writeFile(inputPath, bytes);
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345;
    child.kill = () => true;
    queueMicrotask(() => {
      if (executable.endsWith('ffmpeg.exe') && args.includes('s16le')) fsSync.writeFileSync(args.at(-1), Buffer.alloc(200));
      child.stdout.end(executable.endsWith('ffprobe.exe') ? JSON.stringify({ format: { format_name: 'wav', duration: '0.1', size: String(bytes.length) }, streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le' }] }) : '');
      child.stderr.end(); child.emit('close', 0, null);
    });
    return child;
  };
  const worker = createMediaWorker({
    ffprobePath: path.join(temp, 'ffprobe.exe'), ffmpegPath: path.join(temp, 'ffmpeg.exe'), artifactDir: path.join(temp, 'artifacts'),
    resolveAsset: async id => { assert.equal(id, assetId); return { path: inputPath, name: 'prompt.wav', size: bytes.length, hash: assetId }; },
    spawnProcess, environment: { PATH: 'kept-for-runtime', OPENAI_API_KEY: 'must-not-leak', HOME: 'must-not-leak' },
  });
  const result = await worker.runMaterialTool({
    jobId: 'job-1', expectedEpoch: '10000000-0000-4000-8000-000000000001', sourceRevision: 'a'.repeat(64), toolId: 'media.probe', inputAssetIds: [assetId], parameters: {},
    budget: { timeoutMs: 2000, maxOutputBytes: 65536, maxDurationSeconds: 60 }, cancelToken: null,
  });
  assert.equal(result.state, 'completed');
  assert.equal(result.evidence[0].decodeState, 'playable');
  assert.equal(calls.length, 2, 'metadata probing is followed by a full FFmpeg decode');
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.stdio[0], 'ignore');
    assert.equal(call.options.env.OPENAI_API_KEY, undefined);
    assert.equal(call.options.env.HOME, undefined);
    assert.deepEqual(call.args.slice(call.args.indexOf('-protocol_whitelist'), call.args.indexOf('-protocol_whitelist') + 2), ['-protocol_whitelist', 'file']);
    assert.ok(call.args.includes('wav'), 'the detected demuxer is fixed instead of allowing playlist autodetection');
    assert.ok(call.args.includes(inputPath));
  }
  assert.ok(calls.find(call => call.executable.endsWith('ffmpeg.exe')).args.includes('-nostdin'));
});

test('media worker rejects paths, URLs, command strings, unknown parameters, and unbounded budgets from callers', async () => {
  const worker = createMediaWorker({
    ffprobePath: path.resolve('ffprobe.exe'), ffmpegPath: path.resolve('ffmpeg.exe'), artifactDir: path.resolve('artifacts'),
    resolveAsset: async () => { throw new Error('must not resolve invalid requests'); },
  });
  const base = { jobId: 'job-1', expectedEpoch: '10000000-0000-4000-8000-000000000001', sourceRevision: 'a'.repeat(64), toolId: 'media.probe', inputAssetIds: ['a'.repeat(64)], budget: { timeoutMs: 2000, maxOutputBytes: 65536, maxDurationSeconds: 60 }, cancelToken: null };
  for (const parameters of [{ path: 'C:/private.wav' }, { url: 'https://example.invalid/a.wav' }, { command: 'whoami' }, { outputFormat: 'mp3' }]) {
    await assert.rejects(worker.runMaterialTool({ ...base, parameters }), /参数|不允许/);
  }
  await assert.rejects(worker.runMaterialTool({ ...base, parameters: {}, budget: { timeoutMs: 0, maxOutputBytes: 65536, maxDurationSeconds: 60 } }), /预算/);
  await assert.rejects(worker.runMaterialTool({ ...base, parameters: {}, inputAssetIds: ['../file'] }), /资产/);
});

test('playlist and sidecar-style inputs never reach ffprobe or FFmpeg', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'practicebridge-media-reject-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const bytes = Buffer.from('#EXTM3U\n#EXTINF:10,remote\nhttps://example.invalid/audio.mp3\n');
  const assetId = sha256(bytes); const inputPath = path.join(temp, assetId); await fs.writeFile(inputPath, bytes);
  let spawned = false;
  const worker = createMediaWorker({
    ffprobePath: path.join(temp, 'ffprobe.exe'), ffmpegPath: path.join(temp, 'ffmpeg.exe'), artifactDir: path.join(temp, 'artifacts'),
    resolveAsset: async () => ({ path: inputPath, name: 'misleading.mp3', size: bytes.length, hash: assetId }),
    spawnProcess: () => { spawned = true; throw new Error('must not spawn'); },
  });
  await assert.rejects(worker.runMaterialTool({ jobId: 'playlist', expectedEpoch: '10000000-0000-4000-8000-000000000001', sourceRevision: 'a'.repeat(64), toolId: 'media.probe', inputAssetIds: [assetId], parameters: {}, budget: { timeoutMs: 2000, maxOutputBytes: 65536, maxDurationSeconds: 60 }, cancelToken: null }), /受支持的音频|独立音频格式/);
  assert.equal(spawned, false);
});

const findTool = name => {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) return path.resolve(result.stdout.trim().split(/\r?\n/)[0]);
  if (process.platform !== 'win32') return null;
  const powershell = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Command ${name} -ErrorAction SilentlyContinue).Source`], { encoding: 'utf8', windowsHide: true });
  return powershell.status === 0 && powershell.stdout.trim() ? path.resolve(powershell.stdout.trim().split(/\r?\n/)[0]) : null;
};

function changeXingFrameCount(bytes, frames) {
  const result = Buffer.from(bytes);
  const marker = Math.max(result.indexOf('Info'), result.indexOf('Xing'));
  assert.ok(marker >= 0, 'Synthetic MP3 must contain an Info/Xing duration header');
  const flags = result.readUInt32BE(marker + 4);
  assert.ok(flags & 1, 'Synthetic MP3 must declare a frame count');
  result.writeUInt32BE(frames, marker + 8);
  return result;
}

function removeMpeg1Layer3Frames(bytes, firstIndex, lastIndex) {
  let offset = 0;
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    offset = 10 + size + ((bytes[5] & 0x10) ? 10 : 0);
  }
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const sampleRates = [44100, 48000, 32000];
  const frames = [];
  while (offset + 4 <= bytes.length) {
    const header = bytes.readUInt32BE(offset);
    if ((header >>> 21) !== 0x7ff || ((header >>> 19) & 3) !== 3 || ((header >>> 17) & 3) !== 1) break;
    const bitrate = bitrates[(header >>> 12) & 0xf];
    const sampleRate = sampleRates[(header >>> 10) & 3];
    if (!bitrate || !sampleRate) break;
    const length = Math.floor(144000 * bitrate / sampleRate) + ((header >>> 9) & 1);
    if (offset + length > bytes.length) break;
    frames.push({ start: offset, end: offset + length });
    offset += length;
  }
  assert.ok(frames.length > lastIndex, `Synthetic MP3 needs at least ${lastIndex + 1} complete frames`);
  return Buffer.concat([bytes.subarray(0, frames[firstIndex].start), bytes.subarray(frames[lastIndex].end)]);
}

test('installed FFmpeg fully decodes a real synthetic MP3 stored with .ogg name and rejects a truly truncated counterpart', { skip: !(findTool('ffmpeg') && findTool('ffprobe')) }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'practicebridge-real-media-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const wavPath = path.join(temp, 'synthetic.wav');
  const mp3Path = path.join(temp, 'synthetic.mp3');
  await fs.writeFile(wavPath, wav());
  const encoded = spawnSync(findTool('ffmpeg'), ['-hide_banner', '-v', 'error', '-nostdin', '-f', 'wav', '-i', wavPath, '-map', '0:a:0', '-c:a', 'libmp3lame', '-f', 'mp3', mp3Path], { windowsHide: true });
  assert.equal(encoded.status, 0, encoded.stderr?.toString());
  const realMp3 = await fs.readFile(mp3Path);
  const brokenMp3 = realMp3.subarray(0, 12);
  const records = new Map();
  for (const [name, bytes] of [['question-2.ogg', realMp3], ['broken.ogg', brokenMp3], ['needs-playback-derivative.wav', wav()]]) {
    const hash = sha256(bytes); const filename = path.join(temp, hash); await fs.writeFile(filename, bytes);
    records.set(hash, { path: filename, name, size: bytes.length, hash });
  }
  const worker = createMediaWorker({
    ffprobePath: findTool('ffprobe'), ffmpegPath: findTool('ffmpeg'), artifactDir: path.join(temp, 'artifacts'),
    resolveAsset: async id => records.get(id),
  });
  const probeMedia = async ({ originalAssetId }) => {
    try {
      const result = await worker.runMaterialTool({ jobId: 'real-probe', expectedEpoch: '10000000-0000-4000-8000-000000000001', sourceRevision: 'a'.repeat(64), toolId: 'media.probe', inputAssetIds: [originalAssetId], parameters: {}, budget: { timeoutMs: 10000, maxOutputBytes: 65536, maxDurationSeconds: 10 }, cancelToken: null });
      return result.evidence[0];
    } catch { return { decodeState: 'failed', codec: null, durationSeconds: null }; }
  };
  const checked = await canonicalizeMediaFiles(new Map([['question-2.ogg', realMp3], ['broken.ogg', brokenMp3]]), { probeMedia });
  assert.equal(checked.nameMap.get('question-2.ogg'), 'question-2.mp3');
  assert.equal(checked.nameMap.has('broken.ogg'), false);
  assert.equal(checked.entries.find(entry => entry.originalName === 'question-2.ogg').codec, 'mp3');
  assert.equal(checked.entries.find(entry => entry.originalName === 'broken.ogg').decodeState, 'failed');

  const wavRecord = [...records.values()].find(record => record.name.endsWith('.wav'));
  const derived = await worker.runMaterialTool({ jobId: 'real-transcode', expectedEpoch: '10000000-0000-4000-8000-000000000001', sourceRevision: 'a'.repeat(64), toolId: 'media.playback', inputAssetIds: [wavRecord.hash], parameters: { outputFormat: 'mp3' }, budget: { timeoutMs: 10000, maxOutputBytes: 1024 * 1024, maxDurationSeconds: 10 }, cancelToken: null });
  assert.equal(derived.state, 'completed');
  assert.equal(derived.artifactRefs[0].parentHash, wavRecord.hash);
  assert.equal(derived.artifactRefs[0].recipeVersion, 'ffmpeg-playback-mp3-v1');
  const output = await fs.readFile(derived.artifactRefs[0].hostPath);
  assert.equal(sha256(output), derived.artifactRefs[0].assetId);
  assert.equal(detectMediaContent(output).format, 'mp3');
});

test('real decode range defeats truncated tails and forged MP3 duration metadata without breaking helper-unsupported M4A', { skip: !(findTool('ffmpeg') && findTool('ffprobe')) }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'practicebridge-media-integrity-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const ffmpeg = findTool('ffmpeg');
  const sourcePath = path.join(temp, 'four-seconds.mp3');
  const m4aPath = path.join(temp, 'one-second.m4a');
  const generatedMp3 = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4', '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '128k', '-write_xing', '1', '-f', 'mp3', sourcePath], { windowsHide: true });
  assert.equal(generatedMp3.status, 0, generatedMp3.stderr?.toString());
  const generatedM4a = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1', '-map', '0:a:0', '-c:a', 'aac', '-f', 'ipod', m4aPath], { windowsHide: true });
  assert.equal(generatedM4a.status, 0, generatedM4a.stderr?.toString());

  const complete = await fs.readFile(sourcePath);
  const truncated = complete.subarray(0, Math.floor(complete.length * 0.6));
  const middleDeleted = removeMpeg1Layer3Frames(complete, 40, 99);
  assert.deepEqual(middleDeleted.subarray(-8000), complete.subarray(-8000), 'The middle-frame fixture retains the original tail bytes');
  const forgedDuration = changeXingFrameCount(complete, 10);
  const m4a = await fs.readFile(m4aPath);
  const records = new Map();
  for (const [name, bytes] of [['truncated.ogg', truncated], ['middle-deleted.mp3', middleDeleted], ['forged.mp3', forgedDuration], ['tone.m4a', m4a]]) {
    const hash = sha256(bytes); const filename = path.join(temp, hash); await fs.writeFile(filename, bytes);
    records.set(hash, { path: filename, name, size: bytes.length, hash });
  }
  const worker = createMediaWorker({ ffprobePath: findTool('ffprobe'), ffmpegPath: ffmpeg, artifactDir: path.join(temp, 'artifacts'), resolveAsset: async id => records.get(id) });
  const request = (record, toolId = 'media.probe', maxDurationSeconds = 10) => worker.runMaterialTool({
    jobId: `integrity-${record.name}`, expectedEpoch: '10000000-0000-4000-8000-000000000001', sourceRevision: 'a'.repeat(64), toolId, inputAssetIds: [record.hash],
    parameters: toolId === 'media.playback' ? { outputFormat: 'mp3' } : {}, budget: { timeoutMs: 15000, maxOutputBytes: 1024 * 1024, maxDurationSeconds }, cancelToken: null,
  });

  const truncatedRecord = [...records.values()].find(record => record.name === 'truncated.ogg');
  const truncatedProbe = await request(truncatedRecord);
  const truncatedCanonical = await canonicalizeMediaFiles(new Map([['truncated.ogg', truncated]]), { probeMedia: async () => truncatedProbe.evidence[0] });

  const middleRecord = [...records.values()].find(record => record.name === 'middle-deleted.mp3');
  const middleProbe = await request(middleRecord);

  const forgedRecord = [...records.values()].find(record => record.name === 'forged.mp3');
  let forgedRejected = false;
  try { await request(forgedRecord, 'media.playback', 1); }
  catch (error) { forgedRejected = /实际|时长|预算/.test(error.message); }
  const artifactNames = await fs.readdir(path.join(temp, 'artifacts')).catch(() => []);

  const m4aRecord = [...records.values()].find(record => record.name === 'tone.m4a');
  const m4aCanonical = await canonicalizeMediaFiles(new Map([['tone.m4a', m4a]]), { probeMedia: async () => (await request(m4aRecord)).evidence[0] });
  assert.deepEqual({
    truncatedState: truncatedProbe.evidence[0].decodeState,
    truncatedActualRange: truncatedProbe.evidence[0].actualDurationSeconds > 2 && truncatedProbe.evidence[0].actualDurationSeconds < 3,
    truncatedMissingRanges: truncatedProbe.evidence[0].missingRanges,
    truncatedMissingLocation: truncatedProbe.evidence[0].missingLocationState,
    truncatedMissingTotalKnown: truncatedProbe.evidence[0].missingDurationSeconds > 1 && truncatedProbe.evidence[0].missingDurationSeconds < 2,
    truncatedAliasPublished: truncatedCanonical.nameMap.has('truncated.ogg'),
    middleState: middleProbe.evidence[0].decodeState,
    middleActualRange: middleProbe.evidence[0].actualDurationSeconds > 2 && middleProbe.evidence[0].actualDurationSeconds < 3,
    middleMissingRanges: middleProbe.evidence[0].missingRanges,
    middleMissingLocation: middleProbe.evidence[0].missingLocationState,
    middleMissingTotalKnown: middleProbe.evidence[0].missingDurationSeconds > 1 && middleProbe.evidence[0].missingDurationSeconds < 2,
    forgedRejected,
    forgedArtifactPublished: artifactNames.some(name => /^[a-f0-9]{64}\.mp3$/.test(name)),
    m4aCanonicalName: m4aCanonical.nameMap.get('tone.m4a'),
    m4aBytesPreserved: m4aCanonical.files.get('tone.m4a')?.equals(m4a) || false,
    m4aDecodeState: m4aCanonical.entries[0].decodeState,
    m4aUnavailableIssue: m4aCanonical.entries[0].issues.some(issue => issue.code === 'media_probe_unavailable'),
  }, {
    truncatedState: 'partial', truncatedActualRange: true, truncatedMissingRanges: [], truncatedMissingLocation: 'unknown', truncatedMissingTotalKnown: true, truncatedAliasPublished: false,
    middleState: 'partial', middleActualRange: true, middleMissingRanges: [], middleMissingLocation: 'unknown', middleMissingTotalKnown: true,
    forgedRejected: true, forgedArtifactPublished: false,
    m4aCanonicalName: 'tone.m4a', m4aBytesPreserved: true, m4aDecodeState: 'notChecked', m4aUnavailableIssue: true,
  });
});
