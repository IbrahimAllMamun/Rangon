"""Product specification attributes: stated once, never multiplied into SKUs.

The catalogue sells clothing, shoes, bags *and* cosmetics, and until this the
only spec fields were the free-text `material` and `care_instructions` columns
on `Product` — which is exactly what §10 of the build plan says not to do
("Do not hard-code category-specific columns into the product table").
Cosmetics need Volume and Skin Type, bags need Dimensions, shoes need Sole.

`Attribute.is_variant_defining` already split the world in two and the seed
already marked Material, Gender and Fit as *not* variant-defining — but nothing
could attach one to a product, so those three attributes existed and were
unreachable. `ProductAttributeValue` is the missing half.

Written before the screen, which is the habit `docs/roadmap.md` keeps
recommending and which has now paid for itself eight times.
"""

from __future__ import annotations

import pytest

from catalog.models import CategoryAttribute, ProductAttributeValue
from catalog.services import category_attributes, set_product_specs
from core.exceptions import ValidationError as ServiceValidationError
from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def admin(shop, auth_client):
    return auth_client(shop["owner"])


@pytest.fixture
def specs():
    """One spec attribute and one variant axis, as the seed builds them.

    Self-sufficient on purpose: the category tests below build their own tree
    and never touch the `shop` fixture, so borrowing its Size attribute would
    make them pass only in the order the rest of the file happens to run in.
    """
    material, material_values = factories.attribute(
        "material", name="Material", values=["Cotton", "Linen"]
    )
    material.is_variant_defining = False
    material.save(update_fields=["is_variant_defining"])
    size, _ = factories.attribute("size", name="Size", values=["S", "M"])
    return {
        "material": material,
        "cotton": material_values[0],
        "linen": material_values[1],
        "size": size,
        "size_value": size.values.first(),
    }


class TestStatingASpecification:
    def test_a_spec_value_is_stored_and_comes_back_grouped(self, admin, shop, specs):
        product = shop["product"]

        response = admin.patch(
            f"/api/v1/products/{product.pk}/",
            {"spec_values": [str(specs["cotton"].pk), str(specs["linen"].pk)]},
            format="json",
        )

        assert response.status_code == 200
        assert product.spec_values.count() == 2

        detail = admin.get(f"/api/v1/products/{product.pk}/")
        assert detail.status_code == 200
        rows = detail.json()["specs"]
        # Grouped, not one row per value: "Material: Cotton, Linen" is one
        # fact about the product, not two.
        assert len(rows) == 1
        assert rows[0]["attribute_code"] == "material"
        assert rows[0]["attribute_name"] == "Material"
        assert [value["label"] for value in rows[0]["values"]] == ["Cotton", "Linen"]

    def test_a_product_can_be_created_with_specs_in_one_call(self, admin, shop, specs):
        response = admin.post(
            "/api/v1/products/",
            {
                "name": "Linen Shirt",
                "category": str(shop["product"].category_id),
                "spec_values": [str(specs["linen"].pk)],
            },
            format="json",
        )

        assert response.status_code == 201
        created = response.json()["id"]
        assert ProductAttributeValue.objects.filter(product_id=created).count() == 1

    def test_sending_the_set_again_changes_nothing(self, admin, shop, specs):
        product = shop["product"]
        payload = {"spec_values": [str(specs["cotton"].pk)]}

        admin.patch(f"/api/v1/products/{product.pk}/", payload, format="json")
        first = list(product.spec_values.values_list("pk", flat=True))
        admin.patch(f"/api/v1/products/{product.pk}/", payload, format="json")

        assert list(product.spec_values.values_list("pk", flat=True)) == first

    def test_a_repeated_id_in_one_payload_stores_one_row(self, admin, shop, specs):
        product = shop["product"]
        value = str(specs["cotton"].pk)

        response = admin.patch(
            f"/api/v1/products/{product.pk}/",
            {"spec_values": [value, value, value]},
            format="json",
        )

        assert response.status_code == 200
        assert product.spec_values.count() == 1


class TestTheSetIsReplaced:
    """The form sends the ticks as they now stand, not a diff.

    A caller that has to work out what changed before saving will eventually
    forget to, and the failure mode is a spec list that only ever grows.
    """

    def test_a_value_left_out_is_removed(self, admin, shop, specs):
        product = shop["product"]
        admin.patch(
            f"/api/v1/products/{product.pk}/",
            {"spec_values": [str(specs["cotton"].pk), str(specs["linen"].pk)]},
            format="json",
        )

        admin.patch(
            f"/api/v1/products/{product.pk}/",
            {"spec_values": [str(specs["linen"].pk)]},
            format="json",
        )

        assert [str(row.attribute_value_id) for row in product.spec_values.all()] == [
            str(specs["linen"].pk)
        ]

    def test_an_empty_list_clears_them(self, admin, shop, specs):
        product = shop["product"]
        admin.patch(
            f"/api/v1/products/{product.pk}/",
            {"spec_values": [str(specs["cotton"].pk)]},
            format="json",
        )

        admin.patch(f"/api/v1/products/{product.pk}/", {"spec_values": []}, format="json")

        assert product.spec_values.count() == 0

    def test_omitting_the_key_leaves_them_alone(self, admin, shop, specs):
        """A PATCH of the name must not wipe the specifications."""
        product = shop["product"]
        admin.patch(
            f"/api/v1/products/{product.pk}/",
            {"spec_values": [str(specs["cotton"].pk)]},
            format="json",
        )

        admin.patch(f"/api/v1/products/{product.pk}/", {"name": "Renamed"}, format="json")

        assert product.spec_values.count() == 1


class TestAVariantAxisIsNotASpecification:
    """Size and Colour build SKUs. Stating one as a spec as well would leave
    two places claiming the same fact, and only one of them sellable."""

    def test_the_api_refuses_it_with_a_field_error(self, admin, shop, specs):
        product = shop["product"]

        response = admin.patch(
            f"/api/v1/products/{product.pk}/",
            {"spec_values": [str(specs["size_value"].pk)]},
            format="json",
        )

        assert response.status_code == 400
        body = response.json()
        assert body["error"]["code"] == "VALIDATION_ERROR"
        assert "spec_values" in body["error"]["details"]
        assert "Size" in str(body["error"]["details"]["spec_values"])
        assert product.spec_values.count() == 0

    def test_the_service_refuses_it_too(self, shop, specs):
        """The serializer is the fast path; the service is the authority. A
        management command or a shell reaches one and not the other."""
        with pytest.raises(ServiceValidationError) as caught:
            set_product_specs(product=shop["product"], value_ids=[specs["size_value"].pk])

        assert "Size" in caught.value.message
        assert shop["product"].spec_values.count() == 0

    def test_nothing_is_written_when_one_value_in_the_batch_is_an_axis(self, admin, shop, specs):
        product = shop["product"]

        response = admin.patch(
            f"/api/v1/products/{product.pk}/",
            {"spec_values": [str(specs["cotton"].pk), str(specs["size_value"].pk)]},
            format="json",
        )

        assert response.status_code == 400
        assert product.spec_values.count() == 0


class TestAnUnknownValueIsRefused:
    def test_a_missing_id_is_a_field_error_not_a_silent_drop(self, admin, shop, specs):
        product = shop["product"]
        gone = "00000000-0000-4000-8000-000000000000"

        response = admin.patch(
            f"/api/v1/products/{product.pk}/",
            {"spec_values": [str(specs["cotton"].pk), gone]},
            format="json",
        )

        assert response.status_code == 400
        assert "spec_values" in response.json()["error"]["details"]
        assert product.spec_values.count() == 0

    def test_the_service_refuses_it_and_names_the_id(self, shop):
        gone = "00000000-0000-4000-8000-000000000000"

        with pytest.raises(ServiceValidationError) as caught:
            set_product_specs(product=shop["product"], value_ids=[gone])

        assert gone in caught.value.details["spec_values"]


class TestAuthorisation:
    """`products.view` may read a spec list and must not write one."""

    def test_a_reader_cannot_state_a_specification(self, shop, auth_client, specs):
        # ACCOUNTANT holds products.view without products.update — the same
        # split that made D24 a real privilege escalation.
        accountant = factories.user("ACCOUNTANT", branch_obj=shop["branch"])
        client = auth_client(accountant)

        response = client.patch(
            f"/api/v1/products/{shop['product'].pk}/",
            {"spec_values": [str(specs["cotton"].pk)]},
            format="json",
        )

        assert response.status_code == 403
        assert shop["product"].spec_values.count() == 0


class TestDeletingAValueThatIsStated:
    """`ProductAttributeValue.attribute_value` is PROTECT, so the database
    already refuses. What it does not do is say why — and a bare 409 leaves the
    admin clicking Delete again. The variant branch of this already existed."""

    def test_a_stated_value_is_refused_in_words(self, admin, shop, specs):
        set_product_specs(product=shop["product"], value_ids=[specs["cotton"].pk])

        response = admin.delete(f"/api/v1/attribute-values/{specs['cotton'].pk}/")

        assert response.status_code == 409
        body = response.json()["error"]
        assert body["details"]["spec_usage"] == 1
        assert "specification" in body["message"]

    def test_its_attribute_is_refused_in_words_too(self, admin, shop, specs):
        set_product_specs(product=shop["product"], value_ids=[specs["cotton"].pk])

        response = admin.delete(f"/api/v1/attributes/{specs['material'].pk}/")

        assert response.status_code == 409
        assert response.json()["error"]["details"]["spec_usage"] == 1

    def test_an_unstated_value_still_deletes(self, admin, shop, specs):
        response = admin.delete(f"/api/v1/attribute-values/{specs['linen'].pk}/")

        assert response.status_code == 204


class TestAnAttributeCannotChangeSidesUnderneathAProduct:
    """The mirror image of the guard that already stopped a variant-defining
    attribute being turned off. Both directions can now strand rows."""

    def test_it_cannot_start_defining_variants_while_stated_as_a_spec(self, admin, shop, specs):
        set_product_specs(product=shop["product"], value_ids=[specs["cotton"].pk])

        response = admin.patch(
            f"/api/v1/attributes/{specs['material'].pk}/",
            {"is_variant_defining": True},
            format="json",
        )

        assert response.status_code == 400
        specs["material"].refresh_from_db()
        assert specs["material"].is_variant_defining is False

    def test_it_may_start_defining_variants_once_nothing_states_it(self, admin, specs):
        response = admin.patch(
            f"/api/v1/attributes/{specs['material'].pk}/",
            {"is_variant_defining": True},
            format="json",
        )

        assert response.status_code == 200


class TestWhichAttributesACategoryUses:
    """`CategoryAttribute` has existed since the first migration and nothing
    read it but the seed. It is what stops a handbag offering a Shoe size."""

    def test_it_answers_with_the_categorys_own_links(self, admin, shop, specs):
        category = shop["product"].category
        CategoryAttribute.objects.create(
            category=category, attribute=specs["material"], is_required=True
        )

        response = admin.get(f"/api/v1/categories/{category.pk}/attributes/")

        assert response.status_code == 200
        rows = response.json()
        assert [row["code"] for row in rows] == ["material"]
        assert rows[0]["is_required"] is True
        assert rows[0]["is_variant_defining"] is False
        assert [value["value"] for value in rows[0]["values"]] == ["Cotton", "Linen"]

    def test_a_child_inherits_what_its_parent_declares(self, admin, specs):
        parent = factories.category(name="Men")
        child = factories.category(name="Shirts", parent=parent)
        CategoryAttribute.objects.create(category=parent, attribute=specs["material"])

        response = admin.get(f"/api/v1/categories/{child.pk}/attributes/")

        assert [row["code"] for row in response.json()] == ["material"]
        assert response.json()[0]["declared_by"] == "Men"

    def test_the_nearer_category_wins_the_required_flag(self, specs):
        """A specific category tightening a general rule is the direction that
        makes sense; the reverse would let "Men" loosen "Shirts"."""
        parent = factories.category(name="Men")
        child = factories.category(name="Shirts", parent=parent)
        CategoryAttribute.objects.create(
            category=parent, attribute=specs["material"], is_required=False
        )
        CategoryAttribute.objects.create(
            category=child, attribute=specs["material"], is_required=True
        )

        links = category_attributes(child)

        assert len(links) == 1
        assert links[0].is_required is True

    def test_both_halves_come_back_so_the_form_can_split_them(self, admin, shop, specs):
        category = shop["product"].category
        CategoryAttribute.objects.create(category=category, attribute=specs["material"])
        CategoryAttribute.objects.create(category=category, attribute=specs["size"])

        rows = admin.get(f"/api/v1/categories/{category.pk}/attributes/").json()

        by_code = {row["code"]: row for row in rows}
        assert by_code["size"]["is_variant_defining"] is True
        assert by_code["material"]["is_variant_defining"] is False


class TestTheStorefrontRendersThem:
    def test_product_detail_carries_the_spec_list(self, api, shop, specs):
        product = shop["product"]
        set_product_specs(product=product, value_ids=[specs["cotton"].pk])

        response = api.get(f"/api/v1/shop/products/{product.slug}/")

        assert response.status_code == 200
        rows = response.json()["specs"]
        assert rows == [
            {
                "attribute_code": "material",
                "attribute_name": "Material",
                "kind": "TEXT",
                "values": [{"value": "Cotton", "label": "Cotton", "swatch": ""}],
            }
        ]

    def test_the_listing_does_not_carry_them(self, api, shop, specs):
        """Deliberate: no card renders a spec list, and the listing's query
        budget is asserted (docs/database/indexing.md)."""
        set_product_specs(product=shop["product"], value_ids=[specs["cotton"].pk])

        response = api.get("/api/v1/shop/products/")

        assert response.status_code == 200
        assert all("specs" not in row for row in response.json()["results"])
