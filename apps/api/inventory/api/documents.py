"""What a ledger row's reference points at, in words and as a screen to open.

Every service that moves stock writes a `reference_type` / `reference_id` pair
naming its cause. Read raw, that is `purchase_receipt` and a UUID, which tells
a storekeeper nothing. This turns it into the document a person would open --
an order, a return, a purchase order -- with the number printed on it.

A goods receipt and a supplier return have no screen of their own; both are
shown on their purchase order, so that is where they resolve to. References
with nothing to open (`manual`, `product_import`, `integrity_repair`) resolve
to nothing, and the row's reason says what happened instead.

One query per kind of document on the page, never one per row.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass
from typing import Any

from django.apps import apps


@dataclass(frozen=True)
class Document:
    #: Which admin screen shows it: `order`, `return`, `purchase_order`,
    #: `stock_count` or `stock_transfer`.
    kind: str
    id: str
    label: str

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


def _numbered(app: str, model: str, kind: str, suffix: str = "") -> Callable:
    def resolve(ids: set[str]) -> dict[str, Document]:
        rows = apps.get_model(app, model).objects.filter(pk__in=ids).values_list("pk", "number")
        return {str(pk): Document(kind, str(pk), f"{number}{suffix}") for pk, number in rows}

    return resolve


def _on_purchase_order(model: str) -> Callable:
    def resolve(ids: set[str]) -> dict[str, Document]:
        rows = (
            apps.get_model("purchasing", model)
            .objects.filter(pk__in=ids)
            .values_list("pk", "number", "purchase_order_id", "purchase_order__number")
        )
        return {
            str(pk): Document("purchase_order", str(order_id), f"{order_number} · {number}")
            for pk, number, order_id, order_number in rows
        }

    return resolve


_RESOLVERS: dict[str, Callable[[set[str]], dict[str, Document]]] = {
    "order": _numbered("orders", "Order", "order"),
    "order_void": _numbered("orders", "Order", "order", " (voided)"),
    "return": _numbered("orders", "ReturnRequest", "return"),
    "purchase_receipt": _on_purchase_order("PurchaseReceipt"),
    "purchase_return": _on_purchase_order("PurchaseReturn"),
    "stock_count": _numbered("inventory", "StockCount", "stock_count"),
    "stock_transfer": _numbered("inventory", "StockTransfer", "stock_transfer"),
}


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except (TypeError, ValueError):
        return False
    return True


def resolve(rows: Iterable[Any]) -> dict[tuple[str, str], Document]:
    """Map each row's `(reference_type, reference_id)` to its document, if it has one."""
    wanted: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        # A reference is free text on an append-only table; one that is not a
        # UUID would make the `pk__in` below raise, so it simply has no link.
        if row.reference_type in _RESOLVERS and _is_uuid(row.reference_id):
            wanted[row.reference_type].add(row.reference_id)

    found: dict[tuple[str, str], Document] = {}
    for reference_type, ids in wanted.items():
        for reference_id, document in _RESOLVERS[reference_type](ids).items():
            found[(reference_type, reference_id)] = document
    return found
