import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FastifyRequest } from 'fastify';

import { loadEnv } from '../../src/config/env';
import { ErrorReports } from '../../src/observability/error-reports.service';

const BASE = {
  DJANGO_SECRET_KEY: 'a-production-secret-for-the-unit-tests',
  DATABASE_URL: 'postgresql://x/y',
  DJANGO_ALLOWED_HOSTS: 'shop.example.com',
};

interface Envelope {
  path: string;
  header: Record<string, unknown>;
  item: Record<string, unknown>;
  event: Record<string, unknown> & {
    exception?: {
      values?: { type?: string; value?: string; stacktrace?: { frames?: unknown[] } }[];
    };
    tags?: Record<string, string>;
    request?: Record<string, unknown>;
  };
  raw: string;
}

/** A stand-in for Sentry's ingest endpoint: it keeps what it is sent and answers as told. */
describe('ErrorReports', () => {
  let server: Server;
  let dsn: string;
  let received: Envelope[];
  let status = 200;
  let arrivals: (() => void)[] = [];
  const open: ErrorReports[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const [header, item, event] = raw.split('\n').map((line) => JSON.parse(line || '{}'));
        received.push({ path: request.url ?? '', header, item, event, raw });
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end('{}');
        for (const arrived of arrivals.splice(0)) arrived();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    dsn = `http://publickey@127.0.0.1:${(server.address() as AddressInfo).port}/42`;
  });
  afterAll(() => new Promise<void>((resolve) => void server.close(() => resolve())));
  beforeEach(() => {
    received = [];
    status = 200;
    arrivals = [];
  });
  afterEach(async () => {
    for (const reports of open.splice(0)) await reports.onModuleDestroy();
  });

  const arrival = () => new Promise<void>((resolve) => arrivals.push(resolve));
  const production = (extra: Record<string, string> = {}) => {
    const reports = new ErrorReports(
      loadEnv({ ...BASE, DJANGO_SETTINGS_MODULE: 'config.settings.prod', ...extra }),
    );
    open.push(reports);
    return reports;
  };
  const request = (extra: Partial<Record<string, unknown>> = {}) =>
    ({
      id: 'req-0123456789',
      method: 'POST',
      url: '/api/v1/customers/lookup/?phone=01711000001&token=query-secret',
      raw: { url: '/api/v1/customers/lookup/?phone=01711000001&token=query-secret' },
      routeOptions: { url: '/api/v1/customers/lookup' },
      headers: {
        host: 'shop.example.com',
        authorization: 'Bearer header-secret',
        cookie: 'rangon_access=cookie-secret',
        'x-forwarded-proto': 'https',
      },
      body: { password: 'body-secret' },
      user: { id: 'user-id', email: 'owner@rangon.test' },
      ...extra,
    }) as unknown as FastifyRequest;

  it('is off without a DSN, and off outside production whatever the DSN', () => {
    expect(production().enabled).toBe(false);
    const development = new ErrorReports(loadEnv({ ...BASE, SENTRY_DSN: dsn }));
    open.push(development);
    expect(development.enabled).toBe(false);
    development.request(new Error('boom'), request(), 500);
    development.job(new Error('boom'), 'orders.tasks.release_expired_reservations', 1);
    expect(received).toHaveLength(0);
  });

  it('refuses to start with a DSN that is not one', () => {
    // Sentry's own parser says so on the console as well.
    const said = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => production({ SENTRY_DSN: 'not a dsn' })).toThrow(
      'SENTRY_DSN is not a Sentry DSN.',
    );
    said.mockRestore();
  });

  it('reports a failed request: the error with its stack, where it happened, and its request id', async () => {
    const reports = production({ SENTRY_DSN: dsn, RANGON_RELEASE: 'abc1234' });
    expect(reports.enabled).toBe(true);
    const arrived = arrival();
    reports.request(new TypeError('cannot read the shelf'), request(), 500);
    await arrived;

    expect(received).toHaveLength(1);
    const [{ path, item, event }] = received as [Envelope];
    expect(path).toMatch(/^\/api\/42\/envelope\/\?.*sentry_key=publickey/);
    expect(item.type).toBe('event');
    expect(event.exception?.values?.[0]).toMatchObject({
      type: 'TypeError',
      value: 'cannot read the shelf',
    });
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0);
    expect(event.level).toBe('error');
    expect(event.environment).toBe('production');
    expect(event.release).toBe('abc1234');
    expect(event.transaction).toBe('POST /api/v1/customers/lookup');
    expect(event.tags).toEqual({
      kind: 'request',
      status: '500',
      request_id: 'req-0123456789',
      route: '/api/v1/customers/lookup',
    });
    expect(event.request).toEqual({
      method: 'POST',
      url: 'https://shop.example.com/api/v1/customers/lookup/',
    });
  });

  it('sends nothing a customer or a member of staff would mind: no query, body, header, cookie or user', async () => {
    const reports = production({ SENTRY_DSN: dsn });
    const arrived = arrival();
    reports.request(new Error('boom'), request(), 500);
    await arrived;
    const [{ raw, event }] = received as [Envelope];
    for (const secret of [
      '01711000001',
      'query-secret',
      'header-secret',
      'cookie-secret',
      'body-secret',
      'owner@rangon.test',
      'user-id',
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(event.user).toBeUndefined();
  });

  it('names the environment it was given', async () => {
    const reports = production({ SENTRY_DSN: dsn, RANGON_ENV: 'staging' });
    const arrived = arrival();
    reports.request(new Error('boom'), request(), 409);
    await arrived;
    expect(received[0]?.event.environment).toBe('staging');
    expect(received[0]?.event.release).toBeUndefined();
    expect(received[0]?.event.tags?.status).toBe('409');
  });

  it('reports a job that failed for good, by its name and its attempt', async () => {
    const reports = production({ SENTRY_DSN: dsn });
    const arrived = arrival();
    reports.job(new Error('connect ECONNREFUSED'), 'notifications.tasks.send_order_email', 4);
    await arrived;
    const [{ event }] = received as [Envelope];
    expect(event.exception?.values?.[0]?.value).toBe('connect ECONNREFUSED');
    expect(event.transaction).toBe('notifications.tasks.send_order_email');
    expect(event.tags).toEqual({
      kind: 'job',
      job: 'notifications.tasks.send_order_email',
      attempt: '4',
    });
    expect(event.request).toBeUndefined();
  });

  it('reports an error with what caused it', async () => {
    const reports = production({ SENTRY_DSN: dsn });
    const arrived = arrival();
    reports.job(new Error('could not send', { cause: new RangeError('550 refused') }), 'x', 1);
    await arrived;
    expect(received[0]?.event.exception?.values?.map((value) => value.type)).toEqual([
      'RangeError',
      'Error',
    ]);
  });

  it('reports what is about to end the process, and stops listening when it is shut down', async () => {
    const before = process.listenerCount('uncaughtExceptionMonitor');
    const reports = production({ SENTRY_DSN: dsn });
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before + 1);
    const arrived = arrival();
    // What Node does first for an exception nothing caught.
    (process.emit as (event: string, ...args: unknown[]) => boolean)(
      'uncaughtExceptionMonitor',
      new Error('nobody caught this'),
      'uncaughtException',
    );
    await arrived;
    expect(received[0]?.event.level).toBe('fatal');
    expect(received[0]?.event.tags).toEqual({ kind: 'process', origin: 'uncaughtException' });
    await reports.onModuleDestroy();
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before);
  });

  it('is never a second error: a Sentry that refuses, or is not there, changes nothing here', async () => {
    status = 500;
    const reports = production({ SENTRY_DSN: dsn });
    const arrived = arrival();
    expect(() => reports.request(new Error('boom'), request(), 500)).not.toThrow();
    await arrived;
    const nowhere = production({ SENTRY_DSN: 'http://publickey@127.0.0.1:9/42' });
    expect(() => nowhere.job(new Error('boom'), 'x', 1)).not.toThrow();
    // A thing that is not an Error at all.
    expect(() => nowhere.request('a string was thrown', request(), 500)).not.toThrow();
    await expect(nowhere.onModuleDestroy()).resolves.toBeUndefined();
  });
});
