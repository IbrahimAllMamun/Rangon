import { Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/authentication';
import { Action, StaffView } from '../auth/permissions';
import { ThrottleScope } from '../auth/throttle';
import { lookupParam } from '../catalog/admin/catalog-admin.controller';
import { auditContext } from '../common/audit';
import { absoluteUri } from '../common/http';
import { Params, QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { requestData } from '../http/request-body';
import { ReturnsService } from './returns.service';

/** `request.headers.get("Idempotency-Key")`: null when the header is absent, "" when it is empty. */
function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(',') : value;
}

const REFUND = ['sales.refund'] as const;

/** `ReturnRequestViewSet`: returns, from the request to the refund. */
@StaffView('returns', {
  list: ['orders.view'],
  retrieve: ['orders.view'],
  create: REFUND,
  approve: REFUND,
  reject: REFUND,
  receive: REFUND,
  complete: REFUND,
})
export class ReturnsController {
  constructor(
    private readonly returns: ReturnsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('returns/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.returns.list(request.user as RequestUser, query, absoluteUri(request, this.env));
  }

  @Post('returns/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.returns.create(
      request.user as RequestUser,
      requestData(request),
      auditContext(request, this.env),
    );
  }

  @Get('returns/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.returns.retrieve(request.user as RequestUser, lookupParam(pk), query);
  }

  @Post('returns/:pk/approve/')
  @Action('approve')
  @HttpCode(200)
  approve(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.returns.approve(request.user as RequestUser, lookupParam(pk), query, () =>
      requestData(request),
    );
  }

  @Post('returns/:pk/reject/')
  @Action('reject')
  @HttpCode(200)
  reject(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.returns.reject(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      auditContext(request, this.env),
    );
  }

  @Post('returns/:pk/receive/')
  @Action('receive')
  @HttpCode(200)
  receive(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.returns.receive(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      requestData(request),
    );
  }

  @Post('returns/:pk/complete/')
  @Action('complete')
  @HttpCode(200)
  complete(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.returns.complete(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      requestData(request),
      idempotencyKey(request),
      auditContext(request, this.env),
    );
  }
}

/** `PosReturnView`: a return at the counter, request to refund in one action. */
@StaffView('pos/returns', REFUND)
@ThrottleScope('pos')
export class PosReturnsController {
  constructor(
    private readonly returns: ReturnsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('pos/returns/')
  posReturn(@Req() request: FastifyRequest) {
    return this.returns.posReturn(
      request.user as RequestUser,
      requestData(request),
      auditContext(request, this.env),
    );
  }
}
