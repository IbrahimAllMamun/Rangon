/**
 * Three port bugs found while porting the inventory admin, each pinned here
 * with values printed by the Django API's container:
 *
 * - DRF's `DateField` reads `date.fromisoformat`, which never checks that it
 *   reached the end: `2026010112` is 1 January.
 * - The zone offset of an instant in a year below 100, or before Christ, was
 *   read as the year 1900 and after.
 * - Django resolves a path before it looks at the method, and the router puts
 *   a list-level action's path before `<pk>`: `DELETE /variants/lookup/` is a
 *   405 from the lookup route, not a 404 from the detail route.
 */
import Fastify from 'fastify';

import { zoneOffsetSeconds } from '../../src/common/datetime';
import { dateField } from '../../src/common/drf';
import { dateFromIsoformat } from '../../src/common/isoformat';
import { RouteRegistry } from '../../src/http/routes';

const DHAKA = 'Asia/Dhaka';

describe('date.fromisoformat and DateField', () => {
  it('stops after the day, as CPython does', () => {
    expect(dateFromIsoformat('2026010112')).toEqual({ year: 2026, month: 1, day: 1 });
    expect(dateFromIsoformat('2026-0101')).toBeNull();
    expect(dateField().run('2026010112', false)).toBe('2026-01-01');
  });
});

describe('zoneOffsetSeconds', () => {
  it('reads years below 100 and before Christ as themselves', () => {
    // 0001-01-01T00:00 in Dhaka is still 1 BC in UTC.
    expect(zoneOffsetSeconds(-62135618500, DHAKA)).toBe(6 * 3600 + 100);
    expect(zoneOffsetSeconds(-61000000000, DHAKA)).toBe(6 * 3600 + 100);
  });
});

describe('RouteRegistry', () => {
  it('ranks a literal segment above a parameter, as the router orders them', async () => {
    const fastify = Fastify();
    const routes = new RouteRegistry();
    routes.attach(fastify);
    const ok = async () => ({});
    fastify.get('/api/v1/variants/', ok);
    fastify.get('/api/v1/variants/:pk/', ok);
    fastify.delete('/api/v1/variants/:pk/', ok);
    fastify.get('/api/v1/variants/lookup/', ok);
    fastify.post('/api/v1/variants/:pk/barcode/', ok);
    await fastify.ready();
    expect(routes.resolve('/api/v1/variants/lookup/')).toBe('/api/v1/variants/lookup/');
    expect(routes.resolve('/api/v1/variants/abc/')).toBe('/api/v1/variants/:pk/');
    expect(routes.resolve('/api/v1/variants/abc/barcode/')).toBe('/api/v1/variants/:pk/barcode/');
    expect(routes.resolve('/api/v1/nothing/')).toBeUndefined();
    await fastify.close();
  });
});
