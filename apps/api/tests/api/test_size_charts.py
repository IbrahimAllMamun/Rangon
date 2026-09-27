"""Size charts: a measurement or conversion table per Size attribute.

A size means different things in different places -- a UK 38 is an EU 48, and
one brand's M is another's L -- so a Size attribute carries as many charts as
the shop needs and each product picks the one that describes it
(docs/business-rules.md §5b).

The rules under test, each enforced by the API rather than the form:

  * only a Size attribute carries a chart;
  * every row is one of that attribute's own values, once, with one figure per
    column -- a short row would put its figures under the wrong heading;
  * a product may only use a chart for a size its category offers (or its
    variants are already built on), so a shirt never gets a shoe chart;
  * nothing a chart depends on, and no chart a product depends on, is deleted
    out from under it -- each is refused in words.
"""

from __future__ import annotations

import pytest

from catalog.models import AttributeKind, CategoryAttribute, SizeChart, SizeChartRow
from catalog.services import (
    save_size_chart,
    set_product_size_chart,
    size_chart_payload,
)
from core.exceptions import ValidationError as ServiceValidationError
from core.models import AuditLog
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def admin(shop, auth_client):
    return auth_client(shop["owner"])


@pytest.fixture
def sizes(shop):
    """The shop fixture's Size attribute (S, M) plus a Shoe size, both SIZE kind."""
    size, values = factories.attribute("size", values=["S", "M"])
    # Positioned as the seed positions them. The factory leaves every value at
    # 0, where the order falls through to the value itself and M sorts before S.
    for position, value in enumerate(values):
        value.position = position
        value.save(update_fields=["position"])
    shoe, shoe_values = factories.attribute("shoe-size", name="Shoe size", values=["40", "41"])
    return {"size": size, "s": values[0], "m": values[1], "shoe": shoe, "shoe_values": shoe_values}


def chart_body(sizes, **overrides):
    body = {
        "attribute": str(sizes["size"].pk),
        "name": "Men's shirts",
        "system": "UK",
        "columns": ["Chest (cm)", "UK"],
        "rows": [
            {"attribute_value": str(sizes["s"].pk), "cells": ["92–96", "36"]},
            {"attribute_value": str(sizes["m"].pk), "cells": ["97–101", "38"]},
        ],
        "notes": "Measure under the arms.",
    }
    body.update(overrides)
    return body


def make_chart(sizes, **overrides) -> SizeChart:
    body = chart_body(sizes, **overrides)
    attribute = body.pop("attribute")
    return save_size_chart(
        attribute=sizes["size"] if attribute == str(sizes["size"].pk) else sizes["shoe"],
        data=body,
    )


def error_of(response) -> dict:
    return response.json()["error"]


class TestCreatingAChart:
    def test_a_chart_is_stored_and_read_back_in_the_attributes_order(self, admin, sizes):
        # Put M before S on the attribute: the chart must follow the attribute.
        sizes["m"].position, sizes["s"].position = 0, 1
        sizes["m"].save(update_fields=["position"])
        sizes["s"].save(update_fields=["position"])

        response = admin.post("/api/v1/size-charts/", chart_body(sizes), format="json")

        assert response.status_code == 201, response.content
        body = response.json()
        assert body["attribute_code"] == "size"
        assert body["columns"] == ["Chest (cm)", "UK"]
        assert [row["value"] for row in body["rows"]] == ["M", "S"]
        assert body["rows"][0]["cells"] == ["97–101", "38"]
        assert body["product_count"] == 0

        chart = SizeChart.objects.get(pk=body["id"])
        assert chart.rows.count() == 2
        assert AuditLog.objects.filter(entity_type="SizeChart", entity_id=str(chart.pk)).exists()

    def test_the_list_filters_by_attribute(self, admin, sizes):
        make_chart(sizes)
        make_chart(
            sizes,
            attribute=str(sizes["shoe"].pk),
            name="Shoe conversion",
            rows=[{"attribute_value": str(sizes["shoe_values"][0].pk), "cells": ["25", "6"]}],
        )

        everything = admin.get("/api/v1/size-charts/").json()
        shoes = admin.get(f"/api/v1/size-charts/?attribute={sizes['shoe'].pk}").json()

        assert len(everything) == 2
        assert [chart["name"] for chart in shoes] == ["Shoe conversion"]

    def test_cells_are_trimmed(self, admin, sizes):
        body = chart_body(sizes, columns=["  Chest (cm) ", "UK"])
        body["rows"][0]["cells"] = ["  92 ", " 36"]

        response = admin.post("/api/v1/size-charts/", body, format="json")

        assert response.status_code == 201
        assert response.json()["columns"][0] == "Chest (cm)"
        assert response.json()["rows"][0]["cells"] == ["92", "36"]


class TestWhatAChartRefuses:
    def test_only_a_size_attribute_carries_a_chart(self, admin, sizes):
        colour, values = factories.attribute("color", name="Colour", values=["Black"])
        body = chart_body(
            sizes,
            attribute=str(colour.pk),
            rows=[{"attribute_value": str(values[0].pk), "cells": ["1", "2"]}],
        )

        response = admin.post("/api/v1/size-charts/", body, format="json")

        assert response.status_code == 400
        assert "Only a Size attribute" in error_of(response)["message"]
        assert "attribute" in error_of(response)["details"]

    def test_a_size_from_another_attribute_is_refused(self, admin, sizes):
        body = chart_body(sizes)
        body["rows"][1]["attribute_value"] = str(sizes["shoe_values"][0].pk)

        response = admin.post("/api/v1/size-charts/", body, format="json")

        assert response.status_code == 400
        assert "not a Size value" in error_of(response)["message"]
        assert not SizeChart.objects.exists()

    def test_a_size_twice_is_refused(self, admin, sizes):
        body = chart_body(sizes)
        body["rows"][1]["attribute_value"] = str(sizes["s"].pk)

        response = admin.post("/api/v1/size-charts/", body, format="json")

        assert response.status_code == 400
        assert "twice" in error_of(response)["message"]

    def test_a_row_short_of_a_figure_is_refused(self, admin, sizes):
        """The failure this rule exists for: a short row shifts every figure
        after the gap under the wrong heading, and still looks like a chart."""
        body = chart_body(sizes)
        body["rows"][0]["cells"] = ["92–96"]

        response = admin.post("/api/v1/size-charts/", body, format="json")

        assert response.status_code == 400
        assert "one per column" in error_of(response)["message"]

    def test_a_row_with_no_figures_is_refused(self, admin, sizes):
        body = chart_body(sizes)
        body["rows"][0]["cells"] = ["", "  "]

        response = admin.post("/api/v1/size-charts/", body, format="json")

        assert response.status_code == 400
        assert "no figures" in error_of(response)["message"]

    @pytest.mark.parametrize(
        ("columns", "expected"),
        [
            ([], "at least one column"),
            (["Chest", " "], "needs a heading"),
            (["UK", "uk"], "twice"),
            ([f"C{index}" for index in range(13)], "at most 12"),
        ],
    )
    def test_bad_columns_are_refused(self, admin, sizes, columns, expected):
        body = chart_body(sizes, columns=columns)
        for row in body["rows"]:
            row["cells"] = ["x"] * len(columns)

        response = admin.post("/api/v1/size-charts/", body, format="json")

        assert response.status_code == 400
        assert expected in error_of(response)["message"]
        assert "columns" in error_of(response)["details"]

    def test_a_chart_with_no_sizes_is_refused(self, admin, sizes):
        response = admin.post("/api/v1/size-charts/", chart_body(sizes, rows=[]), format="json")

        assert response.status_code == 400
        assert "at least one size" in error_of(response)["message"]

    def test_names_are_unique_per_attribute_ignoring_case(self, admin, sizes):
        make_chart(sizes)

        response = admin.post(
            "/api/v1/size-charts/", chart_body(sizes, name="MEN'S SHIRTS"), format="json"
        )

        assert response.status_code == 400
        assert "already has a chart" in error_of(response)["message"]

    def test_the_same_name_on_another_attribute_is_fine(self, sizes):
        make_chart(sizes)
        shoe_chart = make_chart(
            sizes,
            attribute=str(sizes["shoe"].pk),
            rows=[{"attribute_value": str(sizes["shoe_values"][0].pk), "cells": ["25", "6"]}],
        )
        assert shoe_chart.name == "Men's shirts"


class TestUpdatingAChart:
    def test_rows_are_replaced_not_merged(self, admin, sizes):
        chart = make_chart(sizes)

        response = admin.patch(
            f"/api/v1/size-charts/{chart.pk}/",
            {"rows": [{"attribute_value": str(sizes["m"].pk), "cells": ["99", "38"]}]},
            format="json",
        )

        assert response.status_code == 200, response.content
        assert [row["value"] for row in response.json()["rows"]] == ["M"]
        assert SizeChartRow.objects.filter(chart=chart).count() == 1

    def test_changing_columns_without_rows_is_refused(self, admin, sizes):
        """The finished chart is what is validated. Adding a column and sending
        no rows would leave every row one figure short."""
        chart = make_chart(sizes)

        response = admin.patch(
            f"/api/v1/size-charts/{chart.pk}/",
            {"columns": ["Chest (cm)", "UK", "US"]},
            format="json",
        )

        assert response.status_code == 400
        chart.refresh_from_db()
        assert chart.columns == ["Chest (cm)", "UK"]

    def test_renaming_leaves_the_rows_alone(self, admin, sizes):
        chart = make_chart(sizes)

        response = admin.patch(
            f"/api/v1/size-charts/{chart.pk}/", {"name": "Men's tops"}, format="json"
        )

        assert response.status_code == 200
        assert response.json()["name"] == "Men's tops"
        assert len(response.json()["rows"]) == 2

    def test_a_chart_cannot_move_to_another_attribute(self, admin, sizes):
        chart = make_chart(sizes)

        response = admin.patch(
            f"/api/v1/size-charts/{chart.pk}/",
            {"attribute": str(sizes["shoe"].pk)},
            format="json",
        )

        assert response.status_code == 400
        assert "cannot move" in error_of(response)["message"]

    def test_an_update_is_audited_with_what_changed(self, admin, sizes):
        chart = make_chart(sizes)

        admin.patch(f"/api/v1/size-charts/{chart.pk}/", {"system": "EU"}, format="json")

        entry = AuditLog.objects.filter(entity_id=str(chart.pk), action="UPDATE").get()
        assert entry.old_values == {"system": "UK"}
        assert entry.new_values == {"system": "EU"}

    def test_renaming_a_size_renames_it_in_every_chart(self, sizes):
        chart = make_chart(sizes)
        sizes["m"].label = "Medium"
        sizes["m"].save(update_fields=["label"])

        payload = size_chart_payload(SizeChart.objects.get(pk=chart.pk))

        assert payload is not None
        assert [row["label"] for row in payload["rows"]] == ["S", "Medium"]


class TestPermissions:
    def test_a_cashier_can_read_but_not_write(self, auth_client, shop, sizes):
        chart = make_chart(sizes)
        cashier = auth_client(shop["cashier"])

        assert cashier.get("/api/v1/size-charts/").status_code == 200
        assert (
            cashier.post("/api/v1/size-charts/", chart_body(sizes, name="X"), format="json")
        ).status_code == 403
        assert (
            cashier.patch(f"/api/v1/size-charts/{chart.pk}/", {"name": "Y"}, format="json")
        ).status_code == 403

    def test_a_manager_can_write_but_not_delete(self, auth_client, shop, sizes):
        manager = auth_client(shop["manager"])

        created = manager.post("/api/v1/size-charts/", chart_body(sizes), format="json")
        assert created.status_code == 201

        response = manager.delete(f"/api/v1/size-charts/{created.json()['id']}/")
        assert response.status_code == 403

    def test_anonymous_is_refused(self, api, sizes):
        assert api.get("/api/v1/size-charts/").status_code == 401


class TestDeletingWhatAChartDependsOn:
    def test_a_chart_in_use_is_refused_in_words(self, admin, shop, sizes):
        chart = make_chart(sizes)
        set_product_size_chart(product=shop["product"], chart=chart)

        response = admin.delete(f"/api/v1/size-charts/{chart.pk}/")

        assert response.status_code == 409
        assert "1 product" in error_of(response)["message"]
        assert error_of(response)["details"] == {"product_count": 1}
        assert SizeChart.objects.filter(pk=chart.pk).exists()

    def test_an_unused_chart_is_deleted_and_audited(self, admin, sizes):
        chart = make_chart(sizes)

        response = admin.delete(f"/api/v1/size-charts/{chart.pk}/")

        assert response.status_code == 204
        assert not SizeChart.objects.filter(pk=chart.pk).exists()
        assert not SizeChartRow.objects.filter(chart_id=chart.pk).exists()
        assert AuditLog.objects.filter(entity_id=str(chart.pk), action="DELETE").exists()

    def test_a_size_in_a_chart_cannot_be_deleted(self, admin, sizes):
        # A value no variant carries, so only the chart stands in the way.
        extra = factories.attribute("size", values=["XL"])[1][0]
        make_chart(
            sizes,
            rows=[{"attribute_value": str(extra.pk), "cells": ["110", "44"]}],
        )

        response = admin.delete(f"/api/v1/attribute-values/{extra.pk}/")

        assert response.status_code == 409
        assert "size chart" in error_of(response)["message"]
        assert error_of(response)["details"] == {"size_chart_usage": 1}

    def test_an_attribute_with_charts_cannot_be_deleted(self, admin, sizes):
        chart = save_size_chart(
            attribute=sizes["shoe"],
            data={
                "name": "Shoe conversion",
                "columns": ["UK"],
                "rows": [{"attribute_value": sizes["shoe_values"][0].pk, "cells": ["6"]}],
            },
        )

        response = admin.delete(f"/api/v1/attributes/{sizes['shoe'].pk}/")

        assert response.status_code == 409
        assert "size chart" in error_of(response)["message"]
        assert SizeChart.objects.filter(pk=chart.pk).exists()

    def test_an_attribute_with_charts_stays_a_size_attribute(self, admin, sizes):
        make_chart(sizes)

        response = admin.patch(
            f"/api/v1/attributes/{sizes['size'].pk}/", {"kind": "TEXT"}, format="json"
        )

        assert response.status_code == 400
        sizes["size"].refresh_from_db()
        assert sizes["size"].kind == AttributeKind.SIZE

    def test_an_attribute_without_charts_may_change_kind(self, admin, sizes):
        response = admin.patch(
            f"/api/v1/attributes/{sizes['shoe'].pk}/", {"kind": "TEXT"}, format="json"
        )
        assert response.status_code == 200


class TestAProductsChart:
    def test_a_chart_for_a_size_the_category_uses_is_accepted(self, admin, shop, sizes):
        product = shop["product"]
        CategoryAttribute.objects.create(category=product.category, attribute=sizes["size"])
        chart = make_chart(sizes)

        response = admin.patch(
            f"/api/v1/products/{product.pk}/", {"size_chart": str(chart.pk)}, format="json"
        )

        assert response.status_code == 200, response.content
        product.refresh_from_db()
        assert product.size_chart_id == chart.pk
        assert admin.get(f"/api/v1/products/{product.pk}/").json()["size_chart"] == str(chart.pk)
        entry = AuditLog.objects.filter(
            entity_id=str(product.pk), reason="Size chart changed"
        ).get()
        assert entry.new_values == {"size_chart": "Men's shirts"}

    def test_a_chart_for_a_size_the_category_does_not_use_is_refused(self, admin, shop, sizes):
        """A shirt is never given a shoe chart."""
        category = factories.category(name="Shirts")
        CategoryAttribute.objects.create(category=category, attribute=sizes["size"])
        product = factories.product(category=category)
        shoe_chart = save_size_chart(
            attribute=sizes["shoe"],
            data={
                "name": "Shoe conversion",
                "columns": ["UK"],
                "rows": [{"attribute_value": sizes["shoe_values"][0].pk, "cells": ["6"]}],
            },
        )

        response = admin.patch(
            f"/api/v1/products/{product.pk}/", {"size_chart": str(shoe_chart.pk)}, format="json"
        )

        assert response.status_code == 400
        assert "does not use Shoe size" in str(error_of(response)["details"]["size_chart"])
        product.refresh_from_db()
        assert product.size_chart is None

    def test_the_service_refuses_it_too(self, sizes):
        category = factories.category(name="Shirts")
        CategoryAttribute.objects.create(category=category, attribute=sizes["size"])
        product = factories.product(category=category)
        shoe_chart = save_size_chart(
            attribute=sizes["shoe"],
            data={
                "name": "Shoe conversion",
                "columns": ["UK"],
                "rows": [{"attribute_value": sizes["shoe_values"][0].pk, "cells": ["6"]}],
            },
        )

        with pytest.raises(ServiceValidationError):
            set_product_size_chart(product=product, chart=shoe_chart)

    def test_a_category_that_declares_nothing_offers_every_chart(self, admin, shop, sizes):
        product = shop["product"]
        assert not CategoryAttribute.objects.filter(category=product.category).exists()
        chart = make_chart(sizes)

        response = admin.patch(
            f"/api/v1/products/{product.pk}/", {"size_chart": str(chart.pk)}, format="json"
        )

        assert response.status_code == 200

    def test_an_axis_the_variants_are_built_on_always_fits(self, admin, shop, sizes):
        """The shop product's variants are S and M. A category that has since
        stopped declaring Size must not strand the chart describing them."""
        product = shop["product"]
        colour, _ = factories.attribute("color", name="Colour", values=["Black"])
        CategoryAttribute.objects.create(category=product.category, attribute=colour)
        chart = make_chart(sizes)

        response = admin.patch(
            f"/api/v1/products/{product.pk}/", {"size_chart": str(chart.pk)}, format="json"
        )

        assert response.status_code == 200

    def test_a_category_change_that_strands_the_chart_is_refused(self, admin, sizes):
        shirts = factories.category(name="Shirts")
        CategoryAttribute.objects.create(category=shirts, attribute=sizes["size"])
        shoes = factories.category(name="Shoes")
        CategoryAttribute.objects.create(category=shoes, attribute=sizes["shoe"])
        product = factories.product(category=shirts)
        set_product_size_chart(product=product, chart=make_chart(sizes))

        response = admin.patch(
            f"/api/v1/products/{product.pk}/", {"category": str(shoes.pk)}, format="json"
        )

        assert response.status_code == 400
        assert "size_chart" in error_of(response)["details"]
        product.refresh_from_db()
        assert product.category_id == shirts.pk

    def test_a_category_change_that_clears_the_chart_is_fine(self, admin, sizes):
        shirts = factories.category(name="Shirts")
        CategoryAttribute.objects.create(category=shirts, attribute=sizes["size"])
        shoes = factories.category(name="Shoes")
        CategoryAttribute.objects.create(category=shoes, attribute=sizes["shoe"])
        product = factories.product(category=shirts)
        set_product_size_chart(product=product, chart=make_chart(sizes))

        response = admin.patch(
            f"/api/v1/products/{product.pk}/",
            {"category": str(shoes.pk), "size_chart": None},
            format="json",
        )

        assert response.status_code == 200, response.content
        product.refresh_from_db()
        assert product.size_chart is None

    def test_a_refused_chart_on_create_leaves_no_draft_behind(self, admin, sizes):
        shirts = factories.category(name="Shirts")
        CategoryAttribute.objects.create(category=shirts, attribute=sizes["size"])
        shoe_chart = save_size_chart(
            attribute=sizes["shoe"],
            data={
                "name": "Shoe conversion",
                "columns": ["UK"],
                "rows": [{"attribute_value": sizes["shoe_values"][0].pk, "cells": ["6"]}],
            },
        )

        response = admin.post(
            "/api/v1/products/",
            {"name": "Oxford shirt", "category": str(shirts.pk), "size_chart": str(shoe_chart.pk)},
            format="json",
        )

        assert response.status_code == 400
        assert not shirts.products.exists()

    def test_a_chart_can_be_set_on_create(self, admin, sizes):
        shirts = factories.category(name="Shirts")
        CategoryAttribute.objects.create(category=shirts, attribute=sizes["size"])
        chart = make_chart(sizes)

        response = admin.post(
            "/api/v1/products/",
            {"name": "Oxford shirt", "category": str(shirts.pk), "size_chart": str(chart.pk)},
            format="json",
        )

        assert response.status_code == 201, response.content
        assert shirts.products.get().size_chart_id == chart.pk


class TestTheProductPage:
    def test_the_detail_payload_carries_the_chart(self, api, shop, sizes):
        product = shop["product"]
        chart = make_chart(sizes)
        set_product_size_chart(product=product, chart=chart)

        body = api.get(f"/api/v1/shop/products/{product.slug}/").json()

        assert body["size_chart"] == {
            "name": "Men's shirts",
            "system": "UK",
            "attribute_code": "size",
            "attribute_name": "Size",
            "columns": ["Chest (cm)", "UK"],
            "rows": [
                {"value": "S", "label": "S", "cells": ["92–96", "36"]},
                {"value": "M", "label": "M", "cells": ["97–101", "38"]},
            ],
            "notes": "Measure under the arms.",
        }

    def test_a_product_without_a_chart_says_null(self, api, shop):
        body = api.get(f"/api/v1/shop/products/{shop['product'].slug}/").json()
        assert body["size_chart"] is None

    def test_the_listing_does_not_carry_it(self, api, shop, sizes):
        set_product_size_chart(product=shop["product"], chart=make_chart(sizes))

        results = api.get("/api/v1/shop/products/").json()["results"]

        assert results
        assert all("size_chart" not in row for row in results)
