import { Inject, Injectable } from '@nestjs/common';

import { ENV, Env } from '../config/env';
import { Jobs } from './jobs.service';

/**
 * `content.tasks.request_revalidation(*tags)`: ask the storefront to drop the
 * pages cached under these tags, by queueing `revalidate_storefront`. Fire-and-forget, and nothing at all when
 * `WEB_REVALIDATE_URL` is unset -- a fresh install works without it.
 *
 * Django sends it from model signals (a category or navigation item saved or
 * deleted) and, where `bulk_update` sends none, from the view itself.
 */
@Injectable()
export class Revalidation {
  constructor(
    private readonly jobs: Jobs,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async request(...tags: string[]): Promise<void> {
    if (!this.env.WEB_REVALIDATE_URL) return;
    await this.jobs.delay('content.tasks.revalidate_storefront', [tags]);
  }
}

/** What a saved or deleted category or navigation item invalidates (`content.signals`). */
export const NAVIGATION_TAGS = ['navigation', 'categories', 'site'] as const;
