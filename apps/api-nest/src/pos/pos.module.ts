import { Module } from '@nestjs/common';

import { CatalogAdminModule } from '../catalog/admin/catalog-admin.module';
import { InventoryModule } from '../inventory/inventory.module';
import { HoldsService } from './holds.service';
import {
  HeldSalesController,
  PosLookupController,
  PosProductsController,
  PosSessionController,
} from './pos.controller';
import { PosReadsService } from './pos-reads.service';

/** The counter: `orders.api.pos_views` (phase 5). */
@Module({
  imports: [InventoryModule, CatalogAdminModule],
  controllers: [
    PosSessionController,
    PosLookupController,
    PosProductsController,
    HeldSalesController,
  ],
  providers: [PosReadsService, HoldsService],
})
export class PosModule {}
