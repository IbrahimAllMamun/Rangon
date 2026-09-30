import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InventoryLedgerService } from '../inventory/ledger.service';
import { CeleryService } from '../jobs/celery.service';
import { OrderWritesService } from '../orders/order-writes.service';
import { CartService } from './cart.service';
import { CheckoutService } from './checkout.service';
import { CouponsService } from './coupons.service';
import { NoticesService } from './notices.service';

/** Cart pricing, coupons and checkout: `orders.services.checkout` and friends. */
@Module({
  imports: [AccountsModule, InventoryModule],
  providers: [
    CartService,
    CouponsService,
    CheckoutService,
    NoticesService,
    InventoryLedgerService,
    OrderWritesService,
    CeleryService,
  ],
  exports: [CartService, CouponsService, CheckoutService, NoticesService, CeleryService],
})
export class CheckoutModule {}
