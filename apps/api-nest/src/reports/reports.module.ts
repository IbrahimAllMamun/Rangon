import { Module } from '@nestjs/common';

import {
  BusinessSummaryReportController,
  DashboardReportController,
  ExpenseReportController,
  InventoryMovementReportController,
  InventoryValuationReportController,
  ProductPerformanceReportController,
  ProfitReportController,
  PurchaseReportController,
  ReturnsReportController,
  SalesReportController,
  VatReportController,
} from './reports.controller';
import { ReportsService } from './reports.service';

/** Phase 7 part 3: the reports, read-only, with their CSV exports. */
@Module({
  controllers: [
    DashboardReportController,
    SalesReportController,
    ProductPerformanceReportController,
    InventoryValuationReportController,
    InventoryMovementReportController,
    PurchaseReportController,
    ReturnsReportController,
    ProfitReportController,
    ExpenseReportController,
    BusinessSummaryReportController,
    VatReportController,
  ],
  providers: [ReportsService],
})
export class ReportsModule {}
