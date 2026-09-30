import { localIso, utcIso } from '../../src/common/datetime';

describe('timestamps as the Django API prints them', () => {
  it('a raw datetime: UTC, six fraction digits, Z', () => {
    expect(utcIso('2026-09-29 10:11:12.1234+00')).toBe('2026-09-29T10:11:12.123400Z');
  });

  it('no fraction at all on a whole second', () => {
    expect(utcIso('2026-09-01 10:00:00+00')).toBe('2026-09-01T10:00:00Z');
  });

  it('a serializer field: converted to the local zone, with its offset', () => {
    expect(localIso('2026-09-29 20:30:00.5+00', 'Asia/Dhaka')).toBe(
      '2026-09-30T02:30:00.500000+06:00',
    );
  });

  it('reads a non-UTC offset correctly', () => {
    expect(utcIso('2026-09-29 16:11:12+05:30')).toBe('2026-09-29T10:41:12Z');
  });

  it('keeps null as null', () => {
    expect(utcIso(null)).toBeNull();
    expect(localIso(null, 'Asia/Dhaka')).toBeNull();
  });
});
