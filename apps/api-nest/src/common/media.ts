/**
 * `core.media.media_url`: the public URL of a stored file, or `""` if unset.
 *
 * With `USE_S3=0` Django's `FileSystemStorage.url(name)` is
 * `urljoin(MEDIA_URL, filepath_to_uri(name))`, which is root-relative and
 * therefore right behind any host, port or scheme (see core/media.py).
 * `filepath_to_uri` percent-encodes everything except the characters in its
 * safe set, and turns backslashes into slashes.
 */
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

export function mediaUrl(name: string | null | undefined, mediaBase = '/media/'): string {
  if (!name) return '';
  // `urljoin(base, url)` with a base ending in `/` and a relative name is a
  // plain concatenation; a name starting with `/` would replace the path.
  const uri = filepathToUri(name);
  return uri.startsWith('/') ? uri : `${mediaBase}${uri}`;
}
