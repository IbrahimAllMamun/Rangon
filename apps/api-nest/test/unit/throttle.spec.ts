import type { FastifyRequest } from 'fastify';

import { clientIp, parseRate } from '../../src/auth/throttle';

const request = (remoteAddress: string, forwarded?: string) =>
  ({
    raw: { socket: { remoteAddress } },
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  }) as unknown as FastifyRequest;

describe('rates', () => {
  it.each([
    ['60/min', 60, 60],
    ['10/minute', 10, 60],
    ['20/hour', 20, 3600],
    ['5/s', 5, 1],
    ['100/day', 100, 86400],
  ])('%s', (rate, requests, seconds) => expect(parseRate(rate)).toEqual({ requests, seconds }));
});

describe('the address a request is counted against (core.ip)', () => {
  it('with no trusted proxy, ignores X-Forwarded-For entirely', () => {
    expect(clientIp(request('10.0.0.5', '1.2.3.4'), 0)).toBe('10.0.0.5');
  });

  it('counts trusted hops from the right, never the left', () => {
    expect(clientIp(request('10.0.0.5', 'spoofed, 203.0.113.9'), 1)).toBe('203.0.113.9');
    expect(clientIp(request('10.0.0.5', 'spoofed, 203.0.113.9, 10.0.0.2'), 2)).toBe('203.0.113.9');
  });

  it('falls back to the socket when the header is shorter than the hop count', () => {
    expect(clientIp(request('10.0.0.5', '203.0.113.9'), 2)).toBe('10.0.0.5');
    expect(clientIp(request('10.0.0.5'), 1)).toBe('10.0.0.5');
  });

  it('caps what it believes at 45 characters', () => {
    expect(clientIp(request('10.0.0.5', 'x'.repeat(80)), 1)).toHaveLength(45);
  });
});
