import { Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/authentication';
import { Action, StaffView } from '../auth/permissions';
import { ThrottleScope } from '../auth/throttle';
import { lookupParam } from '../catalog/admin/catalog-admin.controller';
import { VariantsService } from '../catalog/admin/variants.service';
import { auditContext } from '../common/audit';
import { Params, QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { requestData } from '../http/request-body';
import { HoldsService } from './holds.service';
import { PosCounterService } from './pos-counter.service';
import { PosSales } from './pos-sales.service';
import { PosReadsService } from './pos-reads.service';

/** Every POS view asks for the same thing: the right to ring up a sale. */
const SELL = ['sales.create'] as const;

/** `PosSessionView`: everything the register needs to open. */
@StaffView('pos/session', SELL)
@ThrottleScope('pos')
export class PosSessionController {
  constructor(private readonly reads: PosReadsService) {}

  @Get('pos/session/')
  session(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.reads.session(request.user as RequestUser, query);
  }
}

/** `PosLookupView`: a scan. Exact barcode, else SKU, with stock at the branch. */
@StaffView('pos/lookup', SELL)
@ThrottleScope('pos')
export class PosLookupController {
  constructor(private readonly variants: VariantsService) {}

  /** Not found is the view's own hand-written envelope: no request id in it. */
  @Get('pos/lookup/')
  async lookup(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const code = query.get('code', '') ?? '';
    const variant = await this.variants.lookup(code);
    if (!variant) {
      reply.status(404);
      return {
        error: {
          code: 'NOT_FOUND',
          message: `No product matches '${code}'.`,
          details: { code },
        },
      };
    }
    return this.variants.lookupPayload(
      variant,
      request.user as RequestUser,
      query.get('branch') ?? null,
    );
  }
}

/** `PosProductSearchView`: the grid, for cashiers who tap rather than scan. */
@StaffView('pos/products', SELL)
@ThrottleScope('pos')
export class PosProductsController {
  constructor(private readonly reads: PosReadsService) {}

  @Get('pos/products/')
  products(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.reads.products(request.user as RequestUser, query);
  }
}

/** `PosQuoteView`: the register's running total, priced as the sale would record it. */
@StaffView('pos/quote', SELL)
@ThrottleScope('pos')
export class PosQuoteController {
  constructor(private readonly counter: PosCounterService) {}

  @Post('pos/quote/')
  @HttpCode(200)
  quote(@Req() request: FastifyRequest) {
    return this.counter.quote(request.user as RequestUser, requestData(request));
  }
}

/** `PosElevateView`: a manager's override, behind the sign-in throttle. */
@StaffView('pos/elevate', SELL)
@ThrottleScope('auth')
export class PosElevateController {
  constructor(
    private readonly counter: PosCounterService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('pos/elevate/')
  @HttpCode(200)
  elevate(@Req() request: FastifyRequest) {
    return this.counter.elevate(
      request.user as RequestUser,
      requestData(request),
      auditContext(request, this.env),
    );
  }
}

/** `request.headers.get("Idempotency-Key")`: null when the header is absent, "" when it is empty. */
function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(',') : value;
}

/** `PosSaleViewSet`: ring up a sale, read it back, print its receipt. */
@StaffView('pos/sales', {
  create: ['sales.create'],
  receipt: ['sales.view'],
  void: ['sales.cancel'],
  retrieve: ['sales.view'],
})
@ThrottleScope('pos')
export class PosSalesController {
  constructor(
    private readonly sales: PosSales,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('pos/sales/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.sales.create(
      request.user as RequestUser,
      requestData(request),
      idempotencyKey(request),
      auditContext(request, this.env),
    );
  }

  @Get('pos/sales/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.sales.retrieve(lookupParam(pk), query);
  }

  @Get('pos/sales/:pk/receipt/')
  @Action('receipt')
  receipt(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.sales.receipt(lookupParam(pk), query);
  }
}

/** `HeldSaleViewSet`: parked carts. */
@StaffView('pos/holds', SELL)
@ThrottleScope('pos')
export class HeldSalesController {
  constructor(private readonly holds: HoldsService) {}

  @Get('pos/holds/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.holds.list(request.user as RequestUser, query);
  }

  @Post('pos/holds/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.holds.create(request.user as RequestUser, requestData(request));
  }

  @Get('pos/holds/:pk/')
  @Action('retrieve')
  async retrieve(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    const user = request.user as RequestUser;
    return (await this.holds.serialise([await this.holds.find(user, lookupParam(pk), query)]))[0];
  }

  @Put('pos/holds/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.holds.update(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      false,
    );
  }

  @Patch('pos/holds/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.holds.update(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      true,
    );
  }

  @Delete('pos/holds/:pk/')
  @Action('destroy')
  @HttpCode(204)
  destroy(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.holds.destroy(request.user as RequestUser, lookupParam(pk), query);
  }

  @Post('pos/holds/:pk/resume/')
  @Action('resume')
  @HttpCode(200)
  resume(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.holds.resume(request.user as RequestUser, lookupParam(pk), query);
  }
}
