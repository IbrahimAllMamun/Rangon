/**
 * Numbered parameters for hand-written statements.
 *
 * Every value reaches PostgreSQL as a bound parameter; nothing a client sent
 * is ever spliced into SQL text (CLAUDE.md section 8). Casts are explicit
 * (`$3::uuid`) so a parameter's type is the column's, as psycopg's adapters
 * make it on the Django side.
 */
export class Params {
  readonly values: unknown[] = [];

  add(value: unknown, cast?: string): string {
    this.values.push(value);
    return cast ? `$${this.values.length}::${cast}` : `$${this.values.length}`;
  }

  /** `IN (...)` with one parameter per value, as Django writes it. */
  list(values: readonly unknown[], cast?: string): string {
    return `(${values.map((value) => this.add(value, cast)).join(', ')})`;
  }
}

/** Quote an identifier the way Django does: `"catalog_product"`. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** `"table"."column", ...` for a fixed column list. */
export function columns(alias: string, names: readonly string[]): string {
  return names.map((name) => `${alias}.${ident(name)}`).join(', ');
}
