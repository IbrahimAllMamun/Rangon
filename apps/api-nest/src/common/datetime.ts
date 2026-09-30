/**
 * Timestamps exactly as the Django API writes them.
 *
 * The database session runs in UTC (as Django's does with `USE_TZ = True`), so
 * a `timestamptz` arrives as text like `2026-09-29 10:11:12.123456+00`. It is
 * never turned into a JavaScript `Date`, which would drop the microseconds
 * Python keeps.
 *
 * Django emits two shapes, and which one depends on the code path:
 *
 * - `utcIso`: a datetime put straight into a response dict. DRF's JSON encoder
 *   calls `isoformat()` on the UTC value and swaps `+00:00` for `Z`.
 * - `localIso`: a datetime through a serializer `DateTimeField`, which first
 *   converts to the current time zone (`TIME_ZONE`, Asia/Dhaka), so it reads
 *   `+06:00`.
 */

interface PgTimestamp {
  /** Seconds since the epoch, whole. */
  epochSeconds: number;
  /** Python's microsecond field: 0 to 999999. */
  microseconds: number;
}

const PG_TIMESTAMPTZ =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-]\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/;

export function parsePgTimestamptz(text: string): PgTimestamp {
  const match = PG_TIMESTAMPTZ.exec(text);
  if (!match) throw new Error(`Unrecognised timestamptz: ${text}`);
  const [, y, mo, d, h, mi, s, frac, offH, offM, offS] = match;
  const offsetSign = (offH as string).startsWith('-') ? -1 : 1;
  const offsetSeconds =
    offsetSign * (Math.abs(Number(offH)) * 3600 + Number(offM ?? 0) * 60 + Number(offS ?? 0));
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return {
    epochSeconds: wall / 1000 - offsetSeconds,
    microseconds: frac ? Number(frac.padEnd(6, '0')) : 0,
  };
}

/** Python `datetime.isoformat()` of an aware UTC value, with DRF's `Z`. */
export function utcIso(text: string | null): string | null {
  if (text === null) return null;
  const { epochSeconds, microseconds } = parsePgTimestamptz(text);
  return `${wallClock(epochSeconds, 0)}${fraction(microseconds)}Z`;
}

/** A serializer `DateTimeField`: converted to `timeZone`, then `isoformat()`. */
export function localIso(text: string | null, timeZone: string): string | null {
  if (text === null) return null;
  const { epochSeconds, microseconds } = parsePgTimestamptz(text);
  const offset = zoneOffsetSeconds(epochSeconds, timeZone);
  const suffix = offset === 0 ? 'Z' : formatOffset(offset);
  return `${wallClock(epochSeconds, offset)}${fraction(microseconds)}${suffix}`;
}

function wallClock(epochSeconds: number, offsetSeconds: number): string {
  // toISOString is `YYYY-MM-DDTHH:MM:SS.sssZ`; the first 19 characters are the
  // wall clock at the given offset.
  return new Date((epochSeconds + offsetSeconds) * 1000).toISOString().slice(0, 19);
}

function fraction(microseconds: number): string {
  // isoformat() prints six digits when there is a fraction and none when it is zero.
  return microseconds ? `.${String(microseconds).padStart(6, '0')}` : '';
}

function formatOffset(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const abs = Math.abs(offsetSeconds);
  const hours = String(Math.floor(abs / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
  const seconds = abs % 60;
  return `${sign}${hours}:${minutes}${seconds ? `:${String(seconds).padStart(2, '0')}` : ''}`;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's UTC offset at that instant, from the platform's tz database. */
export function zoneOffsetSeconds(epochSeconds: number, timeZone: string): number {
  let formatter = offsetFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epochSeconds * 1000)).map((part) => [part.type, part.value]),
  );
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return local / 1000 - epochSeconds;
}
