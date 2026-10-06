import { Module } from '@nestjs/common';

import { CashBookService } from '../finance/cash-book.service';
import { OrderPayments } from '../orders/order-payments.service';
import { OrderWritesService } from '../orders/order-writes.service';
import { PaymentsService } from './payments.service';
import { PaymentProviders } from './providers';

/** `orders.payments` and the webhook side of `orders.services.payments`. */
@Module({
  providers: [
    PaymentProviders,
    PaymentsService,
    CashBookService,
    OrderWritesService,
    OrderPayments,
  ],
  exports: [PaymentProviders, PaymentsService],
})
export class PaymentsModule {}
