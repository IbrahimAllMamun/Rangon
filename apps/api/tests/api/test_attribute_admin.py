"""Editing attributes and their values, through the API.

Written before the admin screen is built over it, for the same reason the rest
of `test_taxonomy_admin.py` was: every pass that skipped that step found the
defects afterwards instead (docs/roadmap.md).

The screen this guards was read-only, on the stated grounds that "variants
reference these values, so editing one rewrites history". `OrderItem` says
otherwise -- it snapshots `sku`, `product_name` and `variant_label` under the
comment "history must not move when the catalogue changes" -- so renaming a
value is safe and was withheld for a reason the schema contradicts. What is
genuinely unsafe is narrower, and each of those cases is pinned below.
"""

from __future__ import annotations

import pytest

from catalog.models import AttributeValue
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def admin(shop, auth_client):
    return auth_client(shop["owner"])


class TestSwatchIsAColourOrNothing:
    """`swatch` is rendered straight into `style={{ backgroundColor }}`.

    Anything that is not a colour is stored happily and then paints nothing, so
    the shopper chooses between two identical circles. The field is a plain
    `CharField(max_length=32)`; nothing but this validation stops it — which
    matters more now that a colour picker writes it.
    """

    @pytest.mark.parametrize("bad", ["navy", "rgb(0,0,128)", "#12345", "1E3A8A", "#ggghhh"])
    def test_a_non_colour_is_refused(self, admin, shop, bad):
        _, values = factories.attribute("colour", name="Colour", values=["Navy"])

        response = admin.patch(
            f"/api/v1/attribute-values/{values[0].pk}/", {"swatch": bad}, format="json"
        )

        assert response.status_code == 400
        values[0].refresh_from_db()
        assert values[0].swatch == ""

    @pytest.mark.parametrize("good", ["#fff", "#1E3A8A", "#1e3a8aff"])
    def test_a_hex_colour_is_accepted_and_normalised(self, admin, shop, good):
        _, values = factories.attribute("colour", name="Colour", values=["Navy"])

        response = admin.patch(
            f"/api/v1/attribute-values/{values[0].pk}/", {"swatch": good}, format="json"
        )

        assert response.status_code == 200
        values[0].refresh_from_db()
        # Lower-cased, so two spellings of one colour compare equal.
        assert values[0].swatch == good.lower()

    def test_blank_stays_blank(self, admin, shop):
        """Not every attribute is a colour; an empty swatch is the normal case."""
        _, values = factories.attribute("material", name="Material", values=["Cotton"])

        response = admin.patch(
            f"/api/v1/attribute-values/{values[0].pk}/", {"swatch": ""}, format="json"
        )

        assert response.status_code == 200
        values[0].refresh_from_db()
        assert values[0].swatch == ""


def _order(attribute) -> list[str]:
    return list(
        AttributeValue.objects.filter(attribute=attribute)
        .order_by("position", "value")
        .values_list("value", flat=True)
    )


def _numbered(values) -> None:
    for index, value in enumerate(values):
        value.position = index
        value.save(update_fields=["position"])


class TestValuesCanBeReordered:
    """Up/down rather than drag, so the control works from a keyboard (ADR-0009)."""

    def test_moving_down_swaps_with_the_next_value(self, admin, shop):
        attribute, values = factories.attribute("size", name="Size", values=["S", "M", "L"])
        _numbered(values)

        response = admin.post(
            f"/api/v1/attribute-values/{values[0].pk}/move/", {"direction": "down"}, format="json"
        )

        assert response.status_code == 200
        assert _order(attribute) == ["M", "S", "L"]

    def test_moving_up_swaps_with_the_previous_value(self, admin, shop):
        attribute, values = factories.attribute("size", name="Size", values=["S", "M", "L"])
        _numbered(values)

        admin.post(
            f"/api/v1/attribute-values/{values[2].pk}/move/", {"direction": "up"}, format="json"
        )

        assert _order(attribute) == ["S", "L", "M"]

    def test_values_that_all_share_position_zero_still_reorder(self, admin, shop):
        """The seeded case, and the one a naive swap gets wrong.

        Every value arrives at `position = 0`, so swapping two zeroes changes
        nothing and the ordering falls through to `value` alphabetically. The
        run has to be renumbered instead.
        """
        # A code the `shop` fixture does not already seed: `factories.attribute`
        # is `get_or_create`, so reusing "size" appends to the fixture's S/M/L
        # instead of giving this test an attribute of its own.
        attribute, values = factories.attribute(
            "fit", name="Fit", values=["Large", "Medium", "Small"]
        )
        assert {value.position for value in values} == {0}
        first = AttributeValue.objects.filter(attribute=attribute).order_by("value").first()

        response = admin.post(
            f"/api/v1/attribute-values/{first.pk}/move/", {"direction": "down"}, format="json"
        )

        assert response.status_code == 200
        assert _order(attribute) == ["Medium", "Large", "Small"]

    def test_moving_past_the_end_is_a_no_op_rather_than_an_error(self, admin, shop):
        attribute, values = factories.attribute("size", name="Size", values=["S", "M"])
        _numbered(values)

        response = admin.post(
            f"/api/v1/attribute-values/{values[1].pk}/move/", {"direction": "down"}, format="json"
        )

        assert response.status_code == 200
        assert _order(attribute) == ["S", "M"]

    def test_a_direction_that_is_not_up_or_down_is_refused(self, admin, shop):
        _, values = factories.attribute("size", name="Size", values=["S", "M"])

        response = admin.post(
            f"/api/v1/attribute-values/{values[0].pk}/move/",
            {"direction": "sideways"},
            format="json",
        )

        assert response.status_code == 400

    def test_a_move_does_not_reach_into_another_attribute(self, admin, shop):
        """Siblings are values of the *same* attribute; Size must not reorder Colour."""
        _, size_values = factories.attribute("size", name="Size", values=["S", "M"])
        _, colour_values = factories.attribute("colour", name="Colour", values=["Navy", "Red"])
        before = {value.pk: value.position for value in colour_values}

        admin.post(
            f"/api/v1/attribute-values/{size_values[0].pk}/move/",
            {"direction": "down"},
            format="json",
        )

        for value in colour_values:
            value.refresh_from_db()
            assert value.position == before[value.pk]


class TestWhatIsInUseIsProtectedInWords:
    """The database already refuses these. What it does not do is say why."""

    def test_deleting_an_attribute_that_defines_variants_says_how_many(self, admin, shop):
        link = shop["variants"][0].attribute_values.first()
        assert link is not None

        response = admin.delete(f"/api/v1/attributes/{link.attribute_id}/")

        assert response.status_code == 409
        error = response.json()["error"]
        assert error["details"]["variant_usage"] >= 1
        assert "variant" in error["message"].lower()

    def test_deleting_a_value_in_use_explains_the_alternative(self, admin, shop):
        link = shop["variants"][0].attribute_values.first()

        response = admin.delete(f"/api/v1/attribute-values/{link.attribute_value_id}/")

        assert response.status_code == 409
        error = response.json()["error"]
        assert error["details"]["variant_usage"] >= 1
        # Renaming *is* safe: orders froze their own label at sale time.
        assert "rename" in error["message"].lower()

    def test_a_value_in_use_can_still_be_renamed(self, admin, shop):
        """The whole reason the screen can be made editable at all."""
        link = shop["variants"][0].attribute_values.first()
        value = link.attribute_value

        response = admin.patch(
            f"/api/v1/attribute-values/{value.pk}/", {"label": "Midnight"}, format="json"
        )

        assert response.status_code == 200
        value.refresh_from_db()
        assert value.display == "Midnight"

    def test_it_cannot_stop_being_variant_defining_while_variants_rely_on_it(self, admin, shop):
        link = shop["variants"][0].attribute_values.first()
        attribute = link.attribute
        assert attribute.is_variant_defining

        response = admin.patch(
            f"/api/v1/attributes/{attribute.pk}/", {"is_variant_defining": False}, format="json"
        )

        assert response.status_code == 400
        attribute.refresh_from_db()
        assert attribute.is_variant_defining is True

    def test_an_unused_attribute_can_be_changed_freely(self, admin, shop):
        attribute, _ = factories.attribute("material", name="Material", values=["Cotton"])

        response = admin.patch(
            f"/api/v1/attributes/{attribute.pk}/",
            {"is_variant_defining": False, "name": "Fabric"},
            format="json",
        )

        assert response.status_code == 200
        attribute.refresh_from_db()
        assert attribute.is_variant_defining is False
        assert attribute.name == "Fabric"


class TestVariantUsageIsCheap:
    def test_the_list_does_not_run_a_query_per_attribute(
        self, admin, shop, django_assert_max_num_queries
    ):
        """One subquery, not one COUNT per row.

        `VariantAttributeValue.attribute` is `related_name="+"`, so there is no
        reverse relation to annotate across and the obvious implementation is a
        per-row count that grows with the catalogue.
        """
        for code in ("material", "fit", "season", "origin", "care"):
            factories.attribute(code, name=code.title(), values=["A", "B"])

        with django_assert_max_num_queries(6):
            response = admin.get("/api/v1/attributes/")

        assert response.status_code == 200
        payload = response.json()
        rows = payload if isinstance(payload, list) else payload["results"]
        assert all("variant_usage" in row for row in rows)
        assert any(row["variant_usage"] > 0 for row in rows)
