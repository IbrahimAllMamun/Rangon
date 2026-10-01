/**
 * Python's `csv.reader` and `csv.DictReader` (excel dialect) over
 * `io.StringIO`. Expected values printed by the Django API's container; the
 * port was also compared with CPython on 20,000 generated files before it
 * was committed.
 */
import { csvDictReader, CsvError, csvReader } from '../../src/common/pycsv';

describe('csv.reader', () => {
  it.each([
    [
      'a,b\n1,2\n',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    ['a,"b,c"\n', [['a', 'b,c']]],
    ['"a""b",c\n', [['a"b', 'c']]],
    ['a,"b\nc",d\n', [['a', 'b\nc', 'd']]],
    // A quote left open at the end of the input is the last field.
    ['"open', [['open']]],
    // A quote inside an unquoted field is a character; text after a closing one joins it.
    ['a,b"c,d\n', [['a', 'b"c', 'd']]],
    ['"a"b,c\n', [['ab', 'c']]],
    ['a\r\nb\r\n', [['a'], ['b']]],
    ['\n\nx\n', [[], [], ['x']]],
    [
      'a,\n,b\n',
      [
        ['a', ''],
        ['', 'b'],
      ],
    ],
  ])('%j', (text, rows) => {
    expect([...csvReader(text)]).toEqual(rows);
  });

  it('refuses a carriage return inside an unquoted field', () => {
    expect(() => [...csvReader('a\rb\n')]).toThrow(
      new CsvError(
        "new-line character seen in unquoted field - do you need to open the file with newline=''?",
      ),
    );
  });

  it('refuses a field over the limit', () => {
    expect(() => [...csvReader('x'.repeat(131073))]).toThrow(
      new CsvError('field larger than field limit (131072)'),
    );
  });
});

describe('csv.DictReader', () => {
  it('zips each row with the header: extras under null, missing values null, blank rows skipped', () => {
    const { fieldnames, rows } = csvDictReader('h,h,k\n1,2\n3,4,5,6\n\n7\n');
    expect(fieldnames).toEqual(['h', 'h', 'k']);
    expect([...rows()].map((row) => [...row.entries()])).toEqual([
      [
        ['h', '2'],
        ['k', null],
      ],
      [
        ['h', '4'],
        ['k', '5'],
        [null, ['6']],
      ],
      // `restval` overwrites a repeated header that a short row had filled.
      [
        ['h', null],
        ['k', null],
      ],
    ]);
  });

  it('has no header for an empty file', () => {
    expect(csvDictReader('').fieldnames).toBeNull();
  });
});
