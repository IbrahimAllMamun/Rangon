import { Module } from '@nestjs/common';

import { CheckoutModule } from '../checkout/checkout.module';
import { InventoryAdminModule } from '../inventory/admin/inventory-admin.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrderLifecycle } from '../orders/order-lifecycle.service';
import { OrderWritesService } from '../orders/order-writes.service';
import { JobHandlers } from './job-handlers.service';
import { JobWorker } from './job-worker.service';
import { Mailer } from './mailer.service';
import { SmsService } from './sms.service';

/**
 * Phase 7 part 4: the background jobs and what runs them (ADR-0016). The
 * queue itself -- `Jobs`, the transports -- is in the core module, because
 * every write path hands work to it.
 */
@Module({
  imports: [InventoryModule, CheckoutModule, InventoryAdminModule],
  providers: [JobHandlers, JobWorker, Mailer, SmsService, OrderLifecycle, OrderWritesService],
  exports: [JobWorker, SmsService],
})
export class JobWorkerModule {}
