import { Module } from '@nestjs/common';

import { CouponsAdminService } from './coupons-admin.service';
import { CouponsController } from './coupons.controller';

/** The back office's coupons: `promotions.api.views` (phase 6). */
@Module({
  controllers: [CouponsController],
  providers: [CouponsAdminService],
})
export class PromotionsModule {}
