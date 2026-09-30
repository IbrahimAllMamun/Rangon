import { Controller, Get, Logger, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { SkipAuthentication } from '../auth/authentication';
import { Database } from '../database/database.service';
import { RedisService } from '../redis/redis.service';

/**
 * `core.views`: liveness never touches a dependency; readiness does, so the
 * load balancer can stop routing. Neither leaks versions, settings or error
 * detail (docs/operations/deployment.md).
 */
@Controller('api')
@SkipAuthentication()
export class HealthController {
  private readonly logger = new Logger('rangon.health');

  constructor(
    private readonly db: Database,
    private readonly redis: RedisService,
  ) {}

  @Get('health/')
  health(@Res({ passthrough: true }) reply: FastifyReply): { status: string } {
    neverCache(reply);
    return { status: 'ok' };
  }

  @Get('ready/')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    neverCache(reply);
    const checks = { database: false, cache: false };

    try {
      await this.db.query('SELECT 1');
      checks.database = true;
    } catch (error) {
      this.logger.error(`Readiness: database check failed: ${String(error)}`);
    }

    try {
      await this.redis.ensureConnected();
      await this.redis.client.set('rangon:nest:ready', '1', 'EX', 10);
      checks.cache = (await this.redis.client.get('rangon:nest:ready')) === '1';
    } catch (error) {
      this.logger.error(`Readiness: cache check failed: ${String(error)}`);
    }

    const ready = checks.database && checks.cache;
    reply.status(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not-ready', checks };
  }
}

/** `django.views.decorators.cache.never_cache`. */
function neverCache(reply: FastifyReply): void {
  reply.header('expires', new Date().toUTCString());
  reply.header('cache-control', 'max-age=0, no-cache, no-store, must-revalidate, private');
}
