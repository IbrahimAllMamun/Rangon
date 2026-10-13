/**
 * The recorded proof: the Nest API's answer to each case, kept, so that the
 * comparison can be made again with no Django to ask
 * (docs/architecture/recorded-proof.md).
 *
 *   PARITY_MODE=record   every case to both APIs, as ever; where they agree,
 *                        the Nest API's answer is kept
 *   PARITY_MODE=replay   every case to the Nest API alone, compared with the
 *                        answer kept for it
 *
 * An answer is kept only from a case in which the two APIs agreed, so every
 * recorded answer has been Django's too -- but for the deliberate differences
 * (known-differences.ts), where what is kept is the Nest API's side.
 *
 * A recording is good for one database: the answers hold the ids its rows
 * were given. It is taken with a snapshot of that database and replayed on a
 * restore of it (scripts/nest-parity.sh record, replay).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';

/** An answer as the comparison holds it (`Captured` in compare.ts; declared here so a unit test can load this file alone). */
interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Mode = 'compare' | 'record' | 'replay';

export function parityMode(): Mode {
  const mode = process.env.PARITY_MODE || 'compare';
  if (mode !== 'compare' && mode !== 'record' && mode !== 'replay') {
    throw new Error(`PARITY_MODE is ${JSON.stringify(mode)}: compare, record or replay`);
  }
  return mode;
}

/** Where the answers are kept: a directory mounted for the purpose. */
export const RECORDING_DIR = process.env.PARITY_RECORDING ?? '/recorded';

/**
 * The response headers `compare` reads, and no others: a recording does not
 * keep the date an answer was given or the server that gave it.
 */
const KEPT_HEADERS = [
  'content-type',
  'location',
  'allow',
  'www-authenticate',
  'content-disposition',
  'cache-control',
  'x-content-type-options',
  'content-length',
  'last-modified',
  'content-encoding',
  'x-request-id',
];

export interface Recorded {
  name: string;
  /** What was asked, for whoever reads a difference. Not compared. */
  request: string;
  /** When the Nest API was asked, by the database's clock: a replay keeps in step with it. */
  at?: string;
  response: Captured;
  effects: unknown[][];
}

/**
 * A value as it will read once it has been to a file and back, with what the
 * comparison has never told apart made plain: `diffJson` finds no keys on a
 * `Date`, so two of them have always compared equal, and a `Date` read from a
 * file is a string that would not. Applied to both sides of a replay.
 */
export function plain(value: unknown): unknown {
  if (value instanceof Date) return '<a moment>';
  // The audit log keeps the caller's address, and the caller is this
  // process, whose address is whatever its network gave it that day.
  if (typeof value === 'string' && OWN_ADDRESSES.has(value)) return '<the harness>';
  if (Buffer.isBuffer(value)) return { bytes: value.toString('base64') };
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, plain(item)]),
    );
  }
  return value === undefined ? null : value;
}

const OWN_ADDRESSES = new Set(
  Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => !address.internal)
    .map((address) => address.address),
);

export function kept(response: Captured): Captured {
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = response.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  return { status: response.status, headers, body: response.body };
}

/**
 * Case names are the key, and a few are used twice. The second use of a name
 * is `name #2`, in the order the cases run -- the same in both modes.
 */
export class Names {
  private readonly seen = new Map<string, number>();

  key(name: string): string {
    const count = (this.seen.get(name) ?? 0) + 1;
    this.seen.set(name, count);
    return count === 1 ? name : `${name} #${count}`;
  }

  get repeated(): number {
    let repeated = 0;
    for (const count of this.seen.values()) repeated += count - 1;
    return repeated;
  }
}

/** One file per kind of check: `answers` for the cases, `throttle` for the rate limits. */
function file(kind: string): string {
  return `${RECORDING_DIR}/${kind}.jsonl.gz`;
}

export class Recorder<T extends { name: string } = Recorded> {
  private readonly lines: string[] = [];

  add(entry: T): void {
    this.lines.push(JSON.stringify(entry));
  }

  get size(): number {
    return this.lines.length;
  }

  /** Whole or not at all: a run that is interrupted leaves the last recording in place. */
  write(kind: string): { path: string; bytes: number } {
    const packed = gzipSync(Buffer.from(this.lines.join('\n') + '\n', 'utf8'), { level: 9 });
    const path = file(kind);
    writeFileSync(`${path}.part`, packed);
    renameSync(`${path}.part`, path);
    return { path, bytes: packed.length };
  }
}

export function readRecording<T extends { name: string } = Recorded>(kind: string): Map<string, T> {
  const path = file(kind);
  let text: string;
  try {
    text = gunzipSync(readFileSync(path)).toString('utf8');
  } catch (error) {
    throw new Error(`No recording at ${path}. Take one with scripts/nest-parity.sh record.`, {
      cause: error,
    });
  }
  const recorded = new Map<string, T>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line) as T;
    recorded.set(entry.name, entry);
  }
  return recorded;
}

// --- Tied rows --------------------------------------------------------------
//
// A list ordered by a column that ties leaves the tied rows to the heap, in
// Django's statement and so in the port's. Asked twice a moment apart the two
// APIs read one heap and agree; a restored database is another heap, and the
// same rows come back with the tied ones the other way round. That order is
// nobody's rule and no recording can hold it.
//
// What a recording can hold is everything else. Where a replay on a restored
// database returns the same rows as were recorded with some of them
// permuted, the smallest runs of positions within which they were permuted
// are kept beside the answers (`ties`). From then on rows may change places
// inside such a run and nowhere else: an ordering that broke would move rows
// across runs, and still fail.

export interface Tie {
  /**
   * Where the list is: `body` or `effects`, then keys and indexes from the
   * top. `['body', '#lines']` is a CSV's lines.
   */
  path: (string | number)[];
  /** Runs of positions, first and last inclusive. */
  runs: [number, number][];
}

export interface Tied {
  name: string;
  ties: Tie[];
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as object).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );

/** A body as the tie logic reads it: parsed JSON, or a CSV as a list of its lines. */
function listed(response: Captured): unknown {
  const type = (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type === 'application/json') {
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      return undefined;
    }
  }
  if (type === 'text/csv') return { '#lines': response.body.split('\r\n') };
  return undefined;
}

function unlisted(response: Captured, body: unknown): Captured {
  const lines = (body as { '#lines'?: string[] } | null)?.['#lines'];
  return { ...response, body: lines ? lines.join('\r\n') : JSON.stringify(body) };
}

/**
 * Whether `b` is `a` with rows permuted inside lists, and if so where:
 * appends to `out` each list and the smallest runs that were permuted.
 */
function permuted(a: unknown, b: unknown, path: (string | number)[], out: Tie[]): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const left = a.map(canonical);
    const right = b.map(canonical);
    if (left.every((item, index) => item === right[index])) return true;
    const balance = new Map<string, number>();
    const runs: [number, number][] = [];
    let unsettled = 0;
    let start = 0;
    for (let index = 0; index < left.length; index++) {
      for (const [item, step] of [
        [left[index] as string, 1],
        [right[index] as string, -1],
      ] as const) {
        const before = balance.get(item) ?? 0;
        const after = before + step;
        if (before === 0) unsettled += 1;
        if (after === 0) unsettled -= 1;
        balance.set(item, after);
      }
      if (unsettled === 0) {
        if (index > start) runs.push([start, index]);
        start = index + 1;
      }
    }
    if (unsettled === 0) {
      out.push({ path, runs });
      return true;
    }
    // Not the same rows: perhaps the same list with a list inside a row permuted.
    return a.every((item, index) => permuted(item, b[index], [...path, index], out));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every(
      (key) => key in right && permuted(left[key], right[key], [...path, key], out),
    );
  }
  return a === b;
}

/** An API's answer to a case, as the harness holds it: what it said and what it wrote. */
export interface Answered {
  response: Captured;
  effects: unknown[][];
}

/** Both halves as one value, so that a tie's path says which it is in: `body` or `effects`. */
const whole = (answer: Answered) => ({
  body: listed(answer.response) ?? answer.response.body,
  effects: answer.effects,
});

/**
 * The ties that would make `live` the recorded answer, or null if it is not
 * that answer reordered. The rows a request wrote are held the same way as
 * the rows it returned: where a service walks a set in no order (the lines
 * of a stock count), its ledger entries are written in the heap's order.
 */
export function tiesBetween(recorded: Answered, live: Answered): Tie[] | null {
  const out: Tie[] = [];
  return permuted(whole(recorded), whole(live), [], out) && out.length ? out : null;
}

/** `live` with each tied run put in the recorded order, where it holds the recorded rows. */
export function settled(recorded: Answered, live: Answered, ties: Tie[]): Answered {
  if (!ties.length) return live;
  const a = whole(recorded);
  // A copy: the live answer is also what a difference is printed from.
  const b = structuredClone(whole(live));
  for (const tie of ties) {
    let was: unknown = a;
    let now: unknown = b;
    for (const step of tie.path) {
      was = (was as Record<string | number, unknown> | null)?.[step];
      now = (now as Record<string | number, unknown> | null)?.[step];
    }
    if (!Array.isArray(was) || !Array.isArray(now) || was.length !== now.length) continue;
    for (const [first, last] of tie.runs) {
      const want = was.slice(first, last + 1);
      const have = now.slice(first, last + 1);
      const same = want.map(canonical).sort().join('\n') === have.map(canonical).sort().join('\n');
      if (same) now.splice(first, want.length, ...want);
    }
  }
  return {
    response: typeof b.body === 'string' ? live.response : unlisted(live.response, b.body),
    effects: b.effects,
  };
}

/** Two sets of ties for one case, as one: runs on one list that touch are one run. */
export function mergedTies(one: Tie[], other: Tie[]): Tie[] {
  const byPath = new Map<string, Tie>();
  for (const tie of [...one, ...other]) {
    const key = JSON.stringify(tie.path);
    const runs = [...(byPath.get(key)?.runs ?? []), ...tie.runs].sort((x, y) => x[0] - y[0]);
    const joined: [number, number][] = [];
    for (const run of runs) {
      const last = joined[joined.length - 1];
      if (last && run[0] <= last[1]) last[1] = Math.max(last[1], run[1]);
      else joined.push([run[0], run[1]]);
    }
    byPath.set(key, { path: tie.path, runs: joined });
  }
  return [...byPath.values()];
}

export function readTies(): Map<string, Tied> {
  return existsSync(file('ties')) ? readRecording<Tied>('ties') : new Map<string, Tied>();
}

/** Whether this run keeps answers or is held to them, rather than comparing two APIs. */
export const heldToARecording = (): boolean => parityMode() !== 'compare';

// --- The clock ---------------------------------------------------------------
//
// A replay runs at the hour its recording was taken (docker-compose.recorded.yml
// sets every process's clock back by the recording's age). That settles the
// day; it does not settle the minute. A replay asks one API and a recording
// two, so the replay gets through its cases faster, and a row the database
// holds that is dated a few minutes after the recording began -- the demo
// seed spreads today's sales over the shop's hours -- is behind a case in one
// and still ahead of it in the other.
//
// So a recording keeps every moment the database holds in the hours after it
// began (`moments`), and when each case was asked (`at`). A replay that
// reaches a case before one of those moments which the recording had already
// passed waits for it.

export interface Moment {
  /** The moment, as ISO text: `name` because every recorded line has one. */
  name: string;
}

/** Each wait is to just past the moment: a clock read in milliseconds, a moment kept in microseconds. */
const PAST = 5;

export class Pace {
  private readonly moments: number[];
  waits = 0;
  waited = 0;
  /** Cases the replay reached after a moment the recording had not yet passed: nothing to be done. */
  ahead = 0;

  constructor(moments: Iterable<string>) {
    this.moments = [...moments].map((moment) => Date.parse(moment)).sort((a, b) => a - b);
  }

  /** How long to wait before a case the recording asked at `recorded`, it being `now`. */
  wait(recorded: number, now: number): number {
    let until = now;
    for (const moment of this.moments) {
      if (moment > recorded) break;
      if (moment >= until) until = moment + PAST;
    }
    if (this.moments.some((moment) => moment > recorded && moment <= now)) this.ahead += 1;
    if (until === now) return 0;
    this.waits += 1;
    this.waited += until - now;
    return until - now;
  }
}

// And it does not settle the second at which the harness itself begins. The
// replay's clocks are set a minute and a half behind the recording's age, for
// the stack to come up in, so a replay begins up to that much "earlier" than
// its recording did -- and the cases are built from the clock: what an API
// mints is told from what was there by being newer than the harness
// (`mintedBlanker`), and a row a `reset` made two minutes before a recording
// was older than the recording's harness and newer than the replay's. 109
// cases differed so, on 2026-10-13, in a recording taken straight after a
// reset. So a recording keeps the instant its harness began, and a replay
// waits for it before it builds a case.

const BEGAN = `${RECORDING_DIR}/began.txt`;

/** How long a replay waits to begin where its recording began at `began`, it being `now`. */
export const untilBegan = (began: number, now: number): number =>
  Number.isFinite(began) ? Math.max(began - now, 0) : 0;

/**
 * Before any case is built: a recording keeps this instant, and a replay
 * waits until its own clock has reached the one its recording kept. Answers
 * what was done, for the log. A recording from before this was kept has no
 * instant, and its replay begins when it begins.
 */
export async function beginWhereRecorded(mode: Mode): Promise<string> {
  if (mode === 'record') {
    writeFileSync(BEGAN, `${Date.now()}\n`);
    return '';
  }
  if (mode !== 'replay' || !existsSync(BEGAN)) return '';
  const began = Number(readFileSync(BEGAN, 'utf8').trim());
  const now = Date.now();
  const wait = untilBegan(began, now);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return wait > 0
    ? `began ${(wait / 1000).toFixed(1)}s behind the recording, and waited for it`
    : `began ${((now - began) / 1000).toFixed(1)}s after the recording did: its clock cannot be put back`;
}
