/**
 * `FileSystemStorage` under `MEDIA_ROOT`, as a model `FileField` saves an
 * upload: the name built by `FileField.generate_filename` -- `upload_to`
 * through `strftime` on the server's local clock, the file name cleaned by
 * `get_valid_filename` -- then made free by `get_available_name` (an
 * underscore and seven random letters and digits before the extensions,
 * the stem cut to keep the name within the column), written exclusively and
 * made `0o644`. The name stored in the row is what this answers.
 */
import { randomInt } from 'node:crypto';
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';

import { zoneOffsetSeconds } from './datetime';
import { pyStrip } from './python';

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** `get_random_string(7)`. */
function randomString(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)];
  return out;
}

/** `django.utils.text.get_valid_filename`, or null where Django raises. */
export function validFilename(name: string): string | null {
  const cleaned = pyStrip(name)
    .replaceAll(' ', '_')
    .replace(/[^-\p{L}\p{N}_.]/gu, '');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? null : cleaned;
}

/** `datetime.now().strftime(upload_to)` for the `%Y`, `%m` and `%d` an `upload_to` uses. */
export function strftimeLocal(pattern: string, timeZone: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const local = new Date((seconds + zoneOffsetSeconds(seconds, timeZone)) * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return pattern
    .replaceAll('%Y', String(local.getUTCFullYear()))
    .replaceAll('%m', pad(local.getUTCMonth() + 1))
    .replaceAll('%d', pad(local.getUTCDate()));
}

/** `"".join(pathlib.PurePath(name).suffixes)`: every extension; leading dots are not one. */
export function extensions(fileName: string): string {
  if (fileName.endsWith('.')) return '';
  const parts = fileName.replace(/^\.+/, '').split('.');
  return parts
    .slice(1)
    .map((part) => `.${part}`)
    .join('');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class MediaStorage {
  constructor(
    private readonly root: string,
    private readonly timeZone: string,
  ) {}

  /** `FieldFile.open("rb").read()`: the stored bytes, or null where the file is not there. */
  async read(name: string): Promise<Buffer | null> {
    try {
      return await readFile(posix.join(this.root, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * `FieldFile.save(name, content)`: store `bytes` as an upload named
   * `fileName` under `uploadTo`, and answer the stored name.
   */
  async save(uploadTo: string, fileName: string, bytes: Buffer, maxLength = 100): Promise<string> {
    const valid = validFilename(fileName);
    if (valid === null)
      throw new Error(`SuspiciousFileOperation: Could not derive file name from '${fileName}'`);
    const directory = strftimeLocal(uploadTo, this.timeZone).replace(/\/+$/, '');
    let name = posix.normalize(posix.join(directory, valid));
    const ext = extensions(valid);
    let root = valid.slice(0, valid.length - ext.length);
    const taken = async (candidate: string) =>
      (await exists(posix.join(this.root, candidate))) || Array.from(candidate).length > maxLength;
    for (;;) {
      while (await taken(name)) {
        name = posix.join(directory, `${root}_${randomString(7)}${ext}`);
        const truncation = Array.from(name).length - maxLength;
        if (truncation > 0) {
          root = Array.from(root).slice(0, -truncation).join('');
          if (!root) throw new Error('SuspiciousFileOperation: no available filename');
          name = posix.join(directory, `${root}_${randomString(7)}${ext}`);
        }
      }
      const full = posix.join(this.root, name);
      await mkdir(posix.dirname(full), { recursive: true });
      try {
        const handle = await open(full, 'wx');
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
      } catch (error) {
        // Another writer took the name between the check and the open.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      await chmod(full, 0o644);
      return name;
    }
  }
}
