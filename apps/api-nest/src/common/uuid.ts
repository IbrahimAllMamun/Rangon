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
