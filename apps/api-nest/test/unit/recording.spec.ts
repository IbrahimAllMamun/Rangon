/**
 * The recorded proof's own logic (parity/recording.ts): what a recording
 * keeps, and how far it holds the order of a list whose rows tie.
 */
import {
  type Answered,
  edgesOfAPage,
  endOfTheFirst,
  kept,
  mergedTies,
  Names,
  Pace,
  pageOf,
  plain,
  settled,
  type Tie,
  tiesBetween,
} from '../../parity/recording';

const json = (body: unknown, effects: unknown[][] = []): Answered => ({
  response: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  },
  effects,
});
const csv = (lines: string[]): Answered => ({
  response: {
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8' },
    body: lines.join('\r\n'),
  },
  effects: [],
});
const rows = (...ids: string[]) => ({ count: ids.length, results: ids.map((id) => ({ id })) });

describe('what a recording keeps', () => {
  it('keeps the headers the comparison reads and no others', () => {
    const answer = kept({
      status: 201,
      headers: { 'content-type': 'application/json', location: '/x/', date: 'today', server: 'a' },
      body: '{}',
    });
    expect(answer).toEqual({
      status: 201,
      headers: { 'content-type': 'application/json', location: '/x/' },
      body: '{}',
    });
  });

  it('reads a moment as a moment, as the comparison always has', () => {
    expect(plain([{ at: new Date(0), n: 1n, none: undefined, bytes: Buffer.from('a') }])).toEqual([
      { at: '<a moment>', n: '1', none: null, bytes: { bytes: 'YQ==' } },
    ]);
  });

  it('names the second use of a case name', () => {
    const names = new Names();
    expect([names.key('a'), names.key('b'), names.key('a'), names.key('a')]).toEqual([
      'a',
      'b',
      'a #2',
      'a #3',
    ]);
    expect(names.repeated).toBe(2);
  });
});

describe('tied rows', () => {
  it('finds the smallest runs within which rows changed places', () => {
    const ties = tiesBetween(
      json(rows('a', 'b', 'c', 'd', 'e', 'f')),
      json(rows('a', 'c', 'b', 'd', 'f', 'e')),
    );
    expect(ties).toEqual([
      {
        path: ['body', 'results'],
        runs: [
          [1, 2],
          [4, 5],
        ],
      },
    ]);
  });

  it('is not a tie when a row differs, is missing, or a value outside a list differs', () => {
    expect(tiesBetween(json(rows('a', 'b')), json(rows('a', 'x')))).toBeNull();
    expect(tiesBetween(json(rows('a', 'b')), json(rows('a')))).toBeNull();
    expect(
      tiesBetween(
        json({ total: 1, results: [{ id: 'a' }, { id: 'b' }] }),
        json({ total: 2, results: [{ id: 'b' }, { id: 'a' }] }),
      ),
    ).toBeNull();
    // The same answer is no tie either: there is nothing to mark.
    expect(tiesBetween(json(rows('a', 'b')), json(rows('a', 'b')))).toBeNull();
    // Nor is a body that is neither JSON nor a CSV, whatever it says.
    const page = (body: string): Answered => ({
      response: { status: 200, headers: { 'content-type': 'text/html' }, body },
      effects: [],
    });
    expect(tiesBetween(page('a b'), page('b a'))).toBeNull();
  });

  it('finds a list inside a row, the lines of a CSV, and the rows a request wrote', () => {
    expect(
      tiesBetween(
        json({ parties: [{ name: 'x', documents: [1, 2, 3] }] }),
        json({ parties: [{ name: 'x', documents: [1, 3, 2] }] }),
      ),
    ).toEqual([{ path: ['body', 'parties', 0, 'documents'], runs: [[1, 2]] }]);
    expect(
      tiesBetween(csv(['sku,qty', 'A,1', 'B,1', '']), csv(['sku,qty', 'B,1', 'A,1', ''])),
    ).toEqual([{ path: ['body', '#lines'], runs: [[1, 2]] }]);
    const wrote = (...skus: string[]) => [[{ n: 1 }], skus.map((sku) => ({ sku }))];
    expect(tiesBetween(json({}, wrote('A', 'B')), json({}, wrote('B', 'A')))).toEqual([
      { path: ['effects', 1], runs: [[0, 1]] },
    ]);
  });

  it('lets rows change places inside a marked run', () => {
    const recorded = json(rows('a', 'b', 'c', 'd'));
    const ties: Tie[] = [{ path: ['body', 'results'], runs: [[1, 2]] }];
    for (const live of [rows('a', 'c', 'b', 'd'), rows('a', 'b', 'c', 'd')]) {
      expect(settled(recorded, json(live), ties).response.body).toBe(recorded.response.body);
    }
  });

  it('does not let a row leave its run: an ordering that broke still shows', () => {
    const recorded = json(rows('a', 'b', 'c', 'd'));
    const ties: Tie[] = [{ path: ['body', 'results'], runs: [[1, 2]] }];
    // Whatever happens inside the run, the answer is still not the recorded one.
    for (const live of [
      rows('b', 'a', 'c', 'd'),
      rows('a', 'b', 'd', 'c'),
      rows('d', 'c', 'b', 'a'),
    ]) {
      expect(settled(recorded, json(live), ties).response.body).not.toBe(recorded.response.body);
    }
    // Nor a row that changed: the run is put back only when it holds the recorded rows.
    const changed = rows('a', 'c', 'x', 'd');
    expect(settled(recorded, json(changed), ties).response.body).toBe(JSON.stringify(changed));
  });

  it('puts a CSV back line by line, and written rows row by row', () => {
    const recorded = csv(['sku,qty', 'A,1', 'B,1', '']);
    expect(
      settled(recorded, csv(['sku,qty', 'B,1', 'A,1', '']), [
        { path: ['body', '#lines'], runs: [[1, 2]] },
      ]).response.body,
    ).toBe(recorded.response.body);
    const wrote = (...skus: string[]) => [skus.map((sku) => ({ sku }))];
    const live = json({}, wrote('B', 'A'));
    expect(
      settled(json({}, wrote('A', 'B')), live, [{ path: ['effects', 0], runs: [[0, 1]] }]).effects,
    ).toEqual(wrote('A', 'B'));
    // The live answer itself is left as it came: a difference is printed from it.
    expect(live.effects).toEqual(wrote('B', 'A'));
  });

  it('joins runs on one list that touch, and keeps other lists apart', () => {
    expect(
      mergedTies(
        [{ path: ['body', 'results'], runs: [[1, 2]] }],
        [
          {
            path: ['body', 'results'],
            runs: [
              [2, 3],
              [7, 8],
            ],
          },
          { path: ['body', 'top'], runs: [[0, 1]] },
        ],
      ),
    ).toEqual([
      {
        path: ['body', 'results'],
        runs: [
          [1, 3],
          [7, 8],
        ],
      },
      { path: ['body', 'top'], runs: [[0, 1]] },
    ]);
  });
});

describe('a page cut through a tie', () => {
  const page = (count: number, ...costs: (string | null)[]) => ({
    count,
    results: costs.map((last_cost, index) => ({ id: `row-${index}`, last_cost })),
  });
  const tied = (last_cost: string | null) => ({ 'one of the rows that tie on': { last_cost } });

  afterEach(() => {
    delete process.env.PARITY_MODE;
  });

  it('reads the rows that tie with either end of the page as one of those that tie', () => {
    process.env.PARITY_MODE = 'replay';
    const body = page(9, '5.00', '5.00', '7.00', '9.00', '9.00');
    edgesOfAPage(['last_cost'])(body);
    expect(body.results).toEqual([
      tied('5.00'),
      tied('5.00'),
      { id: 'row-2', last_cost: '7.00' },
      tied('9.00'),
      tied('9.00'),
    ]);
  });

  it('leaves a whole list alone: nothing was cut, and its order can be marked', () => {
    process.env.PARITY_MODE = 'record';
    const body = page(3, '5.00', '5.00', '7.00');
    edgesOfAPage(['last_cost'])(body);
    expect(body).toEqual(page(3, '5.00', '5.00', '7.00'));
  });

  it('leaves everything alone when two APIs are compared', () => {
    const body = page(9, '5.00', '5.00', '7.00');
    edgesOfAPage(['last_cost'])(body);
    expect(body).toEqual(page(9, '5.00', '5.00', '7.00'));
  });

  it('reads the tail of "the first ten" the same way, and leaves a shorter list alone', () => {
    process.env.PARITY_MODE = 'replay';
    const best = (...units: number[]) => ({
      top_products: units.map((sold, index) => ({ sku: `sku-${index}`, units: sold })),
    });
    const body = best(9, 9, 5, 5);
    endOfTheFirst(4, 'top_products', ['units'])(body);
    expect(body.top_products).toEqual([
      { sku: 'sku-0', units: 9 },
      { sku: 'sku-1', units: 9 },
      { 'one of the rows that tie on': { units: 5 } },
      { 'one of the rows that tie on': { units: 5 } },
    ]);
    const short = best(9, 5, 5);
    endOfTheFirst(4, 'top_products', ['units'])(short);
    expect(short).toEqual(best(9, 5, 5));
  });

  it("orders by what was asked for, where the view takes it, and by the view's own otherwise", () => {
    process.env.PARITY_MODE = 'replay';
    const read = (query: string) => {
      const body = {
        count: 9,
        results: [
          { id: 'a', is_preferred: true, last_cost: '5.00', supplier: 's1' },
          { id: 'b', is_preferred: true, last_cost: '6.00', supplier: 's1' },
          { id: 'c', is_preferred: false, last_cost: '6.00', supplier: 's2' },
        ],
      };
      pageOf(query, ['is_preferred', 'last_cost'], ['last_cost', 'created_at'])(body);
      return body.results.map((row) => Object.keys(row).length);
    };
    // One key each for a marked row; four for a row left as it was.
    expect(read('page_size=3')).toEqual([1, 4, 1]);
    expect(read('ordering=-last_cost&page_size=3')).toEqual([1, 1, 1]);
    // `supplier` is not a field the view orders by: its own ordering stands.
    expect(read('ordering=supplier&page_size=3')).toEqual([1, 4, 1]);
  });
});

describe('keeping in step with the recording', () => {
  const at = (minute: number, second = 0) => Date.UTC(2026, 9, 9, 0, minute, second);
  const dated = [at(5), at(12)].map((moment) => new Date(moment).toISOString());

  it('does not wait when no moment lies between here and where the recording was', () => {
    const pace = new Pace(dated);
    expect(pace.wait(at(4), at(2))).toBe(0);
    expect(pace.wait(at(11), at(6))).toBe(0);
    expect(pace).toMatchObject({ waits: 0, waited: 0, ahead: 0 });
  });

  it('waits until just past a moment the recording had passed and the replay has not', () => {
    const pace = new Pace(dated);
    // The recording asked this case at 00:07, after the row dated 00:05; it is 00:03 here.
    expect(pace.wait(at(7), at(3))).toBe(2 * 60_000 + 5);
    // Two such moments: to the later one.
    expect(pace.wait(at(13), at(3))).toBe(9 * 60_000 + 5);
    expect(pace).toMatchObject({ waits: 2, ahead: 0 });
  });

  it('counts a case reached after a moment the recording had not passed, and cannot wait for it', () => {
    const pace = new Pace(dated);
    expect(pace.wait(at(4), at(6))).toBe(0);
    expect(pace.ahead).toBe(1);
  });
});
