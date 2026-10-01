import { Module } from '@nestjs/common';

import {
  AttributesController,
  AttributeValuesController,
  SizeChartsController,
} from './attributes.controller';
import { AttributesService } from './attributes.service';
import { BrandsService } from './brands.service';
import { BrandsController, CategoriesController } from './catalog-admin.controller';
import { CategoriesService } from './categories.service';
import { SizeChartsService } from './size-charts.service';

/** The catalogue's staff endpoints: `catalog/api/views.py`. */
@Module({
  controllers: [
    BrandsController,
    CategoriesController,
    AttributesController,
    AttributeValuesController,
    SizeChartsController,
  ],
  providers: [BrandsService, CategoriesService, AttributesService, SizeChartsService],
})
export class CatalogAdminModule {}
