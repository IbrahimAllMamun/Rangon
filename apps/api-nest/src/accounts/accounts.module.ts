import { Module } from '@nestjs/common';

import { AuditLogService } from './audit-log.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BranchesService } from './branches.service';
import { MeService } from './me.service';
import { OrganizationAdminService } from './organization-admin.service';
import { OrganizationService } from './organization.service';
import { RolesService } from './roles.service';
import {
  AuditLogsController,
  BranchesController,
  OrganizationController,
  PermissionsController,
  RolesController,
  UsersController,
} from './staff.controller';
import { StaffUsersService } from './staff-users.service';
import { TokensService } from './tokens.service';

@Module({
  controllers: [
    AuthController,
    OrganizationController,
    BranchesController,
    UsersController,
    RolesController,
    PermissionsController,
    AuditLogsController,
  ],
  providers: [
    OrganizationService,
    AuthService,
    MeService,
    TokensService,
    BranchesService,
    StaffUsersService,
    RolesService,
    OrganizationAdminService,
    AuditLogService,
  ],
  exports: [OrganizationService, AuthService],
})
export class AccountsModule {}
