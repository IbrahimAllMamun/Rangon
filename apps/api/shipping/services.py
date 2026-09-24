"""Shipping services: handing a parcel to a courier, and what happens after.

A shipment is the record of a parcel leaving the shop. It does not *own* the
order's status — `orders.services.lifecycle.transition` does — but it drives
it: a `DISPATCHED` event moves a PACKED order to SHIPPED and a `DELIVERED` one
moves it to DELIVERED. An invariant that reaches into the order's status
machine cannot live in a serializer, which is why these two functions exist
(CLAUDE.md §4).

Both take the row lock before they read the value they are about to decide on,
so two people pressing the same button at the same moment cannot both pass the
check. The order is locked before anything else, which is the same order
`orders.services.returns` and `purchasing.services` take, so the fulfilment
path cannot deadlock against the money paths.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from accounts.models import User
from core.exceptions import Conflict, ValidationError
from core.money import quantize
from orders.models import Order, OrderEventType, OrderStatus
from orders.services.lifecycle import log_event, transition
from shipping.models import Courier, Shipment, ShipmentEvent, ShipmentStatus, ShippingMethod

#: Orders a parcel may be created for.
#:
#: SHIPPED is included because a split delivery is real — two boxes, two
#: tracking numbers, one order — and the first one has already moved the order
#: on. Everything else is excluded for a reason a picker would recognise:
#: PENDING has not been confirmed, and CANCELLED / REFUNDED / RETURNED /
#: RETURN_REQUESTED are orders that must not leave the shop at all.
SHIPPABLE_ORDER_STATUSES = frozenset(
    {
        OrderStatus.CONFIRMED,
        OrderStatus.PROCESSING,
        OrderStatus.PACKED,
        OrderStatus.SHIPPED,
    }
)

#: A parcel's journey has ended. `FAILED` is deliberately not here: a failed
#: delivery attempt is normally retried the next day, and that retry is an
#: event on the same parcel.
FINISHED_SHIPMENT_STATUSES = frozenset({ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED})

#: Orders whose parcel may leave the shop. Booking one earlier is fine -- a
#: packer can have the tracking number ready -- but packing is when the goods
#: leave the stock ledger, and it is the step that moves on to SHIPPED. A parcel
#: that left a CONFIRMED order was delivered while the order stayed CONFIRMED
#: and its goods stayed on the shelf, reserved (D98). DELIVERED is here for a
#: split delivery: the first parcel home moves the order on before the second
#: has left.
DISPATCHABLE_ORDER_STATUSES = frozenset(
    {OrderStatus.PACKED, OrderStatus.SHIPPED, OrderStatus.DELIVERED}
)


@transaction.atomic
def create_shipment(
    *,
    order: Order,
    courier: Courier | None = None,
    shipping_method: ShippingMethod | None = None,
    tracking_number: str = "",
    cost: Any = None,
    notes: str = "",
    actor: User | None = None,
) -> Shipment:
    """Book a parcel against an order and write it to the order's timeline.

    The shipment always starts `PENDING`, whatever the caller asked for. Its
    status is the tail of its event log and nothing else: allowing a caller to
    create one already `DELIVERED` produced a delivered parcel with no event
    behind it and an order still sitting at PACKED, which is a lie that no
    later correction can unpick.
    """
    tracking_number = (tracking_number or "").strip()
    cost = quantize(cost if cost is not None else Decimal("0.00"))

    if cost < 0:
        raise ValidationError("A shipment cost cannot be negative.")

    # A tracking number is issued *by* a courier. Without one it identifies
    # nothing, cannot be looked up, and cannot be checked for uniqueness --
    # `Courier.tracking_url_template` is the only thing that can turn it into a
    # link the customer can follow.
    if tracking_number and courier is None:
        raise ValidationError(
            "A tracking number needs the courier that issued it.",
            details={"tracking_number": tracking_number},
        )

    # Locked before the status is read, so a cancellation committing in the
    # gap between the check and the insert loses the race rather than winning
    # it silently.
    locked = Order.objects.select_for_update().get(pk=order.pk)

    if locked.status not in SHIPPABLE_ORDER_STATUSES:
        raise Conflict(
            f"A {locked.get_status_display().lower()} order cannot be shipped.",
            details={"order": locked.number, "status": locked.status},
        )

    if tracking_number and courier is not None:
        clash = Shipment.objects.filter(courier=courier, tracking_number=tracking_number)
        if clash.exists():
            raise _duplicate(courier, tracking_number)

    try:
        # A savepoint, so losing the race to the unique index leaves the
        # surrounding transaction usable instead of poisoning it.
        with transaction.atomic():
            shipment = Shipment.objects.create(
                order=locked,
                courier=courier,
                shipping_method=shipping_method,
                tracking_number=tracking_number,
                cost=cost,
                notes=notes,
                status=ShipmentStatus.PENDING,
                created_by=actor,
            )
    except IntegrityError as exc:  # pragma: no cover - exercised by the concurrency test
        if courier is not None and tracking_number:
            raise _duplicate(courier, tracking_number) from exc
        raise

    log_event(
        locked,
        OrderEventType.SHIPMENT_CREATED,
        f"Shipment created{f' ({courier.name})' if courier else ''}",
        data={"tracking_number": tracking_number},
        actor=actor,
    )
    return shipment


@transaction.atomic
def record_event(
    *,
    shipment: Shipment,
    status: str | None = None,
    message: str = "",
    location: str = "",
    occurred_at: Any = None,
    actor: User | None = None,
) -> ShipmentEvent:
    """Record a tracking update and keep the order's status in step.

    `ShipmentEvent` is append-only, so an update posted against a parcel that
    has already been delivered or returned cannot be taken back. It is refused
    instead: the order has moved on by then, and the event would have rewound
    the parcel's status while leaving the order where it was.

    A parcel's first movement needs its order packed (D98). Later updates to a
    parcel already on its way are always recorded: they report what the courier
    did, which happened whatever the order says now.
    """
    # The order before the parcel: the lock order every fulfilment and money
    # path takes, and the order's status is what the parcel leaving is decided
    # on -- a cancellation committing in between must not slip past the check.
    order = Order.objects.select_for_update().get(pk=shipment.order_id)
    locked = Shipment.objects.select_for_update().get(pk=shipment.pk)

    if locked.status in FINISHED_SHIPMENT_STATUSES:
        raise Conflict(
            f"This parcel is already {locked.get_status_display().lower()}; "
            "its tracking history cannot be added to.",
            details={"status": locked.status},
        )

    new_status = status or ShipmentStatus.IN_TRANSIT
    leaving = locked.status == ShipmentStatus.PENDING and new_status != ShipmentStatus.PENDING
    if leaving and order.status not in DISPATCHABLE_ORDER_STATUSES:
        raise Conflict(
            f"Pack {order.number} before its parcel leaves: the order is still"
            f" {order.get_status_display().lower()}.",
            details={"order": order.number, "status": order.status},
        )

    event = ShipmentEvent.objects.create(
        shipment=locked,
        status=new_status,
        message=message,
        location=location,
        occurred_at=occurred_at or timezone.now(),
        created_by=actor,
    )

    locked.status = new_status
    if new_status == ShipmentStatus.DISPATCHED and not locked.dispatched_at:
        locked.dispatched_at = timezone.now()
    if new_status == ShipmentStatus.DELIVERED and not locked.delivered_at:
        locked.delivered_at = timezone.now()
    locked.save(update_fields=["status", "dispatched_at", "delivered_at", "updated_at"])

    log_event(
        order,
        OrderEventType.SHIPMENT_EVENT,
        f"{new_status}: {message}"[:255],
        data={"shipment_id": str(locked.pk), "status": new_status},
        actor=actor,
    )

    if new_status == ShipmentStatus.DISPATCHED and order.status == OrderStatus.PACKED:
        transition(order=order, to_status=OrderStatus.SHIPPED, actor=actor)
    elif new_status == ShipmentStatus.DELIVERED and order.status in {
        OrderStatus.SHIPPED,
        OrderStatus.PACKED,
    }:
        transition(order=order, to_status=OrderStatus.DELIVERED, actor=actor)

    return event


def _duplicate(courier: Courier, tracking_number: str) -> Conflict:
    return Conflict(
        f"{courier.name} already has a parcel with tracking number {tracking_number}.",
        details={"courier": courier.name, "tracking_number": tracking_number},
    )
