import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { CatalogAdminModule } from '../catalog/admin/catalog-admin.module';
import { CheckoutModule } from '../checkout/checkout.module';
import { CashBookService } from '../finance/cash-book.service';
import { InventoryModule } from '../inventory/inventory.module';
import { OrderPayments } from '../orders/order-payments.service';
import { OrderWritesService } from '../orders/order-writes.service';
import { PosReturnsController, ReturnsController } from '../orders/returns.controller';
import { ReturnsService } from '../orders/returns.service';
import { StaffOrders } from '../orders/staff-order.service';
import { HoldsService } from './holds.service';
import {
  HeldSalesController,
  PosElevateController,
  PosLookupController,
  PosProductsController,
  PosQuoteController,
  PosSalesController,
  PosSessionController,
} from './pos.controller';
import { PosCounterService } from './pos-counter.service';
import { PosReadsService } from './pos-reads.service';
import { PosSales } from './pos-sales.service';
import { SalePricing } from './sale-pricing.service';

/** The counter, and the returns it shares with the back office: `orders.api.pos_views`, `ReturnRequestViewSet` (phase 5). */
@Module({
  imports: [AccountsModule, InventoryModule, CatalogAdminModule, CheckoutModule],
  controllers: [
    PosSessionController,
    PosLookupController,
    PosProductsController,
    PosQuoteController,
    PosElevateController,
    PosSalesController,
    HeldSalesController,
    PosReturnsController,
    ReturnsController,
  ],
  providers: [
    PosReadsService,
    HoldsService,
    SalePricing,
    PosCounterService,
    PosSales,
    StaffOrders,
    OrderPayments,
    OrderWritesService,
    CashBookService,
    ReturnsService,
  ],
})
export class PosModule {}
