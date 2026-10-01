import { zoneOffsetSeconds } from './datetime';
import { emptyValue, type Field, Invalid } from './drf';
import { datetimeFromIsoformat, type PyDateTime, ymdToOrd } from './isoformat';
import { pyIntText } from './python';

/**
 * DRF's `serializers.DateTimeField` with Django's `parse_datetime`, as the
 * content admin's publish windows read them (`starts_at`, `ends_at`).
 *
 * `parse_datetime` tries CPython's `datetime.fromisoformat` (common/isoformat.ts)
 * and then Django's own pattern, whose `\d` takes any script's digits.
 * `enforce_timezone` converts an aware value to the shop's zone -- out of
 * Python's datetime range it is "out of range" -- and makes a naive one aware
 * there with zoneinfo's `fold=0`. DRF 3.15's `valid_datetime` then accepts
 * every time, a wall clock the zone skipped or showed twice included (under
 * PEP 495 such a time never equals itself in UTC, so its "exists" test
 * short-circuits its "ambiguous" one) -- but converting a naive time early on
 * 1 January of the year 1 to UTC overflows, uncaught: a 500.
 */

export interface AwareMoment {
  /** `str(value)`: what psycopg sends PostgreSQL for the aware datetime. */
  pg: string;
  /** Microseconds since the epoch. */
  micros: bigint;
  /** The wall clock in the shop's zone, as microseconds: two values in one zone compare by it. */
  wall: bigint;
  /** DRF's `to_representation`: `isoformat()` in the shop's zone, `Z` for UTC. */
  iso: string;
}

const PY_S =
  '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const D = '\\p{Nd}';
/** `django.utils.dateparse.datetime_re`, for `re.match`: anchored at the start, `$` before a last newline too. */
const DATETIME_RE = new RegExp(
  `^(${D}{4})-(${D}{1,2})-(${D}{1,2})[T ](${D}{1,2}):(${D}{1,2})` +
    `(?::(${D}{1,2})(?:[.,](${D}{1,6})${D}{0,6})?)?` +
    `${PY_S}*(Z|[+-]${D}{2}(?::?${D}{2})?)?\\n?$`,
  'u',
);

const num = (text: string) => Number(pyIntText(text));
const pad = (value: number, width: number) => String(value).padStart(width, '0');
/** `date(1970, 1, 1).toordinal()`. */
const EPOCH_ORDINAL = 719_163;
const MINUTE = 60_000_000;

function daysInMonth(year: number, month: number): number {
  return [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1] as number;
}

/** `datetime(...)`'s range checks: null where Python raises `ValueError`. */
function checked(moment: PyDateTime): PyDateTime | null {
  const { year, month, day, hour, minute, second, microsecond } = moment;
  if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59 || microsecond > 999_999) return null;
  return moment;
}

/** `parse_datetime(value)`: a datetime, or null where it returns None or raises. */
export function parseDatetime(value: string): PyDateTime | null {
  const iso = datetimeFromIsoformat(value);
  if (iso) return iso;
  const match = DATETIME_RE.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, tz] = match as unknown as string[];
  let offset: number | null = null;
  if (tz === 'Z') offset = 0;
  else if (tz !== undefined) {
    const minutes = tz.length > 3 ? num(tz.slice(-2)) : 0;
    let total = 60 * num(tz.slice(1, 3)) + minutes;
    if (tz.startsWith('-')) total = -total;
    // `timezone(timedelta(minutes=...))` refuses a day or more.
    if (Math.abs(total) >= 1440) return null;
    offset = total * MINUTE;
  }
  return checked({
    year: num(year as string),
    month: num(month as string),
    day: num(day as string),
    hour: num(hour as string),
    minute: num(minute as string),
    second: second === undefined ? 0 : num(second),
    microsecond: fraction === undefined ? 0 : num(fraction.padEnd(6, '0')),
    offset,
  });
}

/** The wall clock as microseconds since the epoch, as if it were UTC. */
function wallMicros(m: PyDateTime): bigint {
  const days = BigInt(ymdToOrd(m.year, m.month, m.day) - EPOCH_ORDINAL);
  const seconds = days * 86_400n + BigInt(m.hour * 3600 + m.minute * 60 + m.second);
  return seconds * 1_000_000n + BigInt(m.microsecond);
}

/** Python's datetime range, as microseconds since the epoch of a wall clock. */
const MIN_WALL = wallMicros({
  year: 1,
  month: 1,
  day: 1,
  hour: 0,
  minute: 0,
  second: 0,
  microsecond: 0,
  offset: null,
});
const MAX_WALL = wallMicros({
  year: 9999,
  month: 12,
  day: 31,
  hour: 23,
  minute: 59,
  second: 59,
  microsecond: 999_999,
  offset: null,
});

/** The zone's offset (seconds) for an instant, as zoneinfo's `fromutc` finds it. */
function offsetAt(utcMicros: bigint, timeZone: string): number {
  const seconds = Number(utcMicros / 1_000_000n - (utcMicros % 1_000_000n < 0n ? 1n : 0n));
  return zoneOffsetSeconds(seconds, timeZone);
}

/**
 * zoneinfo's `utcoffset` for a naive wall clock (seconds): with `fold=0` the
 * offset in force before a transition, with `fold=1` the one after.
 */
function wallOffset(wall: bigint, timeZone: string, fold: 0 | 1): number {
  const around = (shift: bigint) => offsetAt(wall + shift, timeZone);
  const before = around(-86_400_000_000n);
  const after = around(86_400_000_000n);
  const fits = (offset: number) =>
    offsetAt(wall - BigInt(offset) * 1_000_000n, timeZone) === offset;
  if (before === after) return before;
  const first = fold === 0 ? before : after;
  const second = fold === 0 ? after : before;
  if (fits(first) && !fits(second)) return first;
  if (fits(second) && !fits(first)) return second;
  return first;
}

function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const abs = Math.abs(seconds);
  const text = `${sign}${pad(Math.floor(abs / 3600), 2)}:${pad(Math.floor((abs % 3600) / 60), 2)}`;
  return abs % 60 ? `${text}:${pad(abs % 60, 2)}` : text;
}

/** An aware value in the zone: `str()`, `isoformat()` and its instant. */
function moment(wall: bigint, offsetSeconds: number): AwareMoment {
  const micros = wall - BigInt(offsetSeconds) * 1_000_000n;
  const fraction = Number(((wall % 1_000_000n) + 1_000_000n) % 1_000_000n);
  const wallSeconds = (wall - BigInt(fraction)) / 1_000_000n;
  const days = Number(wallSeconds / 86_400n - (wallSeconds % 86_400n < 0n ? 1n : 0n));
  const secondOfDay = Number(wallSeconds - BigInt(days) * 86_400n);
  const date = new Date(0);
  date.setUTCFullYear(1970, 0, 1 + days);
  const day = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
  const time = `${pad(Math.floor(secondOfDay / 3600), 2)}:${pad(Math.floor((secondOfDay % 3600) / 60), 2)}:${pad(secondOfDay % 60, 2)}`;
  const micro = fraction ? `.${pad(fraction, 6)}` : '';
  const offset = formatOffset(offsetSeconds);
  return {
    pg: `${day} ${time}${micro}${offset}`,
    micros,
    wall,
    iso: `${day}T${time}${micro}${offset === '+00:00' ? 'Z' : offset}`,
  };
}

/** `DateTimeField.enforce_timezone`, with the shop's zone current. */
export function enforceTimezone(value: PyDateTime, timeZone: string): AwareMoment {
  const wall = wallMicros(value);
  if (value.offset !== null) {
    // `value.astimezone(zone)`: to UTC, then to the zone, each in range.
    const utc = wall - BigInt(value.offset);
    if (utc < MIN_WALL || utc > MAX_WALL)
      throw Invalid.of('Datetime value out of range.', 'overflow');
    const offset = offsetAt(utc, timeZone);
    const local = utc + BigInt(offset) * 1_000_000n;
    if (local < MIN_WALL || local > MAX_WALL)
      throw Invalid.of('Datetime value out of range.', 'overflow');
    return moment(local, offset);
  }
  // `make_aware` (fold=0), then `valid_datetime`, whose `astimezone(utc)` can overflow.
  const offset = wallOffset(wall, timeZone, 0);
  const utc = wall - BigInt(offset) * 1_000_000n;
  if (utc < MIN_WALL || utc > MAX_WALL) throw new Error('OverflowError: date value out of range');
  return moment(wall, offset);
}

/** `serializers.DateTimeField(...)`, in the shop's zone. */
export function dateTimeField(
  timeZone: string,
  options: { required?: boolean; allowNull?: boolean } = {},
): Field<AwareMoment | null> {
  return {
    run(data, partial) {
      const settled = emptyValue<AwareMoment>(data, partial, {
        required: options.required ?? true,
        allowNull: options.allowNull ?? false,
      });
      if (settled.settled) return settled.value;
      const parsed = typeof data === 'string' ? parseDatetime(data) : null;
      if (!parsed)
        throw Invalid.of(
          'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
          'invalid',
        );
      return enforceTimezone(parsed, timeZone);
    },
  };
}
