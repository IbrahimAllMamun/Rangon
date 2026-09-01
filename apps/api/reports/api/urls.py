from django.urls import path

from reports.api.views import (
    BusinessSummaryView,
    DashboardView,
    ExpenseReportView,
    InventoryMovementView,
    InventoryValuationView,
    ProductPerformanceView,
    ProfitReportView,
    PurchaseReportView,
    ReturnsReportView,
    SalesReportView,
)

urlpatterns = [
    path("dashboard/", DashboardView.as_view(), name="report-dashboard"),
    path("sales/", SalesReportView.as_view(), name="report-sales"),
    path("products/performance/", ProductPerformanceView.as_view(), name="report-products"),
    path("inventory/valuation/", InventoryValuationView.as_view(), name="report-inventory"),
    path("inventory/movement/", InventoryMovementView.as_view(), name="report-movement"),
    path("purchases/", PurchaseReportView.as_view(), name="report-purchases"),
    path("returns/", ReturnsReportView.as_view(), name="report-returns"),
    path("profit/", ProfitReportView.as_view(), name="report-profit"),
    path("expenses/", ExpenseReportView.as_view(), name="report-expenses"),
    path("business-summary/", BusinessSummaryView.as_view(), name="report-business-summary"),
]
