/**
 * The accounts port against Django's own answers. Every expected value here
 * was printed by the Django API's container (Django 5.1, Python 3.12), not
 * worked out by hand.
 */
import {
  pbkdf2Encode,
  quickRatio,
  validatePassword,
  verifyPassword,
} from '../../src/accounts/passwords';
import {
  bangladeshiPhoneField,
  charField,
  emailField,
  errorMessages,
  Invalid,
  isValidEmail,
  runSerializer,
} from '../../src/common/drf';
import { canonicalPhone } from '../../src/common/phone';
import { PyFloat, pyRepr, pyStr } from '../../src/common/python';
import { uuidFromValue } from '../../src/common/uuid';
import { parsePythonJson, pyTruthy } from '../../src/http/request-body';

describe('password hashes', () => {
  // `Argon2PasswordHasher().encode("Parity-Pass-2026 ü", "abcdefghijklmnopqrstuv")`.
  const djangoArgon2 =
    'argon2$argon2id$v=19$m=102400,t=2,p=8$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dg$IgorAEoC45Hed6TrnrYvCyIvYcj3785+rmJayoEyW88';

  it("verifies Django's Argon2 hash, and sees nothing to upgrade", async () => {
    await expect(verifyPassword('Parity-Pass-2026 ü', djangoArgon2)).resolves.toEqual({
      correct: true,
      mustUpdate: false,
    });
    await expect(verifyPassword('parity-pass-2026 ü', djangoArgon2)).resolves.toMatchObject({
      correct: false,
    });
  });

  it('encodes PBKDF2 exactly as Django does, and upgrades it', async () => {
    const encoded = pbkdf2Encode('Parity-Pass-2026!', 'paritysaltparitysalt22', 1000);
    expect(encoded).toBe(
      'pbkdf2_sha256$1000$paritysaltparitysalt22$XrdDHsXFF+/NZ9xUr3hpVPzeZwyn2bLyDKliY0SgcNM=',
    );
    await expect(verifyPassword('Parity-Pass-2026!', encoded)).resolves.toEqual({
      correct: true,
      mustUpdate: true,
    });
  });

  it('refuses an unusable or unknown hash', async () => {
    await expect(verifyPassword('x', '!unusable')).resolves.toEqual({
      correct: false,
      mustUpdate: false,
    });
    await expect(verifyPassword('x', 'md5$salt$abc')).resolves.toEqual({
      correct: false,
      mustUpdate: false,
    });
  });
});

describe('password validators', () => {
  const user = { firstName: 'Parvin', lastName: 'Sultana', email: 'parity.customer@rangon.test' };

  it.each([
    ['1234567890', null, ['This password is too common.', 'This password is entirely numeric.']],
    ['password123', null, ['This password is too common.']],
    ['Sultana2026', user, ['The password is too similar to the last name.']],
    ['parity.customer', user, ['The password is too similar to the email.']],
    ['Tr0ub4dor&3xyz', null, []],
    // Superscripts are digits to `str.isdigit()`.
    ['¹²³⁴⁵⁶⁷⁸⁹⁰', null, ['This password is entirely numeric.']],
  ])('%s', (password, who, messages) => {
    expect(validatePassword(password, who).map((error) => error.message)).toEqual(messages);
  });

  it("computes SequenceMatcher's quick_ratio", () => {
    expect(quickRatio('abcd', 'bcde')).toBe(0.75);
    expect(quickRatio('parvinsultana1', 'parvin')).toBeCloseTo(0.6);
  });
});

describe('EmailValidator', () => {
  it.each([
    ['a@b.co', true],
    ['bad', false],
    ['a@localhost', true],
    ['a@[127.0.0.1]', true],
    ['a@[::1]', true],
    ['"q u"@x.org', false],
    ['a@münchen.de', true],
    ['a..b@x.org', false],
    ['a@x-.org', false],
    [`${'x'.repeat(65)}@x.org`, true],
    ['K@x.org', true],
  ])('%s -> %s', (email, valid) => {
    expect(isValidEmail(email)).toBe(valid);
  });
});

describe('core.phone.canonical', () => {
  it.each([
    ['01712345678', '8801712345678'],
    ['+880 1712-345678', '8801712345678'],
    ['88001712345678', '8801712345678'],
    ['0171234567', null],
    ['02-9612345', null],
    ['০১৭১২৩৪৫৬৭৮', null],
    // Python's `\d` takes any script's digits after the ASCII `1[3-9]`.
    ['017১২৩৪৫৬৭৮', '88017১২৩৪৫৬৭৮'],
    ['', null],
  ])('%s', (raw, canonical) => {
    expect(canonicalPhone(raw)).toBe(canonical);
  });
});

describe("Python's str() and repr()", () => {
  it.each([
    [1e16, '1e+16'],
    [1.5e-5, '1.5e-05'],
    [4, '4.0'],
    [0.0001, '0.0001'],
    [123456789, '123456789.0'],
    [-0, '-0.0'],
    [1e22, '1e+22'],
  ])('float %s', (value, text) => {
    expect(String(new PyFloat(value))).toBe(text);
  });

  it('writes containers as Python does', () => {
    expect(pyRepr(["a'b", 'it"s', 'x\ny', { k: null, t: true }, new PyFloat(1.5)])).toBe(
      `["a'b", 'it"s', 'x\\ny', {'k': None, 't': True}, 1.5]`,
    );
    expect(pyStr('plain')).toBe('plain');
  });
});

describe('request bodies', () => {
  it("keeps Python's int and float apart", () => {
    const data = parsePythonJson('{"a": 4.0, "b": 4, "c": 12345678901234567890}') as Record<
      string,
      unknown
    >;
    expect(data.a).toBeInstanceOf(PyFloat);
    expect(data.b).toBe(4);
    expect(data.c).toBe(12345678901234567890n);
  });

  it("follows Python's truthiness", () => {
    expect([undefined, null, '', 0, false, [], {}, new PyFloat(0)].map(pyTruthy)).toEqual(
      Array(8).fill(false),
    );
    expect(['x', 1, [0], new PyFloat(0.5)].map(pyTruthy)).toEqual(Array(4).fill(true));
  });

  it('looks up a primary key as UUIDField.to_python does', () => {
    expect(uuidFromValue(1)).toEqual({ id: '00000000-0000-0000-0000-000000000001' });
    expect(uuidFromValue(null)).toEqual({ id: null });
    expect(uuidFromValue('nope')).toEqual({ invalid: true });
    expect(uuidFromValue(-1)).toEqual({ invalid: true });
  });
});

describe('serializer validation', () => {
  const register = {
    email: emailField(),
    password: charField({ minLength: 10 }),
    first_name: charField({ required: false, allowBlank: true, maxLength: 80 }),
    phone: bangladeshiPhoneField({ required: false, allowBlank: true, maxLength: 32 }),
  };

  // Captured from POST /api/v1/auth/register/ on the Django API.
  it('reports every field, in declaration order, with DRF words', async () => {
    const result = await runSerializer(register, {
      email: 'bad',
      password: 'short',
      first_name: 'x'.repeat(81),
      phone: '123',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors)).toEqual(['email', 'password', 'first_name', 'phone']);
    expect(errorMessages(result.errors)).toEqual({
      email: ['Enter a valid email address.'],
      password: ['Ensure this field has at least 10 characters.'],
      first_name: ['Ensure this field has no more than 80 characters.'],
      phone: ['Enter a Bangladeshi mobile number, for example 01712345678.'],
    });
  });

  it('refuses what is not a dictionary', async () => {
    const list = await runSerializer(register, [1]);
    const none = await runSerializer(register, null);
    expect(list.ok || errorMessages(list.errors)).toEqual({
      non_field_errors: ['Invalid data. Expected a dictionary, but got list.'],
    });
    expect(none.ok || errorMessages(none.errors)).toEqual({
      non_field_errors: ['No data provided'],
    });
  });

  it('coerces numbers the way str() does, and runs hooks only on valid values', async () => {
    const seen: string[] = [];
    const result = await runSerializer<{ first_name: string }>(
      { first_name: charField({ required: false, allowBlank: true }), password: charField() },
      { first_name: new PyFloat(4), password: ['x'] },
      {
        hooks: {
          first_name: (value: string) => {
            seen.push(value);
            return value;
          },
          password: () => {
            throw Invalid.of('never reached');
          },
        },
      },
    );
    expect(seen).toEqual(['4.0']);
    expect(result.ok || errorMessages(result.errors)).toEqual({
      password: ['Not a valid string.'],
    });
  });

  it('distinguishes required, null and blank', async () => {
    const result = await runSerializer(
      { a: charField(), b: charField(), c: charField(), d: charField({ trimWhitespace: false }) },
      { b: null, c: '   ', d: '   ' },
    );
    expect(result.ok || errorMessages(result.errors)).toEqual({
      a: ['This field is required.'],
      b: ['This field may not be null.'],
      c: ['This field may not be blank.'],
    });
  });
});
