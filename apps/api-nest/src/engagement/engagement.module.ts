import { Module } from '@nestjs/common';

import { ReviewModerationController } from './review-moderation.controller';
import { ReviewModerationService } from './review-moderation.service';

/**
 * Phase 6 part 9: review moderation, `/reviews/` in the back office. What a
 * shopper writes and reads is `shop`'s.
 */
@Module({
  controllers: [ReviewModerationController],
  providers: [ReviewModerationService],
})
export class EngagementModule {}
