import { Module } from '@nestjs/common';

import { AvailabilityService } from './availability.service';
import { StockService } from './stock.service';

@Module({
  providers: [AvailabilityService, StockService],
  exports: [AvailabilityService, StockService],
})
export class InventoryModule {}
