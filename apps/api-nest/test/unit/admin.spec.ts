/**
 * The staff plumbing against Django's own answers: `RolePermission`, the
 * slugs, DRF's `IntegerField` and django-filter's boolean widget. Every
 * expected value was printed by the Django API's container (Django 5.1,
 * DRF 3.15, django-filter 24.3), not worked out by hand.
 */
import { type RequiredPermissions, requiredCodes } from '../../src/auth/permissions';
import { integerField, Invalid } from '../../src/common/drf';
import { booleanValue } from '../../src/common/filtering';
import { PyFloat } from '../../src/common/python';
import { slugify, slugText } from '../../src/common/slugs';

describe('RolePermission', () => {
  // A user holding only `products.view`, asked by `RolePermission.has_permission`
  // under each declaration, action (`None` for an APIView or an unmapped method)
  // and HTTP method.
  const configs: Record<string, RequiredPermissions> = {
    dict: { list: ['products.view'], retrieve: ['products.view'], create: ['products.create'] },
    per_method: { addresses: { GET: ['products.view'], POST: ['products.update'] } },
    flat_empty: [],
    flat: ['products.view'],
    empty_list_falls_through: { list: [], retrieve: ['products.update'] },
    apiview: { get: ['products.view'], patch: ['settings.manage'] },
  };
  const allowed = new Set([
    ...['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH'].flatMap((method) => [
      `dict|list|${method}`,
      ...['list', 'create', 'addresses', 'None', 'get', 'move'].flatMap((action) => [
        `flat_empty|${action}|${method}`,
        `flat|${action}|${method}`,
      ]),
      `empty_list_falls_through|list|${method}`,
      `apiview|get|${method}`,
    ]),
    ...['GET', 'HEAD', 'OPTIONS'].flatMap((method) => [
      `dict|addresses|${method}`,
      `dict|None|${method}`,
      `dict|get|${method}`,
      `dict|move|${method}`,
      `per_method|addresses|${method}`,
    ]),
    'apiview|None|GET',
  ]);
  const held = new Set(['products.view']);

  for (const [name, required] of Object.entries(configs)) {
    for (const action of ['list', 'create', 'addresses', 'None', 'get', 'move']) {
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH']) {
        const key = `${name}|${action}|${method}`;
        it(`${key} is ${allowed.has(key) ? 'allowed' : 'refused'}`, () => {
          const codes = requiredCodes(required, action === 'None' ? null : action, method);
          const ok = codes !== null && codes.every((code) => held.has(code));
          expect(ok).toBe(allowed.has(key));
        });
      }
    }
  }
});

describe('slugs', () => {
  // `core.slugs.slug_text(s)` and `django.utils.text.slugify(s)`.
  const cases: [string, string, string][] = [
    ['শাড়ি', 'shari', ''],
    ['পাঞ্জাবি', 'panjabi', ''],
    ['থ্রি-পিস', 'thri-pis', ''],
    ['জামদানি', 'jamdani', ''],
    ['লুঙ্গি', 'lungi', ''],
    ['প্যান্ট', 'pyant', ''],
    ['শাড়ি ঘর', 'shari-ghar', ''],
    ['!!!', '', ''],
    ['Café Déjà Vu', 'cafe-deja-vu', 'cafe-deja-vu'],
    ['  Hello   World  ', 'hello-world', 'hello-world'],
    ['a_b-c', 'a_b-c', 'a_b-c'],
    ['Ünïcödé', 'unicode', 'unicode'],
    ['東京', '', ''],
    ['x\x1cy', 'x-y', 'x-y'],
    ['ড়', 'r', ''],
    ['৳ ১২৯০', '1290', ''],
    ['ক্ষ', 'ksh', ''],
    ['হ্যাঁ', 'hya', ''],
    ['--a--', 'a', 'a'],
    ['_a_', 'a', 'a'],
  ];
  for (const [value, text, plain] of cases) {
    it(`slugs ${JSON.stringify(value)}`, () => {
      expect(slugText(value)).toBe(text);
      expect(slugify(value)).toBe(plain);
    });
  }
});

describe('IntegerField(min_value=0, max_value=2147483647)', () => {
  const field = integerField({ minValue: 0, maxValue: 2147483647 });
  const run = (value: unknown): unknown => {
    try {
      return field.run(value, false);
    } catch (error) {
      if (error instanceof Invalid) return error.details.map((detail) => detail.message);
      throw error;
    }
  };
  const invalid = ['A valid integer is required.'];
  const cases: [unknown, unknown][] = [
    ['5', 5],
    ['5.0', 5],
    ['5.', 5],
    ['5.00 ', 5],
    [' 7 ', 7],
    ['+3', 3],
    ['1_000', 1000],
    ['٥', 5],
    ['5.5', invalid],
    ['abc', invalid],
    ['', invalid],
    ['1e3', invalid],
    ['-1', ['Ensure this value is greater than or equal to 0.']],
    ['2147483648', ['Ensure this value is less than or equal to 2147483647.']],
    ['0.0', 0],
    ['5.0\n', 5],
    [5, 5],
    [new PyFloat(5), 5],
    [new PyFloat(5.5), invalid],
    [true, invalid],
    [new PyFloat(1e20), invalid],
    [new PyFloat(-0), 0],
  ];
  for (const [value, expected] of cases) {
    it(`reads ${JSON.stringify(value instanceof PyFloat ? value.toString() : value)}`, () => {
      expect(run(value)).toEqual(expected);
    });
  }
});

describe("django-filter's BooleanWidget", () => {
  const cases: [string, boolean | null][] = [
    ['1', true],
    ['0', false],
    ['true', true],
    ['false', false],
    ['TRUE', true],
    ['False', false],
    ['yes', null],
    ['', null],
    ['on', null],
    ['tRuE', true],
  ];
  for (const [value, expected] of cases) {
    it(`reads ${JSON.stringify(value)}`, () => expect(booleanValue(value)).toBe(expected));
  }
});
