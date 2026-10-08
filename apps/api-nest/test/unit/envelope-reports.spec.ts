import { type ArgumentsHost, BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { EnvelopeFilter } from '../../src/common/envelope.filter';
import { NotFound } from '../../src/common/errors';
import { loadEnv } from '../../src/config/env';
import type { ErrorReports } from '../../src/observability/error-reports.service';

/**
 * Which answers are also reported (ADR-0019): the two the filter logs at
 * error level, and nothing a client could cause by asking wrongly.
 */
describe('EnvelopeFilter and what it reports', () => {
  const make = () => {
    const reports = { request: jest.fn() };
    const filter = new EnvelopeFilter(
      ...([null, null, null, null, null, null] as unknown as [
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
      reports as unknown as ErrorReports,
      loadEnv({ DJANGO_SECRET_KEY: 'unit-test-key', DATABASE_URL: 'postgresql://x/y' }),
    );
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
    const sent: { status?: number; body?: unknown } = {};
    const reply = {
      status(code: number) {
        sent.status = code;
        return reply;
      },
      header() {
        return reply;
      },
      send(body: unknown) {
        sent.body = body;
        return reply;
      },
    };
    const request = { id: 'req-1', method: 'GET', url: '/api/v1/brands/', headers: {} };
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
    } as unknown as ArgumentsHost;
    return { filter, reports, sent, host, request: request as unknown as FastifyRequest, reply };
  };

  it('reports an exception nothing expected, and still tells the client nothing of it', () => {
    const { filter, reports, sent, host, request } = make();
    const failure = new TypeError('cannot read the shelf');
    filter.catch(failure, host);
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toContain('shelf');
    expect(reports.request).toHaveBeenCalledTimes(1);
    expect(reports.request).toHaveBeenCalledWith(failure, request, 500);
  });

  it('reports a constraint that fired past the service layer, answered as a conflict', () => {
    const { filter, reports, sent, host, request } = make();
    const violation = Object.assign(new Error('duplicate key value'), { code: '23505' });
    filter.catch(violation, host);
    expect(sent.status).toBe(409);
    expect(reports.request).toHaveBeenCalledWith(violation, request, 409);
  });

  it('reports nothing for an answer the API meant to give', () => {
    const { filter, reports, sent, host } = make();
    filter.catch(new NotFound(), host);
    expect(sent.status).toBe(404);
    filter.catch(new BadRequestException(), host);
    expect(sent.status).toBe(400);
    expect(reports.request).not.toHaveBeenCalled();
  });
});
