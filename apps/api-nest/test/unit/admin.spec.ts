/**
 * The staff plumbing against Django's own answers: `RolePermission`, the
 * slugs, DRF's `IntegerField` and django-filter's boolean widget. Every
 * expected value was printed by the Django API's container (Django 5.1,
 * DRF 3.15, django-filter 24.3), not worked out by hand.
 */
import { type RequiredPermissions, requiredCodes } from '../../src/auth/permissions';
import {
  charField,
  dateField,
  errorMessages,
  integerField,
  Invalid,
  listField,
  nestedListField,
  runSerializer,
  uuidField,
} from '../../src/common/drf';
import { booleanValue, orderingPlan, searchTerms } from '../../src/common/filtering';
import { PyFloat } from '../../src/common/python';
import { QueryDict } from '../../src/common/query-dict';
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

describe('ListField and a nested serializer with many=True', () => {
  // `SizeChartSerializer(data=...).errors`, printed by Django.
  const cell = () => charField({ allowBlank: true, trimWhitespace: false });
  const fields = {
    columns: listField(cell(), { required: false }),
    rows: nestedListField(
      { attribute_value: uuidField(), cells: listField(cell()) },
      { required: false },
    ),
  };
  const errors = async (data: unknown, partial = false) => {
    const result = await runSerializer(fields, data, { partial });
    return result.ok ? result.values : errorMessages(result.errors);
  };

  it("keys a ListField's errors by index", async () => {
    expect(await errors({ columns: [1, true, null, '', ' a ', [1]] })).toEqual({
      columns: {
        '1': ['Not a valid string.'],
        '2': ['This field may not be null.'],
        '5': ['Not a valid string.'],
      },
    });
    expect(await errors({ columns: 'abc' })).toEqual({
      columns: ['Expected a list of items but got type "str".'],
    });
    expect(await errors({ columns: { a: 1 } })).toEqual({
      columns: ['Expected a list of items but got type "dict".'],
    });
  });

  it('gives a nested list one entry per item', async () => {
    const id = 'e8328b3c-43e1-4161-8f28-117a7ababfe6';
    expect(
      await errors({
        rows: [
          null,
          5,
          's',
          {},
          { attribute_value: 'nope', cells: 'x' },
          { attribute_value: id, cells: [null, 3, new PyFloat(4.5)] },
        ],
      }),
    ).toEqual({
      rows: [
        ['This field may not be null.'],
        { non_field_errors: ['Invalid data. Expected a dictionary, but got int.'] },
        { non_field_errors: ['Invalid data. Expected a dictionary, but got str.'] },
        { attribute_value: ['This field is required.'], cells: ['This field is required.'] },
        {
          attribute_value: ['Must be a valid UUID.'],
          cells: ['Expected a list of items but got type "str".'],
        },
        { cells: { '0': ['This field may not be null.'] } },
      ],
    });
    expect(await errors({ rows: 'x' })).toEqual({
      rows: { non_field_errors: ['Expected a list of items but got type "str".'] },
    });
  });

  it("lets a partial update's nested item leave out a required field", async () => {
    expect(await errors({ rows: [{ cells: ['1'] }] }, true)).toEqual({ rows: [{ cells: ['1'] }] });
  });
});

describe('OrderingFilter', () => {
  const terms = {
    name: '"t"."name"',
    rows: {
      columns: ['"v"."position"', '"v"."value"'],
      join: 'JOIN v',
      groupBy: ['"v"."position"'],
    },
  };
  it("keeps the allowed terms, flips a relation's columns, and adds its join once", () => {
    expect(orderingPlan(new QueryDict('ordering=bogus,-rows,%20name%20,rows'), terms)).toEqual({
      order: [
        '"v"."position" DESC',
        '"v"."value" DESC',
        '"t"."name" ASC',
        '"v"."position" ASC',
        '"v"."value" ASC',
      ],
      joins: ['JOIN v'],
      groupBy: ['"v"."position"'],
    });
    expect(orderingPlan(new QueryDict('ordering=bogus,-'), terms)).toBeNull();
    expect(orderingPlan(new QueryDict(''), terms)).toBeNull();
  });
});

describe('DateField(allow_null=True)', () => {
  // `serializers.DateField(allow_null=True, required=False).run_validation(v)`, printed by DRF.
  const field = dateField({ allowNull: true, required: false });
  const wrong = ['Date has wrong format. Use one of these formats instead: YYYY-MM-DD.'];
  const cases: [unknown, unknown][] = [
    ['2026-01-05', '2026-01-05'],
    ['2026-1-5', '2026-01-05'],
    ['20260105', '2026-01-05'],
    ['2026-W01-1', '2025-12-29'],
    ['2026W011', '2025-12-29'],
    ['2026-02-30', wrong],
    ['', wrong],
    [null, null],
    [5, wrong],
    ['2026-01-05T00:00', wrong],
    ['٢٠٢٦-٠١-٠٥', '2026-01-05'],
    [' 2026-01-05', wrong],
    ['2026-01-05\n', '2026-01-05'],
    ['2026-001', wrong],
    ['+2026-01-05', wrong],
    ['2026-01-05 ', wrong],
  ];
  for (const [value, expected] of cases) {
    it(`reads ${JSON.stringify(value)}`, () => {
      let got: unknown;
      try {
        got = field.run(value, false);
      } catch (error) {
        got = (error as Invalid).details.map((detail) => detail.message);
      }
      expect(got).toEqual(expected);
    });
  }
});

describe("SearchFilter's search_smart_split", () => {
  // `rest_framework.filters.search_smart_split(t)`, printed by DRF.
  const cases: [string, string[]][] = [
    ['a b', ['a', 'b']],
    ['a,b', ['a', 'b']],
    ['"a b" c', ['a b', 'c']],
    ["'x y'", ['x y']],
    ['"', ['']],
    ['""', ['']],
    ['a"b c"d', ['a"b c"d']],
    [',,a,,', ['a']],
    ['RGN-CLA,  WHI', ['RGN-CLA', 'WHI']],
  ];
  for (const [value, expected] of cases) {
    it(`splits ${JSON.stringify(value)}`, () => {
      expect(searchTerms(new QueryDict(`search=${encodeURIComponent(value)}`))).toEqual(expected);
    });
  }
});
