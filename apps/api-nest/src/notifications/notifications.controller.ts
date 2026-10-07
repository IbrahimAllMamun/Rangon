import { Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/authentication';
import { lookupParam } from '../catalog/admin/catalog-admin.controller';
import { absoluteUri } from '../common/http';
import { Params, QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { requestData } from '../http/request-body';
import { NotificationsService } from './notifications.service';

/**
 * `NotificationViewSet`, routed by a `DefaultRouter` of its own under
 * `notifications/`: the list, the two list-level actions, then a notice by
 * its key. `IsAuthenticated` alone: anyone signed in reads their own.
 */
@Controller('api/v1')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('notifications/')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.notifications.list(
      request.user as RequestUser,
      query,
      absoluteUri(request, this.env),
    );
  }

  @Get('notifications/count/')
  count(@Req() request: FastifyRequest) {
    return this.notifications.unread(request.user as RequestUser);
  }

  @Post('notifications/mark-read/')
  @HttpCode(200)
  markRead(@Req() request: FastifyRequest) {
    return this.notifications.markRead(request.user as RequestUser, requestData(request));
  }

  @Get('notifications/:pk/')
  retrieve(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.notifications.retrieve(request.user as RequestUser, lookupParam(pk), query);
  }
}
