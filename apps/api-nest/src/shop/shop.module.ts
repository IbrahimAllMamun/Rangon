import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ShopCatalogController } from './shop-catalog.controller';
import { StorefrontProducts } from './storefront-products.service';

@Module({
  imports: [AccountsModule, CatalogModule, InventoryModule],
  controllers: [ShopCatalogController],
  providers: [StorefrontProducts],
  exports: [StorefrontProducts],
})
export class ShopModule {}
