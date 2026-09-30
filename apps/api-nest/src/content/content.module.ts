import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ContentService } from './content.service';

@Module({ imports: [CatalogModule], providers: [ContentService], exports: [ContentService] })
export class ContentModule {}
