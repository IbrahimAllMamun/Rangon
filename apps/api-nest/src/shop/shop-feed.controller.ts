import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { SkipAuthentication } from '../auth/authentication';
import { ThrottleScope } from '../auth/throttle';
import { FeedService } from '../catalog/feed.service';
import { absoluteUri } from '../common/http';
import { PageCache } from '../common/page-cache';
import { ENV, Env } from '../config/env';

/** Long enough that a scraper cannot hammer the database with the feed. */
const CACHE_SECONDS = 15 * 60;

/**
 * `catalog.api.feed_views`: the public product feed Meta and Google poll.
 * Unauthenticated by design -- they fetch on a schedule with no credential --
 * and cached rather than rate-limited into uselessness.
 */
@Controller('api/v1/shop')
@SkipAuthentication()
@ThrottleScope('search')
export class ShopFeedController {
  constructor(
    private readonly feed: FeedService,
    private readonly cache: PageCache,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('feed.xml')
  async xml(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    await this.serve(
      request,
      reply,
      'application/xml; charset=utf-8',
      'rangon-products.xml',
      async () => this.feed.renderXml(await this.feed.items()),
    );
  }

  @Get('feed.csv')
  async csv(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    await this.serve(request, reply, 'text/csv; charset=utf-8', 'rangon-products.csv', async () =>
      this.feed.renderCsv(await this.feed.items()),
    );
  }

  private async serve(
    request: FastifyRequest,
    reply: FastifyReply,
    contentType: string,
    filename: string,
    render: () => Promise<string>,
  ): Promise<void> {
    const url = absoluteUri(request, this.env);
    const page = (await this.cache.get(url)) ?? { contentType, body: await render() };
    await this.cache.set(url, page, CACHE_SECONDS);
    void reply
      .status(200)
      .header('content-type', page.contentType)
      .header('content-disposition', `inline; filename="${filename}"`)
      // cache_page's own headers: an expiry and a max-age.
      .header('cache-control', `max-age=${CACHE_SECONDS}`)
      .header('expires', new Date(Date.now() + CACHE_SECONDS * 1000).toUTCString())
      .send(page.body);
  }
}
