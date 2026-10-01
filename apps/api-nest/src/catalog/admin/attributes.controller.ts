import { Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { Action, StaffView } from '../../auth/permissions';
import type { RequestUser } from '../../auth/authentication';
import { auditContext, AuditActor } from '../../common/audit';
import { Params, QueryDict } from '../../common/query-dict';
import { ENV, Env } from '../../config/env';
import { requestData } from '../../http/request-body';
import { AttributesService, serialiseValue } from './attributes.service';
import { lookupParam, PRODUCT_PERMISSIONS } from './catalog-admin.controller';
import { SizeChartsService } from './size-charts.service';

function actor(request: FastifyRequest): AuditActor {
  const user = request.user as RequestUser;
  return { id: user.id, email: user.email };
}

/** `AttributeViewSet`. */
@StaffView('attributes', PRODUCT_PERMISSIONS)
export class AttributesController {
  constructor(private readonly attributes: AttributesService) {}

  @Get('attributes/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.attributes.listAttributes(query);
  }

  @Post('attributes/')
  @Action('create')
  async create(@Req() request: FastifyRequest) {
    const data = await this.attributes.validateAttribute(requestData(request), null, false);
    return this.attributes.serialiseOneAttribute(await this.attributes.createAttribute(data));
  }

  @Get('attributes/:pk/')
  @Action('retrieve')
  async retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.attributes.serialiseOneAttribute(
      await this.attributes.findAttribute(lookupParam(pk), query),
    );
  }

  @Put('attributes/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, false);
  }

  @Patch('attributes/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.save(pk, query, request, true);
  }

  private async save(pk: string, query: QueryDict, request: FastifyRequest, partial: boolean) {
    const instance = await this.attributes.findAttribute(lookupParam(pk), query);
    const data = await this.attributes.validateAttribute(requestData(request), instance, partial);
    return this.attributes.serialiseOneAttribute(
      await this.attributes.updateAttribute(instance, data),
    );
  }

  @Delete('attributes/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string, @Params() query: QueryDict): Promise<void> {
    await this.attributes.destroyAttribute(
      await this.attributes.findAttribute(lookupParam(pk), query),
    );
  }
}

/** `AttributeValueViewSet`. */
@StaffView('attribute-values', PRODUCT_PERMISSIONS)
export class AttributeValuesController {
  constructor(private readonly attributes: AttributesService) {}

  @Get('attribute-values/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.attributes.listValues(query);
  }

  @Post('attribute-values/')
  @Action('create')
  async create(@Req() request: FastifyRequest) {
    const data = await this.attributes.validateValue(requestData(request), null, false);
    return serialiseValue(await this.attributes.createValue(data));
  }

  @Get('attribute-values/:pk/')
  @Action('retrieve')
  async retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return serialiseValue(await this.attributes.findValue(lookupParam(pk), query));
  }

  @Put('attribute-values/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, false);
  }

  @Patch('attribute-values/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.save(pk, query, request, true);
  }

  private async save(pk: string, query: QueryDict, request: FastifyRequest, partial: boolean) {
    const instance = await this.attributes.findValue(lookupParam(pk), query);
    const data = await this.attributes.validateValue(requestData(request), instance, partial);
    return serialiseValue(await this.attributes.updateValue(instance, data));
  }

  @Delete('attribute-values/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string, @Params() query: QueryDict): Promise<void> {
    await this.attributes.destroyValue(await this.attributes.findValue(lookupParam(pk), query));
  }

  /**
   * Swap `position` with the previous or next value of the same attribute.
   * The view declares no requirement for `move`, so only an owner or a
   * superuser passes `RolePermission` (D117).
   */
  @Post('attribute-values/:pk/move/')
  @Action('move')
  @HttpCode(200)
  async move(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    const direction = this.attributes.direction(requestData(request));
    const value = await this.attributes.findValue(lookupParam(pk), query);
    await this.attributes.move(value, direction);
    return serialiseValue(await this.attributes.findValue(value.id, query));
  }
}

/** `SizeChartViewSet`: thin, over `save_size_chart` and `delete_size_chart`. */
@StaffView('size-charts', PRODUCT_PERMISSIONS)
export class SizeChartsController {
  constructor(
    private readonly charts: SizeChartsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('size-charts/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.charts.list(query);
  }

  @Post('size-charts/')
  @Action('create')
  async create(@Req() request: FastifyRequest) {
    const data = await this.charts.validate(requestData(request), false);
    const id = await this.charts.save(null, data, actor(request), auditContext(request, this.env));
    return this.charts.payload(id);
  }

  @Get('size-charts/:pk/')
  @Action('retrieve')
  async retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.charts.serialiseOne(await this.charts.find(lookupParam(pk), query));
  }

  @Put('size-charts/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, false);
  }

  @Patch('size-charts/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.save(pk, query, request, true);
  }

  private async save(pk: string, query: QueryDict, request: FastifyRequest, partial: boolean) {
    const chart = await this.charts.find(lookupParam(pk), query);
    const data = await this.charts.validate(requestData(request), partial);
    const id = await this.charts.save(chart, data, actor(request), auditContext(request, this.env));
    return this.charts.payload(id);
  }

  @Delete('size-charts/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    const chart = await this.charts.find(lookupParam(pk), query);
    await this.charts.destroy(chart, actor(request), auditContext(request, this.env));
  }
}
