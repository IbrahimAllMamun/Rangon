/**
 * DRF serializer validation, as far as the ported serializers use it.
 *
 * The error details a client sees -- which fields, which messages, in which
 * order, and when one refusal stops the next check -- are DRF 3.15's
 * `Serializer.run_validation`: each field in declaration order runs
 * `validate_empty_values`, `to_internal_value`, then every validator (all of
 * them, not the first to fail), then the serializer's `validate_<field>`; the
 * serializer-level `validate()` runs only when every field passed.
 *
 * Input is `request.data` as `http/request-body.ts` parses it, so a JSON
 * float is a `PyFloat` and `str()` of it is Python's.
 */
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

import { HtmlInput, isUploadedFile, type UploadedFile } from '../http/multipart';
import { isDict, pythonTypeName } from '../http/request-body';
import { identifyImage } from './images';
import { dateFromIsoformat } from './isoformat';
import Decimal from 'decimal.js';

import { Dec } from './decimal';
import { canonicalPhone, INVALID_PHONE_MESSAGE } from './phone';
import {
  isFiniteDecimal,
  PY_WHITESPACE,
  PyFloat,
  pyDecimal,
  pyIntText,
  pyLen,
  pyStr,
  pyStrip,
} from './python';
import { uuidFromValue } from './uuid';

/** DRF's `empty`: the key was not in the data at all. */
export const EMPTY = Symbol('empty');
/** DRF's `SkipField`: the field is left out of the validated data. */
export const SKIP = Symbol('skip');

export interface ErrorDetail {
  message: string;
  code: string;
}

/** A DRF `ValidationError` raised for one field (or, from `validate()`, for several). */
export class Invalid extends Error {
  constructor(readonly details: ErrorDetail[]) {
    super(details.map((detail) => detail.message).join(' '));
  }

  static of(message: string, code = 'invalid'): Invalid {
    return new Invalid([{ message, code }]);
  }
}

/**
 * A `validate_<field>` method raising `ValidationError({...})`: the field's
 * errors are a dict of their own (`{"shipping_address": {"city": [...]}}`).
 */
export class InvalidNested extends Error {
  constructor(readonly detail: ErrorTree) {
    super('Invalid input.');
  }
}

/**
 * A DRF error detail in any of its shapes: a field's messages, a nested
 * serializer's errors by field, a `ListField`'s by index (`{"0": [...]}`),
 * or a `ListSerializer`'s, one entry per item (`[{}, {"cells": [...]}]`).
 */
export type ErrorTree = ErrorDetail[] | { [key: string]: ErrorTree } | ErrorTree[];

function isDetailList(tree: ErrorTree): tree is ErrorDetail[] {
  return (
    Array.isArray(tree) &&
    tree.every(
      (item) =>
        !Array.isArray(item) &&
        typeof (item as ErrorDetail).message === 'string' &&
        typeof (item as ErrorDetail).code === 'string',
    ) &&
    tree.length > 0
  );
}

/** An `ErrorTree` as the envelope carries it: messages only. */
export function treeMessages(tree: ErrorTree): unknown {
  if (isDetailList(tree)) return tree.map((detail) => detail.message);
  if (Array.isArray(tree)) return tree.map(treeMessages);
  return Object.fromEntries(Object.entries(tree).map(([key, value]) => [key, treeMessages(value)]));
}

export interface Field<T> {
  /** Async where a check needs the database: a unique value, a related row. */
  run(data: unknown, partial: boolean): T | typeof SKIP | Promise<T | typeof SKIP>;
  /**
   * How DRF's `Field.get_value` reads it from form data: what a missing key
   * is (`default_empty_html`), and whether a blank is null, blank or absent.
   */
  html?: HtmlMeta;
}

export interface HtmlMeta {
  required: boolean;
  allowNull: boolean;
  allowBlank: boolean;
  /** `default_empty_html`; undefined is DRF's `empty`. */
  emptyHtml?: unknown;
}

/** `Field.get_value(dictionary)` for a `QueryDict` from a form body. */
function htmlValue(
  field: Field<unknown>,
  name: string,
  data: HtmlInput,
  partial: boolean,
): unknown {
  const meta = field.html ?? { required: true, allowNull: false, allowBlank: false };
  if (!data.has(name))
    return partial ? EMPTY : meta.emptyHtml === undefined ? EMPTY : meta.emptyHtml;
  const value = data.get(name);
  if (value === '' && meta.allowNull) return meta.allowBlank ? '' : null;
  if (value === '' && !meta.required) return meta.allowBlank ? '' : EMPTY;
  return value;
}

type Validator = (value: string) => ErrorDetail | null;

export interface CharOptions {
  required?: boolean;
  allowBlank?: boolean;
  allowNull?: boolean;
  trimWhitespace?: boolean;
  maxLength?: number;
  minLength?: number;
  /** Replaces DRF's "Not a valid string." (`default_error_messages['invalid']`). */
  invalidMessage?: string;
  /** Runs after the string conversion, as a subclass's `to_internal_value` does. */
  convert?: (value: string, fail: () => never) => string;
  validators?: Validator[];
  /**
   * A `UniqueValidator`, which a ModelSerializer puts first: it runs before
   * the length and character checks, and every one of them still runs.
   */
  unique?: UniqueCheck;
}

/** `UniqueValidator(queryset, message)`: does another row already hold this value? */
export interface UniqueCheck {
  message: string;
  exists: (value: string) => Promise<boolean>;
}

/** `Field.validate_empty_values`: the answer for a missing or null value, if it settles the field. */
function emptyValue<T>(
  data: unknown,
  partial: boolean,
  options: { required: boolean; allowNull: boolean },
): { settled: true; value: T | null | typeof SKIP } | { settled: false } {
  if (data === EMPTY || data === undefined) {
    if (partial) return { settled: true, value: SKIP };
    if (options.required) throw Invalid.of('This field is required.', 'required');
    return { settled: true, value: SKIP };
  }
  if (data === null) {
    if (!options.allowNull) throw Invalid.of('This field may not be null.', 'null');
    return { settled: true, value: null };
  }
  return { settled: false };
}

/** Collect every validator's refusal, as `Field.run_validators` does. */
function runValidators(value: string, validators: Validator[]): void {
  const errors = validators
    .map((validator) => validator(value))
    .filter((error): error is ErrorDetail => error !== null);
  if (errors.length) throw new Invalid(errors);
}

/** `serializers.CharField`. */
export function charField(options: CharOptions = {}): Field<string | null> {
  const required = options.required ?? true;
  const allowBlank = options.allowBlank ?? false;
  const trim = options.trimWhitespace ?? true;
  const validators: Validator[] = [];
  if (options.maxLength !== undefined) {
    const max = options.maxLength;
    validators.push((value) =>
      pyLen(value) > max
        ? { message: `Ensure this field has no more than ${max} characters.`, code: 'max_length' }
        : null,
    );
  }
  if (options.minLength !== undefined) {
    const min = options.minLength;
    validators.push((value) =>
      pyLen(value) < min
        ? { message: `Ensure this field has at least ${min} characters.`, code: 'min_length' }
        : null,
    );
  }
  validators.push(prohibitNullCharacters, prohibitSurrogates, ...(options.validators ?? []));
  const invalid = options.invalidMessage ?? 'Not a valid string.';

  return {
    html: { required, allowNull: options.allowNull ?? false, allowBlank },
    run(data, partial) {
      // `CharField.run_validation`: blank is tested before anything else, and
      // only a str can be blank (`str(None).strip()` is "None").
      if (typeof data === 'string' && (data === '' || (trim && pyStrip(data) === ''))) {
        if (!allowBlank) throw Invalid.of('This field may not be blank.', 'blank');
        return '';
      }
      const settled = emptyValue<string>(data, partial, {
        required,
        allowNull: options.allowNull ?? false,
      });
      if (settled.settled) return settled.value;

      // `to_internal_value`: numbers are coerced, everything else refused.
      const isNumber =
        typeof data === 'number' || typeof data === 'bigint' || data instanceof PyFloat;
      if (typeof data !== 'string' && !isNumber) throw Invalid.of(invalid);
      let value = pyStr(data);
      if (trim) value = pyStrip(value);
      if (options.convert) {
        value = options.convert(value, () => {
          throw Invalid.of(invalid);
        });
      }
      if (options.unique) return checkUnique(value, options.unique, validators);
      runValidators(value, validators);
      return value;
    },
  };
}

async function checkUnique(value: string, unique: UniqueCheck, validators: Validator[]) {
  const errors: ErrorDetail[] = [];
  if (await uniqueTaken(value, unique)) errors.push({ message: unique.message, code: 'unique' });
  for (const validator of validators) {
    const error = validator(value);
    if (error) errors.push(error);
  }
  if (errors.length) throw new Invalid(errors);
  return value;
}

/**
 * DRF's `qs_exists`: a value the database cannot even compare -- a NUL in a
 * string -- is a data error, which counts as "not taken", and the other
 * validators say what is wrong with it.
 */
async function uniqueTaken(value: string, unique: UniqueCheck): Promise<boolean> {
  try {
    return await unique.exists(value);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code.startsWith('22')) return false;
    throw error;
  }
}

/** `serializers.EmailField`: a CharField with Django's `EmailValidator` last. */
export function emailField(options: CharOptions = {}): Field<string | null> {
  return charField({ ...options, validators: [...(options.validators ?? []), emailValidator] });
}

/** Django's `ProhibitNullCharactersValidator`. */
function prohibitNullCharacters(value: string): ErrorDetail | null {
  return value.includes('\x00')
    ? { message: 'Null characters are not allowed.', code: 'null_characters_not_allowed' }
    : null;
}

/** DRF's `ProhibitSurrogateCharactersValidator`: names the first one. */
function prohibitSurrogates(value: string): ErrorDetail | null {
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (code >= 0xd800 && code <= 0xdfff) {
      return {
        message: `Surrogate characters are not allowed: U+${code.toString(16).toUpperCase()}.`,
        code: 'surrogate_characters_not_allowed',
      };
    }
  }
  return null;
}

// Django 5.1 `EmailValidator`, with `re.IGNORECASE` on str patterns: the `iu`
// flags fold case as Python's `re` does (U+212A KELVIN SIGN matches `k`).
const EMAIL_USER =
  // eslint-disable-next-line no-control-regex -- RFC 5321's quoted-string allows them, as Django's pattern does.
  /^(?:[-!#$%&'*+/=?^_`{}|~0-9A-Z]+(?:\.[-!#$%&'*+/=?^_`{}|~0-9A-Z]+)*$|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f!#-[\]-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*"$)/iu;
const EMAIL_DOMAIN = /^(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+(?:[A-Z0-9-]{2,63}(?<!-))$/iu;
const EMAIL_LITERAL = /^\[([A-F0-9:.]+)\]$/iu;

function validDomainPart(domain: string): boolean {
  if (EMAIL_DOMAIN.test(domain)) return true;
  const literal = EMAIL_LITERAL.exec(domain);
  if (!literal) return false;
  const address = literal[1] as string;
  // `validate_ipv46_address`: IPv6 is also capped at 39 characters.
  return isIP(address) === 4 || (isIP(address) === 6 && address.length <= 39);
}

export function isValidEmail(value: string): boolean {
  if (!value || !value.includes('@') || pyLen(value) > 320) return false;
  const at = value.lastIndexOf('@');
  const user = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!EMAIL_USER.test(user)) return false;
  if (domain === 'localhost' || validDomainPart(domain)) return true;
  // An internationalised domain, tried again in its punycode form. (Python's
  // `idna` codec is IDNA 2003 and Node's is UTS 46; they differ only on
  // domains no mail system would route.)
  const ascii = domainToASCII(domain);
  return ascii !== '' && validDomainPart(ascii);
}

function emailValidator(value: string): ErrorDetail | null {
  return isValidEmail(value) ? null : { message: 'Enter a valid email address.', code: 'invalid' };
}

/** `serializers.BooleanField`, including the strings and numbers it accepts. */
export function booleanField(
  options: { required?: boolean; allowNull?: boolean } = {},
): Field<boolean | null> {
  const TRUE = new Set<unknown>(['t', 'T', 'y', 'Y', 'yes', 'Yes', 'YES', 'true', 'True', 'TRUE']);
  const FALSE = new Set<unknown>(['f', 'F', 'n', 'N', 'no', 'No', 'NO', 'false', 'False', 'FALSE']);
  for (const word of ['on', 'On', 'ON', '1', 1, true]) TRUE.add(word);
  for (const word of ['off', 'Off', 'OFF', '0', 0, false]) FALSE.add(word);
  const NULL = new Set<unknown>(['null', 'Null', 'NULL', '']);
  const allowNull = options.allowNull ?? false;
  return {
    html: {
      required: options.required ?? true,
      allowNull,
      allowBlank: false,
      emptyHtml: allowNull ? null : false,
    },
    run(data, partial) {
      const settled = emptyValue<boolean>(data, partial, {
        required: options.required ?? true,
        allowNull,
      });
      if (settled.settled) return settled.value;
      // Python compares `1.0 in {1, True}` by value.
      const key = data instanceof PyFloat ? data.value : data;
      if (TRUE.has(key)) return true;
      if (FALSE.has(key)) return false;
      if (NULL.has(key) && allowNull) return null;
      throw Invalid.of('Must be a valid boolean.');
    },
  };
}

/** `serializers.ChoiceField` over string choices. */
export function choiceField(
  choices: readonly string[],
  options: { required?: boolean; allowBlank?: boolean } = {},
): Field<string | null> {
  return {
    html: {
      required: options.required ?? true,
      allowNull: false,
      allowBlank: options.allowBlank ?? false,
    },
    run(data, partial) {
      const settled = emptyValue<string>(data, partial, {
        required: options.required ?? true,
        allowNull: false,
      });
      if (settled.settled) return settled.value;
      if (data === '' && options.allowBlank) return '';
      // `choice_strings_to_values[str(data)]`.
      const text = pyStr(data);
      if (!choices.includes(text))
        throw Invalid.of(`"${text}" is not a valid choice.`, 'invalid_choice');
      return text;
    },
  };
}

export type Fields = Record<string, Field<unknown>>;
export type Errors = Record<string, ErrorTree>;

export interface SerializerOptions<V> {
  partial?: boolean;
  /** `validate_<field>` methods: run on the field's value when it passed. */
  hooks?: Partial<Record<string, (value: never) => unknown>>;
  /** `validate(attrs)`: runs only when every field passed. May throw `Invalid` or `InvalidFields`. */
  validate?: (values: V) => V | Promise<V>;
}

/** `serializers.ValidationError({...})` from `validate()`: errors keyed by field. */
export class InvalidFields extends Error {
  constructor(readonly errors: Errors) {
    super('Invalid input.');
  }
}

export type Validated<V> = { ok: true; values: V } | { ok: false; errors: Errors };

/** `Serializer(data=...).is_valid()`, then `.validated_data` or `.errors`. */
export async function runSerializer<V extends Record<string, unknown>>(
  fields: Fields,
  data: unknown,
  options: SerializerOptions<V> = {},
): Promise<Validated<V>> {
  if (data === null || data === undefined) {
    return {
      ok: false,
      errors: { non_field_errors: [{ message: 'No data provided', code: 'null' }] },
    };
  }
  if (!isDict(data)) {
    const message = `Invalid data. Expected a dictionary, but got ${pythonTypeName(data)}.`;
    return { ok: false, errors: { non_field_errors: [{ message, code: 'invalid' }] } };
  }

  const values: Record<string, unknown> = {};
  const errors: Errors = {};
  for (const [name, field] of Object.entries(fields)) {
    try {
      const partial = options.partial ?? false;
      const primitive =
        data instanceof HtmlInput
          ? htmlValue(field, name, data, partial)
          : Object.hasOwn(data, name)
            ? (data as Record<string, unknown>)[name]
            : EMPTY;
      let value = await field.run(primitive, partial);
      if (value === SKIP) continue;
      const hook = options.hooks?.[name];
      if (hook) value = await hook(value as never);
      values[name] = value;
    } catch (error) {
      if (error instanceof Invalid) errors[name] = error.details;
      else if (error instanceof InvalidNested) errors[name] = error.detail;
      else throw error;
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  if (!options.validate) return { ok: true, values: values as V };
  try {
    return { ok: true, values: await options.validate(values as V) };
  } catch (error) {
    if (error instanceof InvalidFields) return { ok: false, errors: error.errors };
    if (error instanceof Invalid) return { ok: false, errors: { non_field_errors: error.details } };
    throw error;
  }
}

/** `serializer.errors` as the envelope's `details`: messages only. */
export function errorMessages(errors: Errors): Record<string, unknown> {
  return treeMessages(errors) as Record<string, unknown>;
}

/** `core.fields.BangladeshiPhoneField`: blank stays blank, a mobile becomes canonical, else refused. */
export function bangladeshiPhoneField(options: CharOptions = {}): Field<string | null> {
  return charField({
    ...options,
    invalidMessage: INVALID_PHONE_MESSAGE,
    convert: (value, fail) => (pyStrip(value) ? (canonicalPhone(value) ?? fail()) : ''),
  });
}

/**
 * `serializers.DictField(child=...)`: a JSON object, each value run through
 * the child (any value, unvalidated, without one); the values' errors are
 * keyed by their keys.
 */
export function dictField(
  options: { required?: boolean; child?: Field<unknown> } = {},
): Field<Record<string, unknown> | null> {
  const child = options.child;
  return {
    run(data, partial) {
      const settled = emptyValue<Record<string, unknown>>(data, partial, {
        required: options.required ?? true,
        allowNull: false,
      });
      if (settled.settled) return settled.value;
      if (!isDict(data)) {
        throw Invalid.of(
          `Expected a dictionary of items but got type "${pythonTypeName(data)}".`,
          'not_a_dict',
        );
      }
      if (!child) return { ...data };
      return (async () => {
        const values: Record<string, unknown> = {};
        const errors: Record<string, ErrorTree> = {};
        for (const [key, item] of Object.entries(data)) {
          try {
            values[key] = await child.run(item, false);
          } catch (error) {
            if (error instanceof Invalid) errors[key] = error.details;
            else if (error instanceof InvalidNested) errors[key] = error.detail;
            else throw error;
          }
        }
        if (Object.keys(errors).length) throw new InvalidNested(errors);
        return values;
      })();
    },
  };
}

/** A field with `default=`: a missing value is the default, not skipped (unless partial). */
export function withDefault<T>(field: Field<T>, fallback: () => T): Field<T> {
  return {
    // A field whose class reads a missing form key as something (a boolean)
    // reads it as the default instead.
    html: field.html && {
      ...field.html,
      required: false,
      emptyHtml: field.html.emptyHtml === undefined ? undefined : fallback(),
    },
    run(data, partial) {
      if ((data === EMPTY || data === undefined) && !partial) return fallback();
      return field.run(data, partial);
    },
  };
}

/** `serializers.UUIDField()`: an int is `UUID(int=...)`, a str `UUID(hex=...)`, anything else refused. */
export function uuidField(
  options: { required?: boolean; allowNull?: boolean } = {},
): Field<string | null> {
  return {
    html: {
      required: options.required ?? true,
      allowNull: options.allowNull ?? false,
      allowBlank: false,
    },
    run(data, partial) {
      const settled = emptyValue<string>(data, partial, {
        required: options.required ?? true,
        allowNull: options.allowNull ?? false,
      });
      if (settled.settled) return settled.value;
      const isInt =
        typeof data === 'boolean' ||
        typeof data === 'bigint' ||
        (typeof data === 'number' && Number.isInteger(data));
      if (!isInt && typeof data !== 'string') throw Invalid.of('Must be a valid UUID.');
      const lookup = uuidFromValue(data);
      if ('invalid' in lookup || !lookup.id) throw Invalid.of('Must be a valid UUID.');
      return lookup.id;
    },
  };
}

/** `Decimal(text).as_tuple()`'s digits and exponent, for a finite literal. */
function decimalTuple(text: string): { digits: string; exponent: number } {
  const unsigned = text.replace(/^[+-]/, '');
  const [mantissa = '', power = '0'] = unsigned.split(/[eE]/);
  const [whole = '', fraction = ''] = mantissa.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  return { digits, exponent: Number(power) - fraction.length };
}

/**
 * `serializers.DecimalField(max_digits, decimal_places)`: Python's `Decimal`
 * parsing, DRF's precision checks, then quantized (half even) -- answered as
 * the Decimal's text.
 */
export function decimalField(
  maxDigits: number,
  decimalPlaces: number,
  options: { required?: boolean; allowNull?: boolean; minValue?: string } = {},
): Field<string | null> {
  const allowNull = options.allowNull ?? false;
  return {
    html: { required: options.required ?? true, allowNull, allowBlank: false },
    run(data, partial) {
      // `validate_empty_values`: a blank string is None when null is allowed.
      if (allowNull && data !== EMPTY && data !== undefined && pyStrip(pyStr(data)) === '')
        return null;
      const settled = emptyValue<string>(data, partial, {
        required: options.required ?? true,
        allowNull,
      });
      if (settled.settled) return settled.value;
      // `smart_str(data).strip()`.
      const text = pyStrip(pyStr(data));
      if (pyLen(text) > 1000) throw Invalid.of('String value too large.', 'max_string_length');
      const parsed = pyDecimal(text);
      if (parsed === null || !isFiniteDecimal(parsed))
        throw Invalid.of('A valid number is required.');

      const { digits, exponent } = decimalTuple(parsed);
      let total: number;
      let whole: number;
      let places: number;
      if (exponent >= 0) {
        total = digits.length + exponent;
        whole = total;
        places = 0;
      } else if (digits.length > -exponent) {
        total = digits.length;
        whole = total + exponent;
        places = -exponent;
      } else {
        total = -exponent;
        whole = 0;
        places = total;
      }
      if (total > maxDigits) {
        throw Invalid.of(
          `Ensure that there are no more than ${maxDigits} digits in total.`,
          'max_digits',
        );
      }
      if (places > decimalPlaces) {
        throw Invalid.of(
          `Ensure that there are no more than ${decimalPlaces} decimal places.`,
          'max_decimal_places',
        );
      }
      if (whole > maxDigits - decimalPlaces) {
        throw Invalid.of(
          `Ensure that there are no more than ${maxDigits - decimalPlaces} digits before the decimal point.`,
          'max_whole_digits',
        );
      }
      const value = new Dec(parsed).toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_EVEN);
      // `MinValueValidator(min_value)`, on the quantized value.
      if (options.minValue !== undefined && value.lt(options.minValue)) {
        throw Invalid.of(
          `Ensure this value is greater than or equal to ${options.minValue}.`,
          'min_value',
        );
      }
      const shown = value.toFixed(decimalPlaces);
      // Python keeps a negative zero's sign: `Decimal("-0")` quantizes to -0.00.
      return value.isZero() && value.isNeg() && !shown.startsWith('-') ? `-${shown}` : shown;
    },
  };
}

/** `serializers.SlugField()`: a CharField whose last validator is the ASCII slug pattern. */
export function slugField(options: CharOptions = {}): Field<string | null> {
  return charField({
    ...options,
    validators: [
      ...(options.validators ?? []),
      (value) =>
        /^[-a-zA-Z0-9_]+$/.test(value)
          ? null
          : {
              message:
                'Enter a valid "slug" consisting of letters, numbers, underscores or hyphens.',
              code: 'invalid',
            },
    ],
  });
}

/** Python whitespace, then `$`: DRF's `re_decimal`, `\.0*\s*$`. */
const RE_DECIMAL = new RegExp(`\\.0*(?:${PY_WHITESPACE.source})?$`);

/**
 * `serializers.IntegerField(min_value, max_value)`: `int()` of the value's
 * `str()` once a `.0` tail is dropped, so `"5.0"` and `5.0` are 5 and `5.5`,
 * `true` and `"five"` are refused. The maximum is checked before the minimum,
 * and both always run. Answers a number, or a bigint past 2^53.
 */
export function integerField(
  options: { required?: boolean; allowNull?: boolean; minValue?: number; maxValue?: number } = {},
): Field<number | bigint | null> {
  return {
    html: {
      required: options.required ?? true,
      allowNull: options.allowNull ?? false,
      allowBlank: false,
    },
    run(data, partial) {
      const settled = emptyValue<number>(data, partial, {
        required: options.required ?? true,
        allowNull: options.allowNull ?? false,
      });
      if (settled.settled) return settled.value;
      if (typeof data === 'string' && pyLen(data) > 1000)
        throw Invalid.of('String value too large.', 'max_string_length');
      const text = typeof data === 'boolean' ? 'True' : pyStr(data);
      const parsed =
        data === true || data === false ? null : pyIntText(text.replace(RE_DECIMAL, ''));
      if (parsed === null) throw Invalid.of('A valid integer is required.');
      const errors: ErrorDetail[] = [];
      if (options.maxValue !== undefined && parsed > BigInt(options.maxValue)) {
        errors.push({
          message: `Ensure this value is less than or equal to ${options.maxValue}.`,
          code: 'max_value',
        });
      }
      if (options.minValue !== undefined && parsed < BigInt(options.minValue)) {
        errors.push({
          message: `Ensure this value is greater than or equal to ${options.minValue}.`,
          code: 'min_value',
        });
      }
      if (errors.length) throw new Invalid(errors);
      const small =
        parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER);
      return small ? Number(parsed) : parsed;
    },
  };
}

/**
 * The primary-key lookup Django's `UUIDField` makes of a value: `UUID(int=)`
 * for an int, `UUID(hex=)` for anything else -- which only a str can pass.
 * Null where Django raises its "is not a valid UUID" `ValidationError`.
 */
function uuidLookup(value: unknown): string | null {
  const lookup = uuidFromValue(value);
  return 'invalid' in lookup ? null : lookup.id;
}

/**
 * `PrimaryKeyRelatedField(queryset=Model.objects.all())` over a UUID primary
 * key, as a ModelSerializer builds one for a foreign key. A blank is null; a
 * bool is the wrong type; a value that is not a UUID is Django's own
 * `ValidationError` (which DRF reports under the field); a UUID nothing has is
 * "does not exist", naming the value as sent. Answers the canonical id.
 */
export function pkRelatedField(
  exists: (id: string) => Promise<boolean>,
  options: { required?: boolean; allowNull?: boolean } = {},
): Field<string | null> {
  return {
    html: {
      required: options.required ?? true,
      allowNull: options.allowNull ?? false,
      allowBlank: false,
    },
    async run(input, partial) {
      // `RelatedField.run_validation`: "" is forced to None first.
      const data = input === '' ? null : input;
      const settled = emptyValue<string>(data, partial, {
        required: options.required ?? true,
        allowNull: options.allowNull ?? false,
      });
      if (settled.settled) return settled.value;
      if (typeof data === 'boolean')
        throw Invalid.of('Incorrect type. Expected pk value, received bool.', 'incorrect_type');
      const id = uuidLookup(data);
      if (id === null) throw Invalid.of(`“${pyStr(data)}” is not a valid UUID.`);
      if (!(await exists(id)))
        throw Invalid.of(`Invalid pk "${pyStr(data)}" - object does not exist.`, 'does_not_exist');
      return id;
    },
  };
}

/** Django's `get_available_image_extensions()`, in the order a worker builds it (Pillow's preinit first). */
export const IMAGE_EXTENSIONS =
  'bmp, dib, gif, jfif, jpe, jpg, jpeg, pbm, pgm, ppm, pnm, pfm, png, apng, avif, avifs, blp, bufr, ' +
  'cur, pcx, dcx, dds, ps, eps, fit, fits, fli, flc, ftc, ftu, gbr, grib, h5, hdf, jp2, j2k, jpc, jpf, ' +
  'jpx, j2c, icns, ico, im, iim, mpg, mpeg, tif, tiff, mpo, msp, palm, pcd, pdf, pxr, psd, qoi, bw, rgb, ' +
  'rgba, sgi, ras, tga, icb, vda, vst, webp, wmf, emf, xbm, xpm';
const IMAGE_EXTENSION_SET = new Set(IMAGE_EXTENSIONS.split(', '));

/** `pathlib.Path(name).suffix`. */
export function pathSuffix(name: string): string {
  const at = name.lastIndexOf('.');
  return at > 0 && at < name.length - 1 ? name.slice(at) : '';
}

/**
 * `serializers.FileField()`: an upload, by DRF's checks -- no file, not a
 * file, no name, empty -- and nothing more.
 */
export function fileField(
  options: { required?: boolean; allowNull?: boolean } = {},
): Field<UploadedFile | null> {
  const required = options.required ?? true;
  const allowNull = options.allowNull ?? false;
  return {
    html: { required, allowNull, allowBlank: false },
    run(data, partial) {
      if (data === EMPTY || data === undefined) {
        if (partial || !required) return SKIP;
        throw Invalid.of('No file was submitted.', 'required');
      }
      if (data === null) {
        if (!allowNull) throw Invalid.of('This field may not be null.', 'null');
        return null;
      }
      if (!isUploadedFile(data))
        throw Invalid.of('The submitted data was not a file. Check the encoding type on the form.');
      if (!data.name) throw Invalid.of('No filename could be determined.', 'no_name');
      if (!data.size) throw Invalid.of('The submitted file is empty.', 'empty');
      return data;
    },
  };
}

/**
 * `serializers.ImageField` (and `RelativeImageField`): DRF's file checks,
 * then Django's `forms.ImageField` -- Pillow must identify and verify it,
 * and its extension must be one Pillow registers. The upload comes back
 * with Pillow's MIME type as its `contentType`, as Django sets it.
 */
export function imageField(
  options: { required?: boolean; allowNull?: boolean } = {},
): Field<UploadedFile | null> {
  const required = options.required ?? true;
  const allowNull = options.allowNull ?? false;
  return {
    html: { required, allowNull, allowBlank: false },
    run(data, partial) {
      if (data === EMPTY || data === undefined) {
        if (partial || !required) return SKIP;
        throw Invalid.of('No file was submitted.', 'required');
      }
      if (data === null) {
        if (!allowNull) throw Invalid.of('This field may not be null.', 'null');
        return null;
      }
      if (!isUploadedFile(data))
        throw Invalid.of('The submitted data was not a file. Check the encoding type on the form.');
      if (!data.name) throw Invalid.of('No filename could be determined.', 'no_name');
      if (!data.size) throw Invalid.of('The submitted file is empty.', 'empty');
      const image = identifyImage(data.bytes);
      if (!image) {
        throw Invalid.of(
          'Upload a valid image. The file you uploaded was either not an image or a corrupted image.',
          'invalid_image',
        );
      }
      const extension = pathSuffix(data.name).slice(1).toLowerCase();
      if (!IMAGE_EXTENSION_SET.has(extension)) {
        throw Invalid.of(
          `File extension “${extension}” is not allowed. Allowed extensions are: ${IMAGE_EXTENSIONS}.`,
          'invalid_extension',
        );
      }
      return { ...data, contentType: image.mime };
    },
  };
}

/**
 * `serializers.ListField(child=...)`: a JSON array (a string or an object
 * is refused, by type name), each item run through the child; the items'
 * errors are keyed by index.
 */
export function listField<T>(
  child: Field<T>,
  options: { required?: boolean; allowNull?: boolean; allowEmpty?: boolean } = {},
): Field<T[] | null> {
  return {
    async run(data, partial) {
      const settled = emptyValue<T[]>(data, partial, {
        required: options.required ?? true,
        allowNull: options.allowNull ?? false,
      });
      if (settled.settled) return settled.value;
      if (!Array.isArray(data)) {
        throw Invalid.of(
          `Expected a list of items but got type "${pythonTypeName(data)}".`,
          'not_a_list',
        );
      }
      if (options.allowEmpty === false && data.length === 0)
        throw Invalid.of('This list may not be empty.', 'empty');
      const values: T[] = [];
      const errors: Record<string, ErrorTree> = {};
      for (const [index, item] of data.entries()) {
        try {
          const value = await child.run(item, false);
          if (value !== SKIP) values.push(value);
        } catch (error) {
          if (error instanceof Invalid) errors[String(index)] = error.details;
          else if (error instanceof InvalidNested) errors[String(index)] = error.detail;
          else throw error;
        }
      }
      if (Object.keys(errors).length) throw new InvalidNested(errors);
      return values;
    },
  };
}

/**
 * A nested serializer with `many=True` (a `ListSerializer`): a JSON array
 * of objects, each validated by `fields` with the outer serializer's
 * `partial` -- DRF reads it from the root, so a PATCH lets a nested item
 * leave out a required field. Errors come back one entry per item, `{}`
 * for an item that passed; an item that is null is refused as a field is.
 */
export function nestedListField(
  fields: Fields,
  options: { required?: boolean; allowEmpty?: boolean } = {},
): Field<Record<string, unknown>[] | null> {
  return {
    async run(data, partial) {
      const settled = emptyValue<Record<string, unknown>[]>(data, partial, {
        required: options.required ?? true,
        allowNull: false,
      });
      if (settled.settled) return settled.value;
      if (!Array.isArray(data)) {
        throw new InvalidNested({
          non_field_errors: [
            {
              message: `Expected a list of items but got type "${pythonTypeName(data)}".`,
              code: 'not_a_list',
            },
          ],
        });
      }
      if (options.allowEmpty === false && data.length === 0) {
        throw new InvalidNested({
          non_field_errors: [{ message: 'This list may not be empty.', code: 'empty' }],
        });
      }
      const values: Record<string, unknown>[] = [];
      const errors: ErrorTree[] = [];
      let failed = false;
      for (const item of data) {
        if (item === null) {
          errors.push([{ message: 'This field may not be null.', code: 'null' }]);
          failed = true;
          continue;
        }
        const result = await runSerializer(fields, item, { partial });
        if (result.ok) {
          values.push(result.values);
          errors.push({});
        } else {
          errors.push(result.errors);
          failed = true;
        }
      }
      if (failed) throw new InvalidNested(errors);
      return values;
    },
  };
}

/** A Gregorian date from its parts, or null where Python's `date()` raises. */
function gregorian(year: number, month: number, day: number): string | null {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const last = new Date(Date.UTC(2000, month, 0)).getUTCDate();
  const days =
    month === 2 && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 28 : last;
  if (day > days) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * `serializers.DateField()`: Django's `parse_date` -- `date.fromisoformat`,
 * else `YYYY-M-D` in any script's digits (a trailing newline allowed, as
 * Python's `$` allows it) -- or "Date has wrong format". Answers `YYYY-MM-DD`.
 */
export function dateField(
  options: { required?: boolean; allowNull?: boolean } = {},
): Field<string | null> {
  const invalid = () =>
    Invalid.of('Date has wrong format. Use one of these formats instead: YYYY-MM-DD.');
  return {
    run(data, partial) {
      const settled = emptyValue<string>(data, partial, {
        required: options.required ?? true,
        allowNull: options.allowNull ?? false,
      });
      if (settled.settled) return settled.value;
      if (typeof data !== 'string') throw invalid();
      const iso = dateFromIsoformat(data);
      if (iso) return gregorian(iso.year, iso.month, iso.day) as string;
      const match = /^(\p{Nd}{4})-(\p{Nd}{1,2})-(\p{Nd}{1,2})\n?$/u.exec(data);
      if (!match) throw invalid();
      const [year, month, day] = match.slice(1).map((part) => Number(pyIntText(part as string)));
      return (
        gregorian(year as number, month as number, day as number) ??
        (() => {
          throw invalid();
        })()
      );
    },
  };
}
