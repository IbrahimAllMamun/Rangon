import { ValidationError } from '../../src/common/errors';
import { applyFilters, numberFilter } from '../../src/common/filtering';
import { QueryDict } from '../../src/common/query-dict';
import type { Queryable } from '../../src/database/database.service';
import { Params } from '../../src/database/sql';

/**
 * `?rating=` on the review list: django-filter's `NumberFilter` over a small
 * integer column. Every outcome was read off the Django API in the parity
 * stack: the SQL it ran, the error it gave, or that it ran none.
 */
describe('numberFilter (NumberFilter on an integer column)', () => {
  const FIELDS = [numberFilter('rating', '"r"."rating"', 'positiveSmallint')];
  const filter = async (raw: string) => {
    const sql = new Params();
    const where: string[] = [];
    try {
      await applyFilters(
        null as unknown as Queryable,
        new QueryDict(`rating=${encodeURIComponent(raw)}`),
        FIELDS,
        sql,
        where,
      );
    } catch (error) {
      if (error instanceof ValidationError) {
        return (error.details as Record<string, string[]>).rating?.[0];
      }
      throw error;
    }
    return where.length ? `${where[0]} [${sql.values.join()}]` : 'unfiltered';
  };

  it.each([
    ['5', '"r"."rating" = $1 [5]'],
    // The column's lookup cuts the Decimal to a whole number: `rating=4.5` finds the fours.
    ['4.5', '"r"."rating" = $1 [4]'],
    ['4.9', '"r"."rating" = $1 [4]'],
    ['1e0', '"r"."rating" = $1 [1]'],
    ['', 'unfiltered'],
    // Past what the column can hold, Django knows no row matches and asks nothing.
    ['99999', 'FALSE []'],
  ])('rating=%j filters as %s', async (raw, outcome) => {
    expect(await filter(raw)).toBe(outcome);
  });

  it.each(['abc', 'NaN', 'Infinity', '-Infinity', '0x5', '5,0', '5 5', '--5', '5e'])(
    'rating=%j is not a number',
    async (raw) => {
      expect(await filter(raw)).toBe('Enter a number.');
    },
  );

  it('a number past 1e50 is refused by its size', async () => {
    expect(await filter('1e400')).toBe('Ensure this value is less than or equal to 1e+50.');
  });
});
