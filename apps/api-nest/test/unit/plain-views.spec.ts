/**
 * The middleware in front of every view, where it differs by method: Django's
 * APPEND_SLASH (any method, before the resolver) and the plain health views
 * (`require_GET`, CSRF-checked). Expected values printed by the Django API's
 * container; the three requests at the end failed on the port before
 * 2026-10-01 (a 405 JSON body, a 200 to HEAD, no redirect).
 */
import Fastify, { type FastifyInstance } from 'fastify';

import { loadEnv } from '../../src/config/env';
import { csrfFailurePage, parseCookie, unmask } from '../../src/http/csrf';
import { installPipeline, plainViewRefusal } from '../../src/http/pipeline';
import { installBodyCapture } from '../../src/http/request-body';
import { RouteRegistry } from '../../src/http/routes';

describe('django.http.parse_cookie', () => {
  it.each([
    ['a=b; csrftoken=abc', { a: 'b', csrftoken: 'abc' }],
    ['csrftoken=x; csrftoken=y', { csrftoken: 'y' }],
    [' spaced = value ; novalue', { spaced: 'value', '': 'novalue' }],
    ['=onlyvalue', { '': 'onlyvalue' }],
    ['q="a\\"b"', { q: 'a"b' }],
    ['k="\\101\\102"', { k: 'AB' }],
    [';;;', {}],
    ['a=b=c', { a: 'b=c' }],
  ])('%j', (header, expected) => {
    expect(Object.fromEntries(parseCookie(header))).toEqual(expected);
  });
});

it("unmasks a CSRF token as Django's _unmask_cipher_token does", () => {
  expect(unmask('Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe' + 'abcdefghijklmnopqrstuvwxyzABCDEF')).toBe(
    'lNdqShvXlA2pF7tKcxPhBUmFZrJ4wN9B',
  );
});

describe('the pipeline, by method', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://unused/unused',
      DJANGO_SECRET_KEY: 'unit-test-key',
      DJANGO_SETTINGS_MODULE: 'config.settings.parity',
    });
    const routes = new RouteRegistry();
    app = Fastify({ routerOptions: { ignoreTrailingSlash: true } });
    routes.attach(app);
    installPipeline(app, env, routes);
    installBodyCapture(app);
    app.get('/api/health', async () => ({ status: 'ok' }));
    // What `EnvelopeFilter.noRoute` does for a plain view's unrouted method.
    app.setNotFoundHandler((request, reply) => plainViewRefusal(request, reply, env));
    app.get('/api/v1/shop/categories', async () => []);
    await app.ready();
  });

  afterAll(() => app.close());

  it('redirects to the slash whatever the method', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/v1/shop/categories?x=1' });
    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe('/api/v1/shop/categories/?x=1');
  });

  it('refuses HEAD on a plain view, as require_GET does', async () => {
    const response = await app.inject({ method: 'HEAD', url: '/api/health/' });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe('GET');
  });

  it('meets an unsafe method with the CSRF check first', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/health/',
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toBe(csrfFailurePage('cookie'));
  });
});
