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

import { isDict, pythonTypeName } from '../http/request-body';
import { canonicalPhone, INVALID_PHONE_MESSAGE } from './phone';
import { PyFloat, pyLen, pyStr, pyStrip } from './python';

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

export interface Field<T> {
  run(data: unknown, partial: boolean): T | typeof SKIP;
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
      runValidators(value, validators);
      return value;
    },
  };
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
      throw Invalid.of(`"${pyStr(data)}" is not a valid boolean.`);
    },
  };
}

/** `serializers.ChoiceField` over string choices. */
export function choiceField(
  choices: readonly string[],
  options: { required?: boolean; allowBlank?: boolean } = {},
): Field<string | null> {
  return {
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
export type Errors = Record<string, ErrorDetail[]>;

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
      let value = field.run(
        Object.hasOwn(data, name) ? data[name] : EMPTY,
        options.partial ?? false,
      );
      if (value === SKIP) continue;
      const hook = options.hooks?.[name];
      if (hook) value = await hook(value as never);
      values[name] = value;
    } catch (error) {
      if (error instanceof Invalid) errors[name] = error.details;
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
export function errorMessages(errors: Errors): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(errors).map(([name, details]) => [
      name,
      details.map((detail) => detail.message),
    ]),
  );
}

/** `core.fields.BangladeshiPhoneField`: blank stays blank, a mobile becomes canonical, else refused. */
export function bangladeshiPhoneField(options: CharOptions = {}): Field<string | null> {
  return charField({
    ...options,
    invalidMessage: INVALID_PHONE_MESSAGE,
    convert: (value, fail) => (pyStrip(value) ? (canonicalPhone(value) ?? fail()) : ''),
  });
}
