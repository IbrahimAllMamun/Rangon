import { Module } from '@nestjs/common';

import { CatalogAdminModule } from '../../catalog/admin/catalog-admin.module';
import { InventoryModule } from '../inventory.module';
import { CountsService } from './counts.service';
import {
  InventoryAdminController,
  LedgerController,
  StockCountsController,
  StockTransfersController,
} from './inventory-admin.controller';
import { InventoryAdminService } from './inventory-admin.service';
import { LedgerEntries } from './ledger-entries.service';
import { TransfersService } from './transfers.service';

/** The inventory admin: `inventory.api.views` (phase 4). */
@Module({
  imports: [InventoryModule, CatalogAdminModule],
  controllers: [
    InventoryAdminController,
    LedgerController,
    StockTransfersController,
    StockCountsController,
  ],
  providers: [InventoryAdminService, LedgerEntries, TransfersService, CountsService],
})
export class InventoryAdminModule {}
