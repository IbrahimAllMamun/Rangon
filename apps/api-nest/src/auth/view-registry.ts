import { Injectable, OnModuleInit } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

import { type AccessMeta, accessMeta } from './authentication';
import { type ThrottleMeta, throttleMeta } from './throttle';

/**
 * What the view at a route pattern asks of every request, whatever its
 * method: whether it authenticates, who may call it, how it is throttled.
 *
 * A guard reads this from the handler Fastify chose. A request whose method
 * no handler takes has no handler to read, and DRF still runs the view's
 * `initial()` -- authentication, permissions, throttles -- before it answers
 * 405. So the same metadata is collected here, once, from every controller,
 * by the pattern its handlers are routed under.
 */
export interface ViewMeta {
  access: AccessMeta;
  throttle: ThrottleMeta;
}

const paths = (value: unknown): string[] =>
  value === undefined ? [] : Array.isArray(value) ? (value as string[]) : [value as string];

/** A pattern as Fastify registers it: one leading slash, none trailing. */
export function routePattern(...parts: string[]): string {
  return `/${parts.join('/')}`.replace(/\/+/g, '/').replace(/(?<=.)\/$/, '');
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

@Injectable()
export class ViewRegistry implements OnModuleInit {
  private readonly views = new Map<string, ViewMeta[]>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    for (const { instance, metatype } of this.discovery.getControllers()) {
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      const bases = paths(Reflect.getMetadata(PATH_METADATA, metatype) ?? '');
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name] as (...args: unknown[]) => unknown;
        const targets = [handler, metatype];
        const meta: ViewMeta = {
          access: accessMeta(this.reflector, targets),
          throttle: throttleMeta(this.reflector, targets),
        };
        for (const base of bases) {
          for (const path of paths(Reflect.getMetadata(PATH_METADATA, handler))) {
            const pattern = routePattern(base, path);
            this.views.set(pattern, [...(this.views.get(pattern) ?? []), meta]);
          }
        }
      }
    }
  }

  /**
   * The view at a pattern. One Django view has one set of permission and
   * throttle classes, so the handlers routed under a pattern agree; where
   * they do not, or the pattern is not a controller's, nothing is claimed.
   */
  at(pattern: string): Partial<ViewMeta> {
    const handlers = this.views.get(routePattern(pattern)) ?? [];
    const [first] = handlers;
    if (!first) return {};
    return {
      ...(handlers.every((meta) => same(meta.access, first.access))
        ? { access: first.access }
        : {}),
      ...(handlers.every((meta) => same(meta.throttle, first.throttle))
        ? { throttle: first.throttle }
        : {}),
    };
  }
}
