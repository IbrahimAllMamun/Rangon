import { Module } from '@nestjs/common';

import { AccountsService } from './accounts.service';
import { CashBookService } from './cash-book.service';
import {
  AccountsController,
  AccountTransactionsController,
  AccountTransfersController,
} from './finance.controller';

/** The back office's money: `finance.api.views` (phase 6). */
@Module({
  controllers: [AccountsController, AccountTransactionsController, AccountTransfersController],
  providers: [AccountsService, CashBookService],
  exports: [CashBookService],
})
export class FinanceModule {}
