import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AccountsModule } from './accounts/accounts.module';
import { Authenticator, AuthGuard } from './auth/authentication';
import { ThrottleGuard } from './auth/throttle';
import { EnvelopeFilter } from './common/envelope.filter';
import { ENV, Env } from './config/env';
import { Database } from './database/database.service';
import { HealthController } from './health/health.controller';
import { RouteRegistry } from './http/routes';
import { RedisService } from './redis/redis.service';
import { ShopModule } from './shop/shop.module';

@Global()
@Module({})
export class CoreModule {
  static forRoot(env: Env, routes: RouteRegistry) {
    return {
      module: CoreModule,
      providers: [
        { provide: ENV, useValue: env },
        { provide: RouteRegistry, useValue: routes },
        Database,
        RedisService,
        Authenticator,
      ],
      exports: [ENV, RouteRegistry, Database, RedisService, Authenticator],
    };
  }
}

@Module({})
export class AppModule {
  static forRoot(env: Env, routes: RouteRegistry) {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot(env, routes), AccountsModule, ShopModule],
      controllers: [HealthController],
      providers: [
        // In DRF's order: authenticate and check permissions, then throttle.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: ThrottleGuard },
        { provide: APP_FILTER, useClass: EnvelopeFilter },
      ],
    };
  }
}
