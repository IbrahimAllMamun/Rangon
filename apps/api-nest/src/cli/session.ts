import { Client, QueryResultRow, types } from 'pg';

import type { AuditContext } from '../common/audit';
import type { Queryable } from '../database/database.service';
import { Refusal } from './migrate';

/** A command has no request: nobody's address, no browser, no request id. */
export const NO_REQUEST: AuditContext = { ipAddress: null, userAgent: '', requestId: '' };

/** What a command was given after its name: `--flag value`, or `--flag` alone. */
export type Flags = Readonly<Record<string, string | true>>;

/** `--branch DHK1 --fix` as `{ branch: 'DHK1', fix: true }`; anything else is not understood. */
export function parseFlags(args: readonly string[], known: readonly string[]): Flags {
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    const name = arg.startsWith('--') ? arg.slice(2) : '';
    if (!name || !known.includes(name)) throw new Refusal(`Not understood: ${arg}`);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

/** A flag's text, or the environment's, or nothing. `true` (no value) is nothing. */
export function text(flags: Flags, name: string, env?: string): string {
  const value = flags[name];
  if (typeof value === 'string') return value;
  return (env ? process.env[env] : undefined) ?? '';
}

// Dates and moments as PostgreSQL prints them, as the API reads them.
const RAW = new Set<number>([
  types.builtins.TIMESTAMPTZ,
  types.builtins.TIMESTAMP,
  types.builtins.DATE,
]);
const parsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (RAW.has(oid)) return (value: string) => value;
    return types.getTypeParser(oid, format);
  },
} as unknown as typeof types;

/**
 * One connection and one transaction for a command that writes: what it did
 * is committed whole, or -- a refusal, a fault -- not at all.
 */
export async function inTransaction<T>(
  databaseUrl: string,
  work: (q: Queryable) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl, types: parsers });
  await client.connect();
  const q: Queryable = {
    async query<R extends QueryResultRow>(sql: string, values: unknown[] = []) {
      return (await client.query<R>(sql, values)).rows;
    },
    async one<R extends QueryResultRow>(sql: string, values: unknown[] = []) {
      return (await client.query<R>(sql, values)).rows[0] ?? null;
    },
  };
  try {
    await client.query('BEGIN');
    const result = await work(q);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** `Branch.objects.filter(code=...).first()`, or a refusal that names the code. */
export async function branchByCode(
  q: Queryable,
  code: string,
): Promise<{ id: string; code: string } | null> {
  if (!code) return null;
  const branch = await q.one<{ id: string; code: string }>(
    `SELECT id, code FROM public.accounts_branch WHERE code = $1 ORDER BY name, id LIMIT 1`,
    [code],
  );
  if (!branch) throw new Refusal(`No branch with code '${code}'.`);
  return branch;
}
