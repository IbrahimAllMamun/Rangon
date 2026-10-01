import { Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '../../auth/authentication';
import { Action, StaffView } from '../../auth/permissions';
import { lookupParam } from '../../catalog/admin/catalog-admin.controller';
import { auditContext, AuditActor } from '../../common/audit';
import { absoluteUri } from '../../common/http';
import { Params, QueryDict } from '../../common/query-dict';
import { ENV, Env } from '../../config/env';
import { requestData } from '../../http/request-body';
import { CountsService } from './counts.service';
import { InventoryAdminService } from './inventory-admin.service';
import { LedgerEntries } from './ledger-entries.service';
import { TransfersService } from './transfers.service';

function actor(request: FastifyRequest): AuditActor {
  const user = request.user as RequestUser;
  return { id: user.id, email: user.email };
}

/** `request.headers.get("Idempotency-Key")`. */
function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(',') : value;
}

/** `InventoryViewSet`: list, retrieve, update, and the stock actions. */
@StaffView('inventory', {
  list: ['inventory.view'],
  retrieve: ['inventory.view'],
  update: ['inventory.adjust'],
  partial_update: ['inventory.adjust'],
  adjust: ['inventory.adjust'],
  write_off: ['inventory.adjust'],
  low_stock: ['inventory.view'],
  valuation: ['reports.financial'],
  verify_integrity: ['settings.manage'],
})
export class InventoryAdminController {
  constructor(
    private readonly inventory: InventoryAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('inventory/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.inventory.list(request.user as RequestUser, query, absoluteUri(request, this.env));
  }

  @Get('inventory/low-stock/')
  @Action('low_stock')
  lowStock(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.inventory.lowStock(
      request.user as RequestUser,
      query,
      absoluteUri(request, this.env),
    );
  }

  @Get('inventory/valuation/')
  @Action('valuation')
  valuation(@Req() request: FastifyRequest) {
    return this.inventory.valuation(request.user as RequestUser);
  }

  /** 201 with the ledger row, or 200 when the shelf already holds that figure. */
  @Post('inventory/adjust/')
  @Action('adjust')
  async adjust(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const { status, body } = await this.inventory.adjust(
      request.user as RequestUser,
      requestData(request),
      actor(request),
      auditContext(request, this.env),
    );
    reply.status(status);
    return body;
  }

  @Post('inventory/write-off/')
  @Action('write_off')
  writeOff(@Req() request: FastifyRequest) {
    return this.inventory.writeOff(
      request.user as RequestUser,
      requestData(request),
      idempotencyKey(request),
      actor(request),
      auditContext(request, this.env),
    );
  }

  @Post('inventory/verify-integrity/')
  @Action('verify_integrity')
  @HttpCode(200)
  verifyIntegrity(@Req() request: FastifyRequest) {
    return this.inventory.verifyIntegrity(request.user as RequestUser, requestData(request));
  }

  @Get('inventory/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.inventory.retrieve(request.user as RequestUser, lookupParam(pk), query);
  }

  @Put('inventory/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request);
  }

  @Patch('inventory/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.save(pk, query, request);
  }

  /** `update` serves PATCH too: `partial_update` only calls it. */
  private async save(pk: string, query: QueryDict, request: FastifyRequest) {
    const row = await this.inventory.find(request.user as RequestUser, lookupParam(pk), query);
    return this.inventory.update(row, requestData(request));
  }
}

/** `InventoryTransactionViewSet`: the ledger, read only. */
@StaffView('inventory-transactions', ['inventory.view'])
export class LedgerController {
  constructor(
    private readonly ledger: LedgerEntries,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('inventory-transactions/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.ledger.list(request.user as RequestUser, query, absoluteUri(request, this.env));
  }

  @Get('inventory-transactions/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.ledger.retrieve(request.user as RequestUser, lookupParam(pk), query);
  }
}

/** `StockTransferViewSet`: list, retrieve, create. */
@StaffView('stock-transfers', {
  list: ['inventory.view'],
  retrieve: ['inventory.view'],
  create: ['inventory.transfer'],
})
export class StockTransfersController {
  constructor(
    private readonly transfers: TransfersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('stock-transfers/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.transfers.list(request.user as RequestUser, query, absoluteUri(request, this.env));
  }

  @Post('stock-transfers/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.transfers.create(
      request.user as RequestUser,
      requestData(request),
      idempotencyKey(request),
      actor(request),
      auditContext(request, this.env),
    );
  }

  @Get('stock-transfers/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    return this.transfers.retrieve(request.user as RequestUser, lookupParam(pk));
  }
}

/**
 * `StockCountViewSet`, a `ModelViewSet` with `record`, `cancel` and
 * `apply`. `destroy` is routed but declares no requirement: only an owner or
 * a superuser passes (D127, copied).
 */
@StaffView('stock-counts', {
  list: ['inventory.view'],
  retrieve: ['inventory.view'],
  create: ['inventory.count'],
  update: ['inventory.count'],
  partial_update: ['inventory.count'],
  apply: ['inventory.count'],
  record: ['inventory.count'],
  cancel: ['inventory.count'],
})
export class StockCountsController {
  constructor(
    private readonly counts: CountsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('stock-counts/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.counts.list(request.user as RequestUser, query, absoluteUri(request, this.env));
  }

  @Post('stock-counts/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.counts.create(request.user as RequestUser, requestData(request), actor(request));
  }

  @Get('stock-counts/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    return this.counts.retrieve(request.user as RequestUser, lookupParam(pk));
  }

  @Put('stock-counts/:pk/')
  @Action('update')
  async update(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    const row = await this.counts.find(request.user as RequestUser, lookupParam(pk));
    return this.counts.update(row, requestData(request), false);
  }

  @Patch('stock-counts/:pk/')
  @Action('partial_update')
  async partialUpdate(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    const row = await this.counts.find(request.user as RequestUser, lookupParam(pk));
    return this.counts.update(row, requestData(request), true);
  }

  @Delete('stock-counts/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string, @Req() request: FastifyRequest): Promise<void> {
    await this.counts.destroy(await this.counts.find(request.user as RequestUser, lookupParam(pk)));
  }

  @Post('stock-counts/:pk/record/')
  @Action('record')
  @HttpCode(200)
  async record(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    const row = await this.counts.find(request.user as RequestUser, lookupParam(pk));
    return this.counts.record(row, requestData(request));
  }

  @Post('stock-counts/:pk/cancel/')
  @Action('cancel')
  @HttpCode(200)
  async cancel(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    return this.counts.cancel(await this.counts.find(request.user as RequestUser, lookupParam(pk)));
  }

  @Post('stock-counts/:pk/apply/')
  @Action('apply')
  @HttpCode(200)
  async apply(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    const row = await this.counts.find(request.user as RequestUser, lookupParam(pk));
    return this.counts.apply(row, actor(request), auditContext(request, this.env));
  }
}
