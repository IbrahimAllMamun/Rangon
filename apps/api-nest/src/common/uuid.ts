/**
 * Python `uuid.UUID(text)`, as Django's `UUIDField` applies it to a lookup:
 * `urn:` and `uuid:` prefixes, braces and dashes are dropped, and what is left
 * must be 32 hex digits. Answers the canonical form, or null where Python
 * raises -- so a malformed id never reaches PostgreSQL as a cast error.
 */
export function parseUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value
    .replaceAll('urn:', '')
    .replaceAll('uuid:', '')
    .replace(/^[{}]+|[{}]+$/g, '')
    .replaceAll('-', '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const lower = hex.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}

/**
 * A primary-key lookup on a value from a request body, as the ORM makes it:
 * `UUIDField.to_python`. An int (a bool is one) is `UUID(int=value)`; None
 * matches nothing; anything unreadable is Django's `ValidationError`, which
 * the Django API answers with 400 -- reproduced by the caller throwing
 * `invalidUuid(value)`.
 */
export function uuidFromValue(value: unknown): { id: string | null } | { invalid: true } {
  if (value === null || value === undefined) return { id: null };
  if (
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isInteger(value))
  ) {
    const number = BigInt(value);
    if (number < 0n || number >= 1n << 128n) return { invalid: true };
    const hex = number.toString(16).padStart(32, '0');
    return { id: parseUuid(hex) };
  }
  const id = typeof value === 'string' ? parseUuid(value) : null;
  return id ? { id } : { invalid: true };
}
