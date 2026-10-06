import { Module } from '@nestjs/common';

import { CheckoutModule } from '../checkout/checkout.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrderLifecycle } from '../orders/order-lifecycle.service';
import { OrderWritesService } from '../orders/order-writes.service';
import { ShipmentsService } from './shipments.service';
import { ShippingSettingsService } from './shipping-settings.service';
import {
  CouriersController,
  ShipmentsController,
  ShippingMethodsController,
  ShippingZonesController,
} from './shipping.controller';

/** Delivery: `shipping.api.views` (phase 6). */
@Module({
  imports: [InventoryModule, CheckoutModule],
  controllers: [
    ShippingZonesController,
    ShippingMethodsController,
    CouriersController,
    ShipmentsController,
  ],
  providers: [ShippingSettingsService, ShipmentsService, OrderLifecycle, OrderWritesService],
})
export class ShippingModule {}
