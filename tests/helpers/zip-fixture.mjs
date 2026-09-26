// Test-only ZIP records deliberately allow invalid metadata for rejection tests.
// No filesystem extraction; production writers use the bounded async adapter.
import { deflateRawSync } from 'node:zlib';
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export default class ZipFixture {
  constructor() { this.entries = []; }
  static async from(bytes) {
    const { readArchive, collectEntry } = await import('../../src/archive/zip-adapter.mjs');
    const zip = new ZipFixture();
    for await (const entry of readArchive({ inputRef: bytes, budget: { maxCompressedBytes: 160 * 1024 * 1024, maxEntryBytes: 80 * 1024 * 1024 } })) {
      zip.addFile(entry.name + (entry.kind === 'directory' ? '/' : ''), await collectEntry(entry));
    }
    return zip;
  }
  addFile(name, bytes) { const entry = { entryName: name, header: { attr: 0 }, getData: () => Buffer.from(entry.bytes), bytes: Buffer.from(bytes) }; this.entries.push(entry); return entry; }
  getEntry(name) { return this.entries.find(entry => entry.entryName === name); }
  getEntries() { return this.entries; }
  updateFile(name, bytes) { this.getEntry(name).bytes = Buffer.from(bytes); }
  deleteFile(name) { this.entries = this.entries.filter(entry => entry.entryName !== name); }
  toBuffer() {
    const local = [], central = []; let offset = 0;
    for (const entry of this.entries) {
      const name = Buffer.from(entry.entryName), bytes = entry.bytes, compressed = deflateRawSync(bytes);
      const flags = entry.header.flags ?? 0x800, method = entry.header.method ?? 8, crc = crc32(bytes);
      const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt16LE(flags, 6); l.writeUInt16LE(method, 8); l.writeUInt32LE(crc, 14); l.writeUInt32LE(compressed.length, 18); l.writeUInt32LE(bytes.length, 22); l.writeUInt16LE(name.length, 26);
      const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(compressed.length, 20); c.writeUInt32LE(entry.header.size ?? bytes.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(entry.header.attr >>> 0, 38); c.writeUInt32LE(offset, 42);
      local.push(l, name, compressed); central.push(c, name); offset += l.length + name.length + compressed.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
  }
}
