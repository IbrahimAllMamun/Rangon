/**
 * CPython 3.12's `date.fromisoformat` and `datetime.fromisoformat`, ported
 * from `Modules/_datetimemodule.c` step for step, because both are far
 * looser than ISO 8601 and the Django API inherits every quirk:
 * `date.fromisoformat("2026010112")` is 1 January (the parser never checks
 * it reached the end), the date-time separator may be any character,
 * `T10:00:00.1234567x+05:00` is accepted, and `+05:99` is an offset of
 * 6:39.
 *
 * The C code walks the string's UTF-8 bytes with a NUL after the last one,
 * and so does this: positions are byte positions, a byte past the end reads
 * as 0, and a multi-byte character is several bytes no digit test accepts.
 * Every failure -- a malformed string or a value out of range, which Python
 * reports as different `ValueError`s -- is null here.
 */

export interface PyDate {
  year: number;
  month: number;
  day: number;
}

export interface PyDateTime extends PyDate {
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
  /** The fixed UTC offset in microseconds, or null for a naive value. */
  offset: number | null;
}

const DASH = 0x2d;
const COLON = 0x3a;
const W = 0x57;

class Bytes {
  readonly length: number;
  private readonly bytes: Buffer;

  constructor(text: string) {
    this.bytes = Buffer.from(text, 'utf8');
    this.length = this.bytes.length;
  }

  /** `dtstr[i]`: the terminating NUL past the end. */
  at(index: number): number {
    return index >= 0 && index < this.length ? (this.bytes[index] as number) : 0;
  }
}

const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;

/** `parse_digits`: exactly `count` ASCII digits from `at`, or null. */
function parseDigits(s: Bytes, at: number, count: number): [next: number, value: number] | null {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const byte = s.at(at + i);
    if (!isDigit(byte)) return null;
    value = value * 10 + (byte - 0x30);
  }
  return [at + count, value];
}

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeap(year) ? 29 : (DAYS_IN_MONTH[month] as number);
}

function daysBeforeMonth(year: number, month: number): number {
  return (DAYS_BEFORE_MONTH[month] as number) + (month > 2 && isLeap(year) ? 1 : 0);
}

export function ymdToOrd(year: number, month: number, day: number): number {
  const y = year - 1;
  return (
    y * 365 +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) +
    daysBeforeMonth(year, month) +
    day
  );
}

/** `ord_to_ymd`: day 1 is 0001-01-01. */
function ordToYmd(ordinal: number): PyDate {
  let n = ordinal - 1;
  const n400 = Math.floor(n / 146097);
  n -= n400 * 146097;
  const n100 = Math.floor(n / 36524);
  n -= n100 * 36524;
  const n4 = Math.floor(n / 1461);
  n -= n4 * 1461;
  const n1 = Math.floor(n / 365);
  n -= n1 * 365;
  const year = n400 * 400 + 1 + n100 * 100 + n4 * 4 + n1;
  if (n1 === 4 || n100 === 4) return { year: year - 1, month: 12, day: 31 };
  const leap = n1 === 3 && (n4 !== 24 || n100 === 3);
  let month = (n + 50) >> 5;
  let preceding = (DAYS_BEFORE_MONTH[month] as number) + (month > 2 && leap ? 1 : 0);
  if (preceding > n) {
    month -= 1;
    preceding -= month === 2 && leap ? 29 : (DAYS_IN_MONTH[month] as number);
  }
  return { year, month, day: n - preceding + 1 };
}

/** `iso_to_ymd`: an ISO year, week and weekday as a calendar date, or null. */
function isoToYmd(isoYear: number, week: number, weekday: number): PyDate | null {
  if (isoYear < 1 || isoYear > 9999) return null;
  if (week <= 0 || week >= 53) {
    let outOfRange = true;
    if (week === 53) {
      const firstWeekday = (ymdToOrd(isoYear, 1, 1) + 6) % 7;
      if (firstWeekday === 3 || (firstWeekday === 2 && isLeap(isoYear))) outOfRange = false;
    }
    if (outOfRange) return null;
  }
  if (weekday <= 0 || weekday >= 8) return null;
  const firstDay = ymdToOrd(isoYear, 1, 1);
  const firstWeekday = (firstDay + 6) % 7;
  let week1Monday = firstDay - firstWeekday;
  if (firstWeekday > 3) week1Monday += 7;
  return ordToYmd(week1Monday + (week - 1) * 7 + weekday - 1);
}

/** `parse_isoformat_date`, reading at most to `len` for the week's day. */
function parseIsoDate(s: Bytes, len: number): PyDate | null {
  let p = 0;
  const year = parseDigits(s, p, 4);
  if (!year) return null;
  p = year[0];
  const usesSeparator = s.at(p) === DASH;
  if (usesSeparator) p += 1;

  if (s.at(p) === W) {
    p += 1;
    const week = parseDigits(s, p, 2);
    if (!week) return null;
    p = week[0];
    let weekday = 1;
    if (p < len) {
      if (usesSeparator) {
        if (s.at(p) !== DASH) return null;
        p += 1;
      }
      const day = parseDigits(s, p, 1);
      if (!day) return null;
      weekday = day[1];
    }
    return isoToYmd(year[1], week[1], weekday);
  }

  const month = parseDigits(s, p, 2);
  if (!month) return null;
  p = month[0];
  if (usesSeparator) {
    if (s.at(p) !== DASH) return null;
    p += 1;
  }
  const day = parseDigits(s, p, 2);
  if (!day) return null;
  return { year: year[1], month: month[1], day: day[1] };
}

/** `new_date`'s range checks. */
function validDate(date: PyDate | null): PyDate | null {
  if (!date) return null;
  const { year, month, day } = date;
  if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return date;
}

/** `date.fromisoformat(text)`. */
export function dateFromIsoformat(text: string): PyDate | null {
  const s = new Bytes(text);
  if (s.length !== 7 && s.length !== 8 && s.length !== 10) return null;
  return validDate(parseIsoDate(s, s.length));
}

/** `_find_isoformat_datetime_separator`: where the date ends, or -1. */
function findSeparator(s: Bytes, len: number): number {
  if (len === 7) return 7;
  if (s.at(4) === DASH) {
    if (s.at(5) === W) {
      if (len < 8) return -1;
      if (len > 8 && s.at(8) === DASH) {
        if (len === 9) return -1;
        if (len > 10 && isDigit(s.at(10))) return 8;
        return 10;
      }
      return 8;
    }
    return 10;
  }
  if (s.at(4) === W) {
    let index = 7;
    for (; index < len; index++) if (!isDigit(s.at(index))) break;
    if (index < 9) return index;
    return index % 2 === 0 ? 7 : 8;
  }
  return 8;
}

interface Clock {
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
}

/**
 * `parse_hh_mm_ss_ff` over `[from, end)`: 0 when it ends cleanly, 1 when
 * something follows (which only matters with no offset after it), null for
 * a malformed time.
 */
function parseClock(s: Bytes, from: number, end: number, clock: Clock): 0 | 1 | null {
  clock.hour = clock.minute = clock.second = clock.microsecond = 0;
  const fields = ['hour', 'minute', 'second'] as const;
  let p = from;
  let hasSeparator = true;
  for (let i = 0; i < 3; i++) {
    const parsed = parseDigits(s, p, 2);
    if (!parsed) return null;
    p = parsed[0];
    clock[fields[i] as (typeof fields)[number]] = parsed[1];
    const c = s.at(p);
    p += 1;
    if (i === 0) hasSeparator = c === COLON;
    if (p >= end) return c !== 0 ? 1 : 0;
    if (hasSeparator && c === COLON) continue;
    if (c === 0x2e || c === 0x2c) break;
    if (!hasSeparator) p -= 1;
    else return null;
  }
  // The fraction: after a `.` or `,`, or straight on after three fields.
  const remains = end - p;
  const toParse = remains >= 6 ? 6 : remains;
  const digits = parseDigits(s, p, toParse);
  if (!digits) return null;
  p = digits[0];
  let microsecond = digits[1];
  if (toParse < 6) microsecond *= [100000, 10000, 1000, 100, 10][toParse - 1] as number;
  clock.microsecond = microsecond;
  while (isDigit(s.at(p))) p += 1;
  return s.at(p) !== 0 ? 1 : 0;
}

/** `parse_isoformat_time` over `[from, from + len)`: the clock and its offset, or null. */
function parseTime(
  s: Bytes,
  from: number,
  len: number,
): (Clock & { offset: number | null }) | null {
  const end = from + len;
  let tz = from;
  do {
    const c = s.at(tz);
    if (c === 0x5a || c === 0x2b || c === DASH) break;
  } while (++tz < end);

  const clock: Clock = { hour: 0, minute: 0, second: 0, microsecond: 0 };
  const rv = parseClock(s, from, tz, clock);
  if (rv === null) return null;
  if (tz === end) return rv === 1 ? null : { ...clock, offset: null };
  if (s.at(tz) === 0x5a) {
    return s.at(tz + 1) !== 0 ? null : { ...clock, offset: 0 };
  }
  const sign = s.at(tz) === DASH ? -1 : 1;
  const zone: Clock = { hour: 0, minute: 0, second: 0, microsecond: 0 };
  const zoneRv = parseClock(s, tz + 1, end, zone);
  if (zoneRv !== 0) return null;
  const seconds = zone.hour * 3600 + zone.minute * 60 + zone.second;
  // `tzinfo_from_isoformat_results`: zero whole seconds is UTC, any fraction dropped.
  return { ...clock, offset: seconds === 0 ? 0 : sign * (seconds * 1_000_000 + zone.microsecond) };
}

/** `datetime.fromisoformat(text)`. */
export function datetimeFromIsoformat(text: string): PyDateTime | null {
  // `_sanitize_isoformat_str`: fewer than seven characters is never valid.
  if (Array.from(text).length < 7) return null;
  const s = new Bytes(text);
  const len = s.length;
  const separator = findSeparator(s, len);
  const date = parseIsoDate(s, separator === -1 ? Infinity : separator);
  if (!date) return null;
  let time: (Clock & { offset: number | null }) | null = {
    hour: 0,
    minute: 0,
    second: 0,
    microsecond: 0,
    offset: null,
  };
  if (len > separator) {
    // The separator may be any character: skip all of its UTF-8 bytes.
    const lead = s.at(separator);
    const width =
      (lead & 0x80) === 0 ? 1 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf0) === 0xf0 ? 4 : 2;
    const from = separator + width;
    time = parseTime(s, from, len - from);
    if (!time) return null;
  }
  // `timezone(timedelta(...))`: strictly inside a day either way.
  if (time.offset !== null && Math.abs(time.offset) >= 86_400_000_000) return null;
  if (!validDate(date)) return null;
  if (time.hour > 23 || time.minute > 59 || time.second > 59) return null;
  return { ...date, ...time };
}
