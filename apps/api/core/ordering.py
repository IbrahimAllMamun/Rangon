"""One order for every list.

A list ordered by a column that ties -- `on_hand`, a price, a moment several
rows were made in -- leaves the tied rows to PostgreSQL, which returns them as
they lie in the table. That changes whenever one of them is updated, so a page
that ends inside the tie can show a row twice across two pages, or not at all
(D245). `unique_last` ends whatever a queryset is ordered by with its primary
key: the order asked for, and then one order among the rows it does not tell
apart.

`core.filters.OrderingFilter` applies it to every list that goes through the
filter backends, and `core.pagination.StandardPagination` to every page, so a
view needs to do nothing. A query that is not a plain list of model rows -- a
`values()` breakdown, a union, a slice -- names its own last key where it is
written.
"""

from __future__ import annotations

from typing import Any

from django.db.models import F, QuerySet
from django.db.models.expressions import OrderBy
from django.db.models.query import ModelIterable

PRIMARY_KEY = {"pk", "id"}


def _names(term: Any) -> str | None:
    """The field an ordering term sorts by, where it is a plain one."""
    if isinstance(term, str):
        return term.lstrip("-+")
    if isinstance(term, OrderBy):
        term = term.expression
    if isinstance(term, F):
        return term.name
    return None


def unique_last(queryset: Any) -> Any:
    """`queryset` ordered as it was, and by its primary key after that."""
    if not isinstance(queryset, QuerySet):
        return queryset
    query = queryset.query
    if query.is_sliced or query.combinator or query.distinct_fields:
        return queryset
    # `values()` rows have no primary key to order by, and where they are
    # grouped, naming one would change the groups.
    if not issubclass(queryset._iterable_class, ModelIterable):
        return queryset
    ordering = list(query.order_by)
    if not ordering and query.default_ordering:
        ordering = list(query.get_meta().ordering or [])
    primary = PRIMARY_KEY | {query.get_meta().pk.name}
    if any(_names(term) in primary for term in ordering):
        return queryset
    return queryset.order_by(*ordering, "pk")
