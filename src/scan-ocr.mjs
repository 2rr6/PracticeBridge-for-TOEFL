// Automatic OCR for scanned PDF pages during local material processing.
// Runs only when the optional English OCR is installed and enabled; reads each
// page once per file content and engine lock, and keeps the evidence (words,
// boxes, confidence) so later processing never repeats the work.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createOcrWorker } from './workers/ocr.mjs';
import { OCR_LIMITS } from './ocr-policy.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const EPOCH = '00000000-0000-4000-8000-000000000000';
// Bump when page recognition changes, so cached readings are not reused.
const RECOGNITION_VERSION = 3;
// Bump when AI proofreading changes, so earlier corrections are asked again.
const PROOFREAD_VERSION = 1;
const PROOFREAD_WIDTH = 1400;
const PROOFREAD_CONFIDENCE = 95;

export function createScanOcr({ ocrService, workerFactory = createOcrWorker, batchPages = OCR_LIMITS.maxPages } = {}) {
  if (!ocrService?.status || !path.isAbsolute(ocrService.assetDir || '') || !path.isAbsolute(ocrService.artifactDir || '')) throw new TypeError('Scan OCR requires the OCR service.');
  const inputDir = path.join(ocrService.artifactDir, 'scan-inputs'), indexDir = path.join(ocrService.artifactDir, 'scan-index'), proofDir = path.join(ocrService.artifactDir, 'scan-proofread');

  async function enabled() {
    try { return (await ocrService.status()).enabled === true; } catch { return false; }
  }

  async function readIndex(key) {
    try { const value = JSON.parse(await fs.readFile(path.join(indexDir, `${key}.json`), 'utf8')); return value?.version === 1 && value.pages && typeof value.pages === 'object' ? value : null; } catch { return null; }
  }

  async function evidenceFor(ref) {
    if (!/^[a-f0-9]{64}$/.test(ref || '')) return null;
    try { const bytes = await fs.readFile(path.join(ocrService.artifactDir, ref)); return sha(bytes) === ref ? JSON.parse(bytes.toString('utf8')) : null; } catch { return null; }
  }

  /**
   * bytes: the PDF; pages: 1-based page numbers without a text layer.
   * Returns Map(page -> evidence) for pages that were recognised. Pages whose
   * OCR failed are reported in `failed` and keep their empty text.
   */
  async function recognizePdf({ bytes, pages, signal, onProgress = () => {} }) {
    const id = sha(bytes), input = path.join(inputDir, `${id}.pdf`);
    await fs.mkdir(inputDir, { recursive: true }); await fs.mkdir(indexDir, { recursive: true });
    try { await fs.writeFile(input, bytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const key = `${id}-v${RECOGNITION_VERSION}`, index = (await readIndex(key)) || { version: 1, pages: {} };
    const results = new Map(), failed = [];
    for (const page of pages) { const cached = await evidenceFor(index.pages[page]); if (cached) results.set(page, cached); }
    const todo = pages.filter(page => !results.has(page));
    let done = pages.length - todo.length; onProgress({ done, total: pages.length });
    const worker = workerFactory({
      assetDir: ocrService.assetDir, artifactDir: ocrService.artifactDir,
      resolveAsset: async assetId => { if (assetId !== id) throw new Error('OCR asset mismatch'); return { path: input, hash: id, size: bytes.length }; },
      checkGuard: async () => { signal?.throwIfAborted(); if (!(await enabled())) throw Object.assign(new Error('英语 OCR 已停用，扫描页识别已停止。'), { code: 'OCR_DISABLED' }); },
    });
    for (let start = 0; start < todo.length; start += batchPages) {
      signal?.throwIfAborted();
      const batch = todo.slice(start, start + batchPages);
      const result = await worker.runMaterialTool({
        jobId: `scan-${id.slice(0, 16)}-${batch[0]}`, expectedEpoch: EPOCH, sourceRevision: id, toolId: 'document.ocr', inputAssetIds: [id],
        parameters: { pages: batch.map(page => ({ page, region: { x: 0, y: 0, width: 1, height: 1 } })), language: 'eng' },
        budget: { timeoutMs: OCR_LIMITS.timeoutMs, maxPixels: OCR_LIMITS.maxPixels, maxPages: batch.length, maxOutputBytes: OCR_LIMITS.maxOutputBytes, maxMemoryBytes: OCR_LIMITS.maxMemoryBytes },
        ...(signal ? { cancelToken: signal } : {}),
      });
      for (const page of batch) {
        const entry = result.evidence.find(item => item.page === page && item.state === 'needs_review');
        const evidence = entry && await evidenceFor(entry.ref);
        if (evidence) { results.set(page, evidence); index.pages[page] = entry.ref; } else failed.push(page);
      }
      await fs.writeFile(path.join(indexDir, `${key}.json`), JSON.stringify(index));
      done += batch.length; onProgress({ done, total: pages.length });
    }
    // Pages the user had proofread by an AI model replace the local reading.
    const proofs = await readProofIndex(id);
    let proofread = 0;
    for (const page of [...results.keys()]) { const checked = await evidenceFor(proofs.pages[page]?.ref); if (checked) { results.set(page, checked); proofread++; } }
    return { results, failed, proofread };
  }

  async function readProofIndex(id) {
    try { const value = JSON.parse(await fs.readFile(path.join(proofDir, `${id}-v${RECOGNITION_VERSION}-p${PROOFREAD_VERSION}.json`), 'utf8')); if (value?.version === 1 && value.pages && typeof value.pages === 'object') return value; } catch {}
    return { version: 1, pages: {} };
  }

  async function publish(value) {
    const bytes = Buffer.from(JSON.stringify(value)), ref = sha(bytes);
    try { await fs.writeFile(path.join(ocrService.artifactDir, ref), bytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return ref;
  }

  // The page picture OCR read (already turned upright), as a JPEG small enough
  // to send; the word boxes of the evidence refer to this picture.
  async function pageJpeg(evidence) {
    const ref = evidence?.source?.imageRef;
    if (!/^[a-f0-9]{64}$/.test(ref || '')) return null;
    let bytes;
    try { bytes = await fs.readFile(path.join(ocrService.artifactDir, ref)); } catch { return null; }
    if (sha(bytes) !== ref) return null;
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(bytes), scale = Math.min(1, PROOFREAD_WIDTH / image.width);
    const canvas = createCanvas(Math.round(image.width * scale), Math.round(image.height * scale)), context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { mime: 'image/jpeg', base64: canvas.toBuffer('image/jpeg', 82).toString('base64') };
  }

  /**
   * Sends each recognised scanned page (picture plus OCR lines) to `ask`, a
   * model call the user has approved, and keeps the corrected reading. Pages
   * already proofread are skipped, so repeating costs nothing.
   */
  async function proofreadPdf({ bytes, pages, ask, signal, onProgress = () => {}, concurrency = 3 }) {
    const id = sha(bytes), index = await readIndex(`${id}-v${RECOGNITION_VERSION}`), proofs = await readProofIndex(id);
    await fs.mkdir(proofDir, { recursive: true });
    const todo = pages.filter(page => index?.pages?.[page] && !proofs.pages[page]);
    const failed = [];
    let done = pages.length - todo.length, model = null, saving = Promise.resolve();
    onProgress({ done, total: pages.length });
    const askLines = async (image, lines) => {
      try { return await ask({ image, lines, signal }); }
      catch (error) {
        // A long page may not fit the output limit; halves keep line ids.
        if (error.code !== 'incomplete_model_output' || lines.length < 8) throw error;
        const half = Math.ceil(lines.length / 2);
        const first = await askLines(image, lines.slice(0, half)), second = await askLines(image, lines.slice(half));
        return { lines: [...first.lines, ...second.lines], model: first.model };
      }
    };
    const one = async page => {
      signal?.throwIfAborted();
      const evidence = await evidenceFor(index.pages[page]), image = evidence && await pageJpeg(evidence);
      if (!image) { failed.push({ page, message: '缺少本机识别结果或页面图片，请先重新整理一次' }); return; }
      const reply = await askLines(image, evidenceLines(evidence));
      model = reply.model || model;
      const ref = await publish(applyProofread(evidence, reply.lines, { model: reply.model || null }));
      proofs.pages[page] = { ref, model: reply.model || null };
      saving = saving.then(() => fs.writeFile(path.join(proofDir, `${id}-v${RECOGNITION_VERSION}-p${PROOFREAD_VERSION}.json`), JSON.stringify(proofs)));
      await saving;
    };
    const queue = [...todo];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const page = queue.shift();
        try { await one(page); }
        catch (error) { if (signal?.aborted || error.code === 'model_cancelled' || error.code === 'consent_required') throw error; failed.push({ page, message: String(error.message || error).slice(0, 200) }); }
        onProgress({ done: ++done, total: pages.length });
      }
    });
    await Promise.all(workers);
    return { total: pages.length, proofread: pages.filter(page => proofs.pages[page]).length, failed, model };
  }

  /** The reading used for a page (proofread if available) and its picture. */
  async function pageReading(bytes, page) {
    const id = sha(bytes), index = await readIndex(`${id}-v${RECOGNITION_VERSION}`), proofs = await readProofIndex(id);
    const evidence = (await evidenceFor(proofs.pages[page]?.ref)) || (await evidenceFor(index?.pages?.[page]));
    const ref = evidence?.source?.imageRef;
    if (!evidence || !/^[a-f0-9]{64}$/.test(ref || '')) return null;
    try { const picture = await fs.readFile(path.join(ocrService.artifactDir, ref)); return sha(picture) === ref ? { evidence, picture } : null; } catch { return null; }
  }

  async function proofreadStatus(bytes, pages) {
    const id = sha(bytes), index = await readIndex(`${id}-v${RECOGNITION_VERSION}`), proofs = await readProofIndex(id);
    return { recognised: pages.filter(page => index?.pages?.[page]).length, proofread: pages.filter(page => proofs.pages[page]).length };
  }

  return { enabled, recognizePdf, proofreadPdf, proofreadStatus, pageReading };
}

/** OCR lines as the model sees them: Tesseract line index and its words. */
export function evidenceLines(evidence) {
  const lines = new Map();
  for (const word of evidence?.words || []) { if (!lines.has(word.line)) lines.set(word.line, []); lines.get(word.line).push(word.text); }
  return [...lines].map(([id, words]) => ({ id, text: words.join(' ') }));
}

/**
 * Applies proofread line texts to OCR evidence. Where the word count holds,
 * words keep their own boxes; otherwise the line's box is shared out by word
 * length. The result is marked `proofread`, which lets layout repairs trust
 * letters that are ambiguous to OCR alone.
 */
export function applyProofread(evidence, fixedLines, { model = null } = {}) {
  const fixed = new Map(fixedLines.map(line => [line.id, String(line.text ?? '').replace(/\s+/g, ' ').trim()]));
  const byLine = new Map();
  for (const word of evidence.words || []) { if (!byLine.has(word.line)) byLine.set(word.line, []); byLine.get(word.line).push(word); }
  const words = [];
  for (const [id, own] of byLine) {
    const text = fixed.has(id) ? fixed.get(id) : own.map(word => word.text).join(' ');
    const tokens = text.split(' ').filter(Boolean);
    if (!tokens.length) continue;
    if (tokens.length === own.length) { tokens.forEach((token, i) => words.push({ ...own[i], text: token, confidence: token === own[i].text ? own[i].confidence : PROOFREAD_CONFIDENCE })); continue; }
    const x0 = Math.min(...own.map(w => w.bbox.x0)), x1 = Math.max(...own.map(w => w.bbox.x1)), y0 = Math.min(...own.map(w => w.bbox.y0)), y1 = Math.max(...own.map(w => w.bbox.y1));
    const unit = (x1 - x0) / Math.max(1, tokens.reduce((sum, token) => sum + token.length + 1, -1));
    let x = x0;
    for (const token of tokens) { words.push({ text: token, confidence: PROOFREAD_CONFIDENCE, line: id, bbox: { x0: x, y0, x1: x + token.length * unit, y1 } }); x += (token.length + 1) * unit; }
  }
  const text = [...byLine.keys()].map(id => words.filter(word => word.line === id).map(word => word.text).join(' ')).filter(Boolean).join('\n');
  return { ...evidence, words, text, proofread: true, proofreadModel: model };
}
