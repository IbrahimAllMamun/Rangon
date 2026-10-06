import { Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/authentication';
import { Action, StaffView } from '../auth/permissions';
import { lookupParam } from '../catalog/admin/catalog-admin.controller';
import { auditContext } from '../common/audit';
import { absoluteUri } from '../common/http';
import { Params, QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { requestData } from '../http/request-body';
import { SupplierProductsService } from './supplier-products.service';
import { SuppliersService } from './suppliers.service';

const VIEW = ['purchases.view'] as const;
const BUY = ['purchases.create'] as const;

/** `SupplierViewSet`: who the shop buys from. Deleting one is a settings matter. */
@StaffView('suppliers', {
  list: VIEW,
  retrieve: VIEW,
  create: BUY,
  update: BUY,
  partial_update: BUY,
  destroy: ['settings.manage'],
})
export class SuppliersController {
  constructor(
    private readonly suppliers: SuppliersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('suppliers/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.suppliers.list(query, absoluteUri(request, this.env));
  }

  @Post('suppliers/')
  @Action('create')
  async create(@Req() request: FastifyRequest) {
    const data = await this.suppliers.validate(requestData(request), null, false);
    return this.suppliers.serialise(await this.suppliers.create(data));
  }

  @Get('suppliers/:pk/')
  @Action('retrieve')
  async retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.suppliers.serialise(await this.suppliers.find(lookupParam(pk), query));
  }

  @Put('suppliers/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, false);
  }

  @Patch('suppliers/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.save(pk, query, request, true);
  }

  private async save(pk: string, query: QueryDict, request: FastifyRequest, partial: boolean) {
    const instance = await this.suppliers.find(lookupParam(pk), query);
    const data = await this.suppliers.validate(requestData(request), instance, partial);
    return this.suppliers.serialise(await this.suppliers.update(instance, data));
  }

  @Delete('suppliers/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string, @Params() query: QueryDict): Promise<void> {
    await this.suppliers.destroy(await this.suppliers.find(lookupParam(pk), query));
  }
}

/** `SupplierProductViewSet`: each supplier's price for each variant. */
@StaffView('supplier-products', {
  list: VIEW,
  retrieve: VIEW,
  create: BUY,
  update: BUY,
  partial_update: BUY,
  destroy: BUY,
  set_preferred: BUY,
})
export class SupplierProductsController {
  constructor(
    private readonly offers: SupplierProductsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('supplier-products/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.offers.list(query, absoluteUri(request, this.env));
  }

  @Post('supplier-products/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.offers.create(request.user as RequestUser, requestData(request));
  }

  @Get('supplier-products/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.offers.retrieve(lookupParam(pk), query);
  }

  @Put('supplier-products/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.offers.update(lookupParam(pk), query, () => requestData(request), false);
  }

  @Patch('supplier-products/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.offers.update(lookupParam(pk), query, () => requestData(request), true);
  }

  @Delete('supplier-products/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string, @Params() query: QueryDict): Promise<void> {
    await this.offers.destroy(lookupParam(pk), query);
  }

  @Post('supplier-products/:pk/set-preferred/')
  @Action('set_preferred')
  @HttpCode(200)
  setPreferred(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.offers.setPreferred(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      auditContext(request, this.env),
    );
  }
}
