import { Module } from '@nestjs/common';

import { InventoryModule } from '../../inventory/inventory.module';

import {
  AttributesController,
  AttributeValuesController,
  SizeChartsController,
} from './attributes.controller';
import { AttributesService } from './attributes.service';
import { BrandsService } from './brands.service';
import { BrandsController, CategoriesController } from './catalog-admin.controller';
import { CataloguePayloads } from './catalogue-payloads';
import { CategoriesService } from './categories.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { VariantsController } from './variants.controller';
import { VariantsService } from './variants.service';
import { SizeChartsService } from './size-charts.service';

/** The catalogue's staff endpoints: `catalog/api/views.py`. */
@Module({
  imports: [InventoryModule],
  controllers: [
    BrandsController,
    CategoriesController,
    AttributesController,
    AttributeValuesController,
    SizeChartsController,
    ProductsController,
    VariantsController,
  ],
  providers: [
    BrandsService,
    CategoriesService,
    AttributesService,
    SizeChartsService,
    CataloguePayloads,
    ProductsService,
    VariantsService,
  ],
})
export class CatalogAdminModule {}
