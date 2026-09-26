import crypto from 'node:crypto';
import path from 'node:path';

const FORMAT_EXTENSIONS = Object.freeze({
  png: ['.png'], jpeg: ['.jpg', '.jpeg'], gif: ['.gif'], webp: ['.webp'], avif: ['.avif'],
  wav: ['.wav'], mp3: ['.mp3'], ogg: ['.ogg', '.oga', '.opus'], webm: ['.webm'], mp4: ['.m4a', '.mp4'],
});
const ROLES = new Set(['directions', 'stimulus', 'question', 'sampleAnswer']);
const MAPPING_STATES = new Set(['proposed', 'applied', 'ambiguous', 'rejected']);
const CONTENT_STATES = new Set(['notChecked', 'matched', 'conflict', 'inconclusive']);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ascii = (bytes, start, end) => bytes.subarray(start, end).toString('ascii');
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function formatExtensions(format) {
  return [...(FORMAT_EXTENSIONS[format] || [])];
}

/** Detect bytes without consulting a caller-controlled filename. */
export function detectMediaContent(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: 'image', mime: 'image/png', extension: '.png', format: 'png', ffmpegFormat: 'png_pipe', directlyPlayable: true };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { kind: 'image', mime: 'image/jpeg', extension: '.jpg', format: 'jpeg', ffmpegFormat: 'image2', directlyPlayable: true };
  if (['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return { kind: 'image', mime: 'image/gif', extension: '.gif', format: 'gif', ffmpegFormat: 'gif', directlyPlayable: true };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', extension: '.webp', format: 'webp', ffmpegFormat: 'webp_pipe', directlyPlayable: true };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', extension: '.wav', format: 'wav', ffmpegFormat: 'wav', directlyPlayable: true };
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg', extension: '.mp3', format: 'mp3', ffmpegFormat: 'mp3', directlyPlayable: true };
  if (ascii(bytes, 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg', extension: '.ogg', format: 'ogg', ffmpegFormat: 'ogg', directlyPlayable: true };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { kind: 'audio', mime: 'audio/webm', extension: '.webm', format: 'webm', ffmpegFormat: 'matroska', directlyPlayable: true };
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (['avif', 'avis'].includes(brand)) return { kind: 'image', mime: 'image/avif', extension: '.avif', format: 'avif', ffmpegFormat: 'avif', directlyPlayable: true };
    if (['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42', 'qt  '].includes(brand)) return { kind: 'audio', mime: 'audio/mp4', extension: '.m4a', format: 'mp4', ffmpegFormat: 'mov', directlyPlayable: true };
  }
  return null;
}

function normalizeProbe(result) {
  const state = result?.decodeState;
  if (!['notChecked', 'playable', 'failed', 'partial'].includes(state)) return { decodeState: 'failed', codec: null, durationSeconds: null, actualDurationSeconds: null, containerDurationSeconds: null, missingDurationSeconds: null, missingLocationState: 'notApplicable', missingRanges: [] };
  const durationSeconds = Number.isFinite(result.durationSeconds) && result.durationSeconds >= 0 ? result.durationSeconds : null;
  const claimedRanges = state === 'partial' && Array.isArray(result.missingRanges)
    ? result.missingRanges.filter(range => plainObject(range) && Number.isFinite(range.startSeconds) && Number.isFinite(range.endSeconds) && range.startSeconds >= 0 && range.endSeconds >= range.startSeconds).map(range => ({ startSeconds: range.startSeconds, endSeconds: range.endSeconds }))
    : [];
  const actualDurationSeconds = Number.isFinite(result.actualDurationSeconds) && result.actualDurationSeconds >= 0 ? result.actualDurationSeconds : null;
  const containerDurationSeconds = Number.isFinite(result.containerDurationSeconds) && result.containerDurationSeconds >= 0 ? result.containerDurationSeconds : null;
  const inferredMissingDuration = actualDurationSeconds !== null && containerDurationSeconds !== null ? Math.max(0, containerDurationSeconds - actualDurationSeconds) : null;
  const missingDurationSeconds = Number.isFinite(result.missingDurationSeconds) && result.missingDurationSeconds >= 0 ? result.missingDurationSeconds : inferredMissingDuration;
  const missingLocationState = state === 'partial' && result.missingLocationState === 'known' && claimedRanges.length ? 'known' : state === 'partial' ? 'unknown' : 'notApplicable';
  const missingRanges = missingLocationState === 'known' ? claimedRanges : [];
  return { decodeState: state, codec: typeof result.codec === 'string' ? result.codec.slice(0, 100) : null, durationSeconds, actualDurationSeconds, containerDurationSeconds, missingDurationSeconds, missingLocationState, missingRanges };
}

const unavailableProbe = error => error?.code === 'MEDIA_HELPER_UNSUPPORTED' || ['ENOENT', 'EACCES'].includes(error?.code);

export async function inspectMediaAsset({ originalAssetId, originalName, bytes }, { probeMedia } = {}) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Media bytes must be a Buffer.');
  if (typeof originalName !== 'string' || !originalName) throw new TypeError('Media originalName is required.');
  const originalHash = sha256(bytes);
  if (originalAssetId !== undefined && originalAssetId !== originalHash) throw new Error('Media originalAssetId does not match its bytes.');
  const detected = detectMediaContent(bytes);
  const declaredExtension = path.posix.extname(originalName).toLowerCase();
  const declaredFormatState = !detected ? 'unrecognized' : FORMAT_EXTENSIONS[detected.format].includes(declaredExtension) ? 'matched' : 'mismatch';
  let probe = { decodeState: 'notChecked', codec: null, durationSeconds: null, actualDurationSeconds: null, containerDurationSeconds: null, missingDurationSeconds: null, missingLocationState: 'notApplicable', missingRanges: [] };
  const issues = [];
  if (detected?.kind === 'audio' && typeof probeMedia === 'function') {
    try { probe = normalizeProbe(await probeMedia({ originalAssetId: originalHash, originalName, bytes, detected })); }
    catch (error) {
      const unavailable = unavailableProbe(error);
      probe = { decodeState: unavailable ? 'notChecked' : 'failed', codec: null, durationSeconds: null, actualDurationSeconds: null, containerDurationSeconds: null, missingDurationSeconds: null, missingLocationState: 'notApplicable', missingRanges: [] };
      issues.push({ code: unavailable ? 'media_probe_unavailable' : 'media_probe_failed', scope: originalName, reason: String(error?.message || error).slice(0, 1000) });
    }
  }
  return {
    originalAssetId: originalHash, originalHash, originalName, declaredExtension,
    detectedFormat: detected?.format || null, detectedMime: detected?.mime || null, codec: probe.codec,
    decodeState: probe.decodeState, durationSeconds: probe.durationSeconds, actualDurationSeconds: probe.actualDurationSeconds ?? null,
    containerDurationSeconds: probe.containerDurationSeconds ?? null, missingDurationSeconds: probe.missingDurationSeconds ?? null,
    missingLocationState: probe.missingLocationState, missingRanges: probe.missingRanges,
    declaredFormatState, derivativeRefs: [], mappingBasis: null, mappingState: 'proposed',
    contentCheckState: 'notChecked', issues,
  };
}

function safeAliasName(originalName, extension, hash, used) {
  const directory = path.posix.dirname(originalName) === '.' ? '' : `${path.posix.dirname(originalName)}/`;
  const stem = path.posix.basename(originalName, path.posix.extname(originalName)).replace(/[\x00-\x1f<>:"|?*]/g, '-').slice(0, 220) || 'media';
  let candidate = `${directory}${stem}${extension}`;
  if (used.has(candidate.toLocaleLowerCase('en-US'))) candidate = `${directory}${stem}-${hash.slice(0, 12)}${extension}`;
  let counter = 2;
  while (used.has(candidate.toLocaleLowerCase('en-US'))) candidate = `${directory}${stem}-${hash.slice(0, 12)}-${counter++}${extension}`;
  return candidate;
}

/** Build formal-package-ready media names without changing or deleting originals. */
export async function canonicalizeMediaFiles(inputFiles, { probeMedia } = {}) {
  if (!(inputFiles instanceof Map)) throw new TypeError('canonicalizeMediaFiles requires a Map.');
  const files = new Map();
  const nameMap = new Map();
  const entries = [];
  const used = new Set([...inputFiles.keys()].map(name => name.toLocaleLowerCase('en-US')));
  for (const [originalName, bytes] of [...inputFiles].sort(([a], [b]) => naturalMediaCompare(a, b))) {
    const evidence = await inspectMediaAsset({ originalName, bytes }, { probeMedia });
    const detected = detectMediaContent(bytes);
    if (!detected) { entries.push(evidence); continue; }
    const declaredMatches = evidence.declaredFormatState === 'matched';
    const probedFailure = evidence.decodeState === 'failed' || evidence.decodeState === 'partial';
    if (probedFailure || (!declaredMatches && evidence.decodeState !== 'playable')) { entries.push(evidence); continue; }
    const canonicalName = declaredMatches ? originalName : safeAliasName(originalName, detected.extension, evidence.originalHash, used);
    files.set(canonicalName, Buffer.from(bytes));
    nameMap.set(originalName, canonicalName);
    used.add(canonicalName.toLocaleLowerCase('en-US'));
    if (!declaredMatches) evidence.derivativeRefs.push({
      parentHash: evidence.originalHash, recipeVersion: 'playback-alias-v1', outputHash: evidence.originalHash,
      name: canonicalName, mime: detected.mime, operation: 'byte-identical-alias',
    });
    entries.push(evidence);
  }
  return { files, nameMap, entries };
}

export function naturalMediaCompare(left, right) {
  return String(left).localeCompare(String(right), 'en-US', { numeric: true, sensitivity: 'base' });
}

const stemKey = name => path.posix.basename(String(name), path.posix.extname(String(name))).normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const sequenceFromName = name => {
  const matches = stemKey(name).match(/\d+/g);
  return matches?.length ? Number(matches.at(-1)) : null;
};
const roleOf = value => ROLES.has(value) ? value : 'stimulus';
const sameScope = (target, asset) => typeof target.scopeId === 'string' && target.scopeId.length > 0 && target.scopeId === asset.scopeId;
const compatible = (target, asset) => sameScope(target, asset) && roleOf(target.role) === roleOf(asset.role);
const relationContentState = (asset, target) => {
  const evidence = asset?.contentEvidence;
  return plainObject(evidence) && evidence.assetId === asset.assetId && evidence.targetId === target.targetId &&
    Number.isInteger(target.candidateRevision) && evidence.candidateRevision === target.candidateRevision &&
    CONTENT_STATES.has(evidence.state) ? evidence.state : 'notChecked';
};

function mapping(target, assetId, basis, state, candidates = []) {
  return {
    targetId: target.targetId, assetId, mappingBasis: basis, mappingState: MAPPING_STATES.has(state) ? state : 'proposed',
    contentCheckState: 'notChecked', candidates,
  };
}

/** Pure, scoped proposal engine. It never infers semantic content from decoding. */
export function resolveMediaMappings({ assets = [], targets = [], autoPair = false } = {}) {
  if (!Array.isArray(assets) || !Array.isArray(targets)) throw new TypeError('Media assets and targets must be arrays.');
  const result = [];
  const pendingUnnumbered = [];
  for (const target of targets) {
    const candidates = assets.filter(asset => compatible(target, asset));
    if (target.explicitRef) {
      const exact = assets.filter(asset => roleOf(target.role) === roleOf(asset.role) &&
        (asset.assetId === target.explicitRef || asset.originalName === target.explicitRef) &&
        (!target.scopeId || target.scopeId === asset.scopeId));
      if (exact.length === 1) { const item = mapping(target, exact[0].assetId, 'explicitRef', 'applied'); item.contentCheckState = relationContentState(exact[0], target); result.push(item); continue; }
      result.push(mapping(target, null, 'explicitRef', exact.length > 1 ? 'ambiguous' : 'proposed', exact.map(asset => asset.assetId))); continue;
    }
    const hints = Array.isArray(target.filenameHints) ? target.filenameHints.map(stemKey).filter(Boolean) : [];
    if (hints.length) {
      const exact = candidates.filter(asset => hints.includes(stemKey(asset.originalName)));
      if (exact.length === 1) { const item = mapping(target, exact[0].assetId, 'filename', 'applied'); item.contentCheckState = relationContentState(exact[0], target); result.push(item); continue; }
      if (exact.length > 1) { result.push(mapping(target, null, 'filename', 'ambiguous', exact.map(asset => asset.assetId))); continue; }
    }
    const sequenceNumber = Number.isInteger(target.sequenceNumber) && target.sequenceNumber >= 0 ? target.sequenceNumber : null;
    if (sequenceNumber !== null) {
      const exact = candidates.filter(asset => sequenceFromName(asset.originalName) === sequenceNumber);
      if (exact.length === 1) { const item = mapping(target, exact[0].assetId, 'filename', 'applied'); item.contentCheckState = relationContentState(exact[0], target); result.push(item); continue; }
      result.push(mapping(target, null, 'sequence', exact.length > 1 ? 'ambiguous' : 'proposed', exact.map(asset => asset.assetId))); continue;
    }
    const item = mapping(target, null, 'sequence', 'proposed');
    result.push(item); pendingUnnumbered.push({ target, item, candidates: candidates.filter(asset => sequenceFromName(asset.originalName) === null) });
  }
  if (autoPair) {
    const groups = new Map();
    for (const entry of pendingUnnumbered) {
      const key = JSON.stringify([entry.target.scopeId || '', roleOf(entry.target.role)]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    for (const entries of groups.values()) {
      const available = [...new Map(entries.flatMap(entry => entry.candidates).map(asset => [asset.assetId, asset])).values()].sort((a, b) => naturalMediaCompare(a.originalName, b.originalName));
      if (available.length !== entries.length || available.some(asset => !asset.assetId)) continue;
      entries.forEach((entry, index) => {
        entry.item.assetId = available[index].assetId; entry.item.mappingBasis = 'sequence'; entry.item.mappingState = 'applied';
        entry.item.contentCheckState = relationContentState(available[index], entry.target);
      });
    }
  }
  return { mappings: result };
}

export function applyUserMediaMapping(candidate, { targetId, assetId, contentChecked = false }) {
  if (!plainObject(candidate) || !Number.isInteger(candidate.revision) || candidate.revision < 0 || !Array.isArray(candidate.mappings)) throw new TypeError('Candidate revision is invalid.');
  if (typeof targetId !== 'string' || !targetId || typeof assetId !== 'string' || !assetId) throw new TypeError('User mapping requires targetId and assetId.');
  const next = structuredClone(candidate);
  const value = { targetId, assetId, mappingBasis: 'user', mappingState: 'applied', contentCheckState: contentChecked ? 'matched' : 'notChecked' };
  const index = next.mappings.findIndex(item => item.targetId === targetId);
  if (index < 0) next.mappings.push(value); else next.mappings[index] = value;
  next.revision += 1;
  return next;
}
