import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrderWritesService } from '../orders/order-writes.service';
import { CartService } from './cart.service';
import { CheckoutService } from './checkout.service';
import { CouponsService } from './coupons.service';
import { NoticesService } from './notices.service';

/** Cart pricing, coupons and checkout: `orders.services.checkout` and friends. */
@Module({
  imports: [AccountsModule, InventoryModule],
  providers: [CartService, CouponsService, CheckoutService, NoticesService, OrderWritesService],
  exports: [CartService, CouponsService, CheckoutService, NoticesService],
})
export class CheckoutModule {}
