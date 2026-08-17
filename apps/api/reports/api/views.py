from __future__ import annotations

import csv
from collections.abc import Callable
from typing import Any

from django.http import HttpResponse
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import Branch
from accounts.permissions import RolePermission
from reports import services as report_services
from reports.services import DateRange


def _branch_for(request: Request) -> Branch | None:
    """Which branch to report on: explicit, else the user's own if they are scoped."""
    branch_id = request.query_params.get("branch")
    if branch_id:
        return Branch.objects.filter(pk=branch_id).first()
    user = request.user
    if user.can_cross_branch or user.is_superuser:
        return None  # all branches
    return user.branch


def _csv_response(rows: list[dict[str, Any]], filename: str) -> HttpResponse:
    response = HttpResponse(content_type="text/csv")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    if not rows:
        response.write("")
        return response
    writer = csv.DictWriter(response, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)
    return response


class BaseReportView(APIView):
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = ["reports.view"]
    report: Callable[..., Any]
    filename = "report.csv"
    needs_range = True

    def get(self, request: Request) -> Response | HttpResponse:
        branch = _branch_for(request)
        kwargs: dict[str, Any] = {"branch": branch}
        if self.needs_range:
            kwargs["date_range"] = DateRange.from_params(request.query_params)

        data = type(self).report(**kwargs)

        if request.query_params.get("format") == "csv":
            if not request.user.has_perm_code("reports.export"):
                return Response(
                    {
                        "error": {
                            "code": "PERMISSION_DENIED",
                            "message": "You cannot export reports.",
                            "details": {},
                        }
                    },
                    status=403,
                )
            rows = data if isinstance(data, list) else data.get("daily", [])
            return _csv_response(rows, self.filename)

        return Response(data if isinstance(data, dict) else {"results": data})


class DashboardView(BaseReportView):
    report = staticmethod(report_services.dashboard)
    filename = "dashboard.csv"


class SalesReportView(BaseReportView):
    filename = "sales.csv"

    def get(self, request: Request) -> Response | HttpResponse:
        rows = report_services.sales_report(
            date_range=DateRange.from_params(request.query_params),
            branch=_branch_for(request),
            channel=request.query_params.get("channel", ""),
        )
        if request.query_params.get("format") == "csv":
            if not request.user.has_perm_code("reports.export"):
                return Response({"detail": "Export not permitted."}, status=403)
            return _csv_response(rows, self.filename)
        return Response({"results": rows})


class ProductPerformanceView(BaseReportView):
    report = staticmethod(report_services.product_performance)
    filename = "product-performance.csv"


class InventoryValuationView(BaseReportView):
    required_permissions = ["reports.financial"]
    report = staticmethod(report_services.inventory_report)
    filename = "inventory-valuation.csv"
    needs_range = False


class InventoryMovementView(BaseReportView):
    required_permissions = ["reports.financial"]
    report = staticmethod(report_services.inventory_movement)
    filename = "inventory-movement.csv"


class PurchaseReportView(BaseReportView):
    required_permissions = ["reports.financial"]
    report = staticmethod(report_services.purchase_report)
    filename = "purchases.csv"


class ReturnsReportView(BaseReportView):
    report = staticmethod(report_services.returns_report)
    filename = "returns.csv"


class ProfitReportView(BaseReportView):
    required_permissions = ["reports.financial"]
    report = staticmethod(report_services.profit_report)
    filename = "profit.csv"
