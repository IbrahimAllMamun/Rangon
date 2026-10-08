import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, DiscoveryModule } from '@nestjs/core';

import { AccountsModule } from './accounts/accounts.module';
import { Authenticator, AuthGuard } from './auth/authentication';
import { RolePermissions } from './auth/permissions';
import { ThrottleGuard, Throttles } from './auth/throttle';
import { ViewRegistry } from './auth/view-registry';
import { EnvelopeFilter } from './common/envelope.filter';
import { ENV, Env } from './config/env';
import { Database } from './database/database.service';
import { HealthController } from './health/health.controller';
import { CeleryService } from './jobs/celery.service';
import { JobWorkerModule } from './jobs/job-worker.module';
import { Jobs } from './jobs/jobs.service';
import { PgBossTransport } from './jobs/pg-boss.service';
import { Revalidation } from './jobs/revalidation';
import { RouteRegistry } from './http/routes';
import { ContentAdminModule } from './content/admin/content-admin.module';
import { CustomersModule } from './customers/customers.module';
import { InventoryAdminModule } from './inventory/admin/inventory-admin.module';
import { FinanceModule } from './finance/finance.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PosModule } from './pos/pos.module';
import { PromotionsModule } from './promotions/promotions.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { RedisService } from './redis/redis.service';
import { ReportsModule } from './reports/reports.module';
import { CatalogAdminModule } from './catalog/admin/catalog-admin.module';
import { ShippingModule } from './shipping/shipping.module';
import { EngagementModule } from './engagement/engagement.module';
import { ShopModule } from './shop/shop.module';

@Global()
@Module({})
export class CoreModule {
  static forRoot(env: Env, routes: RouteRegistry) {
    return {
      module: CoreModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: ENV, useValue: env },
        { provide: RouteRegistry, useValue: routes },
        Database,
        RedisService,
        Authenticator,
        RolePermissions,
        CeleryService,
        PgBossTransport,
        Jobs,
        Revalidation,
        Throttles,
        ViewRegistry,
      ],
      exports: [
        ENV,
        RouteRegistry,
        Database,
        RedisService,
        Authenticator,
        RolePermissions,
        CeleryService,
        PgBossTransport,
        Jobs,
        Revalidation,
        Throttles,
        ViewRegistry,
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
        PosModule,
        FinanceModule,
        PurchasingModule,
        CustomersModule,
        PromotionsModule,
        ShippingModule,
        EngagementModule,
        NotificationsModule,
        ReportsModule,
        JobWorkerModule,
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
