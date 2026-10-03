"""The label-mark migration is additive, and the marks stay that way.

The instruction that came with the label marks (2026-10-03) was that the
migration must be safe to run on a live shop -- nothing already in the database
may be deleted -- and that the marks, once recorded, are not lost either.
Three things hold that in place:

  * `inventory.0004_labelprint` only *creates*: one new table and its index.
    It names no existing model, so it has nothing to alter or drop.
  * Applied to a database that already holds a stocked shop, it leaves every
    existing row of every table byte-for-byte as it was.
  * No migration, this one or any later one, removes, renames, retypes or
    rewrites `LabelPrint` or a column of it. A later change to the table has to
    be additive too. If one genuinely must not be, this test is the place that
    says so out loud, rather than a migration quietly taking the marks with it.
"""

from __future__ import annotations

import pytest
from django.db import connection, models
from django.db.migrations import Migration
from django.db.migrations import operations as ops
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader

from tests import factories

APP = "inventory"
MIGRATION = "0004_labelprint"
BEFORE = "0003_inventorytransaction_idempotency_key_and_more"
TABLE = "inventory_labelprint"

#: What a migration may do to `LabelPrint`: add to it, or change Python-side
#: options (ordering, verbose names) that never reach a row.
ADDITIVE = (
    ops.CreateModel,
    ops.AddField,
    ops.AddIndex,
    ops.AddConstraint,
    ops.AlterModelOptions,
)


def _targets_label_print(app_label: str, operation: object) -> bool:
    if app_label != APP:
        return False
    names = {
        str(getattr(operation, attribute, "")).lower()
        for attribute in ("name", "model_name", "old_name", "new_name")
    }
    if "labelprint" in names:
        return True
    if isinstance(operation, ops.RunSQL):
        return TABLE in str(operation.sql).lower()
    return False


def test_the_migration_only_creates_the_new_table() -> None:
    migration = MigrationLoader(None, ignore_no_migrations=True).disk_migrations[(APP, MIGRATION)]

    assert [type(operation) for operation in migration.operations] == [ops.CreateModel]
    (create,) = migration.operations
    assert create.name == "LabelPrint"
    assert create.options["db_table"] == TABLE


def _offending(found: dict[tuple[str, str], Migration]) -> list[str]:
    return [
        f"{app_label}.{name}: {type(operation).__name__}"
        for (app_label, name), migration in found.items()
        for operation in migration.operations
        if _targets_label_print(app_label, operation) and not isinstance(operation, ADDITIVE)
    ]


def test_no_migration_takes_anything_away_from_the_marks() -> None:
    loader = MigrationLoader(None, ignore_no_migrations=True)
    # Under `pytest --no-migrations` the loader sees no migrations at all, and
    # the check below would pass by looking at nothing.
    assert (APP, MIGRATION) in loader.disk_migrations, "migrations are not visible to this run"

    assert _offending(loader.disk_migrations) == [], (
        "A migration removes or rewrites label marks. They are append-only "
        "history; change the table additively instead."
    )


def test_the_guard_recognises_a_destructive_change() -> None:
    """The check above passes on an honest history; this proves it can fail."""
    probe = Migration("9999_probe", APP)
    probe.operations = [
        ops.RemoveField(model_name="labelprint", name="quantity"),
        ops.AlterField(model_name="labelprint", name="on_hand", field=models.SmallIntegerField()),
        ops.RenameModel(old_name="LabelPrint", new_name="StickerRun"),
        ops.DeleteModel(name="LabelPrint"),
        ops.RunSQL("DELETE FROM inventory_labelprint"),
        # Additive, and a different model: neither is flagged.
        ops.AddIndex(
            model_name="labelprint", index=models.Index(fields=["printed"], name="probe_idx")
        ),
        ops.RemoveField(model_name="inventory", name="bin_location"),
    ]

    assert _offending({(APP, probe.name): probe}) == [
        f"{APP}.9999_probe: RemoveField",
        f"{APP}.9999_probe: AlterField",
        f"{APP}.9999_probe: RenameModel",
        f"{APP}.9999_probe: DeleteModel",
        f"{APP}.9999_probe: RunSQL",
    ]


def _fingerprint() -> dict[str, tuple[int, str]]:
    """Row count and a digest of every row, for every table but the new one."""
    tables = sorted(
        name
        for name in connection.introspection.table_names()
        if name not in {TABLE, "django_migrations"}
    )
    snapshot: dict[str, tuple[int, str]] = {}
    with connection.cursor() as cursor:
        for table in tables:
            quoted = connection.ops.quote_name(table)
            cursor.execute(
                f"SELECT count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) "  # noqa: S608 -- table names come from the database itself
                f"FROM {quoted} t"
            )
            count, digest = cursor.fetchone()
            snapshot[table] = (count, digest)
    return snapshot


@pytest.mark.django_db(transaction=True)
def test_applying_it_to_a_stocked_shop_changes_no_existing_row() -> None:
    """The shape of a real upgrade: a shop that predates the label marks."""
    shop = factories.full_shop()
    factories.stock(shop["variants"][0], shop["branch"], 3)

    executor = MigrationExecutor(connection)
    executor.migrate([(APP, BEFORE)])
    try:
        assert TABLE not in connection.introspection.table_names()
        before = _fingerprint()
        assert before["catalog_productvariant"][0] >= 2
        assert before["inventory_inventorytransaction"][0] >= 3

        executor.loader.build_graph()
        executor.migrate([(APP, MIGRATION)])

        assert TABLE in connection.introspection.table_names()
        assert _fingerprint() == before
        with connection.cursor() as cursor:
            cursor.execute(f"SELECT count(*) FROM {TABLE}")  # noqa: S608 -- a constant
            assert cursor.fetchone()[0] == 0
    finally:
        # Whatever happened above, leave the schema at the latest state for
        # the tests that run after this one.
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())
