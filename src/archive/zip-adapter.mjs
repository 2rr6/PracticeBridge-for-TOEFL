import { ZipReader, ZipWriter, Reader, Uint8ArrayReader } from '@zip.js/zip.js';
import { open, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const DEFAULTS = Object.freeze({ maxCompressedBytes: 80 * 1024 * 1024, maxExpandedBytes: 160 * 1024 * 1024, maxEntryBytes: 25 * 1024 * 1024, maxEntries: 1200 });
export class ArchiveError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'ArchiveError'; this.code = code; this.status = 400; }
}
const fail = (code, message) => { throw new ArchiveError(code, message); };
const abort = signal => { if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError'); };
function limits(budget = {}) {
  const result = { ...DEFAULTS, ...budget };
  for (const key of Object.keys(DEFAULTS)) if (key !== 'maxEntryBytes' || typeof result[key] !== 'function') {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) fail('budget', 'ZIP 大小限制无效。');
  }
  if (result.maxRatio !== undefined && (!Number.isFinite(result.maxRatio) || result.maxRatio <= 0)) fail('budget', 'ZIP 压缩比例限制无效。');
  return result;
}
export function archiveName(value, directory = false) {
  if (typeof value !== 'string') fail('name', 'ZIP 文件名或路径无效。');
  const name = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  if (!name || name.length > 400 || /[\\\x00-\x1f\x7f?#:<>"|*]/.test(name) || name.startsWith('/')) fail('name', 'ZIP 文件名或路径无效。');
  if (name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) fail('name', `ZIP 文件名或路径无效：${value}`);
  return name;
}
const folded = name => name.normalize('NFC').toLocaleLowerCase('en-US');
function register(names, name, directory) {
  const key = folded(name);
  if (names.has(key)) fail('duplicate', `ZIP 包含重复文件名：${name}`);
  for (const [other, isDirectory] of names) if ((!isDirectory && key.startsWith(`${other}/`)) || (!directory && other.startsWith(`${key}/`))) fail('conflict', `ZIP 文件路径冲突：${name}`);
  names.set(key, directory);
}
function checkSize(value, ceiling) { if (!Number.isSafeInteger(ceiling) || ceiling < 0 || !Number.isSafeInteger(value) || value < 0 || value > ceiling) fail('size', 'ZIP 解压后超过大小限制。'); }
const entryLimit = (budget, name) => typeof budget.maxEntryBytes === 'function' ? budget.maxEntryBytes(name) : budget.maxEntryBytes;
const malformed = error => error instanceof ArchiveError || error?.name === 'AbortError' ? error : new ArchiveError('integrity', error?.message === 'Unsafe filename' ? 'ZIP 文件名或路径无效。' : 'ZIP 文件校验失败；无法打开 ZIP 或文件大小不一致。', { cause: error });

// Seekable file Reader avoids zip.js buffering an arbitrary incoming stream.
class FileReader extends Reader {
  constructor(handle, size, signal) { super(); this.handle = handle; this.size = size; this.signal = signal; }
  async readUint8Array(offset, length) {
    abort(this.signal);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) fail('integrity', 'ZIP 文件校验失败：读取范围无效。');
    // zip.js expects Uint8Array.slice copy semantics when scanning ZIP records;
    // a Node Buffer slice is a view and would retain an unrelated byte offset.
    const bytes = new Uint8Array(length); let position = 0;
    while (position < length) { abort(this.signal); const result = await this.handle.read(bytes, position, length - position, offset + position); if (!result.bytesRead) fail('integrity', 'ZIP 文件校验失败：内容被截断。'); position += result.bytesRead; }
    return bytes;
  }
}

/** Entries are valid only while this iterator is open; consume each stream once.
 * Full metadata is validated before the first entry is exposed. Content stays
 * untrusted until its stream finishes CRC and actual-byte validation.
 */
export async function* readArchive({ inputRef, budget, signal } = {}) {
  const bound = limits(budget), lifetime = new AbortController();
  // Successful output is counted below. A failed decoder can hide bytes before
  // this adapter sees them, so unknown failed work exhausts the batch instead
  // of trusting the same attacker-controlled declaration that caused failure.
  const usage = budget?.usage ?? { expandedBytes: 0, entries: 0 };
  const requireRemainingBudget = () => {
    if (usage.exhausted) fail('size', 'ZIP 解压后超过大小限制：先前失败的实际解压量未知，本批 ZIP 预算已耗尽。');
  };
  requireRemainingBudget();
  checkSize(usage.expandedBytes, bound.maxExpandedBytes); checkSize(usage.entries, bound.maxEntries);
  const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  let handle, reader, closed = false;
  const tasks = new Set();
  try {
    abort(combined); let source;
    if (typeof inputRef === 'string') {
      handle = await open(inputRef, 'r'); const stat = await handle.stat();
      if (!stat.isFile() || stat.size > bound.maxCompressedBytes) fail('compressed_size', 'ZIP 文件超过大小限制。');
      source = new FileReader(handle, stat.size, combined);
    } else if (inputRef instanceof Uint8Array) {
      if (inputRef.byteLength > bound.maxCompressedBytes) fail('compressed_size', 'ZIP 文件超过大小限制。');
      source = new Uint8ArrayReader(inputRef);
    } else fail('input', 'ZIP 输入必须是有限字节或本机文件引用。');
    reader = new ZipReader(source, { useWebWorkers: false, checkSignature: true, strictness: 'strict' });
    const entries = [], names = new Map(); let declared = 0;
    for await (const item of reader.getEntriesGenerator()) {
      abort(combined);
      if (usage.entries >= bound.maxEntries) fail('entries', 'ZIP 内文件数量过多。');
      usage.entries++;
      const name = archiveName(item.filename, item.directory);
      register(names, name, item.directory);
      const attributes = item.externalFileAttributes >>> 0, mode = (attributes >>> 16) & 0xf000;
      if (mode === 0xa000) fail('symlink', 'ZIP 不允许符号链接。');
      if (mode && mode !== 0x8000 && mode !== 0x4000) fail('attributes', 'ZIP 不支持特殊文件属性。');
      if (item.encrypted) fail('encrypted', `ZIP 内文件已加密，请先解密后再导入：${name}`);
      if (![0, 8].includes(item.compressionMethod)) fail('method', 'ZIP 压缩方法不支持。');
      const flags = item.rawBitFlag ?? 0;
      if (flags & ~0x80e) fail('flags', 'ZIP 包含不支持的 flag 标志。');
      checkSize(item.uncompressedSize, entryLimit(bound, name));
      checkSize(item.compressedSize, bound.maxCompressedBytes);
      declared += item.uncompressedSize; checkSize(usage.expandedBytes + declared, bound.maxExpandedBytes);
      if (item.directory && item.uncompressedSize !== 0) fail('size', 'ZIP 目录文件大小不一致。');
      if (bound.maxRatio && item.uncompressedSize > 1024 * 1024 && item.uncompressedSize > Math.max(item.compressedSize, 1) * bound.maxRatio) fail('ratio', 'ZIP 解压后超过大小限制：压缩比例过高。');
      entries.push({ item, name, attributes });
    }
    for (const { item, name, attributes } of entries) {
      abort(combined); let opened = false;
      yield { name, declaredBytes: item.uncompressedSize, compressedBytes: item.compressedSize, attributes, kind: item.directory ? 'directory' : 'file',
        openStream() {
          if (closed || opened) fail('lifetime', 'ZIP 条目流已关闭或已读取。');
          requireRemainingBudget();
          if (tasks.size) fail('concurrency', 'ZIP 条目必须依次读取并关闭。');
          opened = true;
          const local = new AbortController(), streamSignal = AbortSignal.any([combined, local.signal]);
          let count = 0, transformController;
          const stream = new TransformStream({ start(controller) { transformController = controller; }, transform(chunk, controller) {
            abort(streamSignal); count += chunk.byteLength; usage.expandedBytes += chunk.byteLength;
            checkSize(count, Math.min(entryLimit(bound, name), item.uncompressedSize)); checkSize(usage.expandedBytes, bound.maxExpandedBytes);
            controller.enqueue(chunk);
          } });
          const job = item.getData(stream.writable, { signal: streamSignal, checkSignature: true, strictness: 'strict', useWebWorkers: false }).then(() => {
            if (count !== item.uncompressedSize) fail('integrity', `ZIP 文件大小不一致：${name}`);
          });
          tasks.add(job); job.catch(error => {
            // zip.js may reject a size/CRC mismatch before forwarding decoded
            // bytes. Neither the declared size nor error.outputSize establishes
            // the real failed cost. Keep all remaining budget as unknown usage.
            // The flag also refuses subsequent members declaring zero bytes.
            usage.expandedBytes = Math.max(usage.expandedBytes, bound.maxExpandedBytes);
            usage.exhausted = true;
            transformController.error(error);
          });
          return (async function* () {
            try { for await (const chunk of stream.readable) yield chunk; await job; }
            catch (error) { if (streamSignal.aborted) throw streamSignal.reason; throw malformed(error); }
            finally { local.abort(); await job.catch(() => {}); tasks.delete(job); }
          })();
        },
      };
    }
  } catch (error) { if (combined.aborted) throw combined.reason; throw malformed(error); }
  finally { closed = true; lifetime.abort(); await Promise.allSettled(tasks); await reader?.close(); await handle?.close(); }
}
export async function collectEntry(entry) {
  const chunks = []; for await (const chunk of entry.openStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Write to bounded memory or a sibling temporary file, then publish without
 * overwriting an existing destination. Cancellation/failure removes only that
 * writer's temporary file. Entry names never select filesystem destinations.
 */
export async function writeArchive({ entries, outputRef, budget, signal } = {}) {
  const bound = limits(budget), names = new Map(), inventory = [], chunks = [], hash = createHash('sha256');
  let handle, temp, writer, sink, ownsTemp = false, finished = false, bytes = 0, expanded = 0;
  try {
    abort(signal);
    if (outputRef !== undefined) {
      if (typeof outputRef !== 'string') throw new TypeError('outputRef must be a local file path.');
      temp = `${outputRef}.${randomUUID()}.tmp`; handle = await open(temp, 'wx'); ownsTemp = true;
    }
    sink = new WritableStream({ async write(chunk) {
      abort(signal); bytes += chunk.byteLength;
      if (bytes > bound.maxCompressedBytes) fail('compressed_size', 'ZIP 文件超过大小限制。');
      hash.update(chunk);
      if (handle) { let at = 0; while (at < chunk.byteLength) at += (await handle.write(chunk, at, chunk.byteLength - at)).bytesWritten; }
      else chunks.push(Buffer.from(chunk));
    } });
    writer = new ZipWriter(sink, { useWebWorkers: false, bufferedWrite: false, zip64: false });
    for await (const entry of entries) {
      abort(signal);
      if (inventory.length >= bound.maxEntries) fail('entries', 'ZIP 内文件数量过多。');
      const directory = entry.kind === 'directory', name = archiveName(entry.name, directory);
      register(names, name, directory);
      let count = 0; const digest = createHash('sha256');
      const source = entry.bytes instanceof Uint8Array ? (async function* () { yield entry.bytes; })() : entry.openStream?.();
      if (!source) throw new TypeError('Archive entry requires bytes or openStream.');
      const iterator = source[Symbol.asyncIterator]();
      const readable = new ReadableStream({ async pull(controller) {
        try {
          abort(signal); const next = await iterator.next();
          if (next.done) { controller.close(); return; }
          const chunk = next.value;
          if (!(chunk instanceof Uint8Array)) throw new TypeError('Archive stream requires byte chunks.');
          count += chunk.byteLength; expanded += chunk.byteLength; checkSize(count, entryLimit(bound, name)); checkSize(expanded, bound.maxExpandedBytes);
          digest.update(chunk); controller.enqueue(chunk);
        } catch (error) { await iterator.return?.(); controller.error(error); }
      }, async cancel() { await iterator.return?.(); } });
      await writer.add(name + (directory ? '/' : ''), readable, { signal, directory, level: 6, extendedTimestamp: false, lastModDate: new Date(2000, 0, 1) });
      inventory.push({ name, bytes: count, hash: digest.digest('hex') });
    }
    await writer.close(); finished = true;
    abort(signal);
    if (handle) { await handle.sync(); await handle.close(); handle = null; abort(signal); await link(temp, outputRef); }
    return { hash: hash.digest('hex'), bytes, inventory, ...(outputRef === undefined ? { buffer: Buffer.concat(chunks) } : {}) };
  } finally {
    if (!finished) await sink?.abort().catch(() => {});
    await handle?.close();
    if (ownsTemp) await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
