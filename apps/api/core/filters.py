"""The filter backends every list uses."""

from __future__ import annotations

from typing import Any

from rest_framework import filters

from core.ordering import unique_last


class OrderingFilter(filters.OrderingFilter):
    """DRF's `?ordering=`, and then the primary key.

    Whatever a list ends up ordered by -- what was asked for, the view's own
    `ordering`, the model's -- rows it does not tell apart come back in one
    order rather than as they lie in the table (D245, `core.ordering`).
    """

    def filter_queryset(self, request: Any, queryset: Any, view: Any) -> Any:
        return unique_last(super().filter_queryset(request, queryset, view))
