import crypto from 'node:crypto';
import path from 'node:path';
import { InputError, canonicalJSON, prepareImportFiles, identifyMedia } from './package.mjs';
import { extractMaterialSources } from './importer.mjs';
import { addExamDocumentMetadata, isLegacyModularExam, matchExamDirections } from './exam-plan.mjs';

const PROJECTION_VERSION = 1;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_MEDIA_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_PROJECTIONS = 64;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const projectionKey = (library, materials) => sha(Buffer.from(canonicalJSON({ version: PROJECTION_VERSION, sourceHash: library.contentHash, materials: materials.map(material => ({ id: material.id, files: material.files.map(file => ({ id: file.id, name: file.name, size: file.size })) })) })));
const warning = (message, at = 'examPlan') => ({ severity: 'warning', message, path: at });

function mediaEntries(files) {
  return [...files].flatMap(([name, bytes]) => {
    const media = identifyMedia(name, bytes);
    return media ? [{ name, hash: sha(bytes), size: bytes.length, mime: media.mime, kind: media.kind, bytes }] : [];
  });
}

function mediaReferences(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (['audio', 'image'].includes(key) && typeof child === 'string' && child.startsWith('/api/exam-media/')) {
      const match = /^\/api\/exam-media\/([a-f0-9-]{36})\/([a-f0-9]{64})$/i.exec(child);
      if (!match || !UUID.test(match[1])) throw new InputError('机考说明媒体地址无效。');
      found.push({ materialId: match[1], hash: match[2] });
    } else if (child && typeof child === 'object') mediaReferences(child, found);
  }
  return found;
}

/** Verify frozen URLs using the originals carried in the backup, before writes. */
export async function validateExamOverlayReferences(state, originals, { signal } = {}) {
  const references = state.sessions.filter(session => session.sessionVersion === 2).flatMap(session => mediaReferences(session.planSnapshot));
  const materialHashes = new Map(), preparedByContent = new Map();
  for (const reference of references) {
    if (!materialHashes.has(reference.materialId)) {
      const material = (state.materials || []).find(item => item.id === reference.materialId);
      if (!material) throw new InputError('备份中的机考说明引用了缺失的材料原件。');
      const key = canonicalJSON(material.files.map(file => ({ id: file.id, name: file.name, size: file.size })));
      let hashes = preparedByContent.get(key);
      if (!hashes) {
        const uploads = material.files.map(file => {
          const bytes = originals.get(file.id);
          if (!Buffer.isBuffer(bytes) || bytes.length !== file.size || sha(bytes) !== file.id) throw new InputError('备份中的机考说明材料原件不完整。');
          return { name: file.name, data: bytes.toString('base64') };
        });
        const prepared = await prepareImportFiles(uploads, { signal });
        hashes = new Set(mediaEntries(prepared.files).map(media => media.hash));
        preparedByContent.set(key, hashes);
      }
      materialHashes.set(reference.materialId, hashes);
    }
    if (!materialHashes.get(reference.materialId).has(reference.hash)) throw new InputError('备份中找不到冻结练习计划引用的说明音频。');
  }
}

/** Runtime projections never write libraries, blobs, materials or attempts. */
export function createExamOverlay({ inbox, extractSources = extractMaterialSources } = {}) {
  if (!inbox?.loadFiles || !inbox?.get) throw new TypeError('createExamOverlay requires an inbox.');
  const projections = new Map(), mediaCache = new Map();
  let generation = 0, mediaBytes = 0;
  const rememberMedia = (materialId, media) => {
    const key = `${materialId}/${media.hash}`;
    if (mediaCache.has(key)) return;
    while (mediaCache.size && mediaBytes + media.bytes.length > MAX_MEDIA_CACHE_BYTES) {
      const first = mediaCache.keys().next().value;
      mediaBytes -= mediaCache.get(first).bytes.length; mediaCache.delete(first);
    }
    if (media.bytes.length <= MAX_MEDIA_CACHE_BYTES) { mediaCache.set(key, media); mediaBytes += media.bytes.length; }
  };
  const clear = () => { generation += 1; projections.clear(); mediaCache.clear(); mediaBytes = 0; };

  async function project(library, runtime, materials = []) {
    const matches = materials.filter(material => material.libraryId === library.libraryId).sort((a, b) => a.id.localeCompare(b.id));
    if (!isLegacyModularExam(library.originalPack) || Array.isArray(library.originalPack.examSets) || !matches.length) return { pack: runtime, mediaCatalog: [], mediaUrls: {}, extraMedia: [], issues: [], projectionVersion: PROJECTION_VERSION };
    const key = projectionKey(library, matches);
    if (projections.has(key)) return structuredClone(await projections.get(key));
    while (projections.size >= MAX_PROJECTIONS) projections.delete(projections.keys().next().value);
    const startedGeneration = generation;
    const pending = (async () => {
      const chunks = [], issues = [], candidates = [], seenPdfHashes = new Set();
      for (const material of matches) {
        try {
          const prepared = await prepareImportFiles(await inbox.loadFiles(material.id));
          if (startedGeneration !== generation) throw new InputError('工作区已更新，请重新打开练习。', 409);
          for (const media of mediaEntries(prepared.files).filter(item => item.kind === 'audio')) candidates.push({ ...media, materialId: material.id, url: `/api/exam-media/${material.id}/${media.hash}` });
          for (const [name, bytes] of prepared.files) if (path.posix.extname(name).toLowerCase() === '.pdf') {
            const pdfHash = sha(bytes);
            if (seenPdfHashes.has(pdfHash)) continue;
            seenPdfHashes.add(pdfHash);
            try {
              const extracted = await extractSources({ files: [{ name, data: bytes.toString('base64') }], title: library.originalPack.title });
              chunks.push(...extracted.chunks);
              issues.push(...extracted.issues);
            } catch (error) { issues.push(warning(`原件 ${name} 的排版暂时无法读取；保留已有练习文字。`, name)); }
            if (startedGeneration !== generation) throw new InputError('工作区已更新，请重新打开练习。', 409);
          }
        } catch (error) {
          if (startedGeneration !== generation) throw error;
          issues.push(warning('材料原件未通过读取检查，暂未添加额外说明音频或版面信息。', material.id));
        }
      }
      // Identical copies do not create false ambiguity. Distinct bytes with the
      // same filename remain separate so the existing matcher refuses to guess.
      const catalog = [...new Map(candidates.map(candidate => [`${candidate.name}\0${candidate.hash}`, candidate])).values()];
      const matched = matchExamDirections(runtime, catalog);
      const matchedUrls = new Set(matched.matches.map(match => match.direction.audio));
      const selected = catalog.filter(candidate => matchedUrls.has(candidate.url));
      const enriched = addExamDocumentMetadata(runtime, { chunks, mediaCatalog: selected });
      if (startedGeneration !== generation) throw new InputError('工作区已更新，请重新打开练习。', 409);
      for (const media of selected) rememberMedia(media.materialId, media);
      const mediaCatalog = selected.map(({ name, hash, size, mime, materialId, url }) => ({ name, hash, size, mime, materialId, url }));
      return { pack: enriched.pack, mediaCatalog, mediaUrls: Object.fromEntries(mediaCatalog.map(media => [media.name, media.url])), extraMedia: mediaCatalog, issues: [...issues, ...matched.issues, ...enriched.issues], projectionVersion: PROJECTION_VERSION };
    })();
    projections.set(key, pending);
    try { return structuredClone(await pending); }
    catch (error) { if (projections.get(key) === pending) projections.delete(key); throw error; }
  }

  async function readMedia(materialId, hash) {
    if (!UUID.test(materialId) || !HASH.test(hash)) throw new InputError('找不到此机考说明媒体。', 404);
    inbox.get(materialId);
    const key = `${materialId}/${hash}`;
    const cached = mediaCache.get(key);
    if (cached) {
      mediaCache.delete(key); mediaCache.set(key, cached);
      return { bytes: cached.bytes, mime: cached.mime, name: cached.name };
    }
    const startedGeneration = generation;
    const prepared = await prepareImportFiles(await inbox.loadFiles(materialId));
    const media = mediaEntries(prepared.files).find(item => item.hash === hash);
    if (!media) throw new InputError('原材料中找不到此说明媒体。', 404);
    if (startedGeneration !== generation) throw new InputError('工作区已更新，请重新加载媒体。', 409);
    rememberMedia(materialId, media);
    return { bytes: media.bytes, mime: media.mime, name: media.name };
  }

  return { project, readMedia, clear, close: clear };
}
