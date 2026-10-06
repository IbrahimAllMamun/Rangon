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
import { StaffOrderActions } from './staff-order-actions.service';
import { StaffOrders } from './staff-order.service';

/** `request.headers.get("Idempotency-Key")`: null when the header is absent, "" when it is empty. */
function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(',') : value;
}

const VIEW = ['orders.view'] as const;

/** `OrderViewSet`: the back office's orders -- every channel, read and acted on. */
@StaffView('orders', {
  list: VIEW,
  retrieve: VIEW,
  timeline: VIEW,
  invoice: VIEW,
  packing_slip: VIEW,
  status: ['orders.update_status'],
  cancel: ['sales.cancel'],
  payments: ['sales.payment_record'],
  refunds: ['sales.refund'],
})
export class OrdersController {
  constructor(
    private readonly orders: StaffOrders,
    private readonly actions: StaffOrderActions,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private find(pk: string, query: QueryDict, request: FastifyRequest) {
    return this.orders.find(request.user as RequestUser, lookupParam(pk), query);
  }

  @Get('orders/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.orders.list(request.user as RequestUser, query, absoluteUri(request, this.env));
  }

  @Get('orders/:pk/')
  @Action('retrieve')
  async retrieve(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.orders.detail(await this.find(pk, query, request));
  }

  @Get('orders/:pk/timeline/')
  @Action('timeline')
  async timeline(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.orders.timeline(await this.find(pk, query, request));
  }

  @Get('orders/:pk/invoice/')
  @Action('invoice')
  async invoice(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.orders.invoice(await this.find(pk, query, request));
  }

  @Get('orders/:pk/packing-slip/')
  @Action('packing_slip')
  async packingSlip(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.orders.packingSlip(await this.find(pk, query, request));
  }

  @Post('orders/:pk/status/')
  @Action('status')
  @HttpCode(200)
  status(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.actions.status(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      requestData(request),
      auditContext(request, this.env),
    );
  }

  @Post('orders/:pk/cancel/')
  @Action('cancel')
  @HttpCode(200)
  cancel(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.actions.cancel(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      auditContext(request, this.env),
    );
  }

  @Post('orders/:pk/payments/')
  @Action('payments')
  payments(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.actions.recordPayment(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      requestData(request),
      auditContext(request, this.env),
    );
  }

  @Post('orders/:pk/refunds/')
  @Action('refunds')
  refunds(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.actions.refund(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      requestData(request),
      idempotencyKey(request),
      auditContext(request, this.env),
    );
  }
}
