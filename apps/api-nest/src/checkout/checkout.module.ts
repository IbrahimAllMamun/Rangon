import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CartService } from './cart.service';
import { CouponsService } from './coupons.service';

/** Cart pricing, coupons and (next) checkout: `orders.services.checkout` and friends. */
@Module({
  imports: [AccountsModule, InventoryModule],
  providers: [CartService, CouponsService],
  exports: [CartService, CouponsService],
})
export class CheckoutModule {}
