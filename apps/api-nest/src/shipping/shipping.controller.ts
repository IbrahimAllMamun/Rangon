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
import { ShipmentsService } from './shipments.service';
import { ShippingSettingsService } from './shipping-settings.service';

/** `SETTINGS_PERMISSIONS`: delivery is configured by whoever manages settings. */
const SETTINGS = {
  list: ['settings.view'],
  retrieve: ['settings.view'],
  create: ['settings.manage'],
  update: ['settings.manage'],
  partial_update: ['settings.manage'],
  destroy: ['settings.manage'],
} as const;

/** `ShippingZoneViewSet`: unpaginated, each zone with its methods. */
@StaffView('shipping-zones', SETTINGS)
export class ShippingZonesController {
  constructor(private readonly shipping: ShippingSettingsService) {}

  @Get('shipping-zones/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.shipping.zones(query);
  }

  @Post('shipping-zones/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.shipping.createZone(requestData(request));
  }

  @Get('shipping-zones/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string) {
    return this.shipping.retrieveZone(lookupParam(pk));
  }

  @Put('shipping-zones/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    return this.shipping.updateZone(lookupParam(pk), () => requestData(request), false);
  }

  @Patch('shipping-zones/:pk/')
  @Action('partial_update')
  partialUpdate(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    return this.shipping.updateZone(lookupParam(pk), () => requestData(request), true);
  }

  @Delete('shipping-zones/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string): Promise<void> {
    await this.shipping.destroyZone(lookupParam(pk));
  }
}

/** `ShippingMethodViewSet`: unpaginated, filtered by zone and the active switch. */
@StaffView('shipping-methods', SETTINGS)
export class ShippingMethodsController {
  constructor(private readonly shipping: ShippingSettingsService) {}

  @Get('shipping-methods/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.shipping.methods(query);
  }

  @Post('shipping-methods/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.shipping.createMethod(requestData(request));
  }

  @Get('shipping-methods/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.shipping.retrieveMethod(lookupParam(pk), query);
  }

  @Put('shipping-methods/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.shipping.updateMethod(lookupParam(pk), query, () => requestData(request), false);
  }

  @Patch('shipping-methods/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.shipping.updateMethod(lookupParam(pk), query, () => requestData(request), true);
  }

  @Delete('shipping-methods/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string, @Params() query: QueryDict): Promise<void> {
    await this.shipping.destroyMethod(lookupParam(pk), query);
  }
}

/** `CourierViewSet`: unpaginated. */
@StaffView('couriers', SETTINGS)
export class CouriersController {
  constructor(private readonly shipping: ShippingSettingsService) {}

  @Get('couriers/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.shipping.couriers(query);
  }

  @Post('couriers/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.shipping.createCourier(requestData(request));
  }

  @Get('couriers/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string) {
    return this.shipping.findCourier(lookupParam(pk));
  }

  @Put('couriers/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    return this.shipping.updateCourier(lookupParam(pk), () => requestData(request), false);
  }

  @Patch('couriers/:pk/')
  @Action('partial_update')
  partialUpdate(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    return this.shipping.updateCourier(lookupParam(pk), () => requestData(request), true);
  }

  @Delete('couriers/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string): Promise<void> {
    await this.shipping.destroyCourier(lookupParam(pk));
  }
}

const FULFIL = ['orders.fulfil'] as const;

/** `ShipmentViewSet`: parcels, and what has happened to each. */
@StaffView('shipments', {
  list: ['orders.view'],
  retrieve: ['orders.view'],
  create: FULFIL,
  update: FULFIL,
  partial_update: FULFIL,
  destroy: FULFIL,
  events: FULFIL,
})
export class ShipmentsController {
  constructor(
    private readonly shipments: ShipmentsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('shipments/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.shipments.list(request.user as RequestUser, query, absoluteUri(request, this.env));
  }

  @Post('shipments/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.shipments.create(request.user as RequestUser, requestData(request));
  }

  @Get('shipments/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.shipments.retrieve(request.user as RequestUser, lookupParam(pk), query);
  }

  @Put('shipments/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.shipments.update(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      false,
    );
  }

  @Patch('shipments/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.shipments.update(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      true,
    );
  }

  @Delete('shipments/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.shipments.destroy(request.user as RequestUser, lookupParam(pk), query);
  }

  @Post('shipments/:pk/events/')
  @Action('events')
  events(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.shipments.recordEvent(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      auditContext(request, this.env),
    );
  }
}
