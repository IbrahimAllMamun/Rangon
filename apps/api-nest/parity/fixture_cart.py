"""Carts, coupons and a shipping zone for the parity database.

Run through Django after fixture_orders.py, like the other fixtures:

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_cart.py

All or nothing, and a second run finds the marker cart and stops. Carts and
cart lines are written directly: a cart is a cache the server re-prices on
every read, and these exist to be re-priced. No stock is touched.

What each piece is for (tokens start `parity-cart-`, which the harness keeps):
- `mixed`: a stocked shirt, a draft product's variant (UNAVAILABLE) and an
  active variant that was never stocked (INSUFFICIENT_STOCK, label read from
  its attributes).
- `coupon`: two shirts with RANGON10 applied (percentage, capped).
- `expired`: a shirt with EXPIRED50 on it, which a read drops (COUPON_INVALID).
- `empty`: no lines. `dead`: already checked out -- its token is not reused.
- `guest` and the customer's own cart: signing in merges one into the other.
- `attach`: a guest cart a customer signing in with its token takes over.
- Coupons: every refusal `validate_coupon` has, a category restriction that
  covers the category's descendants, a product restriction, a cap, and a
  fixed amount larger than the cart.
- A shipping zone with untidy city names (spaces, capitals, a number) and two
  methods tied on (position, price).
"""

from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from accounts.models import Branch
from catalog.models import Category, Product, ProductVariant, PublishStatus
from customers.models import Customer
from orders.models import Cart, CartItem, Order
from promotions.models import Coupon, CouponRedemption, DiscountType
from shipping.models import ShippingMethod, ShippingZone

MARKER = "parity-cart-mixed"


def apply() -> None:
    branch = Branch.objects.filter(is_default=True).first()
    navy = ProductVariant.objects.get(sku="RGN-CLA-L-NAV")
    white = ProductVariant.objects.get(sku="RGN-CLA-L-WHI")
    draft = ProductVariant.objects.get(sku="PAR-DRAFT")
    unstocked = (
        ProductVariant.objects.filter(
            product__slug="parity-cotton-tee", status=PublishStatus.ACTIVE, name=""
        )
        .order_by("sku")
        .first()
    )
    customer = Customer.objects.get(user__email="parity.customer@rangon.test")

    def cart(token: str, lines, **fields) -> Cart:
        row = Cart.objects.create(token=f"parity-cart-{token}", branch=branch, **fields)
        for variant, quantity in lines:
            CartItem.objects.create(cart=row, variant=variant, quantity=quantity)
        return row

    cart("mixed", [(navy, 2), (draft, 1), (unstocked, 1)])
    cart("coupon", [(navy, 1), (white, 1)], coupon=Coupon.objects.get(code="RANGON10"))
    cart("expired", [(white, 1)], coupon=Coupon.objects.get(code="EXPIRED50"))
    cart("empty", [])
    cart("dead", [(navy, 1)], is_active=False)
    cart("guest", [(white, 2), (navy, 1)])
    cart("customer", [(white, 1)], customer=customer)
    cart("attach", [(navy, 3)])

    now = timezone.now()
    men = Category.objects.get(name="Men")
    for code, fields in {
        "PARITY-CAT": {"discount_type": DiscountType.PERCENTAGE, "value": Decimal("20")},
        "PARITY-PRODUCT": {"discount_type": DiscountType.FIXED, "value": Decimal("150")},
        "PARITY-USED": {"discount_type": DiscountType.FIXED, "value": Decimal("10"), "usage_limit": 1, "used_count": 1},
        "PARITY-SOON": {"discount_type": DiscountType.FIXED, "value": Decimal("10"), "starts_at": now + timedelta(days=30)},
        "PARITY-OFF": {"discount_type": DiscountType.FIXED, "value": Decimal("10"), "is_active": False},
        "PARITY-ONCE": {"discount_type": DiscountType.FIXED, "value": Decimal("25")},
        "PARITY-BIG": {"discount_type": DiscountType.FIXED, "value": Decimal("99999"), "usage_limit_per_customer": None},
        "PARITY-CAP": {"discount_type": DiscountType.PERCENTAGE, "value": Decimal("50"), "maximum_discount": Decimal("100.00")},
    }.items():
        Coupon.objects.create(code=code, description=f"Parity {code}", **fields)
    Coupon.objects.get(code="PARITY-CAT").categories.add(men)
    Coupon.objects.get(code="PARITY-PRODUCT").products.add(
        Product.objects.get(slug="essential-cotton-t-shirt")
    )
    CouponRedemption.objects.create(
        coupon=Coupon.objects.get(code="PARITY-ONCE"),
        order=Order.objects.get(number="RGN-PARITY-0001"),
        customer=customer,
        discount_amount=Decimal("25.00"),
    )

    zone = ShippingZone.objects.create(
        name="Parity Zone", cities=["  Chattogram ", "SYLHET", 4000], position=2
    )
    ShippingMethod.objects.create(
        zone=zone, name="Parity standard", code="p-std", price=Decimal("90.00"),
        free_over=Decimal("4000.00"), min_days=2, max_days=2, position=0,
    )
    for code in ("p-tie-a", "p-tie-b"):
        ShippingMethod.objects.create(
            zone=zone, name=f"Parity {code}", code=code, price=Decimal("120.00"), position=1,
            min_days=1, max_days=1,
        )
    ShippingMethod.objects.create(
        zone=zone, name="Parity retired", code="p-off", price=Decimal("10.00"), is_active=False,
    )


if Cart.objects.filter(token=MARKER).exists():
    print("parity cart fixture already applied")
else:
    with transaction.atomic():
        apply()
    print("parity cart fixture applied")
