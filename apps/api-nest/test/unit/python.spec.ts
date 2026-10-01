import {
  isFiniteDecimal,
  parseQsl,
  pyDecimal,
  pyInt,
  quotePlus,
  removeQueryParam,
  replaceQueryParam,
} from '../../src/common/python';

describe("Python's int()", () => {
  it.each([
    ['12', 12],
    [' 12 ', 12],
    ['+5', 5],
    ['-3', -3],
    ['1_000', 1000],
  ])('accepts %j', (text, value) => expect(pyInt(text)).toBe(value));

  it.each(['', 'abc', '1.0', '1__0', '_1', '1_', '1e3', '0x10'])('refuses %j', (text) =>
    expect(pyInt(text)).toBeNull(),
  );
});

describe("Python's Decimal()", () => {
  it.each([
    ['12.50', '12.50'],
    [' 1e3 ', '1e3'],
    ['1_000.5', '1000.5'],
    ['.5', '.5'],
    ['5.', '5.'],
    ['-0', '-0'],
  ])('accepts %j as %j', (text, value) => expect(pyDecimal(text)).toBe(value));

  it.each([
    ['nan', 'NaN'],
    ['-NaN', '-NaN'],
    ['snan', 'sNaN'],
    ['inf', 'Infinity'],
    ['-infinity', '-Infinity'],
  ])('prints the special %j as Python does', (text, value) => {
    expect(pyDecimal(text)).toBe(value);
    expect(isFiniteDecimal(value)).toBe(false);
  });

  it.each(['', 'abc', '--1', '1e', '.', '1,000'])('refuses %j', (text) =>
    expect(pyDecimal(text)).toBeNull(),
  );
});

describe('query strings as DRF rebuilds them', () => {
  it('quote_plus encodes all but the unreserved set, and spaces as +', () => {
    expect(quotePlus('a b/ü~._-')).toBe('a+b%2F%C3%BC~._-');
  });

  it('parse_qsl keeps blanks and repeats, and decodes + and %', () => {
    expect(parseQsl('a=1&a=2&b&c=x+y&d=%41&e=%zz')).toEqual([
      ['a', '1'],
      ['a', '2'],
      ['b', ''],
      ['c', 'x y'],
      ['d', 'A'],
      ['e', '%zz'],
    ]);
  });

  it('replace_query_param sorts the keys and keeps repeated values in order', () => {
    expect(
      replaceQueryParam('http://h/p/?sort=newest&page_size=3&brand=b&brand=a&q=', 'page', 2),
    ).toBe('http://h/p/?brand=b&brand=a&page=2&page_size=3&q=&sort=newest');
  });

  it('remove_query_param drops the ? when nothing is left', () => {
    expect(removeQueryParam('http://h/p/?page=2', 'page')).toBe('http://h/p/');
  });
});

describe('pyDecimal, as CPython 3.12 converts a string', () => {
  // Printed by the Django API's container: `Decimal(text)`.
  it.each([
    ['1_0', '10'],
    ['_10', '10'],
    ['10_', '10'],
    ['1__0', '10'],
    ['১২৯০', '1290'],
    ['১_২', '12'],
    [' 12 ', '12'],
    ['\x1c5\x1f', '5'],
    ['٣.٥', '3.5'],
    ['1e_5', '1e5'],
    ['inf_', 'Infinity'],
    ['-nan12', '-NaN'],
    ['1.2_3', '1.23'],
  ])('%j is %s', (text, expected) => {
    expect(pyDecimal(text)).toBe(expected);
  });

  it.each(['1,0', '1 0', '0x10', '①', '_ 0.5', ' ১\n_\t', ''])('refuses %j', (text) => {
    expect(pyDecimal(text)).toBeNull();
  });
});
