/**
 * Form bodies, as DRF's `MultiPartParser` and `FormParser` hand them to a
 * view: a `QueryDict` of strings with the uploads merged in after them
 * (`request.data`). A serializer reads such data with HTML-form rules -- a
 * missing boolean is false, a blank optional field is left out -- which
 * `runSerializer` applies when it is given an `HtmlInput`.
 *
 * The multipart rules are Django's `MultiPartParser`: the boundary must be
 * 1-201 printable characters; a part without a name is skipped; a file part
 * whose name sanitises to nothing is skipped; a file's name is unescaped,
 * cut to its last path component and stripped of unprintable characters;
 * text is decoded as UTF-8 with replacement characters.
 */
import { ValidationError } from '../common/errors';
import { parseQsl } from '../common/python';

export interface UploadedFile {
  /** The sanitised file name the client gave. */
  name: string;
  size: number;
  /** The part's own Content-Type, as the browser claimed it. */
  contentType: string;
  bytes: Buffer;
}

export function isUploadedFile(value: unknown): value is UploadedFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    Buffer.isBuffer((value as UploadedFile).bytes) &&
    typeof (value as UploadedFile).name === 'string'
  );
}

/** `request.data` for a form body: last value wins on `get`, as a `QueryDict`. */
export class HtmlInput {
  private readonly values = new Map<string, (string | UploadedFile)[]>();

  append(key: string, value: string | UploadedFile): void {
    const list = this.values.get(key);
    if (list) list.push(value);
    else this.values.set(key, [value]);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  get(key: string): string | UploadedFile | undefined {
    const list = this.values.get(key);
    return list && list.length ? list[list.length - 1] : undefined;
  }

  getlist(key: string): (string | UploadedFile)[] {
    return [...(this.values.get(key) ?? [])];
  }
}

/** DRF's `ParseError` for a multipart body Django cannot read. */
function parseError(message: string): ValidationError {
  return new ValidationError(`Multipart form parse error - ${message}`);
}

/** `parse_header_parameters`: the value and its `;`-separated parameters, quotes removed. */
export function headerParameters(line: string): [string, Map<string, string>] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    if (char === '"' && line[i - 1] !== '\\') quoted = !quoted;
    if (char === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  const key = (parts.shift() ?? '').trim().toLowerCase();
  const params = new Map<string, string>();
  for (const part of parts) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    let name = part.slice(0, at).trim().toLowerCase();
    let value = part.slice(at + 1).trim();
    if (name.endsWith('*')) {
      // RFC 2231: charset'language'percent-encoded.
      name = name.slice(0, -1);
      const pieces = value.split("'");
      if (pieces.length === 3) {
        try {
          value = decodeURIComponent((pieces[2] as string).replace(/%(?![0-9a-fA-F]{2})/g, '%25'));
        } catch {
          value = pieces[2] as string;
        }
      }
    } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replaceAll('\\\\', '\\').replaceAll('\\"', '"');
    }
    params.set(name, value);
  }
  return [key, params];
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** `html.unescape`, for the entities a file name realistically carries. */
function htmlUnescape(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return NAMED_ENTITIES[entity] ?? whole;
  });
}

/** `str.isprintable()` for one character. */
function isPrintable(char: string): boolean {
  if (char === ' ') return true;
  return !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u.test(char);
}

/** `MultiPartParser.sanitize_file_name`: null when nothing usable is left. */
export function sanitizeFileName(raw: string): string | null {
  let name = htmlUnescape(raw);
  name = name.split('/').pop() as string;
  name = name.split('\\').pop() as string;
  name = [...name].filter(isPrintable).join('');
  return name === '' || name === '.' || name === '..' ? null : name;
}

/** Parse `multipart/form-data` into `request.data`. */
export function parseMultipart(contentType: string, body: Buffer): HtmlInput {
  const [, params] = headerParameters(contentType);
  const boundary = params.get('boundary');
  if (!boundary || !/^[ -~]{0,200}[!-~]$/.test(boundary)) {
    throw parseError(`Invalid boundary in multipart: ${boundary ?? 'None'}`);
  }
  const data = new HtmlInput();
  const files: [string, UploadedFile][] = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let position = body.indexOf(delimiter);
  if (position === -1) return data;
  for (;;) {
    position += delimiter.length;
    // The closing delimiter ends the body.
    if (body.subarray(position, position + 2).toString('latin1') === '--') break;
    const headerEnd = body.indexOf('\r\n\r\n', position);
    if (headerEnd === -1) break;
    const next = body.indexOf(delimiter, headerEnd + 4);
    if (next === -1) break;
    // The part's content ends at the CRLF before the next delimiter.
    const content = body.subarray(headerEnd + 4, next >= 2 ? next - 2 : next);
    const headers = new Map<string, string>();
    for (const line of body.subarray(position, headerEnd).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0)
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    position = next;
    const [disposition, dispositionParams] = headerParameters(
      headers.get('content-disposition') ?? '',
    );
    const fieldName = dispositionParams.get('name');
    if (disposition !== 'form-data' || !fieldName) continue;
    if (dispositionParams.has('filename')) {
      const fileName = sanitizeFileName(dispositionParams.get('filename') ?? '');
      if (!fileName) continue;
      const [type] = headerParameters(headers.get('content-type') ?? '');
      files.push([
        fieldName,
        {
          name: fileName,
          size: content.length,
          contentType: type.trim(),
          bytes: Buffer.from(content),
        },
      ]);
    } else {
      data.append(fieldName, new TextDecoder('utf-8', { ignoreBOM: true }).decode(content));
    }
  }
  // `request.data` is the fields, then the files merged in.
  for (const [name, file] of files) data.append(name, file);
  return data;
}

/** `application/x-www-form-urlencoded` into `request.data`. */
export function parseUrlencoded(body: Buffer): HtmlInput {
  const data = new HtmlInput();
  for (const [key, value] of parseQsl(body.toString('utf8'))) data.append(key, value);
  return data;
}
