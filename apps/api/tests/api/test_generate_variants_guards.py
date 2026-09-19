"""`generate-variants/` must build SKUs only from variant axes, and only from values that exist.

business-rules §5a's first rule -- an attribute is an axis or a specification,
never both -- was enforced only on the specification side, and values were
matched with `value__in`, so an unknown one was skipped as long as another
matched (D84). The purchase order's new-product form calls this endpoint too.
Both tests were run against the code as it stood and seen to fail.
"""

from __future__ import annotations

from typing import Any

import pytest

from tests import factories

pytestmark = pytest.mark.django_db


@pytest.fixture
def axes() -> dict[str, Any]:
    size, _ = factories.attribute("size", name="Size", values=["S", "M", "L"])
    material, _ = factories.attribute("material", name="Material", values=["Cotton"])
    material.is_variant_defining = False
    material.save(update_fields=["is_variant_defining"])
    return {"size": size, "material": material}


def _generate(client: Any, product: Any, selections: dict[str, list[str]]) -> Any:
    return client.post(
        f"/api/v1/products/{product.pk}/generate-variants/",
        {"selections": selections, "price": "500.00"},
        format="json",
    )


def test_a_specification_builds_no_variants(owner: Any, auth_client: Any, axes: Any) -> None:
    """Material stated on a product *and* sprouting SKUs is the state §5a forbids."""
    product = factories.product()

    response = _generate(auth_client(owner), product, {"material": ["Cotton"]})

    assert response.status_code == 400
    assert "specification" in response.data["error"]["message"]
    assert not product.variants.exists()


def test_one_unknown_value_refuses_the_whole_request(
    owner: Any, auth_client: Any, axes: Any
) -> None:
    """S and XXXL used to make S alone and say nothing."""
    product = factories.product()

    response = _generate(auth_client(owner), product, {"size": ["S", "XXXL"]})

    assert response.status_code == 400
    assert "XXXL" in response.data["error"]["message"]
    assert not product.variants.exists()


def test_known_axis_values_still_build_every_combination(
    owner: Any, auth_client: Any, axes: Any
) -> None:
    product = factories.product()

    response = _generate(auth_client(owner), product, {"size": ["S", "M"]})

    assert response.status_code == 201
    assert product.variants.count() == 2
