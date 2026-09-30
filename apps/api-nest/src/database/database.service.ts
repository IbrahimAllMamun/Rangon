import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';

import { ENV, Env } from '../config/env';
import * as relations from './relations';
import * as tables from './schema';

export const schema = { ...tables, ...relations };
export type Orm = NodePgDatabase<typeof schema>;

/** What a service needs to run SQL: the pool, or one transaction's connection. */
export interface Queryable {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<T | null>;
}

/** One connection inside `BEGIN ... COMMIT`, handed to `Database.transaction`'s callback. */
export class Transaction implements Queryable {
  constructor(private readonly client: PoolClient) {}

  async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.client.query<T>(text, values);
    return result.rows;
  }

  async one<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, values);
    return rows[0] ?? null;
  }
}

/**
 * Types that stay exactly as PostgreSQL printed them.
 *
 * `pg` turns dates and timestamps into JavaScript `Date`s, which drops
 * microseconds and, for a bare `date`, invents a local midnight. The Django
 * API prints both from the database's own values, so this API keeps the text
 * and formats it (common/datetime.ts). `numeric` and `int8` already arrive as
 * strings and stay that way: money never becomes a float.
 */
const RAW_TEXT_TYPES = new Set<number>([
  types.builtins.TIMESTAMPTZ,
  types.builtins.TIMESTAMP,
  types.builtins.DATE,
  types.builtins.TIME,
  types.builtins.TIMETZ,
  types.builtins.INTERVAL,
]);

const typeParsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (RAW_TEXT_TYPES.has(oid)) return (value: string) => value;
    return types.getTypeParser(oid, format);
  },
} as unknown as typeof types;

/**
 * The one connection pool, shared by Drizzle and by hand-written SQL.
 *
 * Hand-written SQL is used where a query has to match the Django API's own
 * statement -- its joins, its DISTINCT, its ordering and therefore its answer
 * on ties. Drizzle is used where nothing that subtle is at stake.
 */
@Injectable()
export class Database implements OnModuleDestroy, Queryable {
  readonly pool: Pool;
  readonly orm: Orm;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
      application_name: 'rangon-api-nest',
      // Django runs every session in UTC with USE_TZ = True. Timestamps are
      // printed in the session zone, so this must match for the text to parse.
      options: '-c TimeZone=UTC',
      types: typeParsers,
    });
    this.orm = drizzle(this.pool, { schema });
  }

  /** Rows of a parameterised statement. Never interpolate values into `text`. */
  async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(text, values);
    return result.rows;
  }

  /**
   * Rows as arrays, for a statement whose columns repeat a name (`id` from
   * three joined tables). Read them positionally with `pick`.
   */
  async arrays(text: string, values: unknown[] = []): Promise<unknown[][]> {
    const result = await this.pool.query<unknown[]>({ text, values, rowMode: 'array' });
    return result.rows;
  }

  async one<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, values);
    return rows[0] ?? null;
  }

  /** A client for a transaction. The caller must release it. */
  async connect(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /**
   * `transaction.atomic()`: commit when `work` resolves, roll back when it
   * throws. Statements outside one autocommit, as Django's do without
   * ATOMIC_REQUESTS.
   */
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await work(new Transaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection itself failed: do not hand it back to the pool.
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
