"""A second active branch and a stock ledger with history, for the inventory admin (phase 4).

    docker compose -p rangon-nest -f docker-compose.nest.yml exec -T django \\
        python manage.py shell < apps/api-nest/parity/fixture_inventory.py

All or nothing, and a second run finds the branch and stops. Test data for the
parity database only; the account shares the password in fixture_accounts.py.
Every stock movement goes through `inventory.services`, so the ledger and the
cached rows agree. What each row is for:
- PAR3 "Parity Mirpur": an active branch that does not fulfil online orders,
  so the storefront still ships from DHK1. Its stock arrives by a transfer
  from DHK1 (a `stock_transfer` document), so it has been "received" there.
- `parity.mirpur`: a MANAGER at PAR3 -- branch-scoped reads, and a refusal
  when acting on DHK1.
- At PAR3: RGN-BLO-L-BEI at 4 (low stock), RGN-CLA-L-WHI at 6 after a
  write-off whose idempotency key stays claimed, RGN-ESS-XL-WHI counted down
  to 0 (out of stock), two unnamed PAR-TEE variants as opening stock (labels
  read from their attributes), and PAR-FREE with a row and no history (never
  received: an adjustment upwards is refused).
- At DHK1: a stock count applied (a `stock_count` document), and two
  adjustments whose references resolve to nothing -- one not a UUID, one a
  real order's id in capitals.
- For the transfer and count admin: a transfer of one RGN-LIN-M-WHI from DHK1
  to PAR3 whose idempotency key stays claimed; counts being counted at DHK1
  (two lines counted, one up and one down, a third not), at PAR3 (one line
  counted up on a variant PAR3 never received, so applying it is refused)
  and at DHK1 with nothing counted; and a cancelled one.
"""

from django.db import transaction
from django.utils import timezone

from accounts.models import Branch, Role, RoleCode, Status, User
from accounts.services import get_organization
from catalog.models import ProductVariant
from core.services import next_number
from inventory import services as stock
from inventory.models import Inventory, StockCount, StockCountItem, StockCountStatus
from orders.models import Order

PARITY_PASSWORD = "Parity-Pass-2026!"
MARKER = "PAR3"


def variant(sku: str) -> ProductVariant:
    return ProductVariant.objects.get(sku=sku)


def apply() -> None:
    owner = User.objects.get(email="owner@rangon.test")
    home = Branch.objects.get(code="DHK1")
    mirpur = Branch.objects.create(
        organization=get_organization(),
        name="Parity Mirpur",
        code=MARKER,
        address="Mirpur 10, Dhaka",
        status=Status.ACTIVE,
        is_default=False,
        fulfils_online_orders=False,
    )
    User.objects.create_user(
        email="parity.mirpur@rangon.test",
        password=PARITY_PASSWORD,
        role=Role.objects.get(code=RoleCode.MANAGER),
        organization=get_organization(),
        branch=mirpur,
    )

    stock.transfer(
        source_branch=home,
        target_branch=mirpur,
        lines=[
            (variant("RGN-BLO-L-BEI"), 4),
            (variant("RGN-CLA-L-WHI"), 8),
            (variant("RGN-ESS-XL-WHI"), 6),
        ],
        actor=owner,
        notes="Opening stock for Mirpur",
    )
    stock.write_off(
        branch=mirpur,
        variant=variant("RGN-CLA-L-WHI"),
        quantity=2,
        transaction_type="DAMAGE",
        reason="Water damage in the stockroom",
        actor=owner,
        notes="Two shirts",
        idempotency_key="parity-fixture-write-off",
    )
    stock.adjust(
        branch=mirpur,
        variant=variant("RGN-ESS-XL-WHI"),
        new_on_hand=0,
        reason="Shelf count",
        actor=owner,
    )
    for sku, quantity, cost in (("PAR-TEE-S-WHT", 9, "310.00"), ("PAR-TEE-M-WHT", 3, "310.00")):
        stock.receive_stock(
            branch=mirpur,
            variant=variant(sku),
            quantity=quantity,
            unit_cost=cost,
            actor=owner,
            reference_type="product_import",
            notes="Opening stock",
        )
    # A row with no history: what `_lock_inventories` leaves behind.
    stock.get_or_create_inventory(mirpur, variant("PAR-FREE"))

    # A count at DHK1, applied: one line down, one unchanged.
    count = StockCount.objects.create(
        number=next_number("stock_count", prefix="SC"),
        branch=home,
        created_by=owner,
        status=StockCountStatus.COUNTING,
        notes="Parity cycle count",
    )
    for sku, counted in (("RGN-LIN-M-WHI", -1), ("RGN-CLA-L-WHI", 0)):
        row = Inventory.objects.get(branch=home, variant=variant(sku))
        StockCountItem.objects.create(
            stock_count=count,
            variant_id=row.variant_id,
            expected_quantity=row.on_hand,
            counted_quantity=row.on_hand + counted,
        )
    stock.apply_stock_count(count=count, actor=owner)

    # References with nothing to open.
    stock.apply_transaction(
        branch=home,
        variant=variant("RGN-ESS-XL-WHI"),
        transaction_type="ADJUSTMENT",
        quantity=-1,
        actor=owner,
        reference_type="order",
        reference_id="legacy-42",
        reason="Imported from the old till",
    )
    order = Order.objects.order_by("created_at").first()
    stock.apply_transaction(
        branch=home,
        variant=variant("RGN-ESS-XL-WHI"),
        transaction_type="ADJUSTMENT",
        quantity=-1,
        actor=None,
        reference_type="order",
        reference_id=str(order.pk).upper(),
        reason="Reference in capitals",
    )
    stock.transfer(
        source_branch=home,
        target_branch=mirpur,
        lines=[(variant("RGN-LIN-M-WHI"), 1)],
        actor=owner,
        notes="One for the window",
        idempotency_key="parity-fixture-transfer",
    )

    def sheet(branch: Branch, notes: str, lines: dict[str, int | None], status: str) -> None:
        sheet = StockCount.objects.create(
            number=next_number("stock_count", prefix="SC"),
            branch=branch,
            created_by=owner,
            status=status,
            notes=notes,
        )
        for sku, change in lines.items():
            row = Inventory.objects.get(branch=branch, variant=variant(sku))
            StockCountItem.objects.create(
                stock_count=sheet,
                variant_id=row.variant_id,
                expected_quantity=row.on_hand,
                counted_quantity=None if change is None else row.on_hand + change,
            )

    sheet(
        home,
        "Parity counting",
        {"RGN-CLA-L-WHI": 2, "RGN-BLO-L-BEI": -1, "RGN-ESS-XL-WHI": None},
        StockCountStatus.COUNTING,
    )
    sheet(
        mirpur,
        "Parity Mirpur counting",
        {"RGN-BLO-L-BEI": -1, "PAR-FREE": 2, "PAR-TEE-S-WHT": None},
        StockCountStatus.COUNTING,
    )
    sheet(home, "Parity nothing counted", {"RGN-CLA-L-WHI": None}, StockCountStatus.COUNTING)
    sheet(home, "Parity abandoned", {"RGN-BLO-L-BEI": None}, StockCountStatus.CANCELLED)
    print(f"parity inventory fixture applied at {timezone.now().isoformat()}")


if Branch.objects.filter(code=MARKER).exists():
    print("parity inventory fixture already applied")
else:
    with transaction.atomic():
        apply()
