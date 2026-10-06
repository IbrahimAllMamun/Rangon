import { Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/authentication';
import { Action, StaffView } from '../auth/permissions';
import { lookupParam } from '../catalog/admin/catalog-admin.controller';
import { absoluteUri } from '../common/http';
import { Params, QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { requestData } from '../http/request-body';
import { CouponsAdminService } from './coupons-admin.service';

const MANAGE = ['content.coupons_manage'] as const;

/** `CouponViewSet`: one permission for every action, reading included. */
@StaffView('coupons', {
  list: MANAGE,
  retrieve: MANAGE,
  create: MANAGE,
  update: MANAGE,
  partial_update: MANAGE,
  destroy: MANAGE,
  redemptions: MANAGE,
})
export class CouponsController {
  constructor(
    private readonly coupons: CouponsAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('coupons/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.coupons.list(query, absoluteUri(request, this.env));
  }

  @Post('coupons/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.coupons.create(request.user as RequestUser, requestData(request));
  }

  @Get('coupons/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.coupons.retrieve(lookupParam(pk), query);
  }

  @Put('coupons/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.coupons.update(lookupParam(pk), query, () => requestData(request), false);
  }

  @Patch('coupons/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.coupons.update(lookupParam(pk), query, () => requestData(request), true);
  }

  @Delete('coupons/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string, @Params() query: QueryDict): Promise<void> {
    await this.coupons.destroy(lookupParam(pk), query);
  }

  @Get('coupons/:pk/redemptions/')
  @Action('redemptions')
  redemptions(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.coupons.redemptions(lookupParam(pk), query);
  }
}
