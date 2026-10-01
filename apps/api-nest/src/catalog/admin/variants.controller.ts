import { Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '../../auth/authentication';
import { Action, StaffView } from '../../auth/permissions';
import { auditContext, AuditActor } from '../../common/audit';
import { absoluteUri } from '../../common/http';
import { Params, QueryDict } from '../../common/query-dict';
import { ENV, Env } from '../../config/env';
import { requestData } from '../../http/request-body';
import { lookupParam, PRODUCT_PERMISSIONS } from './catalog-admin.controller';
import { VariantsService } from './variants.service';

function actor(request: FastifyRequest): AuditActor {
  const user = request.user as RequestUser;
  return { id: user.id, email: user.email };
}

/** `ProductVariantViewSet`. */
@StaffView('variants', {
  ...PRODUCT_PERMISSIONS,
  lookup: ['products.view'],
  barcode: ['products.update'],
})
export class VariantsController {
  constructor(
    private readonly variants: VariantsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('variants/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.variants.list(query, absoluteUri(request, this.env));
  }

  @Post('variants/')
  @Action('create')
  async create(@Req() request: FastifyRequest) {
    const data = await this.variants.validate(requestData(request), null, false);
    return (await this.variants.serialise([await this.variants.create(data)]))[0];
  }

  /**
   * Exact barcode, else SKU, with stock at the branch. Not found is the
   * view's own hand-written envelope: no request id in it.
   */
  @Get('variants/lookup/')
  @Action('lookup')
  async lookup(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const variant = await this.variants.lookup(query.get('code', ''));
    if (!variant) {
      reply.status(404);
      return {
        error: { code: 'NOT_FOUND', message: 'No product matches that code.', details: {} },
      };
    }
    return this.variants.lookupPayload(
      variant,
      request.user as RequestUser,
      query.get('branch') ?? null,
    );
  }

  @Get('variants/:pk/')
  @Action('retrieve')
  async retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return (await this.variants.serialise([await this.variants.find(lookupParam(pk), query)]))[0];
  }

  @Put('variants/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, false);
  }

  @Patch('variants/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.save(pk, query, request, true);
  }

  private async save(pk: string, query: QueryDict, request: FastifyRequest, partial: boolean) {
    const instance = await this.variants.find(lookupParam(pk), query);
    const data = await this.variants.validate(requestData(request), instance, partial);
    const row = await this.variants.update(instance, data);
    return (await this.variants.serialise([row], partial))[0];
  }

  @Delete('variants/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    const variant = await this.variants.find(lookupParam(pk), query);
    await this.variants.destroy(variant, actor(request), auditContext(request, this.env));
  }

  @Post('variants/:pk/barcode/')
  @Action('barcode')
  @HttpCode(200)
  async barcode(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    const variant = await this.variants.find(lookupParam(pk), query);
    return this.variants.barcode(variant, actor(request), auditContext(request, this.env));
  }
}
