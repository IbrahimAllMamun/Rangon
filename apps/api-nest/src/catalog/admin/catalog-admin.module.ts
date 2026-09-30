import { Module } from '@nestjs/common';

import { BrandsService } from './brands.service';
import { BrandsController, CategoriesController } from './catalog-admin.controller';
import { CategoriesService } from './categories.service';

/** The catalogue's staff endpoints: `catalog/api/views.py`. */
@Module({
  controllers: [BrandsController, CategoriesController],
  providers: [BrandsService, CategoriesService],
})
export class CatalogAdminModule {}
