import { Module } from '@nestjs/common';

import { LeadsAdminService } from '../orders/leads-admin.service';
import { StaffOrders } from '../orders/staff-order.service';
import { AddressesService } from './addresses.service';
import { CustomersAdminService } from './customers-admin.service';
import { AbandonedCheckoutsController, CustomersController } from './customers.controller';

/** The back office's customers and its call-back list (phase 6). */
@Module({
  controllers: [CustomersController, AbandonedCheckoutsController],
  providers: [CustomersAdminService, AddressesService, StaffOrders, LeadsAdminService],
})
export class CustomersModule {}
