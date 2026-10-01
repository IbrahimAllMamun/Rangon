import type { Queryable } from '../database/database.service';

/**
 * `core.services.next_number`: the next human-readable number for `key`,
 * row-locked so two callers never share one. Called inside the caller's
 * transaction: a rollback gives the number back (a gap is acceptable, a
 * duplicate is not). The stored prefix and padding win over the arguments.
 */
export async function nextNumber(
  tx: Queryable,
  key: string,
  prefix: string,
  padding = 6,
): Promise<string> {
  await tx.query(
    `INSERT INTO core_numbersequence (key, prefix, last_value, padding, updated_at)
     VALUES ($1, $2, 0, $3, clock_timestamp()) ON CONFLICT (key) DO NOTHING`,
    [key, prefix, padding],
  );
  const row = await tx.one<{ prefix: string; last_value: string; padding: number }>(
    `SELECT prefix, last_value, padding FROM core_numbersequence WHERE key = $1 FOR UPDATE`,
    [key],
  );
  const next = BigInt(row?.last_value ?? '0') + 1n;
  await tx.query(
    `UPDATE core_numbersequence SET last_value = $2, updated_at = clock_timestamp() WHERE key = $1`,
    [key, next.toString()],
  );
  const effective = row?.prefix || prefix;
  const digits = next.toString().padStart(row?.padding || padding, '0');
  return effective ? `${effective}-${digits}` : digits;
}
