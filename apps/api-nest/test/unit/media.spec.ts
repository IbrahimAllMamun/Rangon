import { guessType } from '../../src/common/mimetypes';
import {
  decodePathInfo,
  inlineDisposition,
  isPrivateMedia,
  parseHttpDate,
  pyNormpath,
  rewriteMediaUrl,
  safeJoin,
} from '../../src/media/media';
import type { IncomingMessage } from 'node:http';

/**
 * What Django and Python answer for the same input, printed in the
 * production Django image (Django 5.1, Python 3.12): `posixpath.normpath`,
 * `mimetypes.guess_type`, `django.utils.http.parse_http_date` and
 * `content_disposition_header`, `django.utils._os.safe_join` (null where it
 * raises `SuspiciousFileOperation`), and the path the resolver sees
 * (`repercent_broken_unicode` over the unquoted bytes).
 */
const NORMPATH: [path: string, normal: string][] = [
  ['', '.'],
  ['.', '.'],
  ['/', '/'],
  ['//', '//'],
  ['///', '/'],
  ['a', 'a'],
  ['a/', 'a'],
  ['a//b', 'a/b'],
  ['a/./b', 'a/b'],
  ['a/../b', 'b'],
  ['../a', '../a'],
  ['a/..', '.'],
  ['a/../..', '..'],
  ['/..', '/'],
  ['/../a', '/a'],
  ['//a/../..', '//'],
  ['a/b/../../c', 'c'],
  ['./a', 'a'],
  ['a/.', 'a'],
  ['..', '..'],
  ['../..', '../..'],
  ['a/../../b', '../b'],
  ['/a/b/', '/a/b'],
  ['expenses/../x', 'x'],
  ['x/../expenses/y', 'expenses/y'],
];

const TYPES: [name: string, type: string | null, encoding: string | null][] = [
  ['a.jpg', 'image/jpeg', null],
  ['a.JPG', 'image/jpeg', null],
  ['a.jpeg', 'image/jpeg', null],
  ['a.png', 'image/png', null],
  ['a.webp', null, null],
  ['a.avif', 'image/avif', null],
  ['a.gif', 'image/gif', null],
  ['a.svg', 'image/svg+xml', null],
  ['a.svgz', 'image/svg+xml', 'gzip'],
  ['a.tar.gz', 'application/x-tar', 'gzip'],
  ['a.tgz', 'application/x-tar', 'gzip'],
  ['a.TGZ', 'application/x-tar', 'gzip'],
  ['a.png.gz', 'image/png', 'gzip'],
  ['a.Z', null, 'compress'],
  ['a.z', null, null],
  ['a.GZ', null, null],
  ['a.gz', null, 'gzip'],
  ['a.br', null, 'br'],
  ['a.xz', null, 'xz'],
  ['a.bz2', null, 'bzip2'],
  ['a.txt', 'text/plain', null],
  ['a.html', 'text/html', null],
  ['a.js', 'text/javascript', null],
  ['a.mjs', 'text/javascript', null],
  ['a.json', 'application/json', null],
  ['a.csv', 'text/csv', null],
  ['a.xlsx', null, null],
  ['a.pdf', 'application/pdf', null],
  ['a.ico', 'image/vnd.microsoft.icon', null],
  ['a.bmp', 'image/bmp', null],
  ['a.tiff', 'image/tiff', null],
  ['a.heic', 'image/heic', null],
  ['a.mp4', 'video/mp4', null],
  ['a.woff2', null, null],
  ['a', null, null],
  ['.hidden', null, null],
  ['..png', null, null],
  ['a.', null, null],
  ['a.b.png', 'image/png', null],
  ['dir.d/a', null, null],
  ['dir.png/a', null, null],
  ['a.rangon', null, null],
  ['.tar.gz', null, 'gzip'],
  ['a.txz', 'application/x-tar', 'xz'],
  ['a.tbz2', 'application/x-tar', 'bzip2'],
  ['a.svg.gz', 'image/svg+xml', 'gzip'],
  ['/app/media/x/y.png', 'image/png', null],
];

const DATES: [header: string, seconds: number | null][] = [
  ['Thu, 01 Jan 2099 00:00:00 GMT', 4070908800],
  ['Thu, 01 Jan 1970 00:00:00 GMT', 0],
  ['Tue, 01 Sep 2026 10:20:30 GMT', 1788258030],
  ['Friday, 01-Jan-99 00:00:00 GMT', 915148800],
  ['Wednesday, 01-Jan-70 00:00:00 GMT', 3155760000],
  ['Sunday, 06-Nov-94 08:49:37 GMT', 784111777],
  ['Sunday, 06-Nov-76 08:49:37 GMT', 3371878177],
  ['Sunday, 06-Nov-77 08:49:37 GMT', 247654177],
  ['Thu Jan  1 00:00:00 2099', 4070908800],
  ['Sun Nov  6 08:49:37 1994', 784111777],
  ['Sun Nov 16 08:49:37 1994', 784975777],
  ['Thu, 01 JAN 2099 00:00:00 GMT', 4070908800],
  ['Xyz, 01 Jan 2099 00:00:00 GMT', 4070908800],
  ['Thu, 01 Foo 2099 00:00:00 GMT', null],
  ['Thu, 31 Feb 2099 00:00:00 GMT', null],
  ['Thu, 29 Feb 2024 00:00:00 GMT', 1709164800],
  ['Thu, 29 Feb 2023 00:00:00 GMT', null],
  ['Thu, 01 Jan 2099 24:00:00 GMT', null],
  ['Thu, 01 Jan 2099 23:60:00 GMT', null],
  ['Thu, 01 Jan 2099 23:59:60 GMT', null],
  ['Thu, 01 Jan 0000 00:00:00 GMT', 946684800],
  ['Thu, 01 Jan 0001 00:00:00 GMT', 978307200],
  ['Thu, 00 Jan 2099 00:00:00 GMT', null],
  ['Thu, 01 Jan 2099 00:00:00', null],
  ['Thu, 01 Jan 2099 00:00:00 +0600', null],
  ['yesterday', null],
  ['', null],
  ['Thu, 1 Jan 2099 00:00:00 GMT', null],
  ['বৃহঃ, 01 Jan 2099 00:00:00 GMT', null],
  ['Thu, 01 Jan 9999 23:59:59 GMT', 253370851199],
  [' Thu, 01 Jan 2099 00:00:00 GMT', null],
];

const DISPOSITIONS: [filename: string, header: string][] = [
  ['photo.png', 'inline; filename="photo.png"'],
  ['a b.png', 'inline; filename="a b.png"'],
  ['say "cheese".png', 'inline; filename="say \\"cheese\\".png"'],
  ['back\\slash.png', 'inline; filename="back\\\\slash.png"'],
  ['ছবি.png', "inline; filename*=utf-8''%E0%A6%9B%E0%A6%AC%E0%A6%BF.png"],
  ['100%.png', 'inline; filename="100%.png"'],
  ['naïve.jpg', "inline; filename*=utf-8''na%C3%AFve.jpg"],
  ['a;b.png', 'inline; filename="a;b.png"'],
  ['tab\there.png', 'inline; filename="tab\there.png"'],
];

const JOINS: [base: string, path: string, joined: string | null][] = [
  ['/app/media', 'a.png', '/app/media/a.png'],
  ['/app/media', 'a/b.png', '/app/media/a/b.png'],
  ['/app/media', '../x', null],
  ['/app/media', '..', null],
  ['/app/media', '.', '/app/media'],
  ['/app/media', '../media', '/app/media'],
  ['/app/media', '../mediax/a', null],
  ['/app/media/', 'a', '/app/media/a'],
  ['/app/media', 'a/../../media/b', '/app/media/b'],
  ['/', 'etc/passwd', '/etc/passwd'],
  ['/', '..', '/'],
  ['/app/media', 'etc/passwd', '/app/media/etc/passwd'],
];

const PATHS: [raw: string, seen: string][] = [
  ['a.png', 'a.png'],
  ['a%20b.png', 'a b.png'],
  ['%ff%fe.png', '%FF%FE.png'],
  ['%e0%a6%9b.png', 'ছ.png'],
  ['%e0%a6.png', '%E0%A6.png'],
  ['a%2Fb', 'a/b'],
  ['%2e%2e/x', '../x'],
  ['100%25.png', '100%.png'],
  ['100%.png', '100%.png'],
  ['%zz', '%zz'],
  ['%c3%28', '%C3('],
  ['%f0%9f%98%80', '😀'],
  ['%f0%9f%98', '%F0%9F%98'],
  ['caf%C3%A9', 'café'],
  ['%00', '\u0000'],
];

// `datetime.now()` when the dates above were printed: a two-digit year is read against it.
const PRINTED = Date.UTC(2026, 9, 8);

describe('the media route, against Django and Python', () => {
  it.each(NORMPATH)('normpath(%j) is %j', (path, normal) => {
    expect(pyNormpath(path)).toBe(normal);
  });

  it.each(TYPES)('guess_type(%j) is %j, %j', (name, type, encoding) => {
    expect(guessType(name)).toEqual([type, encoding]);
  });

  it.each(DATES)('parse_http_date(%j) is %j', (header, seconds) => {
    expect(parseHttpDate(header, PRINTED)).toBe(seconds);
  });

  it.each(DISPOSITIONS)('a file named %j is sent as %j', (filename, header) => {
    expect(inlineDisposition(filename)).toBe(header);
  });

  it.each(JOINS)('safe_join(%j, %j) is %j', (base, path, joined) => {
    expect(safeJoin(base, path)).toBe(joined);
  });

  it.each(PATHS)('the path %j reaches the view as %j', (raw, seen) => {
    expect(decodePathInfo(raw)).toBe(seen);
  });
});

describe('the private prefix', () => {
  it.each([
    'expenses/2026/10/receipt.pdf',
    './expenses/a.pdf',
    'a/../expenses/a.pdf',
    '/expenses/a.pdf',
    '//expenses//a.pdf',
  ])("%j is staff's alone", (path) => {
    expect(isPrivateMedia(path)).toBe(true);
  });

  // The folder itself is not under its own prefix once normalised; it is a folder, and a 404 for that.
  it.each([
    'products/a.jpg',
    'expenses',
    'expenses/',
    'Expenses/a.pdf',
    'expensesx/a.pdf',
    'a/expenses/b.pdf',
    '',
  ])('%j is not under it', (path) => {
    expect(isPrivateMedia(path)).toBe(false);
  });
});

describe('a media URL the router could not read', () => {
  const request = (url: string) => ({ url }) as IncomingMessage & { mediaUrl?: string };

  it('leaves every other URL, and every readable media URL, as it came', () => {
    for (const url of ['/api/v1/brands/%ff/', '/media/a%20b.png?v=1', '/media/', '/media']) {
      const incoming = request(url);
      expect(rewriteMediaUrl(incoming)).toBe(url);
      expect(incoming.mediaUrl).toBeUndefined();
    }
  });

  it('hands the router a spelling it can read, and keeps the one that came for the view', () => {
    const incoming = request('/media/parity/%ff%fe.png?v=1');
    const rewritten = rewriteMediaUrl(incoming);
    expect(rewritten).toBe('/media/parity%2F%25ff%25fe.png?v=1');
    expect(() => decodeURIComponent(rewritten.split('?')[0] as string)).not.toThrow();
    expect(incoming.mediaUrl).toBe('/media/parity/%ff%fe.png?v=1');
  });
});
