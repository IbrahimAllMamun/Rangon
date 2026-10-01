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
import { ProductImagesController } from './product-images.controller';
import { ProductImagesService } from './product-images.service';
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
    ProductImagesController,
  ],
  providers: [
    BrandsService,
    CategoriesService,
    AttributesService,
    SizeChartsService,
    CataloguePayloads,
    ProductsService,
    VariantsService,
    ProductImagesService,
  ],
})
export class CatalogAdminModule {}
