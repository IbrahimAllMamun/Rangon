/**
 * Django's default storage, as a model `FileField` saves an upload: the name
 * built by `FileField.generate_filename` -- `upload_to` through `strftime` on
 * the server's local clock, the file name cleaned by `get_valid_filename` --
 * then made free by `get_available_name` (an underscore and seven random
 * letters and digits before the extensions, the stem cut to keep the name
 * within the column). The name stored in the row is what `save` answers.
 *
 * Two places to keep the bytes, chosen by `USE_S3` as Django's settings
 * choose: `FileSystemStorage` under `MEDIA_ROOT` (written exclusively, made
 * `0o644`), and django-storages' `S3Storage` (one object in the bucket, with
 * its type). `mediaStorage(env)` is the one this process uses.
 */
import { randomInt } from 'node:crypto';
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';

import type { Env } from '../config/env';
import { zoneOffsetSeconds } from './datetime';
import { guessType } from './mimetypes';
import { pyStrip } from './python';
import { cleanName, S3Client, s3Key, type S3Settings } from './s3';

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

export abstract class MediaStorage {
  constructor(private readonly timeZone: string) {}

  /** `FieldFile.open("rb").read()`: the stored bytes, or null where the file is not there. */
  abstract read(name: string): Promise<Buffer | null>;

  /** `Storage.exists(name)`. */
  protected abstract exists(name: string): Promise<boolean>;

  /**
   * `Storage._save(name, content)`: the name as stored, or null where the
   * name was taken between the check and the write and another is wanted.
   */
  protected abstract write(
    name: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<string | null>;

  /**
   * `FieldFile.save(name, content)`: store `bytes` as an upload named
   * `fileName` under `uploadTo`, and answer the stored name. `contentType` is
   * the upload's own -- what Pillow found for an image, what the client
   * claimed for anything else -- which only a bucket keeps.
   */
  async save(
    uploadTo: string,
    fileName: string,
    bytes: Buffer,
    contentType = '',
    maxLength = 100,
  ): Promise<string> {
    const valid = validFilename(fileName);
    if (valid === null)
      throw new Error(`SuspiciousFileOperation: Could not derive file name from '${fileName}'`);
    const directory = strftimeLocal(uploadTo, this.timeZone).replace(/\/+$/, '');
    let name = posix.normalize(posix.join(directory, valid));
    const ext = extensions(valid);
    let root = valid.slice(0, valid.length - ext.length);
    const taken = async (candidate: string) =>
      (await this.exists(candidate)) || Array.from(candidate).length > maxLength;
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
      const stored = await this.write(name, bytes, contentType);
      if (stored !== null) return stored;
    }
  }
}

/** `FileSystemStorage` under `MEDIA_ROOT`. */
export class DiskStorage extends MediaStorage {
  constructor(
    private readonly root: string,
    timeZone: string,
  ) {
    super(timeZone);
  }

  async read(name: string): Promise<Buffer | null> {
    try {
      return await readFile(posix.join(this.root, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  protected exists(name: string): Promise<boolean> {
    return exists(posix.join(this.root, name));
  }

  protected async write(name: string, bytes: Buffer): Promise<string | null> {
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
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw error;
    }
    await chmod(full, 0o644);
    return name;
  }
}

/** `S3Storage`'s `default_content_type`. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * django-storages' `S3Storage`, with `file_overwrite=False`: a name is free
 * when a HEAD of its key finds nothing, and the write is one PUT. Nothing
 * makes that exclusive -- two uploads that pick one name in the same moment
 * leave one object, as they do under Django.
 */
export class S3MediaStorage extends MediaStorage {
  private readonly client: S3Client;

  constructor(settings: S3Settings, timeZone: string, client?: S3Client) {
    super(timeZone);
    this.client = client ?? new S3Client(settings);
  }

  /** `S3Storage._open`: `FileNotFoundError` -- here null -- where S3 says 404. */
  read(name: string): Promise<Buffer | null> {
    return this.client.get(s3Key(name));
  }

  protected exists(name: string): Promise<boolean> {
    return this.client.exists(s3Key(name));
  }

  /**
   * `S3Storage._save`: the type is the upload's own, else what the name's
   * extension says, else the default; a name that says how it is packed
   * (`.gz`) is stored saying so. The name answered is the cleaned one.
   */
  protected async write(name: string, bytes: Buffer, contentType: string): Promise<string | null> {
    const key = s3Key(name);
    const [guessed, encoding] = guessType(key);
    await this.client.put(key, bytes, {
      contentType: contentType || guessed || DEFAULT_CONTENT_TYPE,
      contentEncoding: encoding,
    });
    return cleanName(name);
  }
}

/** `django.core.files.storage.default_storage`, for these settings. */
export function mediaStorage(
  env: Pick<Env, 's3' | 'MEDIA_ROOT' | 'DJANGO_TIME_ZONE'>,
): MediaStorage {
  return env.s3
    ? new S3MediaStorage(env.s3, env.DJANGO_TIME_ZONE)
    : new DiskStorage(env.MEDIA_ROOT, env.DJANGO_TIME_ZONE);
}
