import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ContentModule } from '../content/content.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ShopCatalogController } from './shop-catalog.controller';
import { ShopContentController } from './shop-content.controller';
import { StorefrontProducts } from './storefront-products.service';

@Module({
  imports: [AccountsModule, CatalogModule, ContentModule, InventoryModule],
  controllers: [ShopCatalogController, ShopContentController],
  providers: [StorefrontProducts],
  exports: [StorefrontProducts],
})
export class ShopModule {}
