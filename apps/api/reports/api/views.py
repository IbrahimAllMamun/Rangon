from __future__ import annotations

import csv
from collections.abc import Callable
from decimal import Decimal
from typing import Any

from django.http import HttpResponse
from rest_framework.permissions import IsAuthenticated
from rest_framework.renderers import BaseRenderer, JSONRenderer
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import Branch
from accounts.permissions import RolePermission
from reports import services as report_services
from reports.services import DateRange


def _json_safe(value: Any) -> Any:
    """Decimals out as strings, never as JSON floats.

    Every report here answers with a plain selector dict rather than a
    serializer, so DRF's ``COERCE_DECIMAL_TO_STRING`` -- the setting that keeps
    money out of floats everywhere else -- never applies to it.  The result was
    ``"revenue": 236290.0`` on every dict-shaped report: a float carrying money
    across the API boundary, which CLAUDE.md §4 forbids, and which silently
    drops the two-decimal contract the frontend types already assume
    (`revenue: string`).

    This is [D20](../../../docs/roadmap.md) again.  Fixing it once here covers
    every report rather than one endpoint at a time.
    """
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


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


class CSVRenderer(BaseRenderer):
    """Declares that these views answer to `?format=csv`.

    It never renders anything: every CSV path returns a plain ``HttpResponse``
    built by ``_csv_response``, which Django returns untouched.  What this
    class is for is content negotiation -- without a renderer advertising the
    `csv` format, DRF resolves `?format=csv` against nothing and answers 404,
    which is exactly what the export links on /admin/reports were getting.
    """

    media_type = "text/csv"
    format = "csv"
    charset = "utf-8"

    def render(self, data: Any, accepted_media_type: Any = None, renderer_context: Any = None):
        return data


class BaseReportView(APIView):
    permission_classes = [IsAuthenticated, RolePermission]
    renderer_classes = [JSONRenderer, CSVRenderer]
    required_permissions = ["reports.view"]
    report: Callable[..., Any]
    filename = "report.csv"
    needs_range = True

    @staticmethod
    def csv_rows(data: Any) -> list[dict[str, Any]]:
        """Which rows a CSV export writes.

        A list report exports itself; a dict report has to say which part is
        tabular.  Reports whose shape is neither override this -- returning
        nothing here is how the export silently produced an empty file.
        """
        if isinstance(data, list):
            return data
        return data.get("daily", [])

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
            return _csv_response(type(self).csv_rows(data), self.filename)

        payload = data if isinstance(data, dict) else {"results": data}
        return Response(_json_safe(payload))


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


class ExpenseReportView(BaseReportView):
    required_permissions = ["reports.financial"]
    report = staticmethod(report_services.expense_report)
    filename = "expenses.csv"


class BusinessSummaryView(BaseReportView):
    """Phase 38 -- revenue through to net profit."""

    required_permissions = ["reports.financial"]
    report = staticmethod(report_services.business_summary)
    filename = "business-summary.csv"

    @staticmethod
    def csv_rows(data: Any) -> list[dict[str, Any]]:
        """The statement itself, one row per line, in reading order.

        The default hook would look for `daily` here, find nothing and write an
        empty file -- which is how the CSV export shipped broken once already
        (D19).  An owner pasting this into a spreadsheet wants the statement,
        not the raw nesting.
        """
        revenue = data["revenue"]
        cost = data["cost_of_goods"]
        rows = [
            {"line": "Revenue (goods, net of VAT)", "amount": revenue["goods"]},
            {"line": "Less refunds", "amount": -revenue["refunds"]},
            {"line": "Net revenue", "amount": revenue["net"]},
            {"line": "Cost of goods sold", "amount": -cost["sold"]},
            {
                "line": "Cost recovered from restocked returns",
                "amount": cost["recovered_from_returns"],
            },
            {"line": "Gross profit", "amount": data["gross_profit"]},
        ]
        rows += [
            {"line": f"Expense — {row['category']}", "amount": -row["total"]}
            for row in data["expenses"]["by_category"]
        ]
        rows += [
            {"line": "Total expenses", "amount": -data["expenses"]["total"]},
            {"line": "Net profit", "amount": data["net_profit"]},
            {"line": "VAT collected (held, not income)", "amount": revenue["vat_collected"]},
        ]
        return rows
