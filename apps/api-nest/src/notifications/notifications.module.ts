import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Phase 7 part 2: the notices a signed-in user reads and marks read. Writing
 * them is `checkout`'s (`NoticesService`), sending them the worker's.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
