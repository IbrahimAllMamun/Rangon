/**
 * The Django API's two default filter backends, as a staff viewset applies
 * them to its queryset (`REST_FRAMEWORK["DEFAULT_FILTER_BACKENDS"]`):
 *
 * 1. `DjangoFilterBackend` over `filterset_fields`. django-filter builds a
 *    form from the model's fields and validates every parameter before it
 *    filters by any: one bad value is a 400 naming each bad field, in the
 *    order the view declares them. What each kind accepts is the form
 *    field's rule, not a guess:
 *    - a boolean column (`BooleanWidget`): `1`/`true` and `0`/`false`, any
 *      case; anything else is no filter at all, silently;
 *    - a foreign key (`ModelChoiceField`): a blank is no filter; anything
 *      else is looked up by primary key -- a malformed UUID is Django's own
 *      "is not a valid UUID", a missing row "Select a valid choice";
 *    - a column with choices (`ChoiceField`): a blank is no filter, anything
 *      not a choice is refused with the value named;
 *    - any other text column (`CharField`): stripped, a blank is no filter.
 * 2. `OrderingFilter`: `?ordering=a,-b`, terms the view does not allow
 *    dropped; if any survive they *replace* the view's own ordering.
 *
 * Both apply to a detail request too (`get_object` filters the queryset
 * before it looks the row up), so `?is_active=false` can 404 a detail.
 */
import type { Queryable } from '../database/database.service';
import type { Params as SqlParams } from '../database/sql';
import { ValidationError } from './errors';
import { pyStr, pyStrip } from './python';
import type { QueryDict } from './query-dict';
import { parseUuid } from './uuid';

export type FilterKind =
  | { kind: 'boolean' }
  | { kind: 'model'; table: string }
  | { kind: 'choice'; choices: readonly string[] }
  | { kind: 'char' };

export interface FilterField {
  /** The query parameter, which is the model field's name. */
  param: string;
  /** The SQL column it filters (`"catalog_brand"."is_active"`). */
  column: string;
  filter: FilterKind;
}

export const booleanFilter = (param: string, column: string): FilterField => ({
  param,
  column,
  filter: { kind: 'boolean' },
});

export const modelFilter = (param: string, column: string, table: string): FilterField => ({
  param,
  column,
  filter: { kind: 'model', table },
});

export const choiceFilter = (
  param: string,
  column: string,
  choices: readonly string[],
): FilterField => ({ param, column, filter: { kind: 'choice', choices } });

export const charFilter = (param: string, column: string): FilterField => ({
  param,
  column,
  filter: { kind: 'char' },
});

/** `BooleanWidget.value_from_datadict`. */
export function booleanValue(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const value = raw.toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

/**
 * `filterset.is_valid()` then `filterset.qs`: validate every declared
 * parameter, refuse with all the errors at once, else add one condition per
 * filter that has a value.
 */
export async function applyFilters(
  q: Queryable,
  query: QueryDict,
  fields: readonly FilterField[],
  sql: SqlParams,
  where: string[],
): Promise<void> {
  const errors: Record<string, string[]> = {};
  const conditions: string[] = [];

  for (const field of fields) {
    const raw = query.get(field.param);
    const { filter } = field;
    if (filter.kind === 'boolean') {
      const value = booleanValue(raw);
      if (value !== null) conditions.push(`${field.column} = ${sql.add(value)}`);
      continue;
    }
    if (filter.kind === 'char') {
      // `forms.CharField` strips; a choice or a model choice does not.
      const text = raw === undefined ? '' : pyStrip(raw);
      if (text.includes('\x00')) {
        errors[field.param] = ['Null characters are not allowed.'];
        continue;
      }
      if (text !== '') conditions.push(`${field.column} = ${sql.add(text)}`);
      continue;
    }
    const text = raw ?? '';
    if (filter.kind === 'choice') {
      if (text === '') continue;
      if (!filter.choices.includes(text)) {
        errors[field.param] = [
          `Select a valid choice. ${text} is not one of the available choices.`,
        ];
        continue;
      }
      conditions.push(`${field.column} = ${sql.add(text)}`);
      continue;
    }
    // A model choice.
    if (text === '') continue;
    const id = parseUuid(text);
    if (id === null) {
      errors[field.param] = [`“${pyStr(text)}” is not a valid UUID.`];
      continue;
    }
    const found = await q.one(`SELECT 1 AS "a" FROM "${filter.table}" WHERE "id" = $1 LIMIT 21`, [
      id,
    ]);
    if (!found) {
      errors[field.param] = [
        'Select a valid choice. That choice is not one of the available choices.',
      ];
      continue;
    }
    conditions.push(`${field.column} = ${sql.add(id, 'uuid')}`);
  }

  if (Object.keys(errors).length) {
    throw new ValidationError('Invalid input.', { details: errors });
  }
  where.push(...conditions);
}

/**
 * `OrderingFilter.get_ordering`: the requested terms the view allows, or null
 * to keep its own ordering. `columns` maps each allowed field to its SQL.
 */
export function orderingFrom(
  query: QueryDict,
  columns: Readonly<Record<string, string>>,
): string[] | null {
  const requested = query.get('ordering');
  if (!requested) return null;
  const terms = requested
    .split(',')
    .map((term) => pyStrip(term))
    .filter((term) => Object.hasOwn(columns, term.startsWith('-') ? term.slice(1) : term));
  if (!terms.length) return null;
  return terms.map((term) =>
    term.startsWith('-') ? `${columns[term.slice(1)]} DESC` : `${columns[term]} ASC`,
  );
}
