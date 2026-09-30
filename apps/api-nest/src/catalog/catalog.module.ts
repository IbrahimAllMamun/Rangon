import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { InventoryModule } from '../inventory/inventory.module';
import { DiscoveryService } from './discovery.service';
import { FeedService } from './feed.service';
import { MerchandisingService } from './merchandising.service';
import { ProductDetailsService } from './product-details.service';
import { ProductPayloadService } from './product-payload.service';
import { ProductSearchService } from './product-search';
import { SearchLogService } from './search-log.service';

const services = [
  DiscoveryService,
  FeedService,
  MerchandisingService,
  ProductDetailsService,
  ProductPayloadService,
  ProductSearchService,
  SearchLogService,
];

@Module({ imports: [AccountsModule, InventoryModule], providers: services, exports: services })
export class CatalogModule {}
