"""Shared pytest fixtures."""

from __future__ import annotations

from typing import Any

import pytest
from rest_framework.test import APIClient

from accounts.services import sync_permissions
from tests import factories


@pytest.fixture(autouse=True)
def _permissions(db: Any) -> None:
    """Roles and permission codes exist for every test that touches the database."""
    sync_permissions()


@pytest.fixture
def shop() -> dict[str, Any]:
    return factories.full_shop()


@pytest.fixture
def branch(shop: dict[str, Any]):
    return shop["branch"]


@pytest.fixture
def cashier(shop: dict[str, Any]):
    return shop["cashier"]


@pytest.fixture
def manager(shop: dict[str, Any]):
    return shop["manager"]


@pytest.fixture
def owner(shop: dict[str, Any]):
    return shop["owner"]


@pytest.fixture
def api() -> APIClient:
    return APIClient()


@pytest.fixture
def auth_client() -> Any:
    """Factory: auth_client(user) -> APIClient authenticated as that user."""

    def _make(user: Any) -> APIClient:
        client = APIClient()
        client.force_authenticate(user=user)
        return client

    return _make
