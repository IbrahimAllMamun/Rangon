import { Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Action, StaffView } from '../../auth/permissions';
import { absoluteUri } from '../../common/http';
import { Params, QueryDict } from '../../common/query-dict';
import { ENV, Env } from '../../config/env';
import { requestData } from '../../http/request-body';
import { lookupParam, PRODUCT_PERMISSIONS } from './catalog-admin.controller';
import { ProductImagesService } from './product-images.service';

/** `ProductImageViewSet`: uploads arrive as forms, edits as JSON or forms. */
@StaffView('product-images', PRODUCT_PERMISSIONS)
export class ProductImagesController {
  constructor(
    private readonly images: ProductImagesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('product-images/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.images.list(query, absoluteUri(request, this.env));
  }

  /**
   * DRF's `get_success_headers` names the new row's `url` in `Location`
   * whenever the answer has one -- here the photograph's own URL.
   */
  @Post('product-images/')
  @Action('create')
  async create(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const data = await this.images.validate(requestData(request, { forms: true }), null, false);
    const payload = (await this.images.serialise([await this.images.create(data)]))[0] as {
      url: string;
    };
    reply.header('location', payload.url);
    return payload;
  }

  @Get('product-images/:pk/')
  @Action('retrieve')
  async retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return (await this.images.serialise([await this.images.find(lookupParam(pk), query)]))[0];
  }

  @Put('product-images/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, false);
  }

  @Patch('product-images/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.save(pk, query, request, true);
  }

  private async save(pk: string, query: QueryDict, request: FastifyRequest, partial: boolean) {
    const instance = await this.images.find(lookupParam(pk), query);
    const data = await this.images.validate(
      requestData(request, { forms: true }),
      instance,
      partial,
    );
    return (await this.images.serialise([await this.images.update(instance, data)]))[0];
  }

  @Delete('product-images/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string, @Params() query: QueryDict): Promise<void> {
    await this.images.destroy(await this.images.find(lookupParam(pk), query));
  }
}
