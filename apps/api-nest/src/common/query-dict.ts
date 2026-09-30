import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { parseQsl } from './python';

/**
 * Django's `QueryDict`, read-only.
 *
 * The difference from a plain object matters: `get` answers the *last* value
 * of a repeated key (`?sort=a&sort=b` sorts by `b`), `getlist` answers them
 * all, and a key present with no value is `""`, not absent. Parsed from the
 * raw query string with Python's `parse_qsl` rules, so `+` is a space and a
 * broken `%` escape decodes the way Django decodes it.
 */
export class QueryDict {
  private readonly values = new Map<string, string[]>();

  constructor(queryString: string) {
    for (const [key, value] of parseQsl(queryString)) {
      const existing = this.values.get(key);
      if (existing) existing.push(value);
      else this.values.set(key, [value]);
    }
  }

  get(key: string): string | undefined;
  get(key: string, fallback: string): string;
  get(key: string, fallback?: string): string | undefined {
    const values = this.values.get(key);
    return values && values.length ? values[values.length - 1] : fallback;
  }

  getlist(key: string): string[] {
    return [...(this.values.get(key) ?? [])];
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  /** Keys in first-seen order, as iterating a QueryDict gives them. */
  keys(): string[] {
    return [...this.values.keys()];
  }

  static fromRequest(request: FastifyRequest): QueryDict {
    const url = request.raw.url ?? request.url;
    const question = url.indexOf('?');
    return new QueryDict(question === -1 ? '' : url.slice(question + 1));
  }
}

/** `@Query()` for a `QueryDict`: `list(@Params() params: QueryDict)`. */
export const Params = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  QueryDict.fromRequest(context.switchToHttp().getRequest<FastifyRequest>()),
);
