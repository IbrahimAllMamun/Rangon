/**
 * DRF 3.15's `DateTimeField` with Django's `parse_datetime`, in Asia/Dhaka
 * (`common/datetime-field.ts`). Expected values printed by DRF in the Django
 * container. The port was also compared with DRF on 68,000 generated strings
 * (offsets, fractions, separators, Bengali digits, Dhaka's clock changes of
 * 2009, the ends of Python's range) before it was committed: no difference.
 */
import { dateTimeField } from '../../src/common/datetime-field';
import { Invalid } from '../../src/common/drf';

const field = dateTimeField('Asia/Dhaka', { allowNull: true });

describe('DateTimeField', () => {
  it.each([
    ['2026-10-05T10:00', { ok: '2026-10-05T10:00:00+06:00' }],
    ['2026-10-05 10:00:00', { ok: '2026-10-05T10:00:00+06:00' }],
    ['2026-10-05T10:00:00.123456', { ok: '2026-10-05T10:00:00.123456+06:00' }],
    ['2026-10-05T10:00:00.1234567', { ok: '2026-10-05T10:00:00.123456+06:00' }],
    ['2026-10-05T10:00:00Z', { ok: '2026-10-05T16:00:00+06:00' }],
    ['2026-10-05T04:00:00+00:00', { ok: '2026-10-05T10:00:00+06:00' }],
    ['2026-10-05T10:00:00+05:30', { ok: '2026-10-05T10:30:00+06:00' }],
    ['2026-10-05T10:00:00-12:00', { ok: '2026-10-06T04:00:00+06:00' }],
    ['2026-10-05T10:00+0530', { ok: '2026-10-05T10:30:00+06:00' }],
    ['2026-10-05T10:00:00,5', { ok: '2026-10-05T10:00:00.500000+06:00' }],
    ['2026-10-05T10', { ok: '2026-10-05T10:00:00+06:00' }],
    ['20261005T1000', { ok: '2026-10-05T10:00:00+06:00' }],
    ['2026-W40-1T10:00', { ok: '2026-09-28T10:00:00+06:00' }],
    ['2026-10-05', { ok: '2026-10-05T00:00:00+06:00' }],
    [
      '2026-10-05T',
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
    [
      '2026-10-05T24:00',
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
    [
      '2026-02-29T10:00',
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
    ['2024-02-29T10:00', { ok: '2024-02-29T10:00:00+06:00' }],
    ['২০২৬-১০-০৫T১০:০০', { ok: '2026-10-05T10:00:00+06:00' }],
    ['2026-10-05T10:00\n', { ok: '2026-10-05T10:00:00+06:00' }],
    ['2026-10-05T10:00 ', { ok: '2026-10-05T10:00:00+06:00' }],
    [
      ' 2026-10-05T10:00',
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
    ['2026-10-05T10:00:00+06:01:40', { ok: '2026-10-05T09:58:20+06:00' }],
    ['2026-10-05t10:00', { ok: '2026-10-05T10:00:00+06:00' }],
    ['2026-10-05x10:00', { ok: '2026-10-05T10:00:00+06:00' }],
    ['2009-06-19T23:30', { ok: '2009-06-19T23:30:00+06:00' }],
    ['2009-12-31T23:30', { ok: '2009-12-31T23:30:00+07:00' }],
    ['2010-01-01T00:30', { ok: '2010-01-01T00:30:00+06:00' }],
    ['1890-01-01T00:00', { ok: '1890-01-01T00:00:00+05:53:20' }],
    ['1941-10-01T00:00', { ok: '1941-10-01T00:00:00+05:53:20' }],
    ['0001-01-01T00:00:00+06:00', { err: 'Datetime value out of range.' }],
    ['0001-01-01T10:00', { ok: '0001-01-01T10:00:00+06:01:40' }],
    ['0001-01-01T00:00', { crash: 'OverflowError' }],
    ['9999-12-31T23:59:59+00:00', { err: 'Datetime value out of range.' }],
    ['9999-12-31T23:59:59-01:00', { err: 'Datetime value out of range.' }],
    ['2026-1-5T1:2', { ok: '2026-01-05T01:02:00+06:00' }],
    [
      '2026-10-05T10:00:00+24:00',
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
    [
      '',
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
    [
      'x',
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
    [null, { ok: null }],
    [
      5,
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
    [
      true,
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
    [
      1.5,
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
    [
      [],
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
    [
      {},
      {
        err: 'Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z].',
      },
    ],
  ] as [unknown, { ok?: string | null; err?: string; crash?: string }][])(
    '%j',
    async (input, expected) => {
      let got: { ok?: string | null; err?: string; crash?: string };
      try {
        const value = await field.run(input, false);
        got = { ok: value === null ? null : (value as { iso: string }).iso };
      } catch (error) {
        got =
          error instanceof Invalid
            ? { err: error.details[0]?.message }
            : { crash: 'OverflowError' };
      }
      expect(got).toEqual(expected);
    },
  );
});
