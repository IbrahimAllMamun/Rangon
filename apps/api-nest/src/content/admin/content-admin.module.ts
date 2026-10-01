import { Module } from '@nestjs/common';

import { SiteSettingsController, SocialLinksController } from './content-admin.controller';
import { SiteAdminService } from './site-admin.service';

/** The storefront content admin: `content.api.views` (phase 4 part 5). */
@Module({
  controllers: [SiteSettingsController, SocialLinksController],
  providers: [SiteAdminService],
})
export class ContentAdminModule {}
