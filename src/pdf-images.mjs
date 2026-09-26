import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function chunk(type, data) {
  const name = Buffer.from(type, 'ascii'), bytes = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  const header = Buffer.alloc(4), trailer = Buffer.alloc(4);
  header.writeUInt32BE(data.length); trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, bytes, trailer]);
}

/** Encode the decoded PDF image pixels unchanged; no resizing or new artwork. */
export function pdfImageToPng(image) {
  const { width, height, kind, data } = image || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 9000000 || !ArrayBuffer.isView(data)) return null;
  const stride = kind === 1 ? Math.ceil(width / 8) : kind === 2 ? width * 3 : kind === 3 ? width * 4 : 0;
  if (!stride || data.byteLength !== stride * height) return null;
  const pixels = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) pixels.copy(scanlines, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = kind === 1 ? 1 : 8; header[9] = kind === 1 ? 0 : kind === 2 ? 2 : 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

const multiply = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const rectangle = m => {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

async function decodedImage(page, id) {
  if (typeof id !== 'string') return id;
  const pool = id.startsWith('g_') ? page.commonObjs : page.objs;
  if (!pool?.get) return null;
  let timer;
  try {
    return await Promise.race([
      new Promise(resolve => pool.get(id, resolve)),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Capture standalone raster figures, excluding page decoration and small icons. */
export async function extractPdfFigures(page, { ops, sourceHash, pageNumber }) {
  const list = await page.getOperatorList(), stack = [], images = [], files = [], skipped = [];
  let transform = [1, 0, 0, 1, 0, 0];
  const seen = new Set();
  const view = page.getViewport({ scale: 1 });
  for (let index = 0; index < list.fnArray.length; index++) {
    const operation = list.fnArray[index], args = list.argsArray[index];
    if (operation === ops.save) { stack.push([...transform]); continue; }
    if (operation === ops.restore) { transform = stack.pop() || [1, 0, 0, 1, 0, 0]; continue; }
    if (operation === ops.transform) { if (args?.length === 6 && args.every(Number.isFinite)) transform = multiply(transform, args); continue; }
    if (operation === ops.paintFormXObjectBegin) { stack.push([...transform]); if (args?.[0]?.length === 6) transform = multiply(transform, args[0]); continue; }
    if (operation === ops.paintFormXObjectEnd) { transform = stack.pop() || [1, 0, 0, 1, 0, 0]; continue; }
    if (![ops.paintImageXObject, ops.paintInlineImageXObject].includes(operation)) continue;
    const rect = rectangle(transform), printedWidth = rect[2] - rect[0], printedHeight = rect[3] - rect[1];
    if (printedWidth < 130 || printedHeight < 95 || rect[1] < 65 || printedWidth > view.width * 0.9 || printedHeight > view.height * 0.8) continue;
    if (Math.abs(transform[1]) > 0.001 || Math.abs(transform[2]) > 0.001 || transform[0] <= 0 || transform[3] <= 0) { skipped.push('此页题面图像带有旋转或镜像变换，未按未变换像素显示。'); continue; }
    if (images.length >= 8) { skipped.push('此页大型图像超过提取上限。'); break; }
    const object = await decodedImage(page, args?.[0]);
    const png = pdfImageToPng(object);
    if (!png || png.length > 8 * 1024 * 1024) { skipped.push('此页有无法安全解码的题面图像，原图仍保留在 PDF。'); continue; }
    const hash = createHash('sha256').update(png).digest('hex');
    const name = `derived/pdf-${sourceHash.slice(0, 24)}/page-${pageNumber}-${hash.slice(0, 24)}.png`;
    const key = `${name}:${rect.map(value => value.toFixed(2)).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({ name, rect, width: object.width, height: object.height });
    if (!files.some(file => file.name === name)) files.push({ name, data: png.toString('base64') });
  }
  return { images, files, skipped };
}
