/**
 * Python's `csv.reader` and `csv.DictReader` with the `excel` dialect, over
 * the lines `io.StringIO(text)` yields -- ported from CPython 3.12's
 * `Modules/_csv.c` state machine, because the products import reads uploads
 * with it and every quirk of it shapes what an operator sees:
 *
 * - `StringIO` splits lines at `\n` only, so a lone `\r` ends an unquoted
 *   field and the next character is the error "new-line character seen in
 *   unquoted field", while inside quotes it is kept;
 * - a quote in the middle of an unquoted field is a character, and text after
 *   a closing quote joins the field (the dialect is not strict);
 * - a quoted field still open at the end of the input is the last field;
 * - a field over 131072 characters is an error.
 *
 * Errors are `CsvError` (Python's `csv.Error`), which the importer does not
 * catch: the Django API answers them 500.
 */

export class CsvError extends Error {}

/** `csv.field_size_limit()`'s default. */
const FIELD_LIMIT = 131072;

const EOL = -2;

const enum State {
  StartRecord,
  StartField,
  InField,
  InQuotedField,
  QuoteInQuotedField,
  EatCrnl,
}

const NEWLINE = 0x0a;
const RETURN = 0x0d;
const QUOTE = 0x22;
const COMMA = 0x2c;

/** `io.StringIO(text)` iterated: lines ending at `\n`, each with its `\n`. */
function lines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    if (end === -1) {
      if (start < text.length) out.push(text.slice(start));
      return out;
    }
    out.push(text.slice(start, end + 1));
    start = end + 1;
  }
}

/** `csv.reader(io.StringIO(text))`: every record, as Python's reader returns them. */
export function* csvReader(text: string): Generator<string[]> {
  const input = lines(text);
  let next = 0;
  for (;;) {
    const fields: string[] = [];
    let field: string[] = [];
    let state: State = State.StartRecord as State;

    const save = () => {
      fields.push(field.join(''));
      field = [];
    };
    const add = (char: string) => {
      if (field.length >= FIELD_LIMIT)
        throw new CsvError(`field larger than field limit (${FIELD_LIMIT})`);
      field.push(char);
    };

    /** `parse_process_char`, with `EOL` as -2 and the dialect fixed to excel. */
    const process = (code: number, char: string) => {
      switch (state) {
        case State.StartRecord:
          if (code === EOL) return;
          if (code === NEWLINE || code === RETURN) {
            state = State.EatCrnl;
            return;
          }
          // A normal character: handled as the start of a field.
          state = State.StartField;
          process(code, char);
          return;
        case State.StartField:
          if (code === NEWLINE || code === RETURN || code === EOL) {
            save();
            state = code === EOL ? State.StartRecord : State.EatCrnl;
          } else if (code === QUOTE) {
            state = State.InQuotedField;
          } else if (code === COMMA) {
            save();
          } else {
            add(char);
            state = State.InField;
          }
          return;
        case State.InField:
          if (code === NEWLINE || code === RETURN || code === EOL) {
            save();
            state = code === EOL ? State.StartRecord : State.EatCrnl;
          } else if (code === COMMA) {
            save();
            state = State.StartField;
          } else {
            add(char);
          }
          return;
        case State.InQuotedField:
          if (code === EOL) return;
          if (code === QUOTE) state = State.QuoteInQuotedField;
          else add(char);
          return;
        case State.QuoteInQuotedField:
          if (code === QUOTE) {
            add(char);
            state = State.InQuotedField;
          } else if (code === COMMA) {
            save();
            state = State.StartField;
          } else if (code === NEWLINE || code === RETURN || code === EOL) {
            save();
            state = code === EOL ? State.StartRecord : State.EatCrnl;
          } else {
            add(char);
            state = State.InField;
          }
          return;
        case State.EatCrnl:
          if (code === NEWLINE || code === RETURN) return;
          if (code === EOL) {
            state = State.StartRecord;
            return;
          }
          throw new CsvError(
            "new-line character seen in unquoted field - do you need to open the file with newline=''?",
          );
      }
    };

    let ended = false;
    do {
      if (next >= input.length) {
        // End of input: a field begun, or a quote left open, is the last one.
        if (field.length !== 0 || (state as State) === State.InQuotedField) {
          save();
          ended = true;
          break;
        }
        return;
      }
      for (const char of input[next++] as string) process(char.codePointAt(0) as number, char);
      process(EOL, '');
    } while (state !== State.StartRecord);
    yield fields;
    if (ended) return;
  }
}

/**
 * `csv.DictReader(io.StringIO(text))` as the importer reads it: the header
 * (`fieldnames`, null for an empty file), then each non-empty record as
 * `dict(zip(fieldnames, row))` -- a repeated header keeps its first place and
 * its last value -- with the extra values under `null` (`restkey=None`) and
 * missing ones `null` (`restval=None`).
 */
export function csvDictReader(text: string): {
  fieldnames: string[] | null;
  rows: () => Generator<Map<string | null, string | string[] | null>>;
} {
  const reader = csvReader(text);
  const first = reader.next();
  const fieldnames = first.done ? null : first.value;
  function* rows() {
    if (fieldnames === null) return;
    for (const row of reader) {
      if (row.length === 0) continue;
      const record = new Map<string | null, string | string[] | null>();
      fieldnames.forEach((name, index) => {
        if (index < row.length) record.set(name, row[index] as string);
      });
      if (fieldnames.length < row.length) record.set(null, row.slice(fieldnames.length));
      else for (const name of fieldnames.slice(row.length)) record.set(name, null);
      yield record;
    }
  }
  return { fieldnames, rows };
}

/**
 * `csv.writer(...).writerow(row)` in the excel dialect, `QUOTE_MINIMAL`
 * (`_csv.c`'s `join_append_data`): a field is quoted when it holds the
 * delimiter, the quote character or a character of the line terminator, its
 * quotes doubled; and a row that is one empty field is written `""`, so it
 * is not read back as no row at all.
 */
export function csvRow(fields: readonly string[]): string {
  if (fields.length === 1 && fields[0] === '') return '""\r\n';
  return `${fields
    .map((field) => (/[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field))
    .join(',')}\r\n`;
}

/**
 * `csv.DictWriter(out, fieldnames)`, `writeheader()` then `writerows(rows)`.
 * Each cell is already the text Python's `str()` makes of the value, a
 * `None` the empty string.
 */
export function csvDictWriter(
  fieldnames: readonly string[],
  rows: readonly Readonly<Record<string, string>>[],
): string {
  let out = csvRow(fieldnames);
  for (const row of rows) out += csvRow(fieldnames.map((name) => row[name] ?? ''));
  return out;
}
