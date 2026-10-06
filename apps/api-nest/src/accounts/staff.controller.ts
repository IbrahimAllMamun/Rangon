import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/authentication';
import { Action, StaffView } from '../auth/permissions';
import { lookupParam } from '../catalog/admin/catalog-admin.controller';
import { auditContext } from '../common/audit';
import { absoluteUri } from '../common/http';
import { Params, QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { requestData } from '../http/request-body';
import { ManualResponse } from './auth.service';
import { BranchesService } from './branches.service';
import { OrganizationAdminService } from './organization-admin.service';
import { RolesService } from './roles.service';
import { StaffUsersService } from './staff-users.service';

/** A view's own answer, or one it wrote by hand with its own status. */
function answer<T>(reply: FastifyReply, result: ManualResponse | T) {
  if (result instanceof ManualResponse) {
    void reply.status(result.status);
    return result.body;
  }
  return result;
}

/**
 * `OrganizationView` and `OrganizationTaxView`: `IsAuthenticated` alone --
 * a customer may read the organisation -- with each write's permission
 * checked in the view itself.
 */
@Controller('api/v1')
export class OrganizationController {
  constructor(
    private readonly organization: OrganizationAdminService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('organization/')
  async retrieve(@Res({ passthrough: true }) reply: FastifyReply) {
    return answer(reply, await this.organization.retrieve());
  }

  @Patch('organization/')
  async update(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return answer(
      reply,
      await this.organization.update(
        request.user as RequestUser,
        () => requestData(request),
        auditContext(request, this.env),
      ),
    );
  }

  @Get('organization/tax/')
  async tax(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return answer(reply, await this.organization.tax(request.user as RequestUser));
  }

  @Patch('organization/tax/')
  async settleTax(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return answer(
      reply,
      await this.organization.settleTax(
        request.user as RequestUser,
        () => requestData(request),
        auditContext(request, this.env),
      ),
    );
  }
}

const SETTINGS_VIEW = ['settings.view'] as const;
const SETTINGS_MANAGE = ['settings.manage'] as const;

/** `BranchViewSet`. */
@StaffView('branches', {
  list: SETTINGS_VIEW,
  retrieve: SETTINGS_VIEW,
  create: SETTINGS_MANAGE,
  update: SETTINGS_MANAGE,
  partial_update: SETTINGS_MANAGE,
  destroy: SETTINGS_MANAGE,
})
export class BranchesController {
  constructor(
    private readonly branches: BranchesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('branches/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.branches.list(query, absoluteUri(request, this.env));
  }

  @Post('branches/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.branches.create(requestData(request));
  }

  @Get('branches/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string) {
    return this.branches.retrieve(lookupParam(pk));
  }

  @Put('branches/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    return this.branches.update(lookupParam(pk), () => requestData(request), false);
  }

  @Patch('branches/:pk/')
  @Action('partial_update')
  partialUpdate(@Param('pk') pk: string, @Req() request: FastifyRequest) {
    return this.branches.update(lookupParam(pk), () => requestData(request), true);
  }

  @Delete('branches/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(@Param('pk') pk: string): Promise<void> {
    await this.branches.destroy(lookupParam(pk));
  }
}

const USERS_VIEW = ['users.view'] as const;
const USERS_MANAGE = ['users.manage'] as const;

/** `UserViewSet`: staff accounts. A delete deactivates. */
@StaffView('users', {
  list: USERS_VIEW,
  retrieve: USERS_VIEW,
  create: USERS_MANAGE,
  update: USERS_MANAGE,
  partial_update: USERS_MANAGE,
  destroy: USERS_MANAGE,
  deactivate: USERS_MANAGE,
  activate: USERS_MANAGE,
})
export class UsersController {
  constructor(
    private readonly users: StaffUsersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('users/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.users.list(request.user as RequestUser, query, absoluteUri(request, this.env));
  }

  @Post('users/')
  @Action('create')
  create(@Req() request: FastifyRequest) {
    return this.users.create(
      request.user as RequestUser,
      requestData(request),
      auditContext(request, this.env),
    );
  }

  @Get('users/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.users.retrieve(request.user as RequestUser, lookupParam(pk), query);
  }

  @Put('users/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.users.update(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      false,
      auditContext(request, this.env),
    );
  }

  @Patch('users/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.users.update(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      true,
      auditContext(request, this.env),
    );
  }

  /** `destroy` returns what `deactivate` does: the account, and a 200. */
  @Delete('users/:pk/')
  @Action('destroy')
  @HttpCode(200)
  destroy(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.users.deactivate(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      auditContext(request, this.env),
    );
  }

  @Post('users/:pk/deactivate/')
  @Action('deactivate')
  @HttpCode(200)
  deactivate(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.users.deactivate(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      () => requestData(request),
      auditContext(request, this.env),
    );
  }

  @Post('users/:pk/activate/')
  @Action('activate')
  @HttpCode(200)
  activate(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.users.activate(
      request.user as RequestUser,
      lookupParam(pk),
      query,
      auditContext(request, this.env),
    );
  }
}

/** `RoleViewSet`: read-only, `users.view` for every action. */
@StaffView('roles', USERS_VIEW)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('roles/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.roles.list(query);
  }

  @Get('roles/:pk/')
  @Action('retrieve')
  retrieve(@Param('pk') pk: string) {
    return this.roles.retrieve(lookupParam(pk));
  }
}

/** `PermissionViewSet`: the list alone. */
@StaffView('permissions', USERS_VIEW)
export class PermissionsController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions/')
  @Action('list')
  list(@Params() query: QueryDict) {
    return this.roles.permissions(query);
  }
}
