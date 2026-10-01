import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AccountsModule } from './accounts/accounts.module';
import { Authenticator, AuthGuard } from './auth/authentication';
import { RolePermissions } from './auth/permissions';
import { ThrottleGuard } from './auth/throttle';
import { EnvelopeFilter } from './common/envelope.filter';
import { ENV, Env } from './config/env';
import { Database } from './database/database.service';
import { HealthController } from './health/health.controller';
import { CeleryService } from './jobs/celery.service';
import { Revalidation } from './jobs/revalidation';
import { RouteRegistry } from './http/routes';
import { ContentAdminModule } from './content/admin/content-admin.module';
import { InventoryAdminModule } from './inventory/admin/inventory-admin.module';
import { RedisService } from './redis/redis.service';
import { CatalogAdminModule } from './catalog/admin/catalog-admin.module';
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
        RolePermissions,
        CeleryService,
        Revalidation,
      ],
      exports: [
        ENV,
        RouteRegistry,
        Database,
        RedisService,
        Authenticator,
        RolePermissions,
        CeleryService,
        Revalidation,
      ],
    };
  }
}

@Module({})
export class AppModule {
  static forRoot(env: Env, routes: RouteRegistry) {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(env, routes),
        AccountsModule,
        ShopModule,
        CatalogAdminModule,
        InventoryAdminModule,
        ContentAdminModule,
      ],
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
