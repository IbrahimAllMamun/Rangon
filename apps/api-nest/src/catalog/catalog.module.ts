import { Module } from '@nestjs/common';

import { DiscoveryService } from './discovery.service';
import { MerchandisingService } from './merchandising.service';
import { ProductDetailsService } from './product-details.service';
import { ProductPayloadService } from './product-payload.service';
import { ProductSearchService } from './product-search';
import { SearchLogService } from './search-log.service';

const services = [
  DiscoveryService,
  MerchandisingService,
  ProductDetailsService,
  ProductPayloadService,
  ProductSearchService,
  SearchLogService,
];

@Module({ providers: services, exports: services })
export class CatalogModule {}
