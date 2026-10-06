import { Module } from '@nestjs/common';

import { AccountsService } from './accounts.service';
import { CashBookService } from './cash-book.service';
import { ExpensesService } from './expenses.service';
import {
  AccountsController,
  AccountTransactionsController,
  AccountTransfersController,
  ExpenseCategoriesController,
  ExpensesController,
  PartyLedgerController,
} from './finance.controller';
import { PartyLedgerService } from './party-ledger.service';

/** The back office's money: `finance.api.views` (phase 6). */
@Module({
  controllers: [
    AccountsController,
    AccountTransactionsController,
    AccountTransfersController,
    ExpenseCategoriesController,
    ExpensesController,
    PartyLedgerController,
  ],
  providers: [AccountsService, CashBookService, ExpensesService, PartyLedgerService],
  exports: [CashBookService],
})
export class FinanceModule {}
