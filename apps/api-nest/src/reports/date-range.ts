/**
 * `reports.services.DateRange`: the window a report covers.
 *
 * An explicit `date_from` or `date_to` (`core.dates.parse_moment`: a whole day
 * or an exact moment, refused when unreadable) wins, the missing end being
 * thirty days back or now. Otherwise a preset, every one anchored to the
 * shop's calendar day: an unknown one is the default, and says so.
 *
 * A moment is kept as the text psycopg sends PostgreSQL for an aware
 * datetime -- `str(value)`, offset and all -- which is also what DRF's
 * encoder prints once the space is a `T` and `+00:00` a `Z`.
 */
import { parseMoment } from '../common/dates';
import { zoneOffsetSeconds } from '../common/datetime';
import { ordToYmd, ymdToOrd } from '../common/isoformat';
import type { QueryDict } from '../common/query-dict';

export interface DateRange {
  /** `str(datetime)` of each end, for a `::timestamptz` parameter. */
  start: string;
  end: string;
  label: string;
}

const PRESETS = ['today', 'yesterday', '7d', '30d', '90d', 'month', 'last_month', 'year'];
const DEFAULT_PRESET = '30d';
const DAY_COUNTS: Readonly<Record<string, number>> = { '7d': 7, '30d': 30, '90d': 90 };

/** `date(1970, 1, 1).toordinal()`. */
const EPOCH_ORDINAL = 719_163;
/** `date.max.toordinal()`. */
export const MAX_ORDINAL = 3_652_059;

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** `str()` of an aware UTC datetime: the fraction is left out when it is zero. */
function utcText(epochMs: number): string {
  const moment = new Date(epochMs);
  const ms = moment.getUTCMilliseconds();
  return (
    `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())} ` +
    `${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())}` +
    `${ms ? `.${pad(ms, 3)}000` : ''}+00:00`
  );
}

/** A proleptic ordinal as `YYYY-MM-DD`. */
export function ordinalDate(ordinal: number): string {
  const { year, month, day } = ordToYmd(ordinal);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** `_day_start(day)` and `_day_end(day)`: the day's first and last instant on the shop's clock. */
function dayBound(ordinal: number, end: boolean, timeZone: string): string {
  return parseMoment(ordinalDate(ordinal), end, timeZone) as string;
}

/** `DateRange.from_params(params)`, with `timezone.now()` as given. */
export function dateRangeFromParams(
  params: QueryDict,
  timeZone: string,
  nowMs: number = Date.now(),
): DateRange {
  const now = utcText(nowMs);
  const startParam = params.get('date_from');
  const endParam = params.get('date_to');
  if (startParam || endParam) {
    const start = parseMoment(startParam, false, timeZone) ?? utcText(nowMs - 30 * 86_400_000);
    const end = parseMoment(endParam, true, timeZone) ?? now;
    return { start, end, label: 'custom' };
  }

  let preset = params.get('range') || DEFAULT_PRESET;
  if (!PRESETS.includes(preset)) preset = DEFAULT_PRESET;

  // `timezone.localdate(now)`.
  const epoch = Math.floor(nowMs / 1000);
  const today = EPOCH_ORDINAL + Math.floor((epoch + zoneOffsetSeconds(epoch, timeZone)) / 86_400);
  const { year, month } = ordToYmd(today);
  const start = (ordinal: number) => dayBound(ordinal, false, timeZone);
  const end = (ordinal: number) => dayBound(ordinal, true, timeZone);
  const firstOfMonth = ymdToOrd(year, month, 1);

  switch (preset) {
    case 'today':
      return { start: start(today), end: now, label: preset };
    case 'yesterday':
      return { start: start(today - 1), end: end(today - 1), label: preset };
    case 'month':
      return { start: start(firstOfMonth), end: now, label: preset };
    case 'last_month': {
      const lastDay = firstOfMonth - 1;
      const last = ordToYmd(lastDay);
      return { start: start(ymdToOrd(last.year, last.month, 1)), end: end(lastDay), label: preset };
    }
    case 'year':
      return { start: start(ymdToOrd(year, 1, 1)), end: now, label: preset };
    default:
      return {
        start: start(today - ((DAY_COUNTS[preset] as number) - 1)),
        end: now,
        label: preset,
      };
  }
}

const MOMENT =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([+-])(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * `timezone.localdate(moment).toordinal()`: the shop's calendar day an
 * instant falls on. Past the last day `date` can hold, `astimezone` raises
 * `OverflowError`, which nothing catches.
 */
export function localOrdinal(moment: string, timeZone: string): number {
  const match = MOMENT.exec(moment);
  if (!match) throw new Error(`Unrecognised moment: ${moment}`);
  const [, y, mo, d, h, mi, s, sign, oh, om, os] = match;
  const offset = (sign === '-' ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60 + Number(os ?? 0));
  const utc =
    (ymdToOrd(Number(y), Number(mo), Number(d)) - EPOCH_ORDINAL) * 86_400 +
    Number(h) * 3600 +
    Number(mi) * 60 +
    Number(s) -
    offset;
  const ordinal = EPOCH_ORDINAL + Math.floor((utc + zoneOffsetSeconds(utc, timeZone)) / 86_400);
  if (ordinal < 1 || ordinal > MAX_ORDINAL)
    throw new Error('OverflowError: date value out of range');
  return ordinal;
}

/** DRF's encoder on an aware datetime: `isoformat()`, a UTC offset written `Z`. */
export function momentJson(moment: string): string {
  const iso = moment.replace(' ', 'T');
  return iso.endsWith('+00:00') ? `${iso.slice(0, -6)}Z` : iso;
}
