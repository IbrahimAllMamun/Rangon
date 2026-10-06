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
import { LeadsAdminService } from '../orders/leads-admin.service';
import { CustomersAdminService } from './customers-admin.service';

const VIEW = ['customers.view'] as const;
const EDIT = ['customers.update'] as const;

/**
 * `CustomerViewSet`. `addresses` and `notes` each serve a read and a write,
 * so they declare a requirement per method: someone who may only view
 * customers cannot write an address through the read's permission.
 */
@StaffView('customers', {
  list: VIEW,
  retrieve: VIEW,
  create: ['customers.create'],
  update: EDIT,
  partial_update: EDIT,
  destroy: EDIT,
  lookup: VIEW,
  orders: VIEW,
  addresses: { GET: VIEW, POST: EDIT },
  address_detail: { PATCH: EDIT, DELETE: EDIT },
  notes: { GET: VIEW, POST: EDIT },
  note_detail: { DELETE: EDIT },
})
export class CustomersController {
  constructor(
    private readonly customers: CustomersAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('customers/lookup/')
  @Action('lookup')
  lookup(@Params() query: QueryDict) {
    return this.customers.lookup(query);
  }

  @Get('customers/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.customers.list(query, absoluteUri(request, this.env));
  }

  @Post('customers/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.customers.create(request.user as RequestUser, requestData(request));
  }

  @Get('customers/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.customers.retrieve(lookupParam(pk), query);
  }

  @Put('customers/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.customers.update(lookupParam(pk), query, () => requestData(request), false);
  }

  @Patch('customers/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.customers.update(lookupParam(pk), query, () => requestData(request), true);
  }

  @Delete('customers/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string, @Params() query: QueryDict): Promise<void> {
    await this.customers.destroy(lookupParam(pk), query);
  }

  @Get('customers/:pk/orders/')
  @Action('orders')
  orders(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.customers.ordersOf(lookupParam(pk), query);
  }

  @Get('customers/:pk/addresses/')
  @Action('addresses')
  addresses(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.customers.addressList(lookupParam(pk), query);
  }

  @Post('customers/:pk/addresses/')
  @Action('addresses')
  addAddress(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.customers.addAddress(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      auditContext(request, this.env),
    );
  }

  @Patch('customers/:pk/addresses/:address/')
  @Action('address_detail')
  editAddress(
    @Param('pk') pk: string,
    @Param('address') address: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.customers.editAddress(
      request.user as RequestUser,
      lookupParam(pk),
      lookupParam(address),
      query,
      () => requestData(request),
      auditContext(request, this.env),
    );
  }

  @Delete('customers/:pk/addresses/:address/')
  @Action('address_detail')
  @HttpCode(204)
  async removeAddress(
    @Param('pk') pk: string,
    @Param('address') address: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.customers.removeAddress(
      request.user as RequestUser,
      lookupParam(pk),
      lookupParam(address),
      query,
      auditContext(request, this.env),
    );
  }

  @Get('customers/:pk/notes/')
  @Action('notes')
  notes(@Param('pk') pk: string, @Params() query: QueryDict) {
    return this.customers.noteList(lookupParam(pk), query);
  }

  @Post('customers/:pk/notes/')
  @Action('notes')
  addNote(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.customers.addNote(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      auditContext(request, this.env),
    );
  }

  @Delete('customers/:pk/notes/:note/')
  @Action('note_detail')
  @HttpCode(204)
  async removeNote(
    @Param('pk') pk: string,
    @Param('note') note: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.customers.removeNote(
      request.user as RequestUser,
      lookupParam(pk),
      lookupParam(note),
      query,
      auditContext(request, this.env),
    );
  }
}

/** `AbandonedCheckoutViewSet`: the call-back list. No create and no delete. */
@StaffView('abandoned-checkouts', {
  list: VIEW,
  retrieve: VIEW,
  update: EDIT,
  partial_update: EDIT,
  lost: EDIT,
})
export class AbandonedCheckoutsController {
  constructor(
    private readonly leads: LeadsAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('abandoned-checkouts/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.leads.list(request.user as RequestUser, query, absoluteUri(request, this.env));
  }

  @Get('abandoned-checkouts/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.leads.retrieve(request.user as RequestUser, lookupParam(pk), query);
  }

  @Put('abandoned-checkouts/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.leads.update(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      false,
    );
  }

  @Patch('abandoned-checkouts/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.leads.update(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      true,
    );
  }

  @Post('abandoned-checkouts/:pk/lost/')
  @Action('lost')
  @HttpCode(200)
  lost(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.leads.lost(request.user as RequestUser, lookupParam(pk), query, () =>
      requestData(request),
    );
  }
}
