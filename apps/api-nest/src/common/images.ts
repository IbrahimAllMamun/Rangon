/**
 * What Pillow's `Image.open(f)` then `image.verify()` make of an upload, as
 * Django's `forms.ImageField` asks them (the Django API's only use of
 * Pillow): which format it is -- whose MIME type becomes the upload's
 * `content_type` -- or nothing, when Pillow cannot identify or verify it.
 *
 * Pillow knows some forty formats. This reads the eight an upload is
 * realistically in -- JPEG, PNG, WebP and AVIF, which a product image may
 * be, and GIF, BMP, TIFF and ICO, which are refused by name -- the way
 * Pillow opens them: a JPEG's markers up to its first scan, every PNG
 * chunk's CRC to IEND, a WebP's RIFF container and frame header, an AVIF's
 * boxes. Anything else is "not an image" here, where Django names the
 * formats it accepts instead (docs/architecture/nest-port.md).
 */
import { crc32 } from 'node:zlib';

export interface IdentifiedImage {
  format: string;
  /** `Image.MIME[format]`. */
  mime: string;
  width: number;
  height: number;
}

/** `Image.MAX_IMAGE_PIXELS * 2`: past this Pillow raises `DecompressionBombError`. */
const BOMB_PIXELS = 2 * 89478485;

const u16be = (b: Buffer, at: number) => b.readUInt16BE(at);
const u32be = (b: Buffer, at: number) => b.readUInt32BE(at);

function jpeg(b: Buffer): IdentifiedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  const sof = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let at = 2;
  let size: { width: number; height: number } | null = null;
  for (;;) {
    if (at >= b.length) return null;
    if (b[at] !== 0xff) {
      at += 1;
      continue;
    }
    if (at + 1 >= b.length) return null;
    const marker = b[at + 1] as number;
    if (marker === 0xff || marker === 0x00) {
      at += marker === 0x00 ? 2 : 1;
      continue;
    }
    // SOI, RSTn and EOI carry no length; markers below 0xC0 are not JPEG's.
    if (marker >= 0xd0 && marker <= 0xd9) {
      at += 2;
      continue;
    }
    if (marker < 0xc0) return null;
    if (at + 4 > b.length) return null;
    const length = u16be(b, at + 2);
    if (length < 2 || at + 2 + length > b.length) return null;
    if (sof.has(marker)) {
      if (length < 8 || b[at + 4] !== 8) return null;
      const height = u16be(b, at + 5);
      const width = u16be(b, at + 7);
      const components = b[at + 9] as number;
      if (![1, 3, 4].includes(components)) return null;
      size = { width, height };
    }
    if (marker === 0xda) break;
    at += 2 + length;
  }
  if (!size || size.width <= 0 || size.height <= 0) return null;
  return { format: 'JPEG', mime: 'image/jpeg', ...size };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_MODES = new Set([
  '1,0',
  '2,0',
  '4,0',
  '8,0',
  '16,0',
  '1,3',
  '2,3',
  '4,3',
  '8,3',
  '8,2',
  '16,2',
  '8,4',
  '16,4',
  '8,6',
  '16,6',
]);

function png(b: Buffer): IdentifiedImage | null {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_MAGIC)) return null;
  let at = 8;
  let size: { width: number; height: number } | null = null;
  let data = false;
  for (;;) {
    if (at + 8 > b.length) return null;
    const length = u32be(b, at);
    const type = b.subarray(at + 4, at + 8);
    if (![...type].every((c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return null;
    const name = type.toString('latin1');
    if (name === 'IEND') break;
    if (at + 12 + length > b.length) return null;
    const body = b.subarray(at + 8, at + 8 + length);
    if (crc32(Buffer.concat([type, body])) >>> 0 !== u32be(b, at + 8 + length)) return null;
    if (size === null) {
      if (name !== 'IHDR' || length < 13) return null;
      if (!PNG_MODES.has(`${body[8]},${body[9]}`) || body[11] !== 0) return null;
      size = { width: u32be(body, 0), height: u32be(body, 4) };
    }
    if (name === 'IDAT') data = true;
    at += 12 + length;
  }
  if (!size || !data || size.width <= 0 || size.height <= 0) return null;
  return { format: 'PNG', mime: 'image/png', ...size };
}

function gif(b: Buffer): IdentifiedImage | null {
  const head = b.subarray(0, 6).toString('latin1');
  if ((head !== 'GIF87a' && head !== 'GIF89a') || b.length < 13) return null;
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  if (!b.subarray(13).includes(0x2c)) return null;
  return { format: 'GIF', mime: 'image/gif', width, height };
}

function webp(b: Buffer): IdentifiedImage | null {
  if (b.length < 20 || b.subarray(0, 4).toString('latin1') !== 'RIFF') return null;
  if (b.subarray(8, 12).toString('latin1') !== 'WEBP') return null;
  const chunk = b.subarray(12, 16).toString('latin1');
  if (!['VP8 ', 'VP8L', 'VP8X'].includes(chunk)) return null;
  // libwebp's demuxer wants the whole file the RIFF header promises.
  if (b.readUInt32LE(4) + 8 > b.length) return null;
  const body = b.subarray(20);
  let width: number;
  let height: number;
  if (chunk === 'VP8 ') {
    if (body.length < 10 || body[3] !== 0x9d || body[4] !== 0x01 || body[5] !== 0x2a) return null;
    if ((body[0] as number) & 1) return null;
    width = body.readUInt16LE(6) & 0x3fff;
    height = body.readUInt16LE(8) & 0x3fff;
  } else if (chunk === 'VP8L') {
    if (body.length < 5 || body[0] !== 0x2f) return null;
    const bits = body.readUInt32LE(1);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  } else {
    if (body.length < 10) return null;
    width = body.readUIntLE(4, 3) + 1;
    height = body.readUIntLE(7, 3) + 1;
  }
  if (width <= 0 || height <= 0) return null;
  return { format: 'WEBP', mime: 'image/webp', width, height };
}

function avif(b: Buffer): IdentifiedImage | null {
  if (b.length < 16 || b.subarray(4, 8).toString('latin1') !== 'ftyp') return null;
  if (!['avif', 'avis', 'mif1', 'msf1'].includes(b.subarray(8, 12).toString('latin1'))) return null;
  // Walk the top-level boxes; libavif needs the meta box (and the item data).
  const boxes = new Set<string>();
  let at = 0;
  let width = 0;
  let height = 0;
  while (at + 8 <= b.length) {
    let size = u32be(b, at);
    const type = b.subarray(at + 4, at + 8).toString('latin1');
    if (size === 1) {
      if (at + 16 > b.length) return null;
      size = Number(b.readBigUInt64BE(at + 8));
    } else if (size === 0) size = b.length - at;
    if (size < 8 || at + size > b.length) return null;
    boxes.add(type);
    if (type === 'meta') {
      const ispe = b.subarray(at, at + size).indexOf('ispe');
      if (ispe !== -1 && at + ispe + 16 <= b.length) {
        width = u32be(b, at + ispe + 8);
        height = u32be(b, at + ispe + 12);
      }
    }
    at += size;
  }
  if (!boxes.has('meta') || !boxes.has('mdat') || width <= 0 || height <= 0) return null;
  return { format: 'AVIF', mime: 'image/avif', width, height };
}

function bmp(b: Buffer): IdentifiedImage | null {
  if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
  const header = b.readUInt32LE(14);
  if (![12, 40, 52, 56, 64, 108, 124].includes(header) || b.length < 14 + header) return null;
  const width = header === 12 ? b.readUInt16LE(18) : b.readInt32LE(18);
  const height = Math.abs(header === 12 ? b.readInt16LE(20) : b.readInt32LE(22));
  const bits = header === 12 ? b.readUInt16LE(24) : b.readUInt16LE(28);
  if (![1, 4, 8, 16, 24, 32].includes(bits) || width <= 0 || height <= 0) return null;
  return { format: 'BMP', mime: 'image/bmp', width, height };
}

function tiff(b: Buffer): IdentifiedImage | null {
  if (b.length < 8) return null;
  const head = b.subarray(0, 4).toString('latin1');
  const little = head === 'II*\0';
  if (!little && head !== 'MM\0*') return null;
  const offset = little ? b.readUInt32LE(4) : u32be(b, 4);
  if (offset < 8 || offset + 2 > b.length) return null;
  return { format: 'TIFF', mime: 'image/tiff', width: 1, height: 1 };
}

function ico(b: Buffer): IdentifiedImage | null {
  if (b.length < 6 || b.readUInt32BE(0) !== 0x00000100) return null;
  const count = b.readUInt16LE(4);
  if (count === 0 || b.length < 6 + 16 * count) return null;
  return { format: 'ICO', mime: 'image/x-icon', width: b[6] || 256, height: b[7] || 256 };
}

/** `Image.open(f)` and `verify()`: the format, or null where Pillow would raise. */
export function identifyImage(bytes: Buffer): IdentifiedImage | null {
  for (const open of [jpeg, png, gif, webp, avif, bmp, tiff, ico]) {
    let image: IdentifiedImage | null;
    try {
      image = open(bytes);
    } catch {
      image = null;
    }
    if (image) return image.width * image.height > BOMB_PIXELS ? null : image;
  }
  return null;
}
