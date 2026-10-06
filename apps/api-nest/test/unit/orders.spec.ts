/**
 * The storefront order port's pure pieces, against Python's and Django's own
 * answers (printed in the Django API's container).
 */
import { booleanField, choiceField, errorMessages, runSerializer } from '../../src/common/drf';
import { PyFloat, pyFormatNamed, pyIntText } from '../../src/common/python';
import { customerEventText } from '../../src/orders/customer-orders.service';

describe("Python's int(str)", () => {
  it.each([
    [' 3 ', 3n],
    ['৫', 5n],
    ['+4', 4n],
    ['1_0', 10n],
    ['4.7', null],
    ['1__0', null],
    ['_1', null],
    ['-0', 0n],
    ['٣٤', 34n],
    ['𝟗', 9n],
    ['', null],
    ['0x10', null],
  ])('%j', (text, value) => {
    expect(pyIntText(text)).toBe(value);
  });
});

describe("Python's str.format with named fields", () => {
  const fields = { tracking_number: 'PT 1' };

  it('fills fields and unescapes braces', () => {
    expect(pyFormatNamed('https://t/{tracking_number}?x={{y}}', fields)).toBe(
      'https://t/PT 1?x={y}',
    );
    expect(pyFormatNamed('{tracking_number!r}', fields)).toBe("'PT 1'");
  });

  it('raises where Python raises', () => {
    for (const template of ['a}b', '{other}', '{0}', '{open']) {
      expect(() => pyFormatNamed(template, fields)).toThrow();
    }
  });

  // `Courier(tracking_url_template=...).tracking_url(number)`, printed by Django.
  it.each([
    ['https://t.test/{tracking_number}', 'PT 0001/ü', 'https://t.test/PT 0001/ü'],
    ['https://t.test/track', 'X', 'https://t.test/track'],
    ['https://t.test/{{tracking_number}}', 'X', 'https://t.test/{tracking_number}'],
    ['https://t.test/{tracking_number}/{tracking_number}', 'A1', 'https://t.test/A1/A1'],
    ['https://t.test/{tracking_number!r}', "A'1", 'https://t.test/"A\'1"'],
    ['https://t.test/{tracking_number:>12}', 'PAR-H03', 'https://t.test/     PAR-H03'],
    ['https://t.test/{tracking_number:.3}', 'PAR-H03', 'https://t.test/PAR'],
    ['https://t.test/{tracking_number:*^11s}', 'PAR-H03', 'https://t.test/**PAR-H03**'],
    ['https://t.test/{tracking_number:<10}|', 'ab', 'https://t.test/ab        |'],
    ['https://t.test/{tracking_number:10}|', 'ab', 'https://t.test/ab        |'],
    ['https://t.test/{tracking_number:^5.1}|', 'ab', 'https://t.test/  a  |'],
    ['https://t.test/{tracking_number:010}|', 'ab', 'https://t.test/ab00000000|'],
    ['https://t.test/{tracking_number:}', '12', 'https://t.test/12'],
    ['https://t.test/{tracking_number:x<4}', '12', 'https://t.test/12xx'],
    ['https://t.test/{tracking_number:{tracking_number}}', '12', 'https://t.test/12          '],
    ['https://t.test/{tracking_number[0]}', 'ab', 'https://t.test/a'],
    ['https://t.test/{tracking_number:5s}|', 'ü', 'https://t.test/ü    |'],
    ['https://t.test/{tracking_number!s:>4}', 'ab', 'https://t.test/  ab'],
    ['https://t.test/{tracking_number!r:>6}', 'ab', "https://t.test/  'ab'"],
    ['https://t.test/{tracking_number:>0}', 'ab', 'https://t.test/ab'],
    ['https://t.test/{tracking_number:.0}', 'ab', 'https://t.test/'],
  ])('%j with %j is %j', (template, number, url) => {
    expect(pyFormatNamed(template, { tracking_number: number })).toBe(url);
  });

  // Each of these raises in Python: ValueError, KeyError, IndexError or AttributeError.
  it.each([
    '{tracking_number:=10}',
    '{tracking_number:d}',
    '{tracking_number.real}',
    '{number}',
    '{0}',
    '{}',
    '{tracking_number',
    'tracking_number}',
    '{tracking_number!x}',
    '{ tracking_number }',
    '{tracking_number:,}',
    '{tracking_number:+}',
    '{tracking_number: }',
    '{tracking_number:#}',
    '{tracking_number:5.}',
    '{tracking_number:}}',
    '{tracking_number:{}}',
    '{tracking_number[9]}',
    '{tracking_number[-1]}',
  ])('%j raises', (template) => {
    expect(() => pyFormatNamed(template, { tracking_number: 'ab' })).toThrow();
  });

  it('refuses an attribute, where Python would print the object found', () => {
    // Deliberately unsupported: `{tracking_number.upper}` is a method's memory address.
    expect(() => pyFormatNamed('{tracking_number.upper}', fields)).toThrow();
  });
});

describe('customer_event_text', () => {
  const event = (
    event_type: string,
    extra: Partial<Parameters<typeof customerEventText>[0]> = {},
  ) =>
    customerEventText({
      id: 'x',
      created_at: '2026-09-01 06:00:00+00',
      event_type,
      message: '',
      data: {},
      is_customer_visible: true,
      ...extra,
    });

  it('tells the customer only what is theirs', () => {
    expect(event('CREATED')).toBe('Order placed');
    expect(event('STATUS_CHANGED', { data: { to: 'SHIPPED' } })).toBe('On its way');
    expect(event('STATUS_CHANGED', { data: { to: 'PENDING' } })).toBeNull();
    expect(event('STATUS_CHANGED', { data: {} })).toBeNull();
    expect(event('PAYMENT_RECORDED', { data: { status: 'PENDING' } })).toBeNull();
    expect(event('PAYMENT_RECORDED', { data: { status: 'CAPTURED' } })).toBe('Payment received');
    expect(event('NOTE_ADDED')).toBeNull();
    expect(event('SHIPMENT_EVENT')).toBeNull();
    expect(event('CREATED', { is_customer_visible: false })).toBeNull();
  });

  it('names a return step, never what staff wrote', () => {
    expect(event('RETURN_UPDATED', { message: 'Return RET-1 rejected: stained' })).toBe(
      'Return rejected',
    );
    expect(event('RETURN_UPDATED', { message: 'Return RET-1 changed' })).toBe('Return updated');
  });

  it('treats empty data as a dict, and a list as the AttributeError it is', () => {
    expect(event('STATUS_CHANGED', { data: null })).toBeNull();
    expect(() => event('STATUS_CHANGED', { data: ['to'] })).toThrow();
  });
});

describe('BooleanField and ChoiceField', () => {
  it("accepts DRF's spellings, and words its refusals as DRF 3.15 does", async () => {
    const fields = {
      a: booleanField(),
      b: booleanField(),
      c: booleanField(),
      d: choiceField(['BOTH']),
    };
    const good = await runSerializer(fields, { a: 'yes', b: new PyFloat(0), c: 1, d: 'BOTH' });
    expect(good).toEqual({ ok: true, values: { a: true, b: false, c: true, d: 'BOTH' } });

    const bad = await runSerializer(fields, { a: 'maybe', b: [1], c: 2, d: 'HOME' });
    expect(bad.ok || errorMessages(bad.errors)).toEqual({
      a: ['Must be a valid boolean.'],
      b: ['Must be a valid boolean.'],
      c: ['Must be a valid boolean.'],
      d: ['"HOME" is not a valid choice.'],
    });
  });
});
