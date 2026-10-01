import type { FastifyInstance } from 'fastify';

/**
 * Every route this API registers, so a request can be answered the way
 * Django's URL resolver answers it. Django picks a path's view before it
 * looks at the method: 405 when the path exists for another method (after
 * authentication, which DRF runs first), and Django's HTML 404 page when it
 * does not exist at all.
 *
 * Where several patterns match, the router's order decides, and it puts a
 * viewset's list-level actions (`variants/lookup/`) before its detail route
 * (`variants/<pk>/`): a literal segment wins over a parameter. Fastify picks
 * by method first, so `DELETE variants/lookup/` reaches the detail route
 * there; `resolve` names the pattern Django would have used instead.
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

  /** The route patterns a concrete path matches, by method, the one Django resolves first. */
  match(path: string): { method: string; pattern: string }[] {
    return this.routes
      .filter((route) => route.regex.test(path))
      .sort((a, b) => specificity(a.pattern, b.pattern));
  }

  /** The pattern Django's resolver gives a path, whatever the method. */
  resolve(path: string): string | undefined {
    return this.match(path)[0]?.pattern;
  }
}

/** Negative when `a` is the more literal pattern: compared segment by segment. */
function specificity(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const paramLeft = (left[i] as string).startsWith(':');
    const paramRight = (right[i] as string).startsWith(':');
    if (paramLeft !== paramRight) return paramLeft ? 1 : -1;
  }
  return 0;
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
