import { Module } from '@nestjs/common';

import {
  SitePagesController,
  SiteSettingsController,
  SocialLinksController,
} from './content-admin.controller';
import { PagesAdminService } from './pages-admin.service';
import { SiteAdminService } from './site-admin.service';

/** The storefront content admin: `content.api.views` (phase 4 part 5). */
@Module({
  controllers: [SiteSettingsController, SocialLinksController, SitePagesController],
  providers: [SiteAdminService, PagesAdminService],
})
export class ContentAdminModule {}
