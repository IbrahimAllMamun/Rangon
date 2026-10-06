import { Module } from '@nestjs/common';

import { CatalogAdminModule } from '../catalog/admin/catalog-admin.module';
import { SupplierProductsController, SuppliersController } from './purchasing.controller';
import { SupplierProductsService } from './supplier-products.service';
import { SuppliersService } from './suppliers.service';

/** Buying: `purchasing.api.views` (phase 6). */
@Module({
  imports: [CatalogAdminModule],
  controllers: [SuppliersController, SupplierProductsController],
  providers: [SuppliersService, SupplierProductsService],
})
export class PurchasingModule {}
