import { Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/authentication';
import { Action, StaffView } from '../auth/permissions';
import { lookupParam } from '../catalog/admin/catalog-admin.controller';
import { auditContext } from '../common/audit';
import { absoluteUri } from '../common/http';
import { Params, QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { requestData } from '../http/request-body';
import { AccountsService } from './accounts.service';

/** `request.headers.get("Idempotency-Key")`: null when the header is absent, "" when it is empty. */
export function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(',') : value;
}

const VIEW = ['finance.view'] as const;
const MANAGE = ['finance.manage'] as const;

/** `AccountViewSet`: accounts and the cash book. No delete: an account is closed, not removed. */
@StaffView('accounts', {
  list: VIEW,
  retrieve: VIEW,
  create: MANAGE,
  update: MANAGE,
  partial_update: MANAGE,
  transactions: VIEW,
  cash_position: VIEW,
  record_movement: ['finance.adjust'],
  verify_integrity: ['settings.manage'],
})
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('accounts/cash-position/')
  @Action('cash_position')
  cashPosition(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.accounts.cashPosition(request.user as RequestUser, query);
  }

  @Post('accounts/record-movement/')
  @Action('record_movement')
  recordMovement(@Req() request: FastifyRequest) {
    return this.accounts.recordMovement(
      request.user as RequestUser,
      requestData(request),
      idempotencyKey(request),
      auditContext(request, this.env),
    );
  }

  @Post('accounts/verify-integrity/')
  @Action('verify_integrity')
  @HttpCode(200)
  verifyIntegrity(@Req() request: FastifyRequest) {
    return this.accounts.verifyIntegrity(request.user as RequestUser, requestData(request));
  }

  @Get('accounts/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.accounts.list(request.user as RequestUser, query, absoluteUri(request, this.env));
  }

  @Post('accounts/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.accounts.create(
      request.user as RequestUser,
      requestData(request),
      auditContext(request, this.env),
    );
  }

  @Get('accounts/:pk/')
  @Action('retrieve')
  async retrieve(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.accounts.serialise(
      await this.accounts.find(request.user as RequestUser, lookupParam(pk), query),
    );
  }

  @Put('accounts/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.accounts.update(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      auditContext(request, this.env),
    );
  }

  @Patch('accounts/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.accounts.update(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      auditContext(request, this.env),
    );
  }

  @Get('accounts/:pk/transactions/')
  @Action('transactions')
  transactions(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.accounts.transactions(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      absoluteUri(request, this.env),
    );
  }
}

/** `AccountTransactionViewSet`: the whole cash book. Read-only: the ledger is history. */
@StaffView('account-transactions', { list: VIEW, retrieve: VIEW })
export class AccountTransactionsController {
  constructor(
    private readonly accounts: AccountsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('account-transactions/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.accounts.ledger(request.user as RequestUser, query, absoluteUri(request, this.env));
  }

  @Get('account-transactions/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.accounts.ledgerEntry(request.user as RequestUser, lookupParam(pk), query);
  }
}

/** `AccountTransferViewSet`: money moved between the business's own accounts. */
@StaffView('account-transfers', { list: VIEW, retrieve: VIEW, create: ['finance.transfer'] })
export class AccountTransfersController {
  constructor(
    private readonly accounts: AccountsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('account-transfers/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.accounts.transfers(
      request.user as RequestUser,
      query,
      absoluteUri(request, this.env),
    );
  }

  @Post('account-transfers/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.accounts.createTransfer(
      request.user as RequestUser,
      requestData(request),
      idempotencyKey(request),
      auditContext(request, this.env),
    );
  }

  @Get('account-transfers/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    return this.accounts.transferById(request.user as RequestUser, lookupParam(pk));
  }
}
