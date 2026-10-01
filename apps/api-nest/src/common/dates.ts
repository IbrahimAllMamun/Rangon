/**
 * `core.dates`: a date window off a query string, as the cash book, the
 * reports and the stock ledger read one.
 *
 * A bare day (`date.fromisoformat`) is widened to the whole of itself --
 * midnight for `date_from`, `23:59:59.999999` for `date_to`; anything else
 * goes to `datetime.fromisoformat`, with every quirk of CPython's parser
 * (common/isoformat.ts). A naive value is the shop's local time, made aware
 * the way zoneinfo does it. Anything unreadable is refused, never dropped.
 *
 * The answer is what psycopg sends PostgreSQL for the aware datetime --
 * `str(value)`, offset and all -- for a `::timestamptz` parameter, so the
 * database reads the same instant from the same text.
 */
import { wallOffsetSeconds } from './datetime';
import { ValidationError } from './errors';
import { dateFromIsoformat, datetimeFromIsoformat, type PyDateTime, ymdToOrd } from './isoformat';
import { pyStrip } from './python';
import type { QueryDict } from './query-dict';

/** `date(1970, 1, 1).toordinal()`. */
const EPOCH_ORDINAL = 719_163;

const pad = (value: number, width: number) => String(value).padStart(width, '0');

/** Python's `_format_offset` for an offset in microseconds: `+06:00`, `+06:01:40`. */
function formatOffset(microseconds: number): string {
  const sign = microseconds < 0 ? '-' : '+';
  const abs = Math.abs(microseconds);
  const hours = Math.floor(abs / 3_600_000_000);
  const minutes = Math.floor((abs % 3_600_000_000) / 60_000_000);
  const seconds = Math.floor((abs % 60_000_000) / 1_000_000);
  const fraction = abs % 1_000_000;
  let text = `${sign}${pad(hours, 2)}:${pad(minutes, 2)}`;
  if (seconds || fraction) {
    text += `:${pad(seconds, 2)}`;
    if (fraction) text += `.${pad(fraction, 6)}`;
  }
  return text;
}

/** `str(datetime)` of an aware value. */
function pyStrDatetime(moment: PyDateTime, offset: number): string {
  const date = `${pad(moment.year, 4)}-${pad(moment.month, 2)}-${pad(moment.day, 2)}`;
  const time = `${pad(moment.hour, 2)}:${pad(moment.minute, 2)}:${pad(moment.second, 2)}`;
  const fraction = moment.microsecond ? `.${pad(moment.microsecond, 6)}` : '';
  return `${date} ${time}${fraction}${formatOffset(offset)}`;
}

/** `parse_moment(value, end_of_day=...)`: the instant as PostgreSQL should read it, or null. */
export function parseMoment(
  value: string | undefined,
  endOfDay: boolean,
  timeZone: string,
): string | null {
  if (value === undefined || value === '') return null;
  const text = pyStrip(value);
  let moment: PyDateTime | null;
  const day = dateFromIsoformat(text);
  if (day) {
    moment = endOfDay
      ? { ...day, hour: 23, minute: 59, second: 59, microsecond: 999_999, offset: null }
      : { ...day, hour: 0, minute: 0, second: 0, microsecond: 0, offset: null };
  } else {
    moment = datetimeFromIsoformat(text);
    if (!moment) {
      throw new ValidationError(`“${text}” is not a date. Use YYYY-MM-DD, or a full timestamp.`, {
        details: { value: text },
      });
    }
  }
  let offset = moment.offset;
  if (offset === null) {
    const wall =
      (ymdToOrd(moment.year, moment.month, moment.day) - EPOCH_ORDINAL) * 86_400 +
      moment.hour * 3600 +
      moment.minute * 60 +
      moment.second;
    offset = wallOffsetSeconds(wall, timeZone) * 1_000_000;
  }
  return pyStrDatetime(moment, offset);
}

/** `parse_window(params)`: `date_from` and `date_to`, as an inclusive window. */
export function parseWindow(
  params: QueryDict,
  timeZone: string,
): [from: string | null, to: string | null] {
  return [
    parseMoment(params.get('date_from'), false, timeZone),
    parseMoment(params.get('date_to'), true, timeZone),
  ];
}
