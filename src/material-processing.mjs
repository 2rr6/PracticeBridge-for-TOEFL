import path from 'node:path';
import { InputError, LIMITS, inputFileLimit, decodeUpload, safeRelativeName, prepareImportFiles, createArchiveSession, identifyMedia, validatePackage } from './package.mjs';
import { extractMaterialSources, buildDraftFromSources, applyScannedPages, markScannedQuestions } from './importer.mjs';
import { ocrEvidenceToChunk } from './ocr-layout.mjs';
import {materialSourceRevision} from './material-candidates.mjs';

const PROCESSORS = new Set(['native', 'exam-document', 'worksheet', 'ai']);
const SECTIONS = new Set(['reading', 'listening', 'speaking', 'writing']);
const TEXT_LIMIT = 500000;
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md', '.markdown']);
const BINARY_EXTENSIONS = new Set(['.zip', '.exe', '.dll', '.com', '.msi', '.bin', '.wasm', '.7z', '.rar', '.gz']);
const MIME = Object.freeze({
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json', '.zip': 'application/zip',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
});
const extension = name => path.posix.extname(name).toLowerCase();
const mimeFor = (name, bytes) => identifyMedia(name, bytes)?.mime || MIME[extension(name)] || 'application/octet-stream';
const errorIssue = (error, at = 'materials') => ({ severity: 'error', message: String(error.message || '材料内容暂时无法读取。').slice(0, 2000), path: at });
const warningIssue = (message, at = 'materials') => ({ severity: 'warning', message, path: at });
const uniqueIssues = issues => [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()];
const hasQuestions = pack => Boolean(Array.isArray(pack?.groups) && pack.groups.some(group => Array.isArray(group?.questions) && group.questions.some(question => typeof question?.prompt === 'string' && question.prompt.trim())));

function modelSnapshot(models) {
  const settings = models?.publicSettings?.() || {};
  const binding = models?.binding?.() || {
    provider: settings.provider || '', baseUrl: settings.baseUrl || '', model: settings.model || '',
    timeoutSeconds: Number.isInteger(settings.timeoutSeconds) ? settings.timeoutSeconds : null,
    maxOutputTokens: Number.isInteger(settings.maxOutputTokens) ? settings.maxOutputTokens : null,
  };
  return { binding, signature: JSON.stringify({ ...binding, structuredOutput: settings.structuredOutputMode || settings.structuredOutput || 'auto' }), capabilities: settings.capabilities || {} };
}

function assertSameModel(models, snapshot) {
  if (modelSnapshot(models).signature !== snapshot.signature) throw new InputError('模型连接或设置已改变，本次结果未采用。原文件已保留，请使用当前连接重新评估。', 409);
}

function sameStoredModel(stored, current) {
  return stored && Object.keys(current).every(key => (stored[key] ?? null) === (current[key] ?? null));
}

function readableText(bytes) {
  let text;
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    text = new TextDecoder(encoding, { fatal: true }).decode(encoding === 'utf-8' ? bytes : bytes.subarray(2));
  } catch { return null; }
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(text)) return null;
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Fall back only on content recognition, preserving every ZIP safety check. */
async function prepareReceivedFiles(uploads, { signal } = {}) {
  if (!Array.isArray(uploads) || uploads.length > 200) throw new InputError('待处理原文件数量无效。');
  const decoded = uploads.map(file => file?.data === '' ? { name: safeRelativeName(file.name), bytes: Buffer.alloc(0) } : decodeUpload(file, { maxBytes: inputFileLimit(file?.name) }));
  if (decoded.reduce((sum, file) => sum + file.bytes.length, 0) > LIMITS.uploadBytes) throw new InputError('本次原文件总大小超过限制。');
  const loose = decoded.filter(file => extension(file.name) !== '.zip');
  const archives = createArchiveSession({ looseBytes: loose.reduce((sum, file) => sum + file.bytes.length, 0), looseEntries: loose.length, signal });
  try { return { ...(await prepareImportFiles(uploads, { signal, archiveSession: archives })), issues: [], processingError: null }; }
  catch (error) {
    if (signal?.aborted) throw error;
    const files = new Map();
    const seen = new Set();
    const originalNames = new Set();
    const folded = name => name.normalize('NFC').toLocaleLowerCase('en-US');
    const addFile = (name, bytes) => {
      const safe = safeRelativeName(name);
      if (seen.has(folded(safe))) throw new InputError(`重复文件名：${safe}；请明确文件对应关系后重新接收材料。`);
      seen.add(folded(safe));
      files.set(safe, bytes);
    };
    for (const file of decoded) {
      if (originalNames.has(folded(file.name))) throw new InputError(`重复文件名：${file.name}；原文件已保留。`);
      originalNames.add(folded(file.name));
    }
    for (const file of loose) addFile(file.name, file.bytes);
    const issues = [];
    for (const file of decoded.filter(file => extension(file.name) === '.zip')) {
      try {
        const contents = await archives.read(file);
        // Commit members as a unit only after all metadata, streams and cross-file
        // names pass. A failed attachment cannot poison independent originals.
        const pending = new Set();
        for (const name of contents.files.keys()) {
          const key = folded(name);
          if (seen.has(key) || pending.has(key)) throw new InputError(`重复文件名：${name}`);
          pending.add(key);
        }
        for (const [name, bytes] of contents.files) addFile(name, bytes);
      } catch (error) {
        if (signal?.aborted) throw error;
        issues.push({ ...errorIssue(error, file.name), code: 'archive_processing_failed', state: 'failed' });
      }
    }
    return { native: null, files, issues, processingError: issues.length && !files.size ? new InputError(issues[0].message) : null };
  }
}

function localAnalysis(inspected) {
  const processor = inspected.availableProcessors.find(value => value !== 'ai');
  const canCreateDraft = Boolean(processor && !inspected.processingError && hasQuestions(inspected.localDraft?.pack));
  const errors = inspected.issues.filter(issue => issue.severity === 'error').map(issue => issue.message);
  const warnings = inspected.issues.filter(issue => issue.severity !== 'error').map(issue => issue.message);
  const detectedSections = canCreateDraft ? [...new Set(inspected.localDraft.pack.groups.map(group => group.section).filter(value => SECTIONS.has(value)))] : [];
  return {
    status: canCreateDraft ? errors.length ? 'partially_processable' : 'processable' : 'needs_information',
    summary: canCreateDraft ? '本机已识别现有题目结构，可以生成待核对草稿。' : '原文件已接收；本机尚未识别出可转换的题目结构，可选择 AI 评估或补充可读取文字。',
    detectedSections, missingInformation: canCreateDraft ? [] : errors.length ? [...new Set(errors)] : ['可识别的题目结构或可提取的题目文字。'],
    recommendedProcessor: processor || 'ai', warnings: [...new Set([...warnings, ...errors])], canCreateDraft, provider: 'none', model: '本机识别',
  };
}

function checkedAnalysis(result, inspected, mode) {
  const stringList = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  if (!result || !['processable', 'partially_processable', 'needs_information', 'unsupported'].includes(result.status) ||
      typeof result.summary !== 'string' || typeof result.canCreateDraft !== 'boolean' || !stringList(result.detectedSections) ||
      !stringList(result.missingInformation) || !stringList(result.warnings) || !PROCESSORS.has(result.recommendedProcessor) ||
      !inspected.availableProcessors.includes(result.recommendedProcessor)) throw new InputError('材料评估没有返回可核对的处理方案；原文件已保留。', 502);
  const analysis = {
    status: result.status, summary: result.summary, detectedSections: result.detectedSections,
    missingInformation: result.missingInformation, recommendedProcessor: result.recommendedProcessor,
    warnings: result.warnings, canCreateDraft: result.canCreateDraft, provider: result.provider || 'none', model: result.model || '',
    mode, availableProcessors: inspected.availableProcessors, sourceFiles: inspected.sources.length,
    mediaFiles: inspected.files.filter(file => /^(audio|image|video)\//.test(file.mime)).length,
  };
  if (inspected.processingError || !inspected.sources.some(source => source.text.trim())) {
    analysis.canCreateDraft = false;
    if (analysis.status !== 'unsupported') analysis.status = 'needs_information';
    analysis.detectedSections = [];
    analysis.summary = inspected.processingError ? '原文件已保留，但文件检查尚未通过，当前不能生成草稿。' : '原文件已接收；目前只有文件清单，没有可用于转换的题目文字。';
    analysis.missingInformation = [...new Set([...analysis.missingInformation, ...(inspected.processingError ? [inspected.processingError.message] : ['可提取的题目文字、音频转写或图片文字识别结果。'])])];
  }
  analysis.warnings = [...new Set([...analysis.warnings, '评估只使用提取的文字和文件清单；没有听取音频、查看图片或确认 PDF 的视觉排版。'])];
  return analysis;
}

/** Receiving is handled by the inbox. Nothing here can erase the originals. */
export function createMaterialProcessing({ inbox, models, registerDraft, candidateRepository, getWorkspaceEpoch,probeMedia,scanOcr=null }) {
  if (!inbox?.get || !inbox?.loadFiles || !inbox?.update || typeof registerDraft !== 'function') throw new TypeError('createMaterialProcessing requires an inbox and registerDraft.');
  const active = new Map();
  // In-memory only: which scanned pages are being read for a material.
  const progress = new Map();
  // In-memory only: scanned pages found by the last local reading of a material.
  const scans = new Map();
  const mediaProbes=new Set();let mediaTerminationFailure=null;
  let stopped = false,paused=false;
  const interrupted = () => new InputError('处理已中断；原文件已保留，可以稍后重新评估或整理。', 409);
  const checkpoint = operation => {
    if (stopped || paused || operation?.cancelled || (operation && active.get(operation.id) !== operation)) throw interrupted();
  };
  const inspectMedia=(asset,operation,context)=>{
    const pending=Promise.resolve().then(()=>{checkpoint(operation);return probeMedia(asset,{...context,signal:operation.controller.signal});}).catch(error=>{if(error.code==='worker_termination_unconfirmed')mediaTerminationFailure=error;throw error;});
    mediaProbes.add(pending);void pending.finally(()=>mediaProbes.delete(pending)).catch(()=>{});return pending;
  };

  async function inspect(id, operation, {signal=operation?.controller.signal}={}) {
    const check=()=>{checkpoint(operation);signal?.throwIfAborted();};check();
    const material = inbox.get(id);
    const uploads = await inbox.loadFiles(id);
    check();
    let prepared;
    try { prepared = await prepareReceivedFiles(uploads, { signal }); }
    catch (error) {
      // Do not salvage members from an unsafe archive. Pasted text remains
      // available for an honest assessment, but cannot enable conversion.
      return { material, prepared: null, files: material.files.map(file => ({ name: file.name, mime: file.mime, size: file.size })), sources: material.text?.trim() ? [{ name: '粘贴文字', text: material.text }] : [], issues: [errorIssue(error)], availableProcessors: ['ai'], processingError: error };
    }
    const files = [...prepared.files].map(([name, bytes]) => ({ name, mime: mimeFor(name, bytes), size: bytes.length }));
    const extracted = { chunks: [], media: [], sources: [], issues: [...prepared.issues], files: [...prepared.files].map(([name, bytes]) => ({ name, data: bytes.toString('base64') })) };
    let textSize = 0;
    const scanned = [];
    scans.delete(id);
    const addExtraction = part => {
      const added = part.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
      if (textSize + added > TEXT_LIMIT) {
        extracted.issues.push(warningIssue('提取文字已达到本次处理容量；部分来源尚未加入草稿，需要分批处理。', part.sources[0]?.name || 'sources'));
        return;
      }
      textSize += added;
      extracted.chunks.push(...part.chunks);
      extracted.media.push(...part.media);
      extracted.sources.push(...part.sources);
      extracted.issues.push(...part.issues);
      for(const file of part.derivedFiles||[]){
        const {name,bytes}=decodeUpload(file,{maxBytes:LIMITS.fileBytes}),identified=identifyMedia(name,bytes);
        if(identified?.kind!=='image')throw new InputError('PDF 派生题面图像格式无效。');
        const previous=prepared.files.get(name);
        if(previous){if(!previous.equals(bytes))throw new InputError(`派生图片与已有文件重名，未覆盖原文件：${name}`);continue;}
        if(prepared.files.size>=LIMITS.zipEntries||[...prepared.files.values()].reduce((sum,value)=>sum+value.length,bytes.length)>LIMITS.expandedBytes)throw new InputError('PDF 派生图片超过本次处理容量。');
        prepared.files.set(name,bytes);files.push({name,mime:identified.mime,size:bytes.length});extracted.files.push({name,data:file.data});
      }
    };
    if (material.text?.trim()) addExtraction(await extractMaterialSources({ text: material.text, title: material.title, signal }));
    check();
    for (const [name, bytes] of [...prepared.files]) {
      check();
      const mime = mimeFor(name, bytes);
      if (/^(audio|image|video)\//.test(mime)) { extracted.media.push({ name, mime }); continue; }
      try {
        if (DOCUMENT_EXTENSIONS.has(extension(name)) && bytes.length) {
          const part = await extractMaterialSources({ files: [{ name, data: bytes.toString('base64') }], title: material.title, signal });
          if (extension(name) === '.pdf') scanned.push(...(await readScannedPages(id, name, bytes, part, signal)).map(page => [name, page]));
          addExtraction(part);
        } else {
          const text = BINARY_EXTENSIONS.has(extension(name)) ? null : readableText(bytes);
          if (text === null) extracted.issues.push(warningIssue(`${name} 暂时只能保存为原文件；当前没有可读取的文字。`, name));
          else addExtraction({ chunks: [{ name, text, kind: 'text' }], sources: [{ name, text }], media: [], issues: [] });
        }
      } catch (error) { extracted.issues.push(errorIssue(error, name)); }
      check();
    }
    if (!extracted.sources.some(source => source.text.trim())) extracted.issues.push(warningIssue('尚未得到题目文字；音频和图片不会仅凭文件名转换成题目。', 'sources'));
    let localDraft;
    let processor;
    if ([1,2].includes(prepared.native?.pack?.schemaVersion) && hasQuestions(prepared.native.pack)) {
      const checked = validatePackage(prepared.native.pack, prepared.files);
      localDraft = { ...checked, rawPack:prepared.native.pack, issues: uniqueIssues([...extracted.issues, ...checked.issues]), sources: extracted.sources, method: prepared.native.method };
      processor = 'native';
    } else {
      localDraft = await buildDraftFromSources(extracted, { title: material.title, useAI: false }, models);
      for (const name of new Set(scanned.map(([file]) => file))) markScannedQuestions(localDraft.pack, name, scanned.filter(([file]) => file === name).map(([, page]) => page));
      processor = hasQuestions(localDraft.pack) ? localDraft.method === 'exam-document' ? 'exam-document' : ['template', 'worksheet'].includes(localDraft.method) ? 'worksheet' : null : null;
    }
    check();
    return { material, prepared, files, sources: extracted.sources, issues: uniqueIssues(localDraft.issues), extracted, localDraft, availableProcessors: [...(processor ? [processor] : []), 'ai'], processingError: prepared.processingError };
  }

  async function readScannedPages(id, name, bytes, part, signal) {
    const blank = part.chunks.filter(chunk => chunk.name === name && chunk.kind === 'pdf' && !chunk.text.trim()).map(chunk => chunk.page);
    if (!blank.length) return [];
    if (!scanOcr || !(await scanOcr.enabled())) {
      part.issues.push(warningIssue(`${name} 有 ${blank.length} 页没有文字层，可能是扫描件。在「模型与数据」中安装并启用英语 OCR 后重新整理，可以自动识别这些页。`, name));
      return [];
    }
    progress.set(id, { stage: 'ocr', file: name, done: 0, total: blank.length });
    try {
      const { results, failed, proofread = 0 } = await scanOcr.recognizePdf({ bytes, pages: blank, signal, onProgress: value => progress.set(id, { stage: 'ocr', file: name, ...value }) });
      const summary = scans.get(id) || { pages: 0, proofread: 0 };
      scans.set(id, { pages: summary.pages + results.size, proofread: summary.proofread + proofread });
      if (failed.length) part.issues.push(warningIssue(`${name} 第 ${failed.join('、')} 页扫描识别没有得到文字，原件仍保留。`, name));
      return applyScannedPages(part, name, results);
    } catch (error) {
      if (signal?.aborted) throw error;
      part.issues.push(warningIssue(`${name} 的扫描页识别没有完成：${String(error.message || error).slice(0, 200)}。原件仍保留，可以稍后重新整理。`, name));
      return [];
    } finally { progress.delete(id); }
  }

  function guarded(id, status, work, startPatch = {}) {
    if (stopped||paused) return Promise.reject(interrupted());
    if (active.has(id)) return Promise.reject(new InputError('这批材料正在处理中，请等待当前步骤完成或先中断。', 409));
    let rejectCancellation;
    const cancellation = new Promise((_resolve, reject) => { rejectCancellation = reject; });
    const operation = { id, cancelled: false, controller: new AbortController(), rejectCancellation, done: null };
    active.set(id, operation);
    const pending = (async () => {
      try {
        if (status) await inbox.update(id, { ...startPatch, status, error: null });
        checkpoint(operation);
        const result = await work(operation);
        checkpoint(operation);
        return result;
      } catch (error) {
        if (operation.cancelled || stopped || active.get(id) !== operation) throw interrupted();
        if (status) await inbox.update(id, { status: 'failed', error: String(error.message || '处理未完成；原文件已保留。').slice(0, 20000) }).catch(() => {});
        throw error;
      }
    })();
    operation.done = Promise.race([pending, cancellation]).finally(() => {
      if (active.get(id) === operation) active.delete(id);
    });
    // A model adapter may not support aborting an in-flight request. Its late
    // result stays detached and is checked before every possible state write.
    void pending.catch(() => {});
    return operation.done;
  }

  async function assess(id, { consent = false, useAI = true,expectedBinding } = {}) {
    if (typeof useAI !== 'boolean') throw new InputError('请选择 AI 评估或本机识别。');
    if (useAI && consent !== true) throw new InputError('材料已保存在本机。允许本次 AI 评估后才能发送文字。');
    if(useAI)models.assertBinding?.(expectedBinding);
    const snapshot = useAI ? modelSnapshot(models) : null;
    if (useAI && (!snapshot.capabilities.assessMaterials || typeof models?.assessMaterials !== 'function')) throw new InputError('原文件已保存，请先配置可用模型，再让 AI 评估。');
    return guarded(id, 'analyzing', async operation => {
      const inspected = await inspect(id, operation);
      checkpoint(operation);
      let result;
      if (useAI) {
        assertSameModel(models, snapshot);
        result = await models.assessMaterials({ sources: inspected.sources, files: inspected.files, extractionIssues: inspected.issues, availableProcessors: inspected.availableProcessors, consent,expectedBinding:snapshot.binding,signal:operation.controller.signal });
        checkpoint(operation);
        assertSameModel(models, snapshot);
      } else result = localAnalysis(inspected);
      const analysis = checkedAnalysis(result, inspected, useAI ? 'ai' : 'local');
      const status = analysis.canCreateDraft ? 'assessed' : analysis.status === 'unsupported' ? 'unsupported' : 'needs_information';
      await inbox.update(id, { status, analysis, issues: inspected.issues, modelBinding: snapshot?.binding || null, processor: analysis.recommendedProcessor });
      checkpoint(operation);
      return { material: inbox.get(id) };
    }, { analysis: null, modelBinding: null, processor: null });
  }

  async function convert(id, { consent = false, useAI = true,expectedBinding } = {}) {
    const expectedEpoch=getWorkspaceEpoch?.();
    if (typeof useAI !== 'boolean') throw new InputError('请选择 AI 整理或本机转换。');
    if (active.has(id)) throw new InputError('这批材料正在处理中，请等待当前步骤完成或先中断。', 409);
    const material = inbox.get(id);
    if (!['assessed', 'draft_ready', 'failed', 'interrupted'].includes(material.status) || !material.analysis?.canCreateDraft) throw new InputError('请先评估这批材料；原文件仍保存在材料区。');
    if ((material.analysis.mode || 'ai') !== (useAI ? 'ai' : 'local')) throw new InputError('本次处理方式与评估方式不同，请先用所选方式重新评估。');
    if (useAI && consent !== true) throw new InputError('请确认本次 AI 整理的发送范围。');
    if(useAI)models.assertBinding?.(expectedBinding);
    const snapshot = useAI ? modelSnapshot(models) : null;
    if (useAI && !sameStoredModel(material.modelBinding, snapshot.binding)) throw new InputError('模型连接或设置已改变，请先使用当前连接重新评估。原文件已保留。', 409);
    return guarded(id, 'converting', async operation => {
      const inspected = await inspect(id, operation);
      checkpoint(operation);
      if (inspected.processingError) throw inspected.processingError;
      if (useAI) assertSameModel(models, snapshot);
      const selected = material.analysis.recommendedProcessor;
      if (!inspected.availableProcessors.includes(selected) || (!useAI && selected === 'ai')) throw new InputError('这条处理方案已不适用于当前材料，请重新评估。');
      let result;
      if (selected === 'native' || selected === 'exam-document' || selected === 'worksheet') result = inspected.localDraft;
      else {
        if (!snapshot.capabilities.structure || typeof models?.structure !== 'function') throw new InputError('当前模型不能整理文字；原文件已保留。');
        result = await buildDraftFromSources(inspected.extracted, { title: material.title, useAI: true, consent,expectedBinding:snapshot.binding,signal:operation.controller.signal }, models);
        checkpoint(operation);
        assertSameModel(models, snapshot);
      }
      if (!result?.pack || !hasQuestions(result.pack)) throw new InputError('整理尚未产生可核对的题目草稿；原文件已保留。');
      const checked = validatePackage(result.pack, inspected.prepared.files);
      const sourceIssues = uniqueIssues(result.issues || []);
      const draft = { pack: checked.pack, issues: uniqueIssues([...sourceIssues, ...checked.issues]), sources: result.sources || inspected.sources, media: checked.media, method: `${useAI ? 'ai-plan' : 'local'}/${selected}` };
      checkpoint(operation);
      if (useAI) assertSameModel(models, snapshot);
      if(candidateRepository){
        const candidates=await candidateRepository.ingestPack({materialId:id,pack:result.rawPack||result.pack,files:inspected.prepared.files,method:result.method||selected,documentLayout:result.documentLayout,fieldEvidence:result.fieldEvidence||[],issues:result.issues||[],expectedEpoch,signal:operation.controller.signal,assertCurrent:()=>checkpoint(operation),probeMedia:typeof probeMedia==='function'?asset=>inspectMedia(asset,operation,{materialId:id,expectedEpoch,sourceRevision:materialSourceRevision(inspected.material)}):undefined});
        checkpoint(operation);
        return {candidateReview:true,materialId:id,material:inbox.get(id)};
      }
      const saved = await inbox.update(id, { status: 'draft_ready', draft, processor: selected, error: null });
      checkpoint(operation);
      const registered = await registerDraft({ materialId: id, materialRevision: saved.updatedAt, files: inspected.prepared.files, sources: draft.sources, method: draft.method, sourceIssues, pack: draft.pack });
      checkpoint(operation);
      return { ...registered, materialId: id, material: inbox.get(id) };
    });
  }

  async function openDraft(id) {
    return guarded(id, null, async operation => {
      const material = inbox.get(id);
      if(candidateRepository&&material.candidateSummary)return {candidateReview:true,materialId:id,material};
      if (!material.draft?.pack) throw new InputError('这批材料尚未生成草稿。', 404);
      // Recreate deterministic PDF images from unchanged originals. Keep the
      // saved, potentially edited draft; re-extraction supplies media only.
      const inspected=await inspect(id,operation);
      if(inspected.processingError)throw inspected.processingError;
      const prepared=inspected.prepared;
      const registered = await registerDraft({ materialId: id, materialRevision: material.updatedAt, files: prepared.files, sources: material.draft.sources || [], method: material.draft.method || 'material-draft', sourceIssues: material.draft.issues || [], pack: material.draft.pack });
      checkpoint(operation);
      return { ...registered, materialId: id };
    });
  }

  async function cancel(id) {
    const operation = active.get(id);
    if (!operation) return { material: inbox.get(id) };
    operation.cancelled = true;
    operation.controller.abort();
    operation.rejectCancellation(interrupted());
    await inbox.update(id, { status: 'interrupted', error: '处理已中断；原文件已保留，可以稍后继续。' });
    return { material: inbox.get(id) };
  }

  async function awaitIdle() {
    while(active.size||mediaProbes.size)await Promise.allSettled([...active.values()].map(operation=>operation.done).concat([...mediaProbes]));
    if(mediaTerminationFailure)throw mediaTerminationFailure;
  }

  async function pause() {
    paused=true;
    await Promise.allSettled([...active.keys()].map(id => cancel(id)));
    await awaitIdle();
  }
  function resume(){if(stopped)throw interrupted();paused=false;}
  async function stop(){stopped=true;await pause();}

  /**
   * Sends the scanned pages of a material, as pictures with their local OCR
   * lines, to the connected model for proofreading. Needs the user's consent
   * for this material; the next local processing uses the corrected reading.
   */
  async function proofreadScans(id, { consent = false, expectedBinding } = {}) {
    if (consent !== true) throw new InputError('请先确认把这批材料的扫描页图片发送给当前 AI 服务。');
    if (!scanOcr?.proofreadPdf || !(await scanOcr.enabled())) throw new InputError('请先在「模型与数据」中安装并启用英语 OCR。');
    models.assertBinding?.(expectedBinding);
    const snapshot = modelSnapshot(models);
    if (!snapshot.capabilities.proofreadScans || typeof models?.proofreadScanPage !== 'function') throw new InputError('当前 AI 连接不能看图；请在「模型与数据」中连接支持图片输入的 API 服务。');
    return guarded(id, null, async operation => {
      const signal = operation.controller.signal;
      const prepared = await prepareReceivedFiles(await inbox.loadFiles(id), { signal });
      const summary = { total: 0, proofread: 0, failed: [], model: null };
      try {
        for (const [name, bytes] of [...prepared.files]) {
          checkpoint(operation);
          if (extension(name) !== '.pdf') continue;
          const part = await extractMaterialSources({ files: [{ name, data: bytes.toString('base64') }], title: '', signal });
          const pages = part.chunks.filter(chunk => chunk.name === name && chunk.kind === 'pdf' && !chunk.text.trim()).map(chunk => chunk.page);
          if (!pages.length) continue;
          progress.set(id, { stage: 'ocr', file: name, done: 0, total: pages.length });
          await scanOcr.recognizePdf({ bytes, pages, signal, onProgress: value => progress.set(id, { stage: 'ocr', file: name, ...value }) });
          const result = await scanOcr.proofreadPdf({
            bytes, pages, signal, onProgress: value => progress.set(id, { stage: 'proofread', file: name, ...value }),
            ask: async ({ image, lines, signal: pageSignal }) => { assertSameModel(models, snapshot); return models.proofreadScanPage({ image, lines, consent: true, expectedBinding: snapshot.binding, signal: pageSignal }); },
          });
          summary.total += result.total; summary.proofread += result.proofread; summary.model = result.model || summary.model;
          summary.failed.push(...result.failed.map(item => ({ file: name, ...item })));
        }
      } finally { progress.delete(id); }
      if (!summary.total) throw new InputError('这批材料没有需要校对的扫描页。');
      const current = scans.get(id);
      if (current) scans.set(id, { ...current, proofread: summary.proofread });
      return { ...summary, material: inbox.get(id) };
    });
  }

  /**
   * A band of the original scanned page around the given text lines, as the
   * page picture OCR read, so a scanned question can be checked at a glance.
   */
  async function scanCrop(id, { file, page, line, lines = 1 } = {}) {
    if (typeof file !== 'string' || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(lines) || lines < 1 || lines > 30) throw new InputError('原件位置无效。');
    if (!scanOcr?.pageReading) throw new InputError('这批材料没有本机扫描识别结果。', 404);
    const prepared = await prepareReceivedFiles(await inbox.loadFiles(id));
    const bytes = prepared.files.get(file);
    if (!bytes || extension(file) !== '.pdf') throw new InputError('找不到这份原件。', 404);
    const reading = await scanOcr.pageReading(bytes, page);
    if (!reading) throw new InputError('这一页没有保存的扫描图片，请重新整理一次。', 404);
    const boxes = ocrEvidenceToChunk(reading.evidence, { name: file, page }).ocr.lineBoxes.slice(line - 1, line - 1 + lines);
    if (!boxes.length) throw new InputError('原件中找不到这一行。', 404);
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(reading.picture);
    const height = Math.max(...boxes.map(box => box.y1 - box.y0)), top = Math.max(0, Math.min(...boxes.map(box => box.y0)) - height * 1.5), bottom = Math.min(image.height, Math.max(...boxes.map(box => box.y1)) + height * 1.5);
    const left = Math.max(0, Math.min(...boxes.map(box => box.x0)) - height * 2), right = Math.min(image.width, Math.max(...boxes.map(box => box.x1)) + height * 2);
    const canvas = createCanvas(Math.max(1, Math.round(right - left)), Math.max(1, Math.round(bottom - top)));
    const context = canvas.getContext('2d');
    context.drawImage(image, left, top, right - left, bottom - top, 0, 0, canvas.width, canvas.height);
    // A light band marks the line the question or answer came from.
    context.fillStyle = 'rgba(255, 214, 10, 0.22)';
    const first = boxes[0];
    context.fillRect(0, first.y0 - top - height * 0.25, canvas.width, first.y1 - first.y0 + height * 0.5);
    return canvas.toBuffer('image/jpeg', 85);
  }

  return { assess, convert, openDraft, inspect, cancel, pause,resume,stop,awaitIdle, proofreadScans, scanCrop, busy: () => active.size > 0, progress: id => progress.get(id) || null, scans: id => scans.get(id) || null };
}
