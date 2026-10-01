import { Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '../../auth/authentication';
import { Action, StaffView } from '../../auth/permissions';
import { lookupParam } from '../../catalog/admin/catalog-admin.controller';
import { auditContext, type AuditActor } from '../../common/audit';
import { Params, QueryDict } from '../../common/query-dict';
import { ENV, Env } from '../../config/env';
import { requestData } from '../../http/request-body';
import { BannersAdminService } from './banners-admin.service';
import { CarouselAdminService } from './carousel-admin.service';
import { NavigationAdminService } from './navigation-admin.service';
import { PagesAdminService } from './pages-admin.service';
import { SiteAdminService } from './site-admin.service';

function actor(request: FastifyRequest): AuditActor {
  const user = request.user as RequestUser;
  return { id: user.id, email: user.email };
}

/** Reading is `settings.view`; writing the footer and pages is its own code. */
const SITE_READ = ['settings.view'];
const SITE_WRITE = ['content.site_manage'];

/** `SiteSettingsView`, an `APIView`: its requirements are keyed by method. */
@StaffView('site-settings', { get: SITE_READ, patch: SITE_WRITE })
export class SiteSettingsController {
  constructor(
    private readonly site: SiteAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('site-settings/')
  get() {
    return this.site.settings();
  }

  @Patch('site-settings/')
  patch(@Req() request: FastifyRequest) {
    return this.site.updateSettings(
      requestData(request),
      actor(request),
      auditContext(request, this.env),
    );
  }
}

/** `SocialLinkViewSet`: one row per platform, made by migration. No create, no delete. */
@StaffView('social-links', {
  list: SITE_READ,
  retrieve: SITE_READ,
  partial_update: SITE_WRITE,
  move: SITE_WRITE,
})
export class SocialLinksController {
  constructor(
    private readonly site: SiteAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('social-links/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.site.links(query);
  }

  @Get('social-links/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.site.retrieveLink(lookupParam(pk), query);
  }

  @Patch('social-links/:pk/')
  @Action('partial_update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.site.updateLink(
      lookupParam(pk),
      query,
      requestData(request),
      actor(request),
      auditContext(request, this.env),
    );
  }

  @Post('social-links/:pk/move/')
  @Action('move')
  @HttpCode(200)
  move(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.site.moveLink(
      lookupParam(pk),
      query,
      requestData(request),
      actor(request),
      auditContext(request, this.env),
    );
  }
}

/** `SitePageViewSet`: list, retrieve, create, partial update and delete, addressed by slug. */
@StaffView('site-pages', {
  list: SITE_READ,
  retrieve: SITE_READ,
  create: SITE_WRITE,
  partial_update: SITE_WRITE,
  destroy: SITE_WRITE,
})
export class SitePagesController {
  constructor(
    private readonly pages: PagesAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('site-pages/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.pages.list(query);
  }

  @Post('site-pages/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.pages.create(requestData(request), actor(request), auditContext(request, this.env));
  }

  @Get('site-pages/:slug/')
  @Action('retrieve')
  retrieve(@Param('slug') slug: string, @Params() query: QueryDict) {
    return this.pages.retrieve(lookupParam(slug), query);
  }

  @Patch('site-pages/:slug/')
  @Action('partial_update')
  update(@Param('slug') slug: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.pages.update(
      lookupParam(slug),
      query,
      requestData(request),
      actor(request),
      auditContext(request, this.env),
    );
  }

  @Delete('site-pages/:slug/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(
    @Param('slug') slug: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.pages.destroy(
      lookupParam(slug),
      query,
      actor(request),
      auditContext(request, this.env),
    );
  }
}

/** Merchandising: the navbar, the footer's columns, the banners and the carousel. */
const NAVIGATION_PERMISSIONS = {
  list: ['settings.view'],
  retrieve: ['settings.view'],
  create: ['content.navigation_manage'],
  update: ['content.navigation_manage'],
  partial_update: ['content.navigation_manage'],
  destroy: ['content.navigation_manage'],
  move: ['content.navigation_manage'],
};

/**
 * `NavigationItemViewSet`: a `ModelViewSet` plus `move`. Its image takes an
 * upload, so form bodies are read as DRF reads them.
 */
@StaffView('navigation-items', NAVIGATION_PERMISSIONS)
export class NavigationItemsController {
  constructor(
    private readonly items: NavigationAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('navigation-items/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.items.list(query);
  }

  /** DRF's `get_success_headers` names the answer's `url` -- here the item's link -- in `Location`. */
  @Post('navigation-items/')
  @Action('create')
  async create(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const payload = await this.items.create(
      requestData(request, { forms: true }),
      actor(request),
      auditContext(request, this.env),
    );
    reply.header('location', String(payload.url));
    return payload;
  }

  @Get('navigation-items/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.items.retrieve(lookupParam(pk), query);
  }

  @Put('navigation-items/:pk/')
  @Action('update')
  replace(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, false);
  }

  @Patch('navigation-items/:pk/')
  @Action('partial_update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, true);
  }

  private save(pk: string, query: QueryDict, request: FastifyRequest, partial: boolean) {
    return this.items.update(
      lookupParam(pk),
      query,
      requestData(request, { forms: true }),
      partial,
      actor(request),
      auditContext(request, this.env),
    );
  }

  @Delete('navigation-items/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.items.destroy(
      lookupParam(pk),
      query,
      actor(request),
      auditContext(request, this.env),
    );
  }

  @Post('navigation-items/:pk/move/')
  @Action('move')
  @HttpCode(200)
  move(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.items.move(lookupParam(pk), query, requestData(request, { forms: true }));
  }
}

/** `StorefrontBannerViewSet`: a `ModelViewSet`; its image takes an upload. */
@StaffView('storefront-banners', NAVIGATION_PERMISSIONS)
export class BannersController {
  constructor(
    private readonly banners: BannersAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('storefront-banners/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.banners.list(query);
  }

  /** `Location` is the answer's `url`, as for navigation items. */
  @Post('storefront-banners/')
  @Action('create')
  async create(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const payload = await this.banners.create(
      requestData(request, { forms: true }),
      actor(request),
      auditContext(request, this.env),
    );
    reply.header('location', String(payload.url));
    return payload;
  }

  @Get('storefront-banners/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.banners.retrieve(lookupParam(pk), query);
  }

  @Put('storefront-banners/:pk/')
  @Action('update')
  replace(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, false);
  }

  @Patch('storefront-banners/:pk/')
  @Action('partial_update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, true);
  }

  private save(pk: string, query: QueryDict, request: FastifyRequest, partial: boolean) {
    return this.banners.update(
      lookupParam(pk),
      query,
      requestData(request, { forms: true }),
      partial,
      actor(request),
      auditContext(request, this.env),
    );
  }

  @Delete('storefront-banners/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.banners.destroy(
      lookupParam(pk),
      query,
      actor(request),
      auditContext(request, this.env),
    );
  }
}

/** `HomeCarouselViewSet`: list, add, remove and move -- no detail read. */
@StaffView('home-carousel', {
  list: ['settings.view'],
  create: ['content.navigation_manage'],
  destroy: ['content.navigation_manage'],
  move: ['content.navigation_manage'],
})
export class HomeCarouselController {
  constructor(
    private readonly carousel: CarouselAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('home-carousel/')
  @Action('list')
  list() {
    return this.carousel.list();
  }

  @Post('home-carousel/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.carousel.add(requestData(request), actor(request), auditContext(request, this.env));
  }

  @Delete('home-carousel/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.carousel.remove(
      lookupParam(pk),
      query,
      actor(request),
      auditContext(request, this.env),
    );
  }

  @Post('home-carousel/:pk/move/')
  @Action('move')
  @HttpCode(200)
  move(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.carousel.move(
      lookupParam(pk),
      query,
      requestData(request),
      actor(request),
      auditContext(request, this.env),
    );
  }
}
