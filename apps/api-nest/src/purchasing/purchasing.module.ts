import { Module } from '@nestjs/common';

import { CatalogAdminModule } from '../catalog/admin/catalog-admin.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchaseDocuments } from './purchase-documents';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  PurchaseOrdersController,
  SupplierProductsController,
  SuppliersController,
} from './purchasing.controller';
import { SupplierProductsService } from './supplier-products.service';
import { SuppliersService } from './suppliers.service';

/** Buying: `purchasing.api.views` (phase 6). */
@Module({
  imports: [CatalogAdminModule, InventoryModule],
  controllers: [SuppliersController, SupplierProductsController, PurchaseOrdersController],
  providers: [SuppliersService, SupplierProductsService, PurchaseDocuments, PurchaseOrdersService],
  exports: [PurchaseOrdersService],
})
export class PurchasingModule {}
