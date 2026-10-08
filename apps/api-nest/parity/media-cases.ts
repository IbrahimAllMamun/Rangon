/**
 * Parity cases for `/media/<path>` (phase 7 part 5): uploaded files, served
 * by Django's `core.media.serve_media` and by the Nest API's `media/media.ts`.
 *
 * It is the one path the Nest API has to answer, beyond the API itself, to
 * run without Django beside it: with `USE_S3=0` the files are on the API's
 * disk and nothing else has them. The files are fixture_media.py's, each
 * with one known modification time.
 */
import type { Case } from './run.ts';

/** fixture_media.py's `MODIFIED`, in whole seconds: what a header can say. */
const MODIFIED = 1_788_258_030;
const httpDate = (seconds: number) => new Date(seconds * 1000).toUTCString();

const FILES = [
  'photo.jpg',
  'photo.jpeg',
  'photo.png',
  // No type in Python's table: `application/octet-stream` (D235, copied).
  'photo.webp',
  'photo.avif',
  'photo.gif',
  'drawing.svg',
  'drawing.svgz',
  'page.html',
  'script.js',
  'data.json',
  'sheet.csv',
  'sheet.xlsx',
  'notes.txt',
  'paper.pdf',
  'archive.tar.gz',
  'archive.tgz',
  'photo.png.gz',
  'old.Z',
  'old.z',
  'SHOUT.JPG',
  'two.dots.png',
  'no-extension',
  '.hidden',
  'unknown.rangon',
  'empty.png',
  'a b.png',
  'say "cheese".png',
  'back\\slash.png',
  'ছবি.png',
  '100%.png',
  'deep/er/photo.png',
];

const quoted = (name: string) => name.split('/').map(encodeURIComponent).join('/');

export function mediaCases(): Case[] {
  const cases: Case[] = [];
  const media = (name: string, path: string, extra: Partial<Case> = {}) =>
    cases.push({ name: `media: ${name}`, path, ...extra });
  const M = '/media/parity-media/';

  for (const file of FILES) media(`the file ${file}`, `${M}${quoted(file)}`);

  // --- What is not served -----------------------------------------------------------------------
  media('a file that is not there', `${M}nothing.png`);
  media('the root', '/media/');
  media('a folder', '/media/parity-media');
  media('a folder, with its slash', M);
  media('a path through a file', `${M}photo.png/more`);
  media('a file, with a slash after it', `${M}photo.png/`);
  media('a name with a NUL in it', `${M}pho%00to.png`);
  media('a name that is not UTF-8', `${M}%ff%fe.png`);
  media('a name too long for the filesystem', `${M}${'a'.repeat(300)}.png`);
  media('without its slash', '/media');
  media('without its slash, with a query', '/media?next=1');

  // --- The private prefix (D91) -----------------------------------------------------------------
  media('a receipt', '/media/expenses/parity-media/receipt.pdf');
  media(
    'a receipt, by a longer way round',
    '/media/parity-media/../expenses/parity-media/receipt.pdf',
  );
  media('a receipt, with a dot before it', '/media/./expenses/parity-media/receipt.pdf');
  media('a receipt, with two slashes', '/media//expenses/parity-media/receipt.pdf');
  media('a receipt, its slash percent-encoded', '/media/expenses%2Fparity-media/receipt.pdf');
  media('a receipt, a letter percent-encoded', '/media/e%78penses/parity-media/receipt.pdf');
  media('a receipt that is not there', '/media/expenses/nothing.pdf');
  media('the receipts folder', '/media/expenses/');
  media('the prefix in capitals is another folder', '/media/Expenses/parity-media/receipt.pdf');
  media(
    'a longer name than the prefix is another folder',
    '/media/expensesx/parity-media/receipt.pdf',
  );

  // --- Out of the root --------------------------------------------------------------------------
  media('up and out', '/media/../etc/passwd');
  media('up and out, percent-encoded', '/media/%2e%2e/%2e%2e/etc/passwd');
  media('up and out, from inside', `${M}../../../etc/passwd`);
  media('up, and back in by name', '/media/../media/parity-media/photo.png');
  media('up to the root itself', '/media/parity-media/..');
  media('one above the root', '/media/..');
  media('down and up again, staying in', `${M}deep/../photo.png`);
  media('an absolute path', '/media//etc/passwd');

  // --- A function view: nothing is negotiated, and any method is the view's ----------------------
  media('asked for as XML', `${M}photo.png?format=xml`);
  media('with an Accept nothing satisfies', `${M}photo.png`, {
    headers: { accept: 'application/xml' },
  });
  media('with a query', `${M}photo.png?v=2&w=640`);
  media('with a bad token', `${M}photo.png`, { headers: { authorization: 'Bearer nonsense' } });
  // No HEAD here: Django under gunicorn sends a body after a HEAD's headers
  // (the 404 page, for one), which no HTTP client will read. See "Deliberate
  // differences": the Nest API sends the headers alone.
  media('OPTIONS', `${M}photo.png`, { method: 'OPTIONS' });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    media(`${method}, with no CSRF token`, `${M}photo.png`, { method });
    media(
      `${method} of a receipt, with no CSRF token`,
      '/media/expenses/parity-media/receipt.pdf',
      {
        method,
      },
    );
  }
  media('POST without its slash', '/media', { method: 'POST' });

  // --- If-Modified-Since ------------------------------------------------------------------------
  const since = (name: string, value: string, path = `${M}photo.png`) =>
    media(`If-Modified-Since ${name}`, path, { headers: { 'if-modified-since': value } });
  since('the second it was written', httpDate(MODIFIED));
  since('a second before', httpDate(MODIFIED - 1));
  since('a second after', httpDate(MODIFIED + 1));
  since('long after', 'Thu, 01 Jan 2099 00:00:00 GMT');
  since('long before', 'Thu, 01 Jan 1970 00:00:00 GMT');
  // Two digits: this century, unless that is more than fifty years ahead.
  since('in the RFC 850 form, a year read as this century', 'Wednesday, 01-Jan-70 00:00:00 GMT');
  since('in the RFC 850 form, a year read as the last', 'Friday, 01-Jan-99 00:00:00 GMT');
  since('in the asctime form, after', 'Thu Jan  1 00:00:00 2099');
  since('in the asctime form, before', 'Thu Jan  1 00:00:00 1970');
  since('with the month in capitals', 'Thu, 01 JAN 2099 00:00:00 GMT');
  since('with a weekday that is not one', 'Xyz, 01 Jan 2099 00:00:00 GMT');
  since('with a month that is not one', 'Thu, 01 Foo 2099 00:00:00 GMT');
  since('on a day the month does not have', 'Thu, 31 Feb 2099 00:00:00 GMT');
  since('at an hour the day does not have', 'Thu, 01 Jan 2099 24:00:00 GMT');
  since('in the year nought', 'Thu, 01 Jan 0000 00:00:00 GMT');
  since('without GMT', 'Thu, 01 Jan 2099 00:00:00');
  since('with another zone', 'Thu, 01 Jan 2099 00:00:00 +0600');
  since('that is not a date', 'yesterday');
  since('that is empty', '');
  since('of a file that is not there', 'Thu, 01 Jan 2099 00:00:00 GMT', `${M}nothing.png`);
  since(
    'of a receipt',
    'Thu, 01 Jan 2099 00:00:00 GMT',
    '/media/expenses/parity-media/receipt.pdf',
  );

  return cases;
}
