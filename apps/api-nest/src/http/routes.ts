import type { FastifyInstance } from 'fastify';

/**
 * Every route this API registers, so a request that matched none of them can
 * be answered the way Django's URL resolver answers it: 405 when the path
 * exists for another method (after authentication, which DRF runs first), and
 * Django's HTML 404 page otherwise.
 */
export class RouteRegistry {
  private readonly routes: { method: string; pattern: string; regex: RegExp }[] = [];

  attach(fastify: FastifyInstance): void {
    fastify.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        this.routes.push({ method, pattern: route.url, regex: compile(route.url) });
      }
    });
  }

  /** The route patterns a concrete path matches, by method. */
  match(path: string): { method: string; pattern: string }[] {
    return this.routes.filter((route) => route.regex.test(path));
  }
}

function compile(pattern: string): RegExp {
  const source = pattern
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  // `ignoreTrailingSlash`: a pattern matches with or without its final slash.
  return new RegExp(`^${source.replace(/\/$/, '')}/?$`);
}
