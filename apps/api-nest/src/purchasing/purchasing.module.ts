import { Module } from '@nestjs/common';

import { CatalogAdminModule } from '../catalog/admin/catalog-admin.module';
import { FinanceModule } from '../finance/finance.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchaseDocuments } from './purchase-documents';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  PurchaseOrdersController,
  SupplierPaymentsController,
  SupplierProductsController,
  SuppliersController,
} from './purchasing.controller';
import { SupplierPaymentsService } from './supplier-payments.service';
import { SupplierProductsService } from './supplier-products.service';
import { SuppliersService } from './suppliers.service';

/** Buying: `purchasing.api.views` (phase 6). */
@Module({
  imports: [CatalogAdminModule, InventoryModule, FinanceModule],
  controllers: [
    SuppliersController,
    SupplierProductsController,
    PurchaseOrdersController,
    SupplierPaymentsController,
  ],
  providers: [
    SuppliersService,
    SupplierProductsService,
    PurchaseDocuments,
    PurchaseOrdersService,
    SupplierPaymentsService,
  ],
  exports: [PurchaseOrdersService],
})
export class PurchasingModule {}
