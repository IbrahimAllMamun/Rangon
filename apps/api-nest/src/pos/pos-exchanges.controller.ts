import { HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/authentication';
import { StaffView } from '../auth/permissions';
import { ThrottleScope } from '../auth/throttle';
import { auditContext } from '../common/audit';
import { ENV, Env } from '../config/env';
import { idempotencyKey } from '../finance/finance.controller';
import { requestData } from '../http/request-body';
import { PosExchanges } from './pos-exchanges.service';

/**
 * An exchange at the counter: goods back and goods out in one action. It
 * sells and it refunds, so it takes both permissions.
 */
@StaffView('pos/exchanges', ['sales.create', 'sales.refund'])
@ThrottleScope('pos')
export class PosExchangesController {
  constructor(
    private readonly exchanges: PosExchanges,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('pos/exchanges/quote/')
  @HttpCode(200)
  quote(@Req() request: FastifyRequest) {
    return this.exchanges.quote(
      request.user as RequestUser,
      requestData(request),
      auditContext(request, this.env),
    );
  }

  @Post('pos/exchanges/')
  create(@Req() request: FastifyRequest) {
    return this.exchanges.create(
      request.user as RequestUser,
      requestData(request),
      idempotencyKey(request),
      auditContext(request, this.env),
    );
  }
}
