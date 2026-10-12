from __future__ import annotations

from typing import Any

from rest_framework.pagination import PageNumberPagination

from core.ordering import unique_last


class StandardPagination(PageNumberPagination):
    page_size = 25
    page_size_query_param = "page_size"
    max_page_size = 100

    def paginate_queryset(self, queryset: Any, request: Any, view: Any = None) -> Any:
        # A page is a cut through an order, so the order has to be one order:
        # ended by the primary key, for a view that reaches here without the
        # ordering filter having run (D245, `core.ordering`).
        return super().paginate_queryset(unique_last(queryset), request, view)


class LargePagination(StandardPagination):
    """For admin exports and pickers where 25 rows is pointless."""

    page_size = 100
    max_page_size = 500
