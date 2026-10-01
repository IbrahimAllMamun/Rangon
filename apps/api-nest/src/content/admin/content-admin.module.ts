import { Module } from '@nestjs/common';

import { CatalogAdminModule } from '../../catalog/admin/catalog-admin.module';
import { BannersAdminService } from './banners-admin.service';
import { CarouselAdminService } from './carousel-admin.service';
import {
  BannersController,
  HomeCarouselController,
  NavigationItemsController,
  SitePagesController,
  SiteSettingsController,
  SocialLinksController,
} from './content-admin.controller';
import { NavigationAdminService } from './navigation-admin.service';
import { PagesAdminService } from './pages-admin.service';
import { SiteAdminService } from './site-admin.service';

/** The storefront content admin: `content.api.views` (phase 4 part 5). */
@Module({
  imports: [CatalogAdminModule],
  controllers: [
    SiteSettingsController,
    SocialLinksController,
    SitePagesController,
    NavigationItemsController,
    BannersController,
    HomeCarouselController,
  ],
  providers: [
    SiteAdminService,
    PagesAdminService,
    NavigationAdminService,
    BannersAdminService,
    CarouselAdminService,
  ],
})
export class ContentAdminModule {}
