/**
 * What Django's model fields make of a query-string value handed straight to
 * a lookup (`filter(occurred_at__gte=value)`, `filter(placed_at__date__gte=value)`).
 * A value the field cannot read is Django's own `ValidationError`, which the
 * API answers as a 400 with the message under `non_field_errors`.
 */
import { enforceTimezone, parseDatetime } from './datetime-field';
import { gregorian } from './drf';
import { ValidationError } from './errors';
import { dateFromIsoformat } from './isoformat';
import { pyIntText } from './python';

const refuse = (message: string) =>
  new ValidationError('Invalid input.', { details: { non_field_errors: [message] } });

const DATE_RE = /^(\p{Nd}{4})-(\p{Nd}{1,2})-(\p{Nd}{1,2})\n?$/u;
/** Django's `datetime_re`: the shape `parse_datetime` reads once `fromisoformat` has refused. */
const DATETIME_RE =
  /^\p{Nd}{4}-\p{Nd}{1,2}-\p{Nd}{1,2}[T ]\p{Nd}{1,2}:\p{Nd}{1,2}(?::\p{Nd}{1,2}(?:[.,]\p{Nd}{1,6}\p{Nd}{0,6})?)?\s*(?:Z|[+-]\p{Nd}{2}(?::?\p{Nd}{2})?)?\n?$/u;

/** `parse_date`: a date, null where it returns None, 'invalid' where it raises. */
function parseDate(value: string): string | null | 'invalid' {
  const iso = dateFromIsoformat(value);
  if (iso) return gregorian(iso.year, iso.month, iso.day) as string;
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map((part) => Number(pyIntText(part as string)));
  return gregorian(year as number, month as number, day as number) ?? 'invalid';
}

/** `DateField.to_python(value)`: `YYYY-MM-DD`. */
export function lookupDate(value: string): string {
  const date = parseDate(value);
  if (date === 'invalid')
    throw refuse(`“${value}” value has the correct format (YYYY-MM-DD) but it is an invalid date.`);
  if (date === null)
    throw refuse(`“${value}” value has an invalid date format. It must be in YYYY-MM-DD format.`);
  return date;
}

/**
 * `DateTimeField.to_python(value)`, then `get_prep_value`: a datetime, or a
 * date read as its midnight; a naive value is taken to be in the shop's zone.
 * Answers the instant as PostgreSQL should read it.
 */
export function lookupDateTime(value: string, timeZone: string): string {
  const parsed = parseDatetime(value);
  if (parsed) return enforceTimezone(parsed, timeZone).pg;
  if (DATETIME_RE.test(value)) {
    throw refuse(
      `“${value}” value has the correct format (YYYY-MM-DD HH:MM[:ss[.uuuuuu]][TZ]) but it is an invalid date/time.`,
    );
  }
  const date = parseDate(value);
  if (date === 'invalid')
    throw refuse(`“${value}” value has the correct format (YYYY-MM-DD) but it is an invalid date.`);
  if (date === null) {
    throw refuse(
      `“${value}” value has an invalid format. It must be in YYYY-MM-DD HH:MM[:ss[.uuuuuu]][TZ] format.`,
    );
  }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return enforceTimezone(
    { year, month, day, hour: 0, minute: 0, second: 0, microsecond: 0, offset: null },
    timeZone,
  ).pg;
}
