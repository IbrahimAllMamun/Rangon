import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { CatalogAdminModule } from '../catalog/admin/catalog-admin.module';
import { CheckoutModule } from '../checkout/checkout.module';
import { InventoryModule } from '../inventory/inventory.module';
import { HoldsService } from './holds.service';
import {
  HeldSalesController,
  PosElevateController,
  PosLookupController,
  PosProductsController,
  PosQuoteController,
  PosSessionController,
} from './pos.controller';
import { PosCounterService } from './pos-counter.service';
import { PosReadsService } from './pos-reads.service';
import { SalePricing } from './sale-pricing.service';

/** The counter: `orders.api.pos_views` (phase 5). */
@Module({
  imports: [AccountsModule, InventoryModule, CatalogAdminModule, CheckoutModule],
  controllers: [
    PosSessionController,
    PosLookupController,
    PosProductsController,
    PosQuoteController,
    PosElevateController,
    HeldSalesController,
  ],
  providers: [PosReadsService, HoldsService, SalePricing, PosCounterService],
})
export class PosModule {}
