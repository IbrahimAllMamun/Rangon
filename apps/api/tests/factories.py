"""Test factories.

Tests never depend on seed_demo (that is for humans); they build exactly the
data they need here.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.utils import timezone

from accounts.models import Branch, Organization, Role, RoleCode, User
from accounts.services import sync_permissions
from catalog.models import (
    Attribute,
    AttributeValue,
    Brand,
    Category,
    Product,
    ProductVariant,
    PublishStatus,
    VariantAttributeValue,
)
from customers.models import Customer, CustomerType
from inventory import services as inventory_services
from purchasing.models import Supplier
from shipping.models import ShippingMethod, ShippingZone

_counter = {"n": 0}


def unique(prefix: str = "") -> str:
    _counter["n"] += 1
    return f"{prefix}{_counter['n']:05d}"


def organization(**kwargs: Any) -> Organization:
    defaults = {"name": "Rangon Fashion", "slug": f"rangon-{unique()}", "currency": "BDT"}
    return Organization.objects.create(**{**defaults, **kwargs})


def branch(org: Organization | None = None, **kwargs: Any) -> Branch:
    org = org or Organization.objects.first() or organization()
    defaults = {
        "organization": org,
        "name": f"Branch {unique()}",
        "code": f"BR{unique()}",
        "is_default": not Branch.objects.exists(),
    }
    return Branch.objects.create(**{**defaults, **kwargs})


def user(
    role_code: str = RoleCode.CASHIER, *, branch_obj: Branch | None = None, **kwargs: Any
) -> User:
    if not Role.objects.exists():
        sync_permissions()
    role = Role.objects.get(code=role_code)
    defaults = {
        "email": kwargs.pop("email", f"user{unique()}@rangon.test"),
        "first_name": role_code.title(),
        "role": role,
        "branch": branch_obj,
    }
    account = User.objects.create_user(password="test-password-123", **{**defaults, **kwargs})
    return account


def category(**kwargs: Any) -> Category:
    name = kwargs.pop("name", f"Category {unique()}")
    # Slugs are unique and part of the URL, so a test that asserts on
    # `/category/women` can pass its own rather than accept a generated one.
    slug = kwargs.pop("slug", f"cat-{unique()}")
    return Category.objects.create(name=name, slug=slug, **kwargs)


def brand(**kwargs: Any) -> Brand:
    name = kwargs.pop("name", f"Brand {unique()}")
    return Brand.objects.create(name=name, slug=f"brand-{unique()}", **kwargs)


def attribute(code: str = "size", *, name: str = "Size", values: list[str] | None = None):
    attr, _ = Attribute.objects.get_or_create(code=code, defaults={"name": name})
    created = [
        AttributeValue.objects.get_or_create(attribute=attr, value=value)[0]
        for value in (values or ["S", "M", "L"])
    ]
    return attr, created


def product(*, published: bool = True, **kwargs: Any) -> Product:
    defaults = {
        "name": f"Product {unique()}",
        "slug": f"product-{unique()}",
        "category": kwargs.pop("category", None) or category(),
        "brand": kwargs.pop("brand", None) or brand(),
        "status": PublishStatus.ACTIVE,
        "published": published,
    }
    return Product.objects.create(**{**defaults, **kwargs})


def variant(
    product_obj: Product | None = None,
    *,
    price: str | Decimal = "1000.00",
    cost: str | Decimal = "400.00",
    attribute_values: list[AttributeValue] | None = None,
    **kwargs: Any,
) -> ProductVariant:
    product_obj = product_obj or product()
    defaults = {
        "product": product_obj,
        "sku": kwargs.pop("sku", f"SKU-{unique()}"),
        "barcode": kwargs.pop("barcode", f"20{unique('')}0000"[:13]),
        "price": Decimal(price),
        "cost": Decimal(cost),
        "status": PublishStatus.ACTIVE,
    }
    created = ProductVariant.objects.create(**{**defaults, **kwargs})
    for value in attribute_values or []:
        VariantAttributeValue.objects.create(
            variant=created, attribute=value.attribute, attribute_value=value
        )
    return created


def stock(
    variant_obj: ProductVariant,
    branch_obj: Branch,
    quantity: int = 10,
    unit_cost: str | Decimal = "400.00",
):
    """Put stock on the shelf the way the business does: by receiving it."""
    if quantity <= 0:
        return inventory_services.get_or_create_inventory(branch_obj, variant_obj)
    inventory_services.receive_stock(
        branch=branch_obj,
        variant=variant_obj,
        quantity=quantity,
        unit_cost=Decimal(unit_cost),
        reference_type="test_setup",
    )
    return inventory_services.get_or_create_inventory(branch_obj, variant_obj)


def account(
    branch_obj: Branch,
    *,
    kind: str = "CASH",
    opening_balance: Any = None,
    is_default: bool = True,
    **kwargs: Any,
):
    """An account with its opening balance posted through the service.

    Deliberately goes through finance.services rather than Account.objects so
    the test data satisfies the same invariant the production code does.
    """
    from finance import services as finance_services

    defaults: dict[str, Any] = {
        "name": f"{kind.title()} {unique()}",
        "kind": kind,
        "is_default": is_default,
    }
    defaults.update(kwargs)
    return finance_services.create_account(
        branch=branch_obj,
        opening_balance=Decimal(str(opening_balance)) if opening_balance is not None else None,
        **defaults,
    )


def expense_category(**kwargs: Any):
    """An expense category, created through the service like the API does."""
    from finance import services as finance_services

    label = unique()
    defaults: dict[str, Any] = {"name": f"Category {label}", "code": f"CAT_{label}".upper()[:32]}
    defaults.update(kwargs)
    return finance_services.create_expense_category(**defaults)


def expense(branch_obj: Branch, account_obj: Any = None, **kwargs: Any):
    """An expense posted through the service, so its cash-book row exists."""
    from finance import services as finance_services

    defaults: dict[str, Any] = {
        "category": kwargs.pop("category", None) or expense_category(),
        "account": account_obj or account(branch_obj, opening_balance="10000.00"),
        "amount": Decimal("500.00"),
    }
    defaults.update(kwargs)
    return finance_services.record_expense(branch=branch_obj, **defaults)


def customer(**kwargs: Any) -> Customer:
    defaults = {
        "name": f"Customer {unique()}",
        "phone": f"0171{unique('')}"[:11],
        "customer_type": CustomerType.REGISTERED,
    }
    return Customer.objects.create(**{**defaults, **kwargs})


def supplier(**kwargs: Any) -> Supplier:
    defaults = {"name": f"Supplier {unique()}", "code": f"SUP-{unique()}"}
    return Supplier.objects.create(**{**defaults, **kwargs})


def shipping_method(**kwargs: Any) -> ShippingMethod:
    zone = ShippingZone.objects.filter(is_default=True).first() or ShippingZone.objects.create(
        name=f"Zone {unique()}", is_default=True
    )
    defaults = {
        "zone": zone,
        "name": "Standard delivery",
        "code": f"std-{unique()}",
        "price": Decimal("70.00"),
    }
    return ShippingMethod.objects.create(**{**defaults, **kwargs})


def full_shop() -> dict[str, Any]:
    """A minimal but complete shop: org, branch, staff, product with stock."""
    org = organization()
    main_branch = branch(org)
    size_attr, sizes = attribute("size", values=["S", "M"])
    prod = product()
    small = variant(prod, attribute_values=[sizes[0]])
    medium = variant(prod, attribute_values=[sizes[1]])
    stock(small, main_branch, 10)
    stock(medium, main_branch, 5)
    return {
        "organization": org,
        "branch": main_branch,
        "product": prod,
        "variants": [small, medium],
        "cashier": user(RoleCode.CASHIER, branch_obj=main_branch),
        "manager": user(RoleCode.MANAGER, branch_obj=main_branch),
        "owner": user(RoleCode.OWNER, branch_obj=main_branch),
        "customer": customer(),
        "now": timezone.now(),
    }
