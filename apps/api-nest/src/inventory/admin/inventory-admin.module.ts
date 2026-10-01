import { Module } from '@nestjs/common';

import { CatalogAdminModule } from '../../catalog/admin/catalog-admin.module';
import { InventoryModule } from '../inventory.module';
import { InventoryAdminController, LedgerController } from './inventory-admin.controller';
import { InventoryAdminService } from './inventory-admin.service';
import { LedgerEntries } from './ledger-entries.service';

/** The inventory admin: `inventory.api.views` (phase 4). */
@Module({
  imports: [InventoryModule, CatalogAdminModule],
  controllers: [InventoryAdminController, LedgerController],
  providers: [InventoryAdminService, LedgerEntries],
})
export class InventoryAdminModule {}
