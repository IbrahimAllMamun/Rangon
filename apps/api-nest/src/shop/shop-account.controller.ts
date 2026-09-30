import { timingSafeEqual } from 'node:crypto';

import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AllowAny, CustomerOnly, RequestUser } from '../auth/authentication';
import { auditContext, AuditActor } from '../common/audit';
import { invalidUuid, NotFound, RouteNotMatched } from '../common/errors';
import { pyStr } from '../common/python';
import { Params, QueryDict } from '../common/query-dict';
import { uuidFromValue } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { AddressesService, serialiseAddress } from '../customers/addresses.service';
import { dataGet, requestData } from '../http/request-body';
import { CustomerOrdersService } from '../orders/customer-orders.service';

/** Django's `str` path converter: one or more characters, none of them `/`. */
function strParam(value: string): string {
  if (!value || value.includes('/')) throw new RouteNotMatched();
  return value;
}

/** `hmac.compare_digest`: equal, compared in constant time. */
function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `pk=value` in a lookup: a UUID, nothing (None), or Django's 400. */
function lookupId(value: unknown): string | null {
  const lookup = uuidFromValue(value);
  if ('invalid' in lookup) throw invalidUuid(pyStr(value));
  return lookup.id;
}

function actor(request: FastifyRequest): AuditActor {
  const user = request.user as RequestUser;
  return { id: user.id, email: user.email };
}

/**
 * The storefront's order and account views (`orders/api/shop_views.py`):
 * `OrderTrackingView`, `AccountOrdersView` and `AccountAddressView`.
 */
@Controller('api/v1/shop')
export class ShopAccountController {
  constructor(
    private readonly orders: CustomerOrdersService,
    private readonly addresses: AddressesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Guest order tracking: the order's own customer, signed in, or the token
   * from the tracking link. Never the number alone -- and a blank token opens
   * nothing (D113).
   */
  @Get('orders/:number/')
  @AllowAny()
  async track(
    @Param('number') number: string,
    @Req() request: FastifyRequest,
    @Params() params: QueryDict,
  ) {
    const order = await this.orders.byNumber(strParam(number));
    if (!order) throw new NotFound('Order not found.');
    const customerId = await this.orders.customerOf(request.user?.id);
    const token = params.get('token', '');
    const owner = customerId !== null && order.customer_id === customerId;
    const opened = order.guest_token !== '' && sameSecret(token, order.guest_token);
    if (!owner && !opened) throw new NotFound('Order not found.');
    return this.orders.payload(order);
  }

  @Get('account/orders/')
  @CustomerOnly()
  async accountOrders(@Req() request: FastifyRequest) {
    const customerId = await this.orders.customerOf(request.user?.id);
    if (!customerId) return { results: [] };
    return { results: await this.orders.list(customerId) };
  }

  @Get('account/orders/:number/')
  @CustomerOnly()
  async accountOrder(@Param('number') number: string, @Req() request: FastifyRequest) {
    strParam(number);
    const customerId = await this.orders.customerOf(request.user?.id);
    // Django answers an account with no customer record this way, detail or not.
    if (!customerId) return { results: [] };
    const order = await this.orders.byNumberFor(number, customerId);
    if (!order) throw new NotFound();
    return this.orders.payload(order);
  }

  @Get('account/addresses/')
  @CustomerOnly()
  async listAddresses(@Req() request: FastifyRequest) {
    const customerId = await this.orders.customerOf(request.user?.id);
    return customerId ? this.addresses.list(customerId) : [];
  }

  @Post('account/addresses/')
  @CustomerOnly()
  async addAddress(@Req() request: FastifyRequest) {
    const customerId = await this.orders.customerOf(request.user?.id);
    // `IsCustomer` proves the role, not that a customer record exists.
    if (!customerId) throw new NotFound('This account has no customer profile.');
    const data = await this.addresses.validate(requestData(request), false);
    const row = await this.addresses.add(
      customerId,
      data,
      actor(request),
      auditContext(request, this.env),
    );
    return serialiseAddress(row);
  }

  @Patch('account/addresses/')
  @CustomerOnly()
  async updateAddress(@Req() request: FastifyRequest) {
    const body = requestData(request);
    const id = lookupId(dataGet(body, 'id') ?? null);
    const customerId = await this.orders.customerOf(request.user?.id);
    const address = await this.addresses.find(id, customerId);
    const data = await this.addresses.validate(body, true);
    const row = await this.addresses.update(
      address,
      data,
      actor(request),
      auditContext(request, this.env),
    );
    return serialiseAddress(row);
  }

  @Delete('account/addresses/')
  @CustomerOnly()
  @HttpCode(204)
  async deleteAddress(@Req() request: FastifyRequest, @Params() params: QueryDict): Promise<void> {
    const id = lookupId(params.get('id') ?? null);
    const customerId = await this.orders.customerOf(request.user?.id);
    const address = await this.addresses.find(id, customerId);
    await this.addresses.remove(address, actor(request), auditContext(request, this.env));
  }
}
