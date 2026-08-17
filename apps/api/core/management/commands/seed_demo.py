"""Realistic demo data for development, testing and training.

    python manage.py seed_demo --reset

Creates an organisation, a branch, one user per role, brands, categories,
attributes, and products across the four categories the shop actually sells —
clothing (size/colour), shoes (size/colour), cosmetics (shade/volume + expiry)
and bags (colour/capacity) — then purchases stock, and generates POS and online
orders so every screen and report has something to show.

Tests do NOT depend on this command; they use tests/factories.py.
"""

from __future__ import annotations

import random
from datetime import timedelta
from decimal import Decimal
from typing import Any

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from accounts.models import Branch, Organization, Role, RoleCode, Status, User
from accounts.services import create_staff_user, sync_permissions
from catalog.models import (
    Attribute,
    AttributeKind,
    AttributeValue,
    Brand,
    Category,
    CategoryAttribute,
    Product,
    PublishStatus,
)
from catalog.services import create_variant
from customers.models import Customer, CustomerAddress, CustomerType
from inventory.models import Inventory
from orders.models import Channel, OrderStatus, PaymentMethod
from orders.services import checkout as checkout_services
from orders.services import pos as pos_services
from orders.services.lifecycle import transition
from orders.services.pos import PaymentInput, SaleInput, SaleLineInput
from promotions.models import Coupon, DiscountType
from purchasing.models import Supplier
from purchasing.services import (
    PurchaseLine,
    create_purchase_order,
    receive_purchase,
    send_purchase_order,
)
from shipping.models import Courier, ShippingMethod, ShippingZone

PASSWORD = "rangon12345"  # development seed only — never reaches production

STAFF = [
    ("owner@rangon.test", RoleCode.OWNER, "Rafiq", "Ahmed"),
    ("manager@rangon.test", RoleCode.MANAGER, "Nusrat", "Jahan"),
    ("cashier@rangon.test", RoleCode.CASHIER, "Sabbir", "Hossain"),
    ("stock@rangon.test", RoleCode.INVENTORY_MANAGER, "Tanvir", "Islam"),
    ("accounts@rangon.test", RoleCode.ACCOUNTANT, "Farhana", "Akter"),
]

ATTRIBUTES = {
    "size": ("Size", AttributeKind.SIZE, ["XS", "S", "M", "L", "XL", "XXL"]),
    "shoe-size": ("Shoe size", AttributeKind.SIZE, ["38", "39", "40", "41", "42", "43", "44"]),
    "color": (
        "Colour",
        AttributeKind.COLOR,
        [
            ("Black", "#111111"),
            ("White", "#FFFFFF"),
            ("Navy", "#1B2A4A"),
            ("Olive", "#5A6B3B"),
            ("Maroon", "#6B1F2E"),
            ("Beige", "#D8C3A5"),
            ("Rangon Red", "#FB3208"),
        ],
    ),
    "shade": (
        "Shade",
        AttributeKind.COLOR,
        [
            ("Nude Rose", "#C98B79"),
            ("Crimson", "#B01B2E"),
            ("Coral", "#FF6F52"),
            ("Berry", "#7B2D42"),
        ],
    ),
    "volume": ("Volume", AttributeKind.NUMBER, ["15 ml", "30 ml", "50 ml", "100 ml"]),
    "capacity": ("Capacity", AttributeKind.NUMBER, ["15 L", "20 L", "25 L", "35 L"]),
    "material": ("Material", AttributeKind.TEXT, ["Cotton", "Denim", "Leather", "Canvas", "Linen"]),
    "gender": ("Gender", AttributeKind.TEXT, ["Men", "Women", "Unisex", "Kids"]),
    "fit": ("Fit", AttributeKind.TEXT, ["Slim", "Regular", "Relaxed"]),
}

CATEGORY_TREE = {
    "Men": ["Shirts", "T-Shirts", "Panjabi", "Trousers"],
    "Women": ["Kurti", "Saree", "Tops", "Scarves"],
    "Kids": ["Boys", "Girls"],
    "Shoes": ["Sneakers", "Sandals", "Formal"],
    "Bags": ["Backpacks", "Handbags", "Travel"],
    "Cosmetics": ["Lipstick", "Skincare", "Fragrance"],
}

CATEGORY_ATTRIBUTES = {
    "Shirts": ["size", "color", "material", "gender", "fit"],
    "T-Shirts": ["size", "color", "material", "gender", "fit"],
    "Panjabi": ["size", "color", "material", "gender"],
    "Trousers": ["size", "color", "material", "gender", "fit"],
    "Kurti": ["size", "color", "material", "gender"],
    "Saree": ["color", "material"],
    "Tops": ["size", "color", "material", "gender"],
    "Scarves": ["color", "material"],
    "Boys": ["size", "color"],
    "Girls": ["size", "color"],
    "Sneakers": ["shoe-size", "color", "material", "gender"],
    "Sandals": ["shoe-size", "color", "gender"],
    "Formal": ["shoe-size", "color", "material", "gender"],
    "Backpacks": ["color", "capacity", "material"],
    "Handbags": ["color", "material"],
    "Travel": ["color", "capacity", "material"],
    "Lipstick": ["shade"],
    "Skincare": ["volume"],
    "Fragrance": ["volume"],
}

PRODUCTS: list[dict[str, Any]] = [
    # name, category, brand, price, cost, variant attributes
    {
        "name": "Classic Oxford Shirt",
        "category": "Shirts",
        "brand": "Rangon",
        "price": "2450",
        "cost": "1200",
        "attrs": {"size": ["S", "M", "L", "XL"], "color": ["White", "Navy"]},
    },
    {
        "name": "Essential Cotton T-Shirt",
        "category": "T-Shirts",
        "brand": "Rangon",
        "price": "890",
        "cost": "380",
        "attrs": {"size": ["S", "M", "L", "XL"], "color": ["Black", "White", "Olive"]},
    },
    {
        "name": "Embroidered Panjabi",
        "category": "Panjabi",
        "brand": "Nokshi",
        "price": "3950",
        "cost": "2100",
        "attrs": {"size": ["M", "L", "XL"], "color": ["Beige", "Maroon"]},
    },
    {
        "name": "Slim Fit Chinos",
        "category": "Trousers",
        "brand": "Rangon",
        "price": "2790",
        "cost": "1350",
        "attrs": {"size": ["S", "M", "L"], "color": ["Navy", "Olive"]},
    },
    {
        "name": "Block Print Kurti",
        "category": "Kurti",
        "brand": "Nokshi",
        "price": "1890",
        "cost": "820",
        "attrs": {"size": ["S", "M", "L", "XL"], "color": ["Maroon", "Beige"]},
    },
    {
        "name": "Linen Blend Top",
        "category": "Tops",
        "brand": "Rangon",
        "price": "1450",
        "cost": "640",
        "attrs": {"size": ["S", "M", "L"], "color": ["White", "Rangon Red"]},
    },
    {
        "name": "Street Runner Sneakers",
        "category": "Sneakers",
        "brand": "Stride",
        "price": "4250",
        "cost": "2300",
        "attrs": {"shoe-size": ["39", "40", "41", "42", "43"], "color": ["Black", "White"]},
    },
    {
        "name": "Leather Formal Shoes",
        "category": "Formal",
        "brand": "Stride",
        "price": "5450",
        "cost": "3100",
        "attrs": {"shoe-size": ["40", "41", "42", "43"], "color": ["Black"]},
    },
    {
        "name": "Everyday Canvas Backpack",
        "category": "Backpacks",
        "brand": "Carry",
        "price": "2950",
        "cost": "1450",
        "attrs": {"color": ["Black", "Olive"], "capacity": ["20 L", "25 L"]},
    },
    {
        "name": "City Handbag",
        "category": "Handbags",
        "brand": "Carry",
        "price": "3450",
        "cost": "1750",
        "attrs": {"color": ["Maroon", "Beige"]},
    },
    {
        "name": "Matte Lipstick",
        "category": "Lipstick",
        "brand": "Aurelia",
        "price": "1250",
        "cost": "520",
        "attrs": {"shade": ["Nude Rose", "Crimson", "Coral", "Berry"]},
        "expiry": True,
    },
    {
        "name": "Hydrating Face Serum",
        "category": "Skincare",
        "brand": "Aurelia",
        "price": "2150",
        "cost": "980",
        "attrs": {"volume": ["30 ml", "50 ml"]},
        "expiry": True,
    },
]


class Command(BaseCommand):
    help = "Load realistic demo data for Rangon Fashion."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--reset", action="store_true", help="Delete existing demo data first.")
        parser.add_argument(
            "--orders", type=int, default=40, help="How many demo orders to create."
        )

    @transaction.atomic
    def handle(self, *args: Any, **options: Any) -> None:
        random.seed(20260817)  # deterministic demo data

        if options["reset"]:
            self._reset()

        self.stdout.write("Syncing permissions and roles…")
        sync_permissions()

        organization, branch = self._organization()
        users = self._users(branch)
        brands = self._brands()
        categories = self._categories()
        attributes = self._attributes(categories)
        products = self._products(categories, brands, attributes)
        supplier = self._supplier()
        self._purchase_stock(branch, supplier, products, users["stock@rangon.test"])
        self._shipping()
        self._coupons()
        customers = self._customers()
        self._orders(branch, users, customers, options["orders"])

        self.stdout.write(self.style.SUCCESS("\nDemo data ready."))
        self.stdout.write(f"  Organisation : {organization.name}")
        self.stdout.write(f"  Branch       : {branch.name} ({branch.code})")
        self.stdout.write(f"  Products     : {Product.objects.count()}")
        self.stdout.write(
            f"  Variants     : {sum(p.variants.count() for p in Product.objects.all())}"
        )
        self.stdout.write(f"  Stock rows   : {Inventory.objects.count()}")
        self.stdout.write("\n  Logins (password: rangon12345)")
        for email, role, *_ in STAFF:
            self.stdout.write(f"    {role:<20} {email}")
        self.stdout.write(f"    {'CUSTOMER':<20} customer@rangon.test")

    # -- steps --------------------------------------------------------------

    def _reset(self) -> None:
        from core.models import AuditLog, NumberSequence
        from engagement.models import Review, Wishlist
        from inventory.models import InventoryTransaction
        from orders.models import Cart, HeldSale, Order, Payment, Refund, ReturnRequest
        from promotions.models import CouponRedemption
        from purchasing.models import PurchaseOrder, PurchaseReceipt

        self.stdout.write(self.style.WARNING("Deleting existing data…"))
        # Order matters: financial rows reference catalogue rows with PROTECT.
        for model in (
            Review,
            Wishlist,
            Refund,
            ReturnRequest,
            Payment,
            CouponRedemption,
            HeldSale,
            Cart,
            Order,
            PurchaseReceipt,
            PurchaseOrder,
            InventoryTransaction,
            Inventory,
            AuditLog,
        ):
            model.objects.all().delete()
        Product.objects.all().delete()
        AttributeValue.objects.all().delete()
        Attribute.objects.all().delete()
        CategoryAttribute.objects.all().delete()
        Category.objects.all().delete()
        Brand.objects.all().delete()
        Coupon.objects.all().delete()
        Supplier.objects.all().delete()
        Customer.objects.all().delete()
        ShippingMethod.objects.all().delete()
        ShippingZone.objects.all().delete()
        Courier.objects.all().delete()
        User.objects.filter(email__endswith="@rangon.test").delete()
        NumberSequence.objects.all().delete()

    def _organization(self) -> tuple[Organization, Branch]:
        organization, _ = Organization.objects.get_or_create(
            slug="rangon-fashion",
            defaults={
                "name": "Rangon Fashion",
                "legal_name": "Rangon Fashion Ltd.",
                "email": "hello@rangonfashion.com",
                "phone": "+8801700000000",
                "address": "Level 3, Bashundhara City, Panthapath, Dhaka 1215",
                "currency": "BDT",
                "receipt_footer": (
                    "Thank you for shopping at Rangon Fashion.\n"
                    "Exchange within 14 days with this receipt."
                ),
                "status": Status.ACTIVE,
            },
        )
        branch, _ = Branch.objects.get_or_create(
            organization=organization,
            code="DHK1",
            defaults={
                "name": "Rangon Panthapath",
                "address": "Level 3, Bashundhara City, Panthapath, Dhaka 1215",
                "phone": "+8801700000001",
                "is_default": True,
                "register_count": 2,
            },
        )
        return organization, branch

    def _users(self, branch: Branch) -> dict[str, User]:
        users: dict[str, User] = {}
        for email, role_code, first, last in STAFF:
            existing = User.objects.filter(email=email).first()
            if existing is not None:
                users[email] = existing
                continue
            users[email] = create_staff_user(
                email=email,
                password=PASSWORD,
                role_code=role_code,
                branch=branch,
                first_name=first,
                last_name=last,
            )
        owner = users["owner@rangon.test"]
        if not owner.is_staff:
            owner.is_staff = owner.is_superuser = True
            owner.save(update_fields=["is_staff", "is_superuser"])

        if not User.objects.filter(email="customer@rangon.test").exists():
            customer_user = User.objects.create_user(
                email="customer@rangon.test",
                password=PASSWORD,
                first_name="Ayesha",
                last_name="Rahman",
                phone="01711000000",
                role=Role.objects.get(code=RoleCode.CUSTOMER),
            )
            Customer.objects.create(
                user=customer_user,
                name="Ayesha Rahman",
                email="customer@rangon.test",
                phone="01711000000",
                customer_type=CustomerType.REGISTERED,
            )
        return users

    def _brands(self) -> dict[str, Brand]:
        data = [
            ("Rangon", "The house label — everyday essentials with a sharp cut.", True),
            ("Nokshi", "Hand-blocked and embroidered pieces from local artisans.", True),
            ("Stride", "Footwear built for Dhaka streets.", True),
            ("Carry", "Bags and travel goods.", False),
            ("Aurelia", "Cosmetics and skincare.", True),
        ]
        return {
            name: Brand.objects.get_or_create(
                name=name, defaults={"description": description, "is_featured": featured}
            )[0]
            for name, description, featured in data
        }

    def _categories(self) -> dict[str, Category]:
        categories: dict[str, Category] = {}
        for position, (parent_name, children) in enumerate(CATEGORY_TREE.items()):
            parent, _ = Category.objects.get_or_create(
                name=parent_name, parent=None, defaults={"position": position}
            )
            categories[parent_name] = parent
            for child_position, child_name in enumerate(children):
                child, _ = Category.objects.get_or_create(
                    name=child_name, parent=parent, defaults={"position": child_position}
                )
                categories[child_name] = child
        return categories

    def _attributes(self, categories: dict[str, Category]) -> dict[str, Attribute]:
        attributes: dict[str, Attribute] = {}
        for position, (code, (name, kind, values)) in enumerate(ATTRIBUTES.items()):
            attribute, _ = Attribute.objects.get_or_create(
                code=code,
                defaults={
                    "name": name,
                    "kind": kind,
                    "position": position,
                    "is_variant_defining": code
                    in {"size", "shoe-size", "color", "shade", "volume", "capacity"},
                },
            )
            attributes[code] = attribute
            for value_position, value in enumerate(values):
                raw, swatch = value if isinstance(value, tuple) else (value, "")
                AttributeValue.objects.get_or_create(
                    attribute=attribute,
                    value=raw,
                    defaults={"label": raw, "swatch": swatch, "position": value_position},
                )

        for category_name, attribute_codes in CATEGORY_ATTRIBUTES.items():
            category = categories.get(category_name)
            if category is None:
                continue
            for position, code in enumerate(attribute_codes):
                CategoryAttribute.objects.get_or_create(
                    category=category,
                    attribute=attributes[code],
                    defaults={"position": position, "is_required": position < 2},
                )
        return attributes

    def _products(
        self,
        categories: dict[str, Category],
        brands: dict[str, Brand],
        attributes: dict[str, Attribute],
    ) -> list[Product]:
        products: list[Product] = []
        for spec in PRODUCTS:
            product, created = Product.objects.get_or_create(
                name=spec["name"],
                defaults={
                    "category": categories[spec["category"]],
                    "brand": brands[spec["brand"]],
                    "short_description": f"{spec['name']} by {spec['brand']}.",
                    "description": (
                        f"{spec['name']} — made for everyday wear in Dhaka's climate. "
                        "Cut and finished to Rangon's house standard."
                    ),
                    "status": PublishStatus.ACTIVE,
                    "published": True,
                    "featured": len(products) % 4 == 0,
                    "material": "Cotton" if spec["category"] in {"Shirts", "T-Shirts"} else "",
                    "care_instructions": "Machine wash cold. Do not bleach.",
                    "seo_title": f"{spec['name']} | Rangon Fashion",
                    "seo_description": f"Buy {spec['name']} online at Rangon Fashion.",
                },
            )
            products.append(product)
            if not created and product.variants.exists():
                continue

            expiry = (
                timezone.now().date() + timedelta(days=random.randint(120, 540))
                if spec.get("expiry")
                else None
            )
            groups = [
                list(attributes[code].values.filter(value__in=values).order_by("position"))
                for code, values in spec["attrs"].items()
            ]

            import itertools

            for combination in itertools.product(*groups):
                create_variant(
                    product=product,
                    attribute_values=list(combination),
                    price=Decimal(spec["price"]),
                    cost=Decimal(spec["cost"]),
                    batch_number=f"B{random.randint(1000, 9999)}" if expiry else "",
                    expiry_date=expiry,
                )
        return products

    def _supplier(self) -> Supplier:
        supplier, _ = Supplier.objects.get_or_create(
            code="SUP-001",
            defaults={
                "name": "Dhaka Textile House",
                "contact_person": "Kamrul Hasan",
                "phone": "+8801811111111",
                "email": "sales@dhakatextile.test",
                "address": "Islampur Road, Dhaka",
                "payment_terms_days": 30,
                "lead_time_days": 10,
            },
        )
        Supplier.objects.get_or_create(
            code="SUP-002",
            defaults={
                "name": "Chattogram Leather Co.",
                "contact_person": "Rina Das",
                "phone": "+8801822222222",
                "lead_time_days": 21,
            },
        )
        return supplier

    def _purchase_stock(
        self, branch: Branch, supplier: Supplier, products: list[Product], actor: User
    ) -> None:
        if Inventory.objects.filter(on_hand__gt=0).exists():
            return

        lines: list[PurchaseLine] = []
        for product in products:
            for variant in product.variants.all():
                lines.append(
                    PurchaseLine(
                        variant_id=variant.pk,
                        quantity=random.randint(12, 40),
                        unit_cost=variant.cost,
                    )
                )

        # Two purchase orders so the demo shows a completed and a partial one.
        half = len(lines) // 2
        first = create_purchase_order(
            supplier=supplier,
            branch=branch,
            lines=lines[:half],
            actor=actor,
            invoice_number="INV-2026-0455",
            notes="Opening stock — first tranche",
        )
        send_purchase_order(purchase_order=first, actor=actor)
        receive_purchase(
            purchase_order=first,
            lines={str(item.pk): item.quantity_ordered for item in first.items.all()},
            actor=actor,
            notes="Full delivery",
        )

        second = create_purchase_order(
            supplier=supplier,
            branch=branch,
            lines=lines[half:],
            actor=actor,
            invoice_number="INV-2026-0461",
            notes="Opening stock — second tranche",
        )
        send_purchase_order(purchase_order=second, actor=actor)
        receive_purchase(
            purchase_order=second,
            lines={
                str(item.pk): max(item.quantity_ordered - random.randint(0, 6), 1)
                for item in second.items.all()
            },
            actor=actor,
            notes="Partial delivery — remainder to follow",
        )

    def _shipping(self) -> None:
        courier, _ = Courier.objects.get_or_create(
            code="pathao",
            defaults={
                "name": "Pathao Courier",
                "phone": "+8809610003030",
                "tracking_url_template": "https://merchant.pathao.com/tracking/{tracking_number}",
            },
        )
        Courier.objects.get_or_create(code="in-house", defaults={"name": "Rangon Delivery"})

        inside, _ = ShippingZone.objects.get_or_create(
            name="Inside Dhaka",
            defaults={
                "cities": ["dhaka", "dhaka city", "gulshan", "banani", "uttara", "mirpur"],
                "position": 0,
            },
        )
        outside, _ = ShippingZone.objects.get_or_create(
            name="Outside Dhaka",
            defaults={"is_default": True, "position": 1, "cities": []},
        )

        ShippingMethod.objects.get_or_create(
            zone=inside,
            code="standard",
            defaults={
                "name": "Standard delivery",
                "price": Decimal("70.00"),
                "free_over": Decimal("3000.00"),
                "min_days": 1,
                "max_days": 2,
            },
        )
        ShippingMethod.objects.get_or_create(
            zone=inside,
            code="express",
            defaults={
                "name": "Same-day express",
                "price": Decimal("150.00"),
                "min_days": 1,
                "max_days": 1,
                "position": 1,
            },
        )
        ShippingMethod.objects.get_or_create(
            zone=outside,
            code="standard",
            defaults={
                "name": "Nationwide delivery",
                "price": Decimal("130.00"),
                "free_over": Decimal("5000.00"),
                "min_days": 2,
                "max_days": 5,
            },
        )
        ShippingMethod.objects.get_or_create(
            zone=inside,
            code="pickup",
            defaults={
                "name": "Collect from store",
                "price": Decimal("0.00"),
                "is_pickup": True,
                "min_days": 0,
                "max_days": 1,
                "position": 2,
            },
        )

    def _coupons(self) -> None:
        now = timezone.now()
        Coupon.objects.get_or_create(
            code="RANGON10",
            defaults={
                "description": "10% off your order",
                "discount_type": DiscountType.PERCENTAGE,
                "value": Decimal("10.00"),
                "minimum_order_value": Decimal("1500.00"),
                "maximum_discount": Decimal("500.00"),
                "starts_at": now - timedelta(days=7),
                "ends_at": now + timedelta(days=60),
                "usage_limit": 500,
                "usage_limit_per_customer": 1,
                "channels": [Channel.ONLINE],
            },
        )
        Coupon.objects.get_or_create(
            code="FREESHIP",
            defaults={
                "description": "Free delivery",
                "discount_type": DiscountType.FREE_SHIPPING,
                "value": Decimal("1.00"),
                "minimum_order_value": Decimal("2000.00"),
                "starts_at": now - timedelta(days=1),
                "ends_at": now + timedelta(days=30),
                "channels": [Channel.ONLINE],
            },
        )
        Coupon.objects.get_or_create(
            code="EXPIRED50",
            defaults={
                "description": "Expired coupon (for testing refusals)",
                "discount_type": DiscountType.FIXED,
                "value": Decimal("50.00"),
                "starts_at": now - timedelta(days=90),
                "ends_at": now - timedelta(days=30),
            },
        )

    def _customers(self) -> list[Customer]:
        names = [
            ("Ayesha Rahman", "01711000000"),
            ("Imran Chowdhury", "01712000001"),
            ("Sadia Noor", "01713000002"),
            ("Mahmud Hasan", "01714000003"),
            ("Tasnim Karim", "01715000004"),
            ("Rezaul Karim", "01716000005"),
        ]
        customers = []
        for name, phone in names:
            customer, created = Customer.objects.get_or_create(
                phone=phone,
                defaults={
                    "name": name,
                    "email": f"{phone}@example.test",
                    "customer_type": CustomerType.REGISTERED,
                },
            )
            if created:
                CustomerAddress.objects.create(
                    customer=customer,
                    recipient_name=name,
                    phone=phone,
                    line1=f"House {random.randint(1, 120)}, Road {random.randint(1, 25)}",
                    area=random.choice(["Dhanmondi", "Gulshan", "Uttara", "Mirpur"]),
                    city="Dhaka",
                    postal_code="1207",
                    is_default=True,
                )
            customers.append(customer)
        return customers

    def _orders(
        self, branch: Branch, users: dict[str, User], customers: list[Customer], count: int
    ) -> None:
        from catalog.models import ProductVariant

        cashier = users["cashier@rangon.test"]
        manager = users["manager@rangon.test"]
        in_stock = list(
            ProductVariant.objects.filter(inventory__branch=branch, inventory__on_hand__gt=3)[:120]
        )
        if not in_stock:
            return

        pos_count = int(count * 0.6)

        for index in range(pos_count):
            lines = [
                SaleLineInput(variant_id=variant.pk, quantity=random.randint(1, 2))
                for variant in random.sample(in_stock, random.randint(1, 3))
            ]
            try:
                total_guess = sum(
                    ProductVariant.objects.get(pk=line.variant_id).price * line.quantity
                    for line in lines
                )
                pos_services.create_pos_sale(
                    branch=branch,
                    actor=cashier,
                    data=SaleInput(
                        lines=lines,
                        payments=[
                            PaymentInput(
                                method=random.choice(
                                    [
                                        PaymentMethod.CASH,
                                        PaymentMethod.CARD,
                                        PaymentMethod.MOBILE_MFS,
                                    ]
                                ),
                                amount=total_guess,
                                tendered_amount=total_guess,
                            )
                        ],
                        customer_id=random.choice(customers).pk if index % 3 == 0 else None,
                        register=f"REG-{random.randint(1, 2):02d}",
                    ),
                )
            except Exception as exc:  # a demo order failing must not abort the seed
                self.stderr.write(f"  POS demo order skipped: {exc}")

        for index in range(count - pos_count):
            customer = random.choice(customers)
            cart = checkout_services.get_or_create_cart(customer=customer, branch=branch)
            cart.items.all().delete()
            for variant in random.sample(in_stock, random.randint(1, 3)):
                try:
                    checkout_services.add_item(cart=cart, variant_id=variant.pk, quantity=1)
                except Exception as exc:
                    # Earlier demo orders may have exhausted this variant.
                    self.stderr.write(f"  cart line skipped ({variant.sku}): {exc}")
            if not cart.items.exists():
                continue

            address = customer.addresses.first()
            try:
                order = checkout_services.place_order(
                    cart=cart,
                    shipping_address=address.as_snapshot()
                    if address
                    else {
                        "recipient_name": customer.name,
                        "phone": customer.phone or "",
                        "line1": "Demo address",
                        "city": "Dhaka",
                    },
                    payment_method=PaymentMethod.COD,
                    shipping_method_id=ShippingMethod.objects.filter(code="standard").first().pk,
                    customer=customer,
                    idempotency_key=f"seed-order-{index}",
                )
            except Exception as exc:
                self.stderr.write(f"  Online demo order skipped: {exc}")
                continue

            # Walk a share of them down the fulfilment path so the admin has
            # orders in every status.
            stage = index % 5
            if stage >= 1:
                transition(
                    order=order, to_status=OrderStatus.PROCESSING, actor=manager, notify=False
                )
            if stage >= 2:
                transition(order=order, to_status=OrderStatus.PACKED, actor=manager, notify=False)
            if stage >= 3:
                transition(order=order, to_status=OrderStatus.SHIPPED, actor=manager, notify=False)
            if stage >= 4:
                transition(
                    order=order, to_status=OrderStatus.DELIVERED, actor=manager, notify=False
                )
                from orders.services import payments as payment_services

                pending = order.payments.filter(status="PENDING").first()
                if pending is not None:
                    payment_services.capture_payment(payment=pending, actor=manager)
