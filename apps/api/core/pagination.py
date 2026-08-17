from __future__ import annotations

from rest_framework.pagination import PageNumberPagination


class StandardPagination(PageNumberPagination):
    page_size = 25
    page_size_query_param = "page_size"
    max_page_size = 100


class LargePagination(StandardPagination):
    """For admin exports and pickers where 25 rows is pointless."""

    page_size = 100
    max_page_size = 500
