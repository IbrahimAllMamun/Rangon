"""Cart pricing and online checkout.

The browser never decides a price, a discount, a shipping cost or a total.  On
every cart read and again at checkout the server re-prices from the database and
re-checks stock (docs/business-rules.md §3.1).
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from accounts.models import Branch
from accounts.services import default_branch
from catalog.models import ProductVariant, PublishStatus
from core import audit
from core.exceptions import Conflict, PriceChanged, ValidationError
from core.money import ZERO, quantize
from core.services import next_number
from customers.models import Customer, CustomerType
from inventory import services as inventory_services
from orders.models import (
    Cart,
    CartItem,
    Channel,
    Order,
    OrderEventType,
    OrderItem,
    OrderStatus,
    PaymentMethod,
    PaymentState,
)
from orders.services import payments as payment_services
from orders.services import pricing
from orders.services.lifecycle import log_event
from promotions import services as promotion_services
from shipping.models import ShippingMethod, ShippingZone


@dataclass
class CartView:
    cart: Cart
    priced: pricing.PricedOrder
    availability: dict[str, Any]
    issues: list[dict[str, Any]]


def get_or_create_cart(
    *, token: str | None = None, customer: Customer | None = None, branch: Branch | None = None
) -> Cart:
    branch = branch or default_branch()
    if branch is None:
        raise ValidationError("No branch is configured to sell from.")

    if customer is not None:
        cart = Cart.objects.filter(customer=customer, is_active=True).first()
        if cart is not None:
            if token and cart.token != token:
                _merge_guest_cart(cart, token)
            return cart

    if token:
        cart = Cart.objects.filter(token=token, is_active=True).first()
        if cart is not None:
            if customer is not None and cart.customer_id is None:
                cart.customer = customer
                cart.save(update_fields=["customer", "updated_at"])
            return cart

    # The token may belong to a cart that has already been checked out. Reusing
    # it would collide on the unique index, so a fresh cart gets a fresh token —
    # the response's X-Cart-Token header tells the client about it.
    if token and Cart.objects.filter(token=token).exists():
        token = None

    return Cart.objects.create(
        token=token or secrets.token_urlsafe(24),
        customer=customer,
        branch=branch,
    )


def _merge_guest_cart(cart: Cart, guest_token: str) -> None:
    """Signing in should not silently lose what the visitor put in the basket."""
    guest = Cart.objects.filter(token=guest_token, is_active=True).first()
    if guest is None or guest.pk == cart.pk:
        return
    for item in guest.items.all():
        existing = cart.items.filter(variant_id=item.variant_id).first()
        if existing is not None:
            existing.quantity += item.quantity
            existing.save(update_fields=["quantity", "updated_at"])
        else:
            CartItem.objects.create(cart=cart, variant=item.variant, quantity=item.quantity)
    guest.is_active = False
    guest.save(update_fields=["is_active", "updated_at"])


def price_cart(*, cart: Cart, shipping_method: ShippingMethod | None = None) -> CartView:
    """Re-price the cart from scratch and report anything that changed."""
    items = list(
        cart.items.select_related(
            "variant", "variant__product", "variant__product__category"
        ).order_by("created_at")
    )
    issues: list[dict[str, Any]] = []

    sellable = []
    for item in items:
        variant = item.variant
        if variant.status != PublishStatus.ACTIVE or not variant.product.is_visible:
            issues.append(
                {
                    "code": "UNAVAILABLE",
                    "variant_id": str(variant.pk),
                    "message": f"{variant.product.name} is no longer available.",
                }
            )
            continue
        sellable.append(item)

    snapshots = inventory_services.availability(
        branch=cart.branch, variants=[item.variant for item in sellable]
    )

    raw_lines = []
    for item in sellable:
        snapshot = snapshots[str(item.variant_id)]
        quantity = item.quantity
        if snapshot.available < quantity:
            issues.append(
                {
                    "code": "INSUFFICIENT_STOCK",
                    "variant_id": str(item.variant_id),
                    "requested": quantity,
                    "available": snapshot.available,
                    "message": (
                        f"Only {snapshot.available} left of {item.variant.product.name} "
                        f"{item.variant.label}."
                    ),
                }
            )
        raw_lines.append((item.variant, quantity, ZERO))

    priced_lines = pricing.price_lines(raw_lines)
    subtotal = quantize(sum((line.line_total for line in priced_lines), ZERO))

    coupon_discount = ZERO
    free_shipping = False
    if cart.coupon_id and priced_lines:
        try:
            result = promotion_services.validate_coupon(
                coupon=cart.coupon,
                lines=priced_lines,
                subtotal=subtotal,
                customer=cart.customer,
                channel=Channel.ONLINE,
            )
            coupon_discount = result.discount
            free_shipping = result.free_shipping
        except Exception as exc:  # coupon became invalid since it was applied
            issues.append(
                {"code": "COUPON_INVALID", "message": str(exc), "coupon": cart.coupon.code}
            )
            cart.coupon = None
            cart.save(update_fields=["coupon", "updated_at"])

    shipping_total = ZERO
    if shipping_method is not None and priced_lines:
        shipping_total = ZERO if free_shipping else shipping_method.price_for(subtotal)

    priced = pricing.calculate(
        priced_lines,
        coupon_discount=coupon_discount,
        shipping_total=shipping_total,
        coupon=cart.coupon,
    )
    return CartView(cart=cart, priced=priced, availability=snapshots, issues=issues)


def add_item(*, cart: Cart, variant_id: Any, quantity: int = 1) -> CartItem:
    if quantity <= 0:
        raise ValidationError("Quantity must be at least 1.")

    variant = ProductVariant.objects.select_related("product").filter(pk=variant_id).first()
    if variant is None or variant.status != PublishStatus.ACTIVE or not variant.product.is_visible:
        raise ValidationError("That product is not available.")

    item = cart.items.filter(variant=variant).first()
    new_quantity = (item.quantity if item else 0) + quantity

    # Advisory only — the authoritative check happens under a lock at checkout.
    inventory_services.check_availability(branch=cart.branch, lines=[(variant.pk, new_quantity)])

    if item is None:
        item = CartItem.objects.create(cart=cart, variant=variant, quantity=quantity)
    else:
        item.quantity = new_quantity
        item.save(update_fields=["quantity", "updated_at"])

    Cart.objects.filter(pk=cart.pk).update(last_activity_at=timezone.now())
    return item


def update_item(*, cart: Cart, item_id: Any, quantity: int) -> CartItem | None:
    item = cart.items.filter(pk=item_id).first()
    if item is None:
        raise ValidationError("That item is not in your cart.")
    if quantity <= 0:
        item.delete()
        return None
    inventory_services.check_availability(branch=cart.branch, lines=[(item.variant_id, quantity)])
    item.quantity = quantity
    item.save(update_fields=["quantity", "updated_at"])
    return item


def apply_coupon(*, cart: Cart, code: str) -> pricing.PricedOrder:
    coupon = promotion_services.get_coupon(code)
    view = price_cart(cart=cart)
    promotion_services.validate_coupon(
        coupon=coupon,
        lines=view.priced.lines,
        subtotal=view.priced.subtotal,
        customer=cart.customer,
        channel=Channel.ONLINE,
    )
    cart.coupon = coupon
    cart.save(update_fields=["coupon", "updated_at"])
    return price_cart(cart=cart).priced


def remove_coupon(*, cart: Cart) -> None:
    cart.coupon = None
    cart.save(update_fields=["coupon", "updated_at"])


def shipping_options(*, city: str, subtotal: Decimal) -> list[dict[str, Any]]:
    """Zone-matched methods with server-computed prices."""
    zone = next(
        (z for z in ShippingZone.objects.filter(is_active=True) if z.matches(city)),
        ShippingZone.objects.filter(is_active=True, is_default=True).first(),
    )
    if zone is None:
        return []
    return [
        {
            "id": str(method.pk),
            "code": method.code,
            "name": method.name,
            "description": method.description,
            "price": method.price_for(subtotal),
            "eta": method.eta_label,
            "is_pickup": method.is_pickup,
            "supports_cod": method.supports_cod,
            "zone": zone.name,
        }
        for method in zone.methods.filter(is_active=True).order_by("position", "price")
    ]


@transaction.atomic
def place_order(
    *,
    cart: Cart,
    shipping_address: dict[str, Any],
    payment_method: str,
    shipping_method_id: Any = None,
    billing_address: dict[str, Any] | None = None,
    customer: Customer | None = None,
    contact_name: str = "",
    contact_phone: str = "",
    contact_email: str = "",
    note: str = "",
    idempotency_key: str | None = None,
    expected_total: Decimal | None = None,
) -> Order:
    """Turn a cart into an order: re-price, re-check stock, reserve, create.

    Everything below happens in one transaction with the inventory rows locked,
    so two shoppers cannot both buy the last unit.
    """
    if idempotency_key:
        existing = Order.objects.filter(idempotency_key=idempotency_key).first()
        if existing is not None:
            return existing  # double-clicked "Place order"

    items = list(cart.items.select_related("variant", "variant__product").all())
    if not items:
        raise ValidationError("Your cart is empty.")

    shipping_method = (
        ShippingMethod.objects.filter(pk=shipping_method_id, is_active=True).first()
        if shipping_method_id
        else None
    )
    if shipping_method_id and shipping_method is None:
        raise ValidationError("That delivery option is no longer available.")
    if (
        payment_method == PaymentMethod.COD
        and shipping_method is not None
        and not shipping_method.supports_cod
    ):
        raise ValidationError("Cash on delivery is not available for that delivery option.")

    view = price_cart(cart=cart, shipping_method=shipping_method)
    blocking = [issue for issue in view.issues if issue["code"] != "COUPON_INVALID"]
    if blocking:
        raise Conflict(
            "Some items in your cart are no longer available.",
            details={"issues": blocking},
            code="INSUFFICIENT_STOCK",
        )

    priced = view.priced
    if expected_total is not None and quantize(expected_total) != priced.grand_total:
        raise PriceChanged(
            "The total has changed since you reviewed your order.",
            details={"expected": str(expected_total), "actual": str(priced.grand_total)},
        )

    customer = customer or _resolve_guest_customer(
        name=contact_name, phone=contact_phone, email=contact_email
    )

    try:
        order = Order.objects.create(
            number=next_number("order:WEB", prefix="RGN-WEB"),
            channel=Channel.ONLINE,
            status=OrderStatus.PENDING,
            branch=cart.branch,
            customer=customer,
            subtotal=priced.subtotal,
            coupon_discount=priced.coupon_discount,
            discount_total=priced.discount_total,
            tax_rate=priced.tax_rate,
            tax_mode=priced.tax_mode,
            tax_total=priced.tax_total,
            shipping_total=priced.shipping_total,
            grand_total=priced.grand_total,
            currency=settings.RANGON["CURRENCY"],
            coupon=cart.coupon,
            shipping_method=shipping_method,
            shipping_address=shipping_address,
            billing_address=billing_address or shipping_address,
            customer_note=note,
            idempotency_key=idempotency_key,
            guest_token=secrets.token_urlsafe(24),
            placed_at=timezone.now(),
        )
    except IntegrityError:
        existing = Order.objects.filter(idempotency_key=idempotency_key).first()
        if existing is not None:
            return existing
        raise

    for line in priced.lines:
        OrderItem.objects.create(
            order=order,
            variant=line.variant,
            sku=line.sku,
            product_name=line.product_name,
            variant_label=line.variant_label,
            quantity=line.quantity,
            unit_price=line.unit_price,
            unit_cost=line.unit_cost,
            line_discount=line.line_discount,
            tax_amount=line.tax_amount,
            line_total=line.line_total,
        )

    # Hold the stock.  Raises INSUFFICIENT_STOCK under the row lock if someone
    # else got there first.
    inventory_services.reserve(
        branch=cart.branch,
        lines=[(line.variant.pk, line.quantity) for line in priced.lines],
        reference_type="order",
        reference_id=order.pk,
    )
    log_event(
        order,
        OrderEventType.STOCK_RESERVED,
        "Stock reserved",
        customer_visible=False,
    )

    if cart.coupon_id:
        promotion_services.redeem(
            coupon=cart.coupon,
            order=order,
            discount=priced.coupon_discount,
            customer=customer,
        )

    if payment_method == PaymentMethod.COD:
        payment_services.record_payment(
            order=order,
            method=PaymentMethod.COD,
            amount=priced.grand_total,
            status=PaymentState.PENDING,
            provider="manual",
        )
        # COD is confirmed straight away — there is nothing to wait for.
        from orders.services.lifecycle import transition

        order = transition(
            order=order,
            to_status=OrderStatus.CONFIRMED,
            reason="Cash on delivery order placed",
            notify=False,
        )
    else:
        payment_services.record_payment(
            order=order,
            method=payment_method,
            amount=priced.grand_total,
            status=PaymentState.PENDING,
            provider=settings.RANGON["DEFAULT_PAYMENT_PROVIDER"],
        )

    cart.is_active = False
    cart.save(update_fields=["is_active", "updated_at"])

    log_event(
        order,
        OrderEventType.CREATED,
        "Order placed online",
        data={"items": len(priced.lines), "payment_method": payment_method},
    )
    audit.record(
        action=audit.AuditAction.SALE_CREATED,
        entity=order,
        new_values={
            "number": order.number,
            "total": order.grand_total,
            "channel": Channel.ONLINE,
            "payment_method": payment_method,
        },
        branch=order.branch,
    )

    from notifications import services as notification_services

    transaction.on_commit(
        lambda: notification_services.notify_staff(
            notification_type="NEW_ONLINE_ORDER",
            title=f"New online order {order.number}",
            body=f"{order.item_count} item(s), {order.grand_total} {order.currency}",
            permission_code="orders.view",
            branch=order.branch,
            link=f"/admin/orders/{order.pk}",
        )
    )
    return order


def _resolve_guest_customer(*, name: str, phone: str, email: str) -> Customer:
    """Match an existing customer by phone (identity is phone-first) or create one."""
    phone = (phone or "").strip()
    email = (email or "").strip().lower()

    if phone:
        existing = Customer.objects.filter(phone=phone).first()
        if existing is not None:
            return existing
    if email:
        existing = Customer.objects.filter(email=email).first()
        if existing is not None:
            return existing

    return Customer.objects.create(
        name=name or "Guest customer",
        phone=phone or None,
        email=email or None,
        customer_type=CustomerType.GUEST,
    )
