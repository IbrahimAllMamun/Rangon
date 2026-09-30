import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CheckoutModule } from '../checkout/checkout.module';
import { ContentModule } from '../content/content.module';
import { InventoryModule } from '../inventory/inventory.module';
import { AddressesService } from '../customers/addresses.service';
import { ReviewsService } from '../engagement/reviews.service';
import { CustomerOrdersService } from '../orders/customer-orders.service';
import { ShopAccountController } from './shop-account.controller';
import { ShopCartController } from './shop-cart.controller';
import { ShopCatalogController } from './shop-catalog.controller';
import { ShopContentController } from './shop-content.controller';
import { ShopFeedController } from './shop-feed.controller';
import { ShopReviewsController } from './shop-reviews.controller';
import { PageCache } from '../common/page-cache';
import { StorefrontProducts } from './storefront-products.service';

@Module({
  imports: [AccountsModule, CatalogModule, CheckoutModule, ContentModule, InventoryModule],
  controllers: [
    ShopCatalogController,
    ShopContentController,
    ShopFeedController,
    ShopAccountController,
    ShopCartController,
    ShopReviewsController,
  ],
  providers: [
    StorefrontProducts,
    PageCache,
    CustomerOrdersService,
    AddressesService,
    ReviewsService,
  ],
  exports: [StorefrontProducts],
})
export class ShopModule {}
