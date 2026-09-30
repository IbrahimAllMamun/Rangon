import { Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AllowAny, RequestUser, SkipAuthentication } from '../auth/authentication';
import { OnlyScopedThrottle, SkipThrottle, ThrottleScope } from '../auth/throttle';
import { auditContext } from '../common/audit';
import { ENV, Env } from '../config/env';
import { requestData } from '../http/request-body';
import { AuthService, ManualResponse } from './auth.service';

/** `accounts/api/urls.py`: `/api/v1/auth/...`. */
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('login/')
  @AllowAny()
  @ThrottleScope('auth')
  async login(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const context = auditContext(request, this.env);
    return this.answer(reply, await this.auth.login(requestData(request), context), 200);
  }

  @Post('refresh/')
  @AllowAny()
  @ThrottleScope('auth')
  async refresh(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.answer(reply, await this.auth.refresh(requestData(request)), 200);
  }

  /**
   * No authentication and no throttle, deliberately (`LogoutView`): holding
   * the refresh token is the credential, and a 429 would leave it alive.
   */
  @Post('logout/')
  @SkipAuthentication()
  @SkipThrottle()
  @HttpCode(204)
  async logout(@Req() request: FastifyRequest): Promise<void> {
    await this.auth.logout(requestData(request), auditContext(request, this.env));
  }

  @Get('me/')
  async me(@Req() request: FastifyRequest) {
    return this.auth.whoami((request.user as RequestUser).id);
  }

  @Post('register/')
  @AllowAny()
  @ThrottleScope('auth')
  @HttpCode(201)
  async register(@Req() request: FastifyRequest) {
    return this.auth.register(requestData(request));
  }

  /** Throttled on the `auth` scope alone: this is a password check (D87). */
  @Post('password/change/')
  @OnlyScopedThrottle('auth')
  @HttpCode(200)
  async changePassword(@Req() request: FastifyRequest) {
    const user = request.user as RequestUser;
    return this.auth.changePassword(user.id, requestData(request), auditContext(request, this.env));
  }

  /** A view's own answer, or one it wrote by hand with its own status. */
  private answer<T>(reply: FastifyReply, result: ManualResponse | T, status: number) {
    if (result instanceof ManualResponse) {
      void reply.status(result.status);
      return result.body;
    }
    void reply.status(status);
    return result;
  }
}
