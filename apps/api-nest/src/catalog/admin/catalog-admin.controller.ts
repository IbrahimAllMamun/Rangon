import { Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { Action, StaffView } from '../../auth/permissions';
import { RouteNotMatched } from '../../common/errors';
import { Params, QueryDict } from '../../common/query-dict';
import { requestData } from '../../http/request-body';
import { BrandsService } from './brands.service';
import { CategoriesService } from './categories.service';

/**
 * The catalogue's staff viewsets (`catalog/api/views.py`), routed as DRF's
 * `DefaultRouter` routes them: a list route and a detail route per viewset,
 * and a route per `@action`.
 */

/** Everything a catalogue viewset requires, by action. */
export const PRODUCT_PERMISSIONS = {
  list: ['products.view'],
  retrieve: ['products.view'],
  create: ['products.create'],
  update: ['products.update'],
  partial_update: ['products.update'],
  destroy: ['products.delete'],
} as const;

/**
 * The router's lookup: `(?P<pk>[^/.]+)`. A key with a dot is the router's
 * format-suffix route, which this API does not serve.
 */
export function lookupParam(value: string): string {
  if (value === '' || value.includes('/') || value.includes('.')) throw new RouteNotMatched();
  return value;
}

@StaffView('brands', PRODUCT_PERMISSIONS)
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Get('brands/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.brands.list(query);
  }

  @Post('brands/')
  @Action('create')
  async create(@Req() request: FastifyRequest) {
    const data = await this.brands.validate(requestData(request), null, false);
    return this.brands.serialise(await this.brands.create(data));
  }

  @Get('brands/:pk/')
  @Action('retrieve')
  async retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.brands.serialise(await this.brands.find(lookupParam(pk), query));
  }

  @Put('brands/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, false);
  }

  @Patch('brands/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.save(pk, query, request, true);
  }

  private async save(pk: string, query: QueryDict, request: FastifyRequest, partial: boolean) {
    const instance = await this.brands.find(lookupParam(pk), query);
    const data = await this.brands.validate(requestData(request), instance, partial);
    return this.brands.serialise(await this.brands.update(instance, data));
  }

  @Delete('brands/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string, @Params() query: QueryDict): Promise<void> {
    await this.brands.destroy(await this.brands.find(lookupParam(pk), query));
  }
}

@StaffView('categories', PRODUCT_PERMISSIONS)
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get('categories/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.categories.list(query);
  }

  @Post('categories/')
  @Action('create')
  async create(@Req() request: FastifyRequest, @Params() query: QueryDict) {
    const data = await this.categories.validate(requestData(request), null, false);
    const row = await this.categories.create(data);
    return this.categories.serialise(row, query.get('tree') === 'true');
  }

  @Get('categories/:pk/')
  @Action('retrieve')
  async retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    const row = await this.categories.find(lookupParam(pk), query);
    return this.categories.serialise(row, query.get('tree') === 'true');
  }

  @Put('categories/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, false);
  }

  @Patch('categories/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.save(pk, query, request, true);
  }

  private async save(pk: string, query: QueryDict, request: FastifyRequest, partial: boolean) {
    const instance = await this.categories.find(lookupParam(pk), query);
    const data = await this.categories.validate(requestData(request), instance, partial);
    const row = await this.categories.update(instance, data);
    return this.categories.serialise(row, query.get('tree') === 'true', partial);
  }

  @Delete('categories/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string, @Params() query: QueryDict): Promise<void> {
    await this.categories.destroy(await this.categories.find(lookupParam(pk), query));
  }

  /** Which attributes this category uses, inherited from its ancestors. */
  @Get('categories/:pk/attributes/')
  @Action('attributes')
  async attributes(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.categories.attributes(await this.categories.find(lookupParam(pk), query));
  }
}
