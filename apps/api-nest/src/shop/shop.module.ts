import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ContentModule } from '../content/content.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ShopCatalogController } from './shop-catalog.controller';
import { ShopContentController } from './shop-content.controller';
import { ShopFeedController } from './shop-feed.controller';
import { PageCache } from '../common/page-cache';
import { StorefrontProducts } from './storefront-products.service';

@Module({
  imports: [AccountsModule, CatalogModule, ContentModule, InventoryModule],
  controllers: [ShopCatalogController, ShopContentController, ShopFeedController],
  providers: [StorefrontProducts, PageCache],
  exports: [StorefrontProducts],
})
export class ShopModule {}
