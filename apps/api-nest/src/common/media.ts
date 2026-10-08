/**
 * `core.media.media_url`: the public URL of a stored file, or `""` if unset.
 *
 * With `USE_S3=0` Django's `FileSystemStorage.url(name)` is
 * `urljoin(MEDIA_URL, filepath_to_uri(name))`, which is root-relative and
 * therefore right behind any host, port or scheme (see core/media.py).
 * `filepath_to_uri` percent-encodes everything except the characters in its
 * safe set, and turns backslashes into slashes.
 */
import { type S3Settings, s3ObjectUrl } from './s3';

const SAFE = new Set("/~!*()'".split(''));

export function filepathToUri(path: string): string {
  let out = '';
  for (const byte of Buffer.from(path.replaceAll('\\', '/'), 'utf8')) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.-]/.test(char) || SAFE.has(char)) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * What `FieldFile.url` is built from: `MEDIA_URL` for files on disk, the
 * bucket's settings with `USE_S3` -- where the URL is the bucket's own,
 * absolute, and passed through unchanged (docs/api/conventions.md).
 */
export type MediaBase = string | S3Settings;

export function mediaUrl(
  name: string | null | undefined,
  mediaBase: MediaBase = '/media/',
): string {
  if (!name) return '';
  if (typeof mediaBase !== 'string') return s3ObjectUrl(mediaBase, name);
  // `urljoin(base, url)` with a base ending in `/` and a relative name is a
  // plain concatenation; a name starting with `/` would replace the path.
  const uri = filepathToUri(name);
  return uri.startsWith('/') ? uri : `${mediaBase}${uri}`;
}
