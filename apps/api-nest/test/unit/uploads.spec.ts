/**
 * Uploads against Django and Pillow: what Pillow identifies (images it made
 * itself, then broken), Django's file-name rules -- `sanitize_file_name`,
 * `get_valid_filename`, `PurePath.suffixes` -- and multipart parsing. Every
 * expected value was printed in the Django API's container.
 */
import { crc32 } from 'node:zlib';

import { identifyImage } from '../../src/common/images';
import { extensions, strftimeLocal, validFilename } from '../../src/common/storage';
import {
  HtmlInput,
  isUploadedFile,
  parseMultipart,
  sanitizeFileName,
} from '../../src/http/multipart';
import { IMAGES } from '../../parity/images';

const bytes = (key: keyof typeof IMAGES) => Buffer.from(IMAGES[key], 'base64');

describe('Image.open + verify', () => {
  it.each([
    ['jpeg', 'JPEG', 'image/jpeg'],
    ['png', 'PNG', 'image/png'],
    ['webp', 'WEBP', 'image/webp'],
    ['avif', 'AVIF', 'image/avif'],
    ['gif', 'GIF', 'image/gif'],
    ['bmp', 'BMP', 'image/bmp'],
    ['tiff', 'TIFF', 'image/tiff'],
  ] as const)('identifies %s', (key, format, mime) => {
    expect(identifyImage(bytes(key))).toMatchObject({ format, mime });
  });

  it('refuses text, a broken PNG checksum and a JPEG cut before its scan', () => {
    expect(identifyImage(Buffer.from('hello'))).toBeNull();
    const png = Buffer.from(bytes('png'));
    png[29] = (png[29] as number) ^ 0xff;
    expect(identifyImage(png)).toBeNull();
    const jpeg = bytes('jpeg');
    expect(identifyImage(jpeg.subarray(0, jpeg.indexOf(Buffer.from([0xff, 0xda]))))).toBeNull();
  });

  it('refuses a PNG with no IEND, and accepts one padded with a checked private chunk', () => {
    const png = bytes('png');
    expect(identifyImage(png.subarray(0, png.length - 12))).toBeNull();
    const type = Buffer.from('prVt');
    const data = Buffer.alloc(64, 1);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
    const padded = Buffer.concat([
      png.subarray(0, png.length - 12),
      length,
      type,
      data,
      crc,
      png.subarray(-12),
    ]);
    expect(identifyImage(padded)).toMatchObject({ format: 'PNG' });
  });
});

describe("Django's file names", () => {
  // [sanitize_file_name, get_valid_filename, "".join(PurePath(name).suffixes)]
  const cases: [string, string | null, string | null, string | null][] = [
    ['a b.jpg', 'a b.jpg', 'a_b.jpg', '.jpg'],
    ['../../etc/x.jpg', 'x.jpg', 'x.jpg', '.jpg'],
    ['c:\\dir\\y.png', 'y.png', 'y.png', '.png'],
    ['ছবি নতুন.jpg', 'ছবি নতুন.jpg', 'ছব_নতন.jpg', '.jpg'],
    ['&amp;x&#65;.jpg', '&xA.jpg', 'xA.jpg', '.jpg'],
    ['tab\there.jpg', 'tabhere.jpg', 'tabhere.jpg', '.jpg'],
    ['..', null, null, null],
    ['.hidden.jpg', '.hidden.jpg', '.hidden.jpg', '.jpg'],
    ['x.tar.gz', 'x.tar.gz', 'x.tar.gz', '.tar.gz'],
    [
      "john's portrait in 2004.jpg",
      "john's portrait in 2004.jpg",
      'johns_portrait_in_2004.jpg',
      '.jpg',
    ],
    ['  spaced  .png', '  spaced  .png', 'spaced__.png', '.png'],
    ['★.jpg', '★.jpg', '.jpg', '.jpg'],
  ];
  for (const [raw, sanitized, valid, suffixes] of cases) {
    it(JSON.stringify(raw), () => {
      const name = sanitizeFileName(raw);
      expect(name).toBe(sanitized);
      if (name !== null) {
        expect(validFilename(name)).toBe(valid);
        expect(extensions(name)).toBe(suffixes);
      }
    });
  }

  it("dates upload_to by the shop's clock, not UTC", () => {
    // 2026-09-30 19:30 UTC is already 1 October in Dhaka.
    expect(strftimeLocal('products/%Y/%m/', 'Asia/Dhaka', Date.UTC(2026, 8, 30, 19, 30))).toBe(
      'products/2026/10/',
    );
  });
});

describe('multipart/form-data', () => {
  const boundary = 'xyz';
  const body = Buffer.from(
    [
      '--xyz',
      'Content-Disposition: form-data; name="alt"',
      '',
      'caf\u00e9',
      '--xyz',
      'Content-Disposition: form-data; name="image"; filename="../a b.jpg"',
      'Content-Type: image/jpeg ',
      '',
      'JPEGDATA',
      '--xyz',
      'Content-Disposition: form-data; name="blank"; filename=""',
      '',
      'nothing',
      '--xyz',
      'Content-Disposition: form-data; name="skipped"; filename="../"',
      '',
      'gone',
      '--xyz',
      'Content-Disposition: form-data; name="alt"',
      '',
      'second',
      '--xyz--',
      '',
    ].join('\r\n'),
  );

  it('reads fields (the last of a name winning) and files, a nameless file skipped', () => {
    // Django: `TYPE = FILE` only when `filename` is not empty -- an empty one
    // is a field; a name that sanitises to nothing is a file, skipped.
    const data = parseMultipart(`multipart/form-data; boundary=${boundary}`, body);
    expect(data).toBeInstanceOf(HtmlInput);
    expect(data.get('alt')).toBe('second');
    expect(data.getlist('alt')).toEqual(['café', 'second']);
    expect(data.get('blank')).toBe('nothing');
    expect(data.has('skipped')).toBe(false);
    const image = data.get('image');
    expect(isUploadedFile(image)).toBe(true);
    expect(image).toMatchObject({ name: 'a b.jpg', size: 8, contentType: 'image/jpeg' });
  });

  it('refuses a missing boundary as DRF words it', () => {
    expect(() => parseMultipart('multipart/form-data', body)).toThrow(
      'Multipart form parse error - Invalid boundary in multipart: None',
    );
  });
});
