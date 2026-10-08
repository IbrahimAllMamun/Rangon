import type { AwareMoment } from '../../common/datetime-field';
import { localIso, parsePgTimestamptz } from '../../common/datetime';
import { type Errors, InvalidFields } from '../../common/drf';
import type { MediaStorage } from '../../common/storage';
import type { UploadedFile } from '../../http/multipart';

/**
 * What `ScheduledContentSerializer` shares between navigation items and
 * banners: the publish window, the uploaded image, and how a datetime reads
 * back in a response.
 */

/** A window bound as validated (`AwareMoment`) or as the row holds it (timestamptz text). */
export type Bound = AwareMoment | string | null;

/**
 * `validate()`'s first rule: the window must not end before it starts. Two
 * values from the request share the shop's zone and compare by wall clock, as
 * Python compares datetimes with one `tzinfo`; anything read from the row is
 * UTC and compares by instant.
 */
export function checkWindow(startsAt: Bound, endsAt: Bound): void {
  if (!startsAt || !endsAt) return;
  const instant = (bound: AwareMoment | string) =>
    typeof bound === 'string' ? pgMicros(bound) : bound.micros;
  const before =
    typeof startsAt !== 'string' && typeof endsAt !== 'string'
      ? endsAt.wall < startsAt.wall
      : instant(endsAt) < instant(startsAt);
  if (before)
    throw new InvalidFields({
      ends_at: [{ message: 'The window must end after it starts.', code: 'invalid' }],
    });
}

function pgMicros(text: string): bigint {
  const { epochSeconds, microseconds } = parsePgTimestamptz(text);
  return BigInt(epochSeconds) * 1_000_000n + BigInt(microseconds);
}

/** A bound for the database: what psycopg sends, or the row's own text. */
export function boundParam(bound: Bound): string | null {
  if (bound === null) return null;
  return typeof bound === 'string' ? bound : bound.pg;
}

/**
 * A `DateTimeField` in a response. A value set by this request is the
 * datetime as DRF validated it; one read from the row is converted to the
 * shop's zone.
 */
export function boundIso(bound: Bound, timeZone: string): string | null {
  if (bound === null) return null;
  return typeof bound === 'string' ? localIso(bound, timeZone) : bound.iso;
}

/** `Model.clean()` raising `DjangoValidationError({field: message})`: the serializer's errors. */
export function cleanError(field: string, message: string): InvalidFields {
  const errors: Errors = { [field]: [{ message, code: 'invalid' }] };
  return new InvalidFields(errors);
}

/**
 * The image column after a write: an upload is stored under `uploadTo` (the
 * field's `pre_save`), `None` clears it to "" (`str()` of an empty
 * `FieldFile`), and leaving it out keeps what was there.
 */
export async function storedImage(
  storage: MediaStorage,
  uploadTo: string,
  value: UploadedFile | null | undefined,
  current: string,
): Promise<string> {
  if (value === undefined) return current;
  if (value === null) return '';
  return storage.save(uploadTo, value.name, value.bytes, value.contentType);
}
