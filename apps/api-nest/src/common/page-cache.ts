import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';

export interface CachedPage {
  contentType: string;
  body: string;
}

/**
 * `django.views.decorators.cache.cache_page`, for the few views that use it:
 * a successful GET is kept in Redis for `seconds`, keyed on the absolute URL.
 *
 * The Django API's cached copies live under its own keys, so each API serves
 * its own copy; both expire on the same schedule. A Redis outage serves the
 * page uncached rather than failing it.
 */
@Injectable()
export class PageCache {
  private readonly logger = new Logger('rangon.cache');

  constructor(private readonly redis: RedisService) {}

  private key(url: string): string {
    return `rangon:nest:page:${createHash('sha256').update(url).digest('hex')}`;
  }

  async get(url: string): Promise<CachedPage | null> {
    try {
      await this.redis.ensureConnected();
      const raw = await this.redis.client.get(this.key(url));
      return raw ? (JSON.parse(raw) as CachedPage) : null;
    } catch (error) {
      this.logger.warn(`Page cache read failed: ${String(error)}`);
      return null;
    }
  }

  async set(url: string, page: CachedPage, seconds: number): Promise<void> {
    try {
      await this.redis.ensureConnected();
      await this.redis.client.set(this.key(url), JSON.stringify(page), 'EX', seconds);
    } catch (error) {
      this.logger.warn(`Page cache write failed: ${String(error)}`);
    }
  }
}
