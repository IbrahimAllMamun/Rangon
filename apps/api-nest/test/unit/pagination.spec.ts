import { NotFound } from '../../src/common/errors';
import {
  pageSizeFrom,
  paginated,
  resolvePage,
  STANDARD_PAGINATION,
} from '../../src/common/pagination';
import { QueryDict } from '../../src/common/query-dict';

describe('PageNumberPagination', () => {
  it.each([
    ['', 25],
    ['page_size=5', 5],
    ['page_size=%205', 5],
    ['page_size=0', 25],
    ['page_size=-1', 25],
    ['page_size=abc', 25],
    ['page_size=1000', 100],
    ['page_size=2&page_size=4', 4],
  ])('page size for %j is %i', (query, size) => {
    expect(pageSizeFrom(new QueryDict(query), STANDARD_PAGINATION)).toBe(size);
  });

  it('an empty result still has page 1', () => {
    expect(resolvePage(new QueryDict(''), 0, 25)).toMatchObject({ number: 1, offset: 0, limit: 0 });
  });

  it('`last` is the last page, and the last page may be short', () => {
    expect(resolvePage(new QueryDict('page=last'), 12, 5)).toMatchObject({
      number: 3,
      offset: 10,
      limit: 2,
    });
  });

  it.each(['page=0', 'page=4', 'page=abc', 'page=2.0'])('%j is "Invalid page."', (query) => {
    expect(() => resolvePage(new QueryDict(query), 12, 5)).toThrow(NotFound);
    expect(() => resolvePage(new QueryDict(query), 12, 5)).toThrow('Invalid page.');
  });

  it('previous to page 1 drops page; next replaces it', () => {
    const page = resolvePage(new QueryDict('page=2'), 12, 5);
    expect(paginated(page, [], 'http://h/p/?page=2&page_size=5')).toEqual({
      count: 12,
      next: 'http://h/p/?page=3&page_size=5',
      previous: 'http://h/p/?page_size=5',
      results: [],
    });
  });
});
