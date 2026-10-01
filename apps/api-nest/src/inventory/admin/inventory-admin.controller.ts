import { Get, HttpCode, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '../../auth/authentication';
import { Action, StaffView } from '../../auth/permissions';
import { lookupParam } from '../../catalog/admin/catalog-admin.controller';
import { auditContext, AuditActor } from '../../common/audit';
import { absoluteUri } from '../../common/http';
import { Params, QueryDict } from '../../common/query-dict';
import { ENV, Env } from '../../config/env';
import { requestData } from '../../http/request-body';
import { InventoryAdminService } from './inventory-admin.service';
import { LedgerEntries } from './ledger-entries.service';

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
