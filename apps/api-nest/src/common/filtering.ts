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
  | { kind: 'char' }
  | { kind: 'uuid' };

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

/** `filters.UUIDFilter`: a `forms.UUIDField`, which strips and reads the value as `uuid.UUID` does. */
export const uuidFilter = (param: string, column: string): FilterField => ({
  param,
  column,
  filter: { kind: 'uuid' },
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
    if (filter.kind === 'uuid') {
      const text = raw === undefined ? '' : pyStrip(raw);
      if (text === '') continue;
      const id = parseUuid(text);
      if (id === null) {
        errors[field.param] = ['Enter a valid UUID.'];
        continue;
      }
      conditions.push(`${field.column} = ${sql.add(id, 'uuid')}`);
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
 * One term `OrderingFilter` allows. A plain column, or -- for a relation --
 * what Django orders by in its place: the related model's own
 * `Meta.ordering`, through a join the term adds (and, on an aggregated
 * query, the columns it adds to the GROUP BY). A descending term flips
 * every column.
 */
export type OrderingTerm = string | { columns: string[]; join?: string; groupBy?: string[] };

export interface OrderingPlan {
  order: string[];
  joins: string[];
  groupBy: string[];
}

/**
 * `OrderingFilter.get_ordering`: the requested terms the view allows, or null
 * to keep its own ordering.
 */
export function orderingPlan(
  query: QueryDict,
  terms: Readonly<Record<string, OrderingTerm>>,
): OrderingPlan | null {
  const requested = query.get('ordering');
  if (!requested) return null;
  const valid = requested
    .split(',')
    .map((term) => pyStrip(term))
    .filter((term) => Object.hasOwn(terms, term.startsWith('-') ? term.slice(1) : term));
  if (!valid.length) return null;
  const plan: OrderingPlan = { order: [], joins: [], groupBy: [] };
  for (const term of valid) {
    const descending = term.startsWith('-');
    const spec = terms[descending ? term.slice(1) : term] as OrderingTerm;
    const columns = typeof spec === 'string' ? [spec] : spec.columns;
    // A related model's ordering may itself run backwards ("-created_at"): its
    // column carries " DESC", and a descending term flips it to ascending.
    plan.order.push(
      ...columns.map((column) => {
        const natural = column.endsWith(' DESC');
        const bare = natural ? column.slice(0, -5) : column;
        return `${bare} ${natural !== descending ? 'DESC' : 'ASC'}`;
      }),
    );
    if (typeof spec !== 'string') {
      if (spec.join && !plan.joins.includes(spec.join)) plan.joins.push(spec.join);
      for (const column of spec.groupBy ?? [])
        if (!plan.groupBy.includes(column)) plan.groupBy.push(column);
    }
  }
  return plan;
}

/** `orderingPlan` for a view whose allowed terms are all plain columns. */
export function orderingFrom(
  query: QueryDict,
  columns: Readonly<Record<string, string>>,
): string[] | null {
  return orderingPlan(query, columns)?.order ?? null;
}

/** Python's `\s`, and its complement, for `smart_split`. */
const WS =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const SMART_SPLIT = new RegExp(
  `((?:[^${WS}'"]*(?:(?:"(?:[^"\\\\]|\\\\[^\\n])*"|'(?:[^'\\\\]|\\\\[^\\n])*')[^${WS}'"]*)+)|[^${WS}]+)`,
  'gu',
);

/**
 * `SearchFilter.get_search_terms`: the `search` parameter split as DRF's
 * `search_smart_split` does -- on whitespace and commas, a quoted phrase kept
 * whole. A NUL is refused, as its `CharField` refuses one.
 */
export function searchTerms(query: QueryDict): string[] {
  const value = query.get('search') ?? '';
  if (value.includes('\x00')) {
    throw new ValidationError('Invalid input.', { details: ['Null characters are not allowed.'] });
  }
  const terms: string[] = [];
  for (const [bit] of value.matchAll(SMART_SPLIT)) {
    const term = bit.replace(/^,+|,+$/g, '');
    if ((term.startsWith('"') || term.startsWith("'")) && term[0] === term[term.length - 1]) {
      // `unescape_string_literal`.
      const quote = term[0] as string;
      terms.push(term.slice(1, -1).replaceAll(`\\${quote}`, quote).replaceAll('\\\\', '\\'));
    } else {
      for (const part of term.split(',')) if (part) terms.push(pyStrip(part));
    }
  }
  return terms;
}
