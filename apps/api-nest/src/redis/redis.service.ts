import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { ENV, Env } from '../config/env';

/** The Redis the Django API uses for its cache and rate limits (`REDIS_URL`). */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      // A dead Redis must fail a readiness check, not hang it.
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      enableOfflineQueue: false,
    });
    this.client.on('error', () => undefined);
  }

  async ensureConnected(): Promise<void> {
    if (this.client.status === 'wait' || this.client.status === 'end') await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
