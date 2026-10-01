import { Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { RequestUser } from '../../auth/authentication';
import { Action, StaffView } from '../../auth/permissions';
import { lookupParam } from '../../catalog/admin/catalog-admin.controller';
import { auditContext, type AuditActor } from '../../common/audit';
import { Params, QueryDict } from '../../common/query-dict';
import { ENV, Env } from '../../config/env';
import { requestData } from '../../http/request-body';
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
