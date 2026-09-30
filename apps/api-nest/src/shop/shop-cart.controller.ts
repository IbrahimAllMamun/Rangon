import { Controller, Delete, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AllowAny } from '../auth/authentication';
import { CartRow, CartService } from '../checkout/cart.service';
import { invalidUuid } from '../common/errors';
import { pyStr } from '../common/python';
import { Params, QueryDict } from '../common/query-dict';
import { uuidFromValue } from '../common/uuid';
import { dataGet, pyIntOf, pyTruthy, requestData } from '../http/request-body';
import { CustomerOrdersService } from '../orders/customer-orders.service';

/** `pk=value` in a lookup: a UUID, nothing, or Django's 400. */
function lookupId(value: unknown): string | null {
  const lookup = uuidFromValue(value);
  if ('invalid' in lookup) throw invalidUuid(pyStr(value));
  return lookup.id;
}

/**
 * The storefront cart (`orders/api/shop_views.py`): `CartView`,
 * `CartCouponView` and `ShippingOptionsView`. Open to anyone; a guest's cart
 * is found by its `X-Cart-Token`, a signed-in customer's by the customer.
 */
@Controller('api/v1/shop')
@AllowAny()
export class ShopCartController {
  constructor(
    private readonly carts: CartService,
    private readonly orders: CustomerOrdersService,
  ) {}

  /** `_cart_for(request)`: the header, else `?cart_token=`, and the signed-in customer. */
  private async cartFor(request: FastifyRequest, params: QueryDict): Promise<CartRow> {
    const header = request.headers['x-cart-token'];
    const token =
      (Array.isArray(header) ? header.join(',') : header) || params.get('cart_token') || null;
    const customerId = await this.orders.customerOf(request.user?.id);
    return this.carts.getOrCreate(token, customerId);
  }

  /** `CartView._respond`: re-priced, serialised, and the token in a header. */
  private async respond(reply: FastifyReply, cart: CartRow) {
    const view = await this.carts.price(cart);
    const body = await this.carts.payload(view);
    void reply.header('x-cart-token', cart.token);
    return body;
  }

  @Get('cart/')
  async get(
    @Req() request: FastifyRequest,
    @Params() params: QueryDict,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.respond(reply, await this.cartFor(request, params));
  }

  @Post('cart/')
  @HttpCode(200)
  async add(
    @Req() request: FastifyRequest,
    @Params() params: QueryDict,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const cart = await this.cartFor(request, params);
    const data = requestData(request);
    const variant = dataGet(data, 'variant');
    const raw = dataGet(data, 'quantity');
    const quantity = pyIntOf(raw === undefined ? 1 : raw);
    await this.carts.addItem(cart, () => lookupId(variant ?? null), quantity);
    return this.respond(reply, cart);
  }

  @Patch('cart/')
  async update(
    @Req() request: FastifyRequest,
    @Params() params: QueryDict,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const cart = await this.cartFor(request, params);
    const data = requestData(request);
    const item = dataGet(data, 'item');
    const raw = dataGet(data, 'quantity');
    const quantity = pyIntOf(raw === undefined ? 0 : raw);
    await this.carts.updateItem(cart, lookupId(item ?? null), quantity);
    return this.respond(reply, cart);
  }

  @Delete('cart/')
  @HttpCode(200)
  async remove(
    @Req() request: FastifyRequest,
    @Params() params: QueryDict,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const cart = await this.cartFor(request, params);
    // `query_params.get("item") or request.data.get("item")`: the body is read
    // only when the query string names nothing.
    const fromQuery = params.get('item');
    const item = fromQuery || dataGet(requestData(request), 'item');
    if (pyTruthy(item)) {
      await this.carts.updateItem(cart, lookupId(item), 0n);
    } else {
      await this.carts.clear(cart);
    }
    return this.respond(reply, cart);
  }

  @Post('cart/coupon/')
  @HttpCode(200)
  async applyCoupon(
    @Req() request: FastifyRequest,
    @Params() params: QueryDict,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const cart = await this.cartFor(request, params);
    const code = dataGet(requestData(request), 'code');
    await this.carts.applyCoupon(cart, code === undefined ? '' : code);
    return this.respond(reply, cart);
  }

  @Delete('cart/coupon/')
  @HttpCode(200)
  async removeCoupon(
    @Req() request: FastifyRequest,
    @Params() params: QueryDict,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const cart = await this.cartFor(request, params);
    await this.carts.removeCoupon(cart);
    return this.respond(reply, cart);
  }

  @Get('shipping-options/')
  async shippingOptions(@Req() request: FastifyRequest, @Params() params: QueryDict) {
    const cart = await this.cartFor(request, params);
    const view = await this.carts.price(cart);
    return this.carts.shippingOptions(params.get('city', ''), view.priced.subtotal);
  }
}
