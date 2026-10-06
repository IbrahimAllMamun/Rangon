import { Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/authentication';
import { Action, StaffView } from '../auth/permissions';
import { lookupParam } from '../catalog/admin/catalog-admin.controller';
import { auditContext } from '../common/audit';
import { absoluteUri } from '../common/http';
import { Params, QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { requestData } from '../http/request-body';
import { ReviewModerationService } from './review-moderation.service';

const MODERATE = ['content.review_moderate'] as const;

/** `ReviewModerationViewSet`: one permission for reading and for deciding. */
@StaffView('reviews', {
  list: MODERATE,
  retrieve: MODERATE,
  approve: MODERATE,
  reject: MODERATE,
})
export class ReviewModerationController {
  constructor(
    private readonly reviews: ReviewModerationService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('reviews/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.reviews.list(query, absoluteUri(request, this.env));
  }

  @Get('reviews/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.reviews.retrieve(lookupParam(pk), query);
  }

  @Post('reviews/:pk/approve/')
  @Action('approve')
  @HttpCode(200)
  approve(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.reviews.moderate(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      'APPROVED',
      auditContext(request, this.env),
    );
  }

  @Post('reviews/:pk/reject/')
  @Action('reject')
  @HttpCode(200)
  reject(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.reviews.moderate(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      'REJECTED',
      auditContext(request, this.env),
    );
  }
}
