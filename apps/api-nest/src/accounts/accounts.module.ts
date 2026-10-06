import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MeService } from './me.service';
import { OrganizationService } from './organization.service';
import { TokensService } from './tokens.service';

@Module({
  controllers: [AuthController],
  providers: [OrganizationService, AuthService, MeService, TokensService],
  exports: [OrganizationService, AuthService],
})
export class AccountsModule {}
