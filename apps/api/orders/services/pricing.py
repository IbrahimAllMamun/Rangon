"""Order maths — the single place totals are computed.

POS and online checkout both call this, so a receipt and a web invoice can never
disagree about how a total was reached (docs/business-rules.md §3.2).

    line_subtotal  = unit_price * quantity - line_discount
    subtotal       = sum(line_subtotal)
    discount_total = coupon_discount + manual_discount
    taxable_base   = subtotal - discount_total
    tax            = round(taxable_base * tax_rate, 2)
    grand_total    = taxable_base + tax + shipping
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from django.conf import settings

from catalog.models import ProductVariant
from core.exceptions import ValidationError
from core.money import ZERO, quantize

ZERO_RATE = Decimal("0.0000")


@dataclass
class PricedLine:
    variant: ProductVariant
    quantity: int
    unit_price: Decimal
    unit_cost: Decimal = ZERO
    line_discount: Decimal = ZERO
    tax_amount: Decimal = ZERO

    @property
    def gross(self) -> Decimal:
        return quantize(self.unit_price * self.quantity)

    @property
    def line_total(self) -> Decimal:
        return quantize(self.gross - self.line_discount)

    @property
    def sku(self) -> str:
        return self.variant.sku

    @property
    def product_name(self) -> str:
        return self.variant.product.name

    @property
    def variant_label(self) -> str:
        return self.variant.label


@dataclass
class PricedOrder:
    lines: list[PricedLine] = field(default_factory=list)
    subtotal: Decimal = ZERO
    coupon_discount: Decimal = ZERO
    manual_discount: Decimal = ZERO
    discount_total: Decimal = ZERO
    tax_rate: Decimal = ZERO_RATE
    tax_total: Decimal = ZERO
    shipping_total: Decimal = ZERO
    grand_total: Decimal = ZERO
    coupon: Any = None
    coupon_message: str = ""

    @property
    def item_count(self) -> int:
        return sum(line.quantity for line in self.lines)

    @property
    def cogs_total(self) -> Decimal:
        return quantize(sum((line.unit_cost * line.quantity for line in self.lines), ZERO))


def resolve_tax_rate(lines: list[PricedLine]) -> Decimal:
    """Category override wins over the organisation default.

    A single order-level rate is used; mixed-rate baskets take the highest rate
    present, which is the conservative choice. Revisit if the shop ever sells
    goods at genuinely different VAT rates (docs/requirements.md ❓1).
    """
    default = Decimal(settings.RANGON["DEFAULT_TAX_RATE"])
    rates = [
        line.variant.product.category.tax_rate
        for line in lines
        if line.variant.product.category.tax_rate is not None
    ]
    return max([*rates, default]) if rates else default


def price_lines(
    raw_lines: list[tuple[ProductVariant, int, Decimal | None]],
    *,
    costs: dict[str, Decimal] | None = None,
) -> list[PricedLine]:
    """Build priced lines from (variant, quantity, optional line discount).

    The unit price always comes from the database — never from the client.
    """
    costs = costs or {}
    priced: list[PricedLine] = []
    for variant, quantity, line_discount in raw_lines:
        if quantity <= 0:
            raise ValidationError(f"Quantity for {variant.sku} must be at least 1.")
        discount = quantize(line_discount or ZERO)
        gross = quantize(variant.price * quantity)
        if discount > gross:
            raise ValidationError(
                f"Discount on {variant.sku} exceeds the line value.",
                details={"sku": variant.sku, "line_total": str(gross), "discount": str(discount)},
            )
        priced.append(
            PricedLine(
                variant=variant,
                quantity=quantity,
                unit_price=quantize(variant.price),
                unit_cost=quantize(costs.get(str(variant.pk), variant.cost)),
                line_discount=discount,
            )
        )
    return priced


def calculate(
    lines: list[PricedLine],
    *,
    coupon_discount: Decimal = ZERO,
    manual_discount: Decimal = ZERO,
    shipping_total: Decimal = ZERO,
    tax_rate: Decimal | None = None,
    coupon: Any = None,
) -> PricedOrder:
    """Compute every order-level figure once, in a fixed order."""
    subtotal = quantize(sum((line.line_total for line in lines), ZERO))
    coupon_discount = quantize(coupon_discount)
    manual_discount = quantize(manual_discount)
    discount_total = quantize(coupon_discount + manual_discount)

    if discount_total > subtotal:
        raise ValidationError(
            "The discount cannot exceed the order subtotal.",
            details={"subtotal": str(subtotal), "discount": str(discount_total)},
        )

    taxable_base = quantize(subtotal - discount_total)
    rate = tax_rate if tax_rate is not None else resolve_tax_rate(lines)
    tax_total = quantize(taxable_base * rate)

    # Distribute tax across lines for the receipt; the order total stays the
    # authoritative figure, so rounding drift lands on the last line only.
    if tax_total and taxable_base:
        allocated = ZERO
        for index, line in enumerate(lines):
            if index == len(lines) - 1:
                line.tax_amount = quantize(tax_total - allocated)
            else:
                share = quantize(tax_total * (line.line_total / taxable_base))
                line.tax_amount = share
                allocated += share
    else:
        for line in lines:
            line.tax_amount = ZERO

    shipping_total = quantize(shipping_total)
    grand_total = quantize(taxable_base + tax_total + shipping_total)

    return PricedOrder(
        lines=lines,
        subtotal=subtotal,
        coupon_discount=coupon_discount,
        manual_discount=manual_discount,
        discount_total=discount_total,
        tax_rate=rate,
        tax_total=tax_total,
        shipping_total=shipping_total,
        grand_total=grand_total,
        coupon=coupon,
    )


def change_due(total: Decimal, tendered: Decimal) -> Decimal:
    """Cash change; never negative."""
    difference = quantize(tendered) - quantize(total)
    return difference if difference > ZERO else ZERO
