"""One walk-in customer per branch, and the merge that gets there (D43).

`pos.walk_in_customer()` resolves the branch's anonymous counter row with
`get_or_create`, which is only atomic when a unique constraint backs its
lookup.  The race itself is proved in `test_concurrency.py`; what is proved
here is the constraint that makes it impossible and the data migration that
collapses the duplicates an unconstrained database may already hold.
"""

from __future__ import annotations

import importlib
from decimal import Decimal

import pytest
from django.apps import apps as django_apps
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from customers.models import Customer
from orders.models import Order, OrderStatus
from orders.services import pos
from tests import factories

pytestmark = pytest.mark.django_db

MIGRATION = importlib.import_module("customers.migrations.0002_merge_duplicate_walk_in_customers")


def _walk_in(name: str, **kwargs) -> Customer:
    return Customer.objects.create(name=name, is_walk_in=True, customer_type="WALK_IN", **kwargs)


def _order(customer: Customer, branch, *, total: str) -> Order:
    return Order.objects.create(
        number=factories.unique("RGN-POS-"),
        branch=branch,
        customer=customer,
        channel="POS",
        status=OrderStatus.DELIVERED,
        payment_status="PAID",
        subtotal=Decimal(total),
        grand_total=Decimal(total),
        paid_total=Decimal(total),
        placed_at=timezone.now(),
    )


def _drop_the_constraint() -> None:
    """Recreate the pre-fix schema for one test.

    The constraint is a partial unique *index* in PostgreSQL.  Dropping it is
    DDL inside the test's transaction, so the rollback at the end of the test
    puts it back — nothing leaks into the next one.
    """
    with connection.cursor() as cursor:
        cursor.execute("DROP INDEX customers_customer_walk_in_name_uniq")


def test_a_branch_cannot_hold_two_walk_in_customers():
    _walk_in("Walk-in (DHK)")

    with pytest.raises(IntegrityError), transaction.atomic():
        _walk_in("Walk-in (DHK)")


def test_other_branches_and_ordinary_customers_are_unaffected():
    _walk_in("Walk-in (DHK)")
    _walk_in("Walk-in (CTG)")
    factories.customer(name="Rana Ahmed")
    factories.customer(name="Rana Ahmed")

    assert Customer.objects.filter(is_walk_in=True).count() == 2
    assert Customer.objects.filter(name="Rana Ahmed").count() == 2


def test_walk_in_customer_returns_the_same_row_every_time():
    branch = factories.branch(factories.organization())

    first = pos.walk_in_customer(branch)
    second = pos.walk_in_customer(branch)

    assert first.pk == second.pk
    assert first.name == f"Walk-in ({branch.code})"
    assert Customer.objects.filter(is_walk_in=True).count() == 1


def test_the_migration_merges_duplicates_and_repoints_their_orders():
    branch = factories.branch(factories.organization())
    _drop_the_constraint()

    survivor = _walk_in("Walk-in (DHK)")
    # What the race actually produced: a second row for the same branch, which
    # then took counter sales of its own.
    duplicate = _walk_in(
        "Walk-in (DHK)",
        total_orders=2,
        total_spent=Decimal("750.00"),
        loyalty_points=5,
        last_order_at=timezone.now(),
    )
    first_sale = _order(survivor, branch, total="1000.00")
    stranded_sale = _order(duplicate, branch, total="750.00")

    MIGRATION.collapse_duplicate_walk_ins(django_apps, None)

    assert list(Customer.objects.filter(is_walk_in=True).values_list("pk", flat=True)) == [
        survivor.pk
    ]
    # The orders are repointed, never deleted (CLAUDE.md §3).
    first_sale.refresh_from_db()
    stranded_sale.refresh_from_db()
    assert first_sale.customer_id == survivor.pk
    assert stranded_sale.customer_id == survivor.pk
    assert Order.objects.count() == 2

    survivor.refresh_from_db()
    assert survivor.total_orders == 2
    assert survivor.total_spent == Decimal("750.00")
    assert survivor.loyalty_points == 5
    assert survivor.last_order_at == duplicate.last_order_at


def test_the_migration_leaves_a_healthy_database_alone():
    _walk_in("Walk-in (DHK)")
    _walk_in("Walk-in (CTG)")

    MIGRATION.collapse_duplicate_walk_ins(django_apps, None)

    assert Customer.objects.filter(is_walk_in=True).count() == 2
