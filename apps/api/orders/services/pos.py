"""POS sales.

A POS sale is instantaneous: the customer walks out with the goods, so stock is
deducted immediately (no reservation) and the order is created DELIVERED.
docs/business-rules.md §1.3

Discounts at the counter come from three places (§3.3): a discount on a line, a
discount on the whole sale -- both the cashier's own, both under the approval
threshold -- and a coupon, which was authorised when it was created and is
checked here exactly as checkout checks it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from django.conf import settings
from django.core import signing
from django.db import IntegrityError, transaction
from django.utils import timezone

from accounts.models import Branch, User
from catalog.models import ProductVariant
from core import audit
from core.exceptions import (
    BusinessError,
    Conflict,
    CouponInvalid,
    PermissionDenied,
    PriceChanged,
    ValidationError,
)
from core.money import ZERO, quantize
from core.services import next_number
from customers.models import Customer
from inventory import services as inventory_services
from orders.models import (
    Channel,
    HeldSale,
    Order,
    OrderEventType,
    OrderItem,
    OrderStatus,
    PaymentMethod,
    PaymentState,
)
from orders.services import payments as payment_services
from orders.services import pricing, shortages
from orders.services.lifecycle import log_event
from promotions import services as promotion_services
from promotions.models import Coupon, DiscountType

#: What a manager holds that lets a discount pass the threshold.
DISCOUNT_OVERRIDE = "sales.discount_override"

#: A manager's approval is carried from `POST /pos/elevate/` to the sale in a
#: token signed with this salt, and lasts this long.
APPROVAL_SALT = "orders.pos.approval"
APPROVAL_MAX_AGE = 5 * 60

HUNDRED = Decimal("100")


@dataclass
class SaleLineInput:
    variant_id: Any
    quantity: int
    line_discount: Decimal = ZERO


@dataclass
class PaymentInput:
    method: str
    amount: Decimal
    tendered_amount: Decimal | None = None
    reference: str = ""
    #: Which account this tender lands in.  Per-payment rather than per-sale so
    #: a split of cash + card puts the cash in the drawer and the card takings
    #: in the bank, instead of both in whichever was picked for the sale.
    account: Any = None


@dataclass
class SaleInput:
    lines: list[SaleLineInput]
    payments: list[PaymentInput] = field(default_factory=list)
    customer_id: Any = None
    manual_discount: Decimal = ZERO
    #: The same discount as a percentage, turned into money here rather than in
    #: the browser. Taken off what the goods come to after any coupon, so
    #: "another 10%" is 10% of what the customer would otherwise pay. Give this
    #: or `manual_discount`, not both.
    manual_discount_percent: Decimal | None = None
    #: A code typed at the register: a claim, never an amount (§3.3).
    coupon_code: str = ""
    register: str = ""
    note: str = ""
    idempotency_key: str | None = None
    elevated_by: User | None = None
    #: A manager's approval from `POST /pos/elevate/`, for a discount above the
    #: threshold. Read only when the discount actually needs it.
    approval_token: str = ""
    #: The total the register showed. A sale that would record any other total
    #: is refused rather than charged (§3.1).
    expected_total: Decimal | None = None


@dataclass(frozen=True)
class Approval:
    """A manager's approval, read back from its signed token."""

    approver: User
    #: The largest discount, in percent, the manager was shown. None approves
    #: whatever the discount is -- only a service-level caller gets that.
    max_percent: Decimal | None = None


@dataclass(frozen=True)
class DiscountOverride:
    """Who let a discount above the threshold through, recorded on the sale."""

    approver: User
    #: The cashier's own discount -- lines plus the whole sale -- in money.
    discount: Decimal
    percent: Decimal
    threshold: Decimal


@dataclass
class SaleQuote:
    """A counter sale priced exactly as it would be recorded."""

    priced: pricing.PricedOrder
    #: The customer the cashier attached. None is an anonymous sale, which the
    #: sale itself files against the branch's walk-in record.
    customer: Customer | None
    coupon: Coupon | None = None
    override: DiscountOverride | None = None
    #: What stands between this basket and payment. Only a quote collects
    #: these; a sale raises the first one instead.
    issues: list[dict[str, Any]] = field(default_factory=list)


def walk_in_customer(branch: Branch) -> Customer:
    """Every order needs a customer FK; anonymous counter sales use this row.

    The lookup is backed by `customers_customer_walk_in_name_uniq`, which is
    what makes `get_or_create` atomic here: two registers ringing up anonymous
    sales at the same instant both miss the SELECT and both INSERT, and the
    loser now gets an IntegrityError instead of a second row.  Losing the race
    is not an error for the caller — the winner's row is the answer — so it is
    re-fetched rather than raised.
    """
    lookup = {"is_walk_in": True, "name": f"Walk-in ({branch.code})"}
    try:
        customer, _ = Customer.objects.get_or_create(
            **lookup,
            defaults={"customer_type": "WALK_IN", "phone": None, "email": None},
        )
    except IntegrityError:
        # get_or_create rolls its own savepoint back and re-fetches once; this
        # covers the narrower window where that re-fetch also missed.
        customer = Customer.objects.get(**lookup)
    return customer


def approval_token(
    *,
    approver: User,
    requested_by: User,
    permission: str,
    max_percent: Decimal | None = None,
) -> str:
    """Sign what a manager has just approved, for the register to carry to the sale.

    `elevate()` checks the manager's password behind the login throttle; this is
    what lets the sale rely on that check without seeing the password again. It
    is not a session. It names the approver, the cashier it was given to, the one
    permission, and -- for a discount -- the largest percentage the manager was
    shown, and it expires after APPROVAL_MAX_AGE seconds.
    """
    return signing.dumps(
        {
            "approver": str(approver.pk),
            "cashier": str(requested_by.pk),
            "permission": permission,
            "max_percent": None if max_percent is None else str(quantize(max_percent)),
        },
        salt=APPROVAL_SALT,
    )


def read_approval(*, token: str, actor: User, branch: Branch, permission: str) -> Approval:
    """Check a manager's approval at the moment a sale relies on it.

    The approver is re-read rather than trusted from the token: a manager
    deactivated, or moved off the role, since approving no longer approves.
    """
    refused = {"requires": permission}
    try:
        payload = signing.loads(token, salt=APPROVAL_SALT, max_age=APPROVAL_MAX_AGE)
    except signing.SignatureExpired as exc:
        raise PermissionDenied(
            "The manager's approval has expired. Ask for it again.", details=refused
        ) from exc
    except signing.BadSignature as exc:
        raise PermissionDenied("That manager approval is not valid.", details=refused) from exc

    if payload.get("cashier") != str(actor.pk) or payload.get("permission") != permission:
        raise PermissionDenied("That approval was given for something else.", details=refused)

    approver = User.objects.filter(pk=payload.get("approver"), is_active=True).first()
    if approver is None or not approver.has_perm_code(permission):
        raise PermissionDenied(
            "The manager who approved this can no longer approve it.", details=refused
        )
    # The same rule `resolve_branch` applies to the manager's own requests: a
    # manager bound to one shop does not approve discounts in another.
    if not approver.can_cross_branch and approver.branch_id and approver.branch_id != branch.pk:
        raise PermissionDenied(
            "A manager can only approve a discount at their own branch.", details=refused
        )

    max_percent = payload.get("max_percent")
    return Approval(
        approver=approver,
        max_percent=None if max_percent is None else Decimal(max_percent),
    )


def _check_discount_permission(
    *,
    actor: User,
    discount: Decimal,
    subtotal: Decimal,
    branch: Branch,
    elevated_by: User | None = None,
    approval_token: str = "",
) -> DiscountOverride | None:
    """Large discounts need manager approval (docs/business-rules.md §3.3).

    `discount` is the cashier's own -- lines plus the whole-sale discount --
    measured against the sale before any discount. A coupon's is not in it: the
    coupon was authorised when it was created.

    Returns who approved a discount above the threshold, or None when nothing
    needed approving. Writes nothing -- the register's quote runs this on every
    change to the basket, and the sale records the override against its order.
    """
    if discount <= ZERO:
        return None
    if not actor.has_perm_code("sales.discount"):
        raise PermissionDenied("You do not have permission to apply discounts.")
    if subtotal <= ZERO:
        return None

    exact = (discount / subtotal) * HUNDRED
    threshold = Decimal(settings.RANGON["DISCOUNT_APPROVAL_PERCENT"])
    if exact <= threshold:
        return None

    percent = quantize(exact)
    # The amount too, so the register can say what the percentage is of: it is
    # measured against the whole sale, and a percentage typed after a coupon
    # reads lower here than it did at the till.
    details = {
        "discount": str(quantize(discount)),
        "discount_percent": str(percent),
        "threshold": str(threshold),
    }

    def approved_by(approver: User) -> DiscountOverride:
        return DiscountOverride(
            approver=approver, discount=discount, percent=percent, threshold=threshold
        )

    for approver in (actor, elevated_by):
        if approver is not None and approver.has_perm_code(DISCOUNT_OVERRIDE):
            return approved_by(approver)

    if approval_token:
        approval = read_approval(
            token=approval_token, actor=actor, branch=branch, permission=DISCOUNT_OVERRIDE
        )
        # Compared at the precision the manager was shown it, which is the
        # precision it was signed at.
        if approval.max_percent is not None and percent > approval.max_percent:
            raise PermissionDenied(
                f"The manager approved a discount of up to {approval.max_percent}%; "
                f"this one is {percent}%.",
                details={
                    **details,
                    "requires": DISCOUNT_OVERRIDE,
                    "approved_percent": str(approval.max_percent),
                },
            )
        return approved_by(approval.approver)

    raise PermissionDenied(
        f"A discount above {threshold}% needs manager approval.",
        details={**details, "requires": DISCOUNT_OVERRIDE},
    )


def _named_customer(customer_id: Any) -> Customer | None:
    """The customer the cashier attached, or None for an anonymous sale.

    The walk-in record is anonymous too: every unnamed sale at the branch
    shares it, so it can never stand for one person.
    """
    if not customer_id:
        return None
    customer = Customer.objects.filter(pk=customer_id).first()
    if customer is None or customer.is_walk_in:
        return None
    return customer


def _times(count: int) -> str:
    return {1: "once", 2: "twice"}.get(count, f"{count} times")


def _coupon_for_sale(
    *,
    code: str,
    lines: list[pricing.PricedLine],
    subtotal: Decimal,
    customer: Customer | None,
) -> tuple[Coupon, Decimal]:
    """Validate a code typed at the register and return what it takes off.

    Everything checkout checks is checked here, for the POS channel, by the same
    function. The counter adds three refusals of its own. Two come first,
    because nothing the cashier could change would get past them; asking for a
    customer comes last, because attaching one is no use if the coupon would be
    refused anyway.
    """
    coupon = promotion_services.get_coupon(code)
    details = {"code": coupon.code}

    if coupon.discount_type == DiscountType.FREE_SHIPPING:
        raise CouponInvalid(
            f"{coupon.code} takes off the delivery charge, and a counter sale has none.",
            details=details,
        )
    if coupon.channels and Channel.POS not in coupon.channels:
        raise CouponInvalid(f"{coupon.code} cannot be used in store.", details=details)

    result = promotion_services.validate_coupon(
        coupon=coupon, lines=lines, subtotal=subtotal, customer=customer, channel=Channel.POS
    )

    # The per-customer limit has to be counted against somebody. The walk-in
    # record is shared by every anonymous sale at the branch -- counting against
    # it would let the first stranger spend everyone's use, and not counting
    # would make the limit unenforceable at the counter (§3.3).
    if customer is None and coupon.usage_limit_per_customer:
        raise CouponInvalid(
            f"{coupon.code} can be used {_times(coupon.usage_limit_per_customer)} per "
            "customer, so it needs the customer on the sale. Attach them to apply it.",
            details={**details, "needs_customer": True},
        )
    return coupon, result.discount


def _manual_discount(data: SaleInput, *, base: Decimal) -> Decimal:
    """The cashier's discount on the whole sale, in money.

    `base` is what the goods come to after any coupon, so a percentage is taken
    off what the customer would otherwise pay.
    """
    amount = quantize(data.manual_discount or ZERO)
    percent = data.manual_discount_percent
    if percent is None:
        return amount
    if amount > ZERO:
        raise ValidationError(
            "Give the discount as an amount or as a percentage, not both.",
            details={"manual_discount": str(amount), "manual_discount_percent": str(percent)},
        )
    if percent < ZERO or percent > HUNDRED:
        raise ValidationError(
            "A percentage discount must be between 0 and 100.",
            details={"manual_discount_percent": str(percent)},
        )
    return quantize(base * percent / HUNDRED)


def price_sale(*, branch: Branch, actor: User, data: SaleInput, strict: bool = True) -> SaleQuote:
    """Price a counter sale exactly as it would be recorded.

    The register's running total (`POST /pos/quote/`) and the sale itself both
    come through here, so the figure a cashier reads out is the figure the sale
    records -- the guarantee `checkout.price_cart` gives the storefront.

    `strict` is the sale: the first refusal is raised. A quote collects coupon
    and discount refusals into `issues` instead and prices everything else, so
    the register can show the total *and* what stands between it and payment.
    A basket that cannot be priced at all -- an unknown item, a discount larger
    than the sale -- raises either way.
    """
    if not data.lines:
        raise ValidationError("A sale needs at least one item.")

    variant_ids = [line.variant_id for line in data.lines]
    variants = {
        str(v.pk): v
        for v in ProductVariant.objects.select_related("product", "product__category").filter(
            pk__in=variant_ids
        )
    }
    missing = [str(v) for v in variant_ids if str(v) not in variants]
    if missing:
        raise ValidationError("Unknown product variant.", details={"variant_ids": missing})

    # Cost comes from the branch's weighted average at this moment (ADR-0006).
    snapshots = inventory_services.availability(branch=branch, variants=list(variants.values()))
    costs = {vid: snapshot.average_cost for vid, snapshot in snapshots.items()}

    priced_lines = pricing.price_lines(
        [
            (variants[str(line.variant_id)], line.quantity, line.line_discount)
            for line in data.lines
        ],
        costs=costs,
    )
    subtotal = quantize(sum((line.line_total for line in priced_lines), ZERO))
    gross_subtotal = quantize(sum((line.gross for line in priced_lines), ZERO))
    line_discounts = quantize(sum((line.line_discount for line in priced_lines), ZERO))

    customer = _named_customer(data.customer_id)
    issues: list[dict[str, Any]] = []

    def refuse(exc: BusinessError, field: str) -> None:
        if strict:
            raise exc
        issues.append(
            {"code": exc.code, "field": field, "message": exc.message, "details": exc.details}
        )

    coupon: Coupon | None = None
    coupon_discount = ZERO
    code = (data.coupon_code or "").strip()
    if code:
        try:
            coupon, coupon_discount = _coupon_for_sale(
                code=code, lines=priced_lines, subtotal=subtotal, customer=customer
            )
        except CouponInvalid as exc:
            refuse(exc, "coupon")

    manual_discount = _manual_discount(data, base=quantize(subtotal - coupon_discount))

    override: DiscountOverride | None = None
    try:
        override = _check_discount_permission(
            actor=actor,
            discount=quantize(line_discounts + manual_discount),
            subtotal=gross_subtotal,
            branch=branch,
            elevated_by=data.elevated_by,
            approval_token=data.approval_token,
        )
    except PermissionDenied as exc:
        refuse(exc, "discount")

    priced = pricing.calculate(
        priced_lines,
        coupon_discount=coupon_discount,
        manual_discount=manual_discount,
        coupon=coupon,
    )
    if coupon is not None:
        priced.coupon_message = coupon.description
    return SaleQuote(
        priced=priced, customer=customer, coupon=coupon, override=override, issues=issues
    )


@transaction.atomic
def create_pos_sale(*, branch: Branch, actor: User, data: SaleInput) -> Order:
    """Create a completed counter sale: stock out, money in, receipt ready."""
    if data.idempotency_key:
        existing = Order.objects.filter(idempotency_key=data.idempotency_key).first()
        if existing is not None:
            return existing

    quote = price_sale(branch=branch, actor=actor, data=data)
    priced = quote.priced
    if data.expected_total is not None and quantize(data.expected_total) != priced.grand_total:
        raise PriceChanged(
            "The total has changed since the register showed it.",
            details={
                "expected": str(quantize(data.expected_total)),
                "actual": str(priced.grand_total),
            },
        )

    customer = quote.customer or walk_in_customer(branch)

    try:
        # Savepoint: without it the IntegrityError poisons the transaction
        # and the lookup below raises `TransactionManagementError` instead
        # of answering -- the recovery never ran (D90).
        with transaction.atomic():
            order = Order.objects.create(
                number=next_number("order:POS", prefix="RGN-POS"),
                channel=Channel.POS,
                status=OrderStatus.DELIVERED,
                branch=branch,
                customer=customer,
                created_by=actor,
                register=data.register,
                subtotal=priced.subtotal,
                coupon=quote.coupon,
                coupon_discount=priced.coupon_discount,
                manual_discount=priced.manual_discount,
                discount_total=priced.discount_total,
                tax_rate=priced.tax_rate,
                tax_mode=priced.tax_mode,
                tax_total=priced.tax_total,
                shipping_total=ZERO,
                grand_total=priced.grand_total,
                currency=settings.RANGON["CURRENCY"],
                customer_note=data.note,
                idempotency_key=data.idempotency_key,
                placed_at=timezone.now(),
                delivered_at=timezone.now(),
                stock_committed=True,
            )
    except IntegrityError:
        existing = Order.objects.filter(idempotency_key=data.idempotency_key).first()
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
            fulfilled_quantity=line.quantity,
        )

    # Deduct stock — this is where an oversell would be caught, under a row lock.
    inventory_services.sell(
        branch=branch,
        lines=[(line.variant.pk, line.quantity) for line in priced.lines],
        actor=actor,
        reference_type="order",
        reference_id=order.pk,
    )
    # Where the owner lets the counter take reserved units, the online orders
    # that lost them are flagged for staff (§1.4, D115).
    shortages.flag_short_orders(
        branch=branch,
        lines=[(line.variant.pk, line.quantity) for line in priced.lines],
        sale=order,
        actor=actor,
    )

    # Count the coupon's use, re-checking both limits under its row lock. After
    # the stock, as checkout does it: every sale takes the inventory rows first
    # and the coupon row second, so a counter sale and an online order spending
    # one coupon on one item cannot each hold the lock the other is waiting for.
    if quote.coupon is not None:
        promotion_services.redeem(
            coupon=quote.coupon,
            order=order,
            discount=priced.coupon_discount,
            customer=quote.customer,
        )

    total_paid = ZERO
    for payment_input in data.payments:
        amount = quantize(payment_input.amount)
        if amount <= ZERO:
            continue
        payment_services.record_payment(
            order=order,
            method=payment_input.method,
            amount=amount,
            actor=actor,
            status=PaymentState.CAPTURED,
            reference=payment_input.reference,
            tendered_amount=payment_input.tendered_amount,
            account=payment_input.account,
        )
        total_paid += amount

    if total_paid < priced.grand_total:
        raise ValidationError(
            "Payment does not cover the sale total.",
            details={"total": str(priced.grand_total), "paid": str(quantize(total_paid))},
        )

    _touch_customer(customer, order)

    # A lead chased by phone is usually rung up at the counter, not online. If
    # only checkout closed leads, every recovery the shop actually made would
    # stay on the call-back list and be called again.
    from orders.services import leads

    leads.recover_for_order(order)

    coupon_code = quote.coupon.code if quote.coupon is not None else ""
    log_event(
        order,
        OrderEventType.CREATED,
        f"POS sale at {branch.code}",
        data={"register": data.register, "items": len(priced.lines), "coupon": coupon_code},
        actor=actor,
    )
    if quote.override is not None:
        audit.record(
            action=audit.AuditAction.DISCOUNT_OVERRIDE,
            entity=order,
            actor=actor,
            new_values={
                "discount": str(quote.override.discount),
                "percent": str(quote.override.percent),
                "threshold": str(quote.override.threshold),
                "approved_by": quote.override.approver.email,
            },
            reason="Discount above threshold approved",
            # The till's branch: an override is that shop's business, not every
            # shop's -- with no branch the entry reached every auditor (D95).
            branch=branch,
        )
    audit.record(
        action=audit.AuditAction.SALE_CREATED,
        entity=order,
        actor=actor,
        new_values={
            "number": order.number,
            "total": order.grand_total,
            "items": len(priced.lines),
            "register": data.register,
            "discount_total": priced.discount_total,
            "coupon": coupon_code,
        },
        branch=branch,
    )

    # record_payment() updated the row through its own locked copy; refresh so
    # the caller (and therefore the receipt) sees the real payment status.
    order.refresh_from_db()
    return order


def _touch_customer(customer: Customer, order: Order) -> None:
    if customer.is_walk_in:
        return
    Customer.objects.filter(pk=customer.pk).update(
        total_orders=customer.total_orders + 1,
        total_spent=quantize(customer.total_spent + order.grand_total),
        last_order_at=order.placed_at,
    )


@transaction.atomic
def void_sale(*, order: Order, actor: User, reason: str) -> Order:
    """Void a POS sale: restock the goods and refund the money.

    The sale itself is never deleted (CLAUDE.md §3.3) — it becomes a cancelled
    order with a compensating RETURN in the ledger.
    """
    if order.channel != Channel.POS:
        raise Conflict("Only a POS sale can be voided; use returns for online orders.")
    if order.status == OrderStatus.CANCELLED:
        return order
    if not reason.strip():
        raise ValidationError("A reason is required to void a sale.")

    order = Order.objects.select_for_update().get(pk=order.pk)

    inventory_services.restock_return(
        branch=order.branch,
        lines=[(item.variant_id, item.quantity) for item in order.items.all()],
        actor=actor,
        reference_type="order_void",
        reference_id=order.pk,
        reason=f"Sale {order.number} voided: {reason}",
    )

    if order.paid_total > order.refunded_total:
        payment_services.refund_order(
            order=order,
            amount=order.paid_total - order.refunded_total,
            actor=actor,
            reason=f"Sale voided: {reason}",
        )

    # The sale is undone -- goods back, money back -- so its coupon use comes
    # back too, as it does for a cancelled order (§3.3). A void is how a cashier
    # corrects a mis-rung sale, and the re-ring must be able to spend it.
    promotion_services.release(order=order, reason=f"Sale voided: {reason}")

    # Re-read first: refund_order() wrote paid/refunded totals on its own copy.
    order.refresh_from_db()
    order.status = OrderStatus.CANCELLED
    order.cancelled_at = timezone.now()
    order.cancel_reason = reason[:255]
    order.stock_committed = False
    order.save(
        update_fields=["status", "cancelled_at", "cancel_reason", "stock_committed", "updated_at"]
    )

    log_event(order, OrderEventType.CANCELLED, f"Sale voided: {reason}", actor=actor)
    audit.record(
        action=audit.AuditAction.ORDER_CANCELLED,
        entity=order,
        actor=actor,
        old_values={"status": OrderStatus.DELIVERED},
        new_values={"status": OrderStatus.CANCELLED},
        reason=reason,
        branch=order.branch,
    )
    return order


# --- held sales ------------------------------------------------------------


def hold_sale(
    *,
    branch: Branch,
    actor: User,
    payload: dict[str, Any],
    label: str = "",
    register: str = "",
    customer_id: Any = None,
) -> HeldSale:
    """Park a cart.  Nothing is reserved: a hold must never lock up stock."""
    return HeldSale.objects.create(
        branch=branch,
        register=register,
        label=label or timezone.now().strftime("%H:%M"),
        customer_id=customer_id,
        payload=payload,
        created_by=actor,
    )


def resume_sale(*, hold: HeldSale) -> dict[str, Any]:
    """Return the parked cart and delete the hold.

    Prices and availability are deliberately *not* returned from the hold — the
    POS re-looks-up every line so a stale hold cannot sell at a stale price.
    """
    payload = hold.payload
    hold.delete()
    return payload


def lookup_variant(*, code: str) -> ProductVariant | None:
    """Barcode/SKU lookup: exact match first — a cashier scanning must not get
    a fuzzy result."""
    code = code.strip()
    if not code:
        return None
    return (
        ProductVariant.objects.select_related("product", "product__category")
        .filter(barcode=code)
        .first()
        or ProductVariant.objects.select_related("product", "product__category")
        .filter(sku__iexact=code)
        .first()
    )


def elevate(
    *,
    email: str,
    password: str,
    permission: str,
    requested_by: User,
    discount_percent: Decimal | None = None,
) -> User:
    """Manager override at the counter.

    Verifies a manager's own credentials and returns the approver; the cashier's
    session is never upgraded.  Both identities land in the audit log, with the
    discount the manager was shown when that is what they approved.
    """
    from django.contrib.auth import authenticate

    approver = authenticate(username=email, password=password)
    if approver is None or not approver.is_active:
        raise PermissionDenied("Those manager credentials were not accepted.")
    if not approver.has_perm_code(permission):
        raise PermissionDenied("That user cannot approve this action.")

    new_values: dict[str, Any] = {"permission": permission, "approved_by": approver.email}
    if discount_percent is not None:
        new_values["discount_percent"] = str(quantize(discount_percent))
    audit.record(
        action=audit.AuditAction.PERMISSION_ELEVATION,
        entity=approver,
        actor=requested_by,
        new_values=new_values,
        reason="POS manager override",
        # The counter it happened at is the cashier's (D95).
        branch=requested_by.branch,
    )
    return approver


@transaction.atomic
def pos_return(
    *,
    order: Order,
    actor: User,
    lines: list[tuple[Any, int, str]],
    reason: str,
    refund_method: str = PaymentMethod.CASH,
) -> Any:
    """In-store return: request, approve, receive and refund in one step.

    `lines` is [(order_item_id, quantity, restock_decision)].
    """
    from orders.services import returns as return_services

    request = return_services.request_return(
        order=order,
        lines=[(item_id, quantity) for item_id, quantity, _ in lines],
        reason=reason,
        actor=actor,
        restock_decisions={str(item_id): decision for item_id, _, decision in lines},
    )
    return_services.approve(return_request=request, actor=actor)
    return_services.receive(return_request=request, actor=actor)
    return return_services.complete(
        return_request=request, actor=actor, refund_method=refund_method
    )
