"""Request types that carry what a permission class has already proved.

DRF types ``Request.user`` as ``User | AnonymousUser``, because in general a
request may be unauthenticated.  On a view whose ``permission_classes`` include
``IsAuthenticated`` it may not: DRF has already answered 401 before the handler
runs, so ``request.user`` is a real ``User`` every time the body executes.

Nothing in the type system knew that, so every view that passed ``request.user``
to a service -- which takes a ``User``, because a service acts on behalf of
somebody -- produced an error, 81 of them across ten modules (D6).  The
alternatives were worse: a ``cast`` at each of those call sites says nothing
about *why* it is safe, and an ``assert isinstance`` adds a runtime check for a
condition DRF has already enforced.

``AuthedRequest`` states the invariant once, where the reason for it lives.

Use it **only** on a handler that ``IsAuthenticated`` guards.  On an ``AllowAny``
view the annotation would be a lie, and a lie mypy would then help propagate --
so ``accounts.api.views``, which serves both kinds, keeps the plain ``Request``
on its public handlers.
"""

from __future__ import annotations

from typing import cast

from rest_framework.request import Request

from accounts.models import User


class AuthedRequest(Request):
    """A request on a view that has already required authentication."""

    # Narrowing DRF's property to the concrete model.  This is a typing-only
    # declaration: no attribute is created and nothing shadows the property at
    # runtime, because the class is never instantiated -- DRF builds a plain
    # `Request` and this only ever appears in an annotation.
    user: User


def actor(request: Request) -> User:
    """The signed-in user behind a request, for handlers that cannot use
    :class:`AuthedRequest`.

    A method that overrides one of DRF's mixins -- ``create``, ``update``,
    ``list`` -- inherits its signature, and narrowing a parameter in an override
    is unsound however true it happens to be here: a caller holding the base
    class may legitimately pass a plain ``Request``.  mypy says so, and it is
    right to, so those handlers keep ``Request`` and narrow the one value they
    actually need through this instead.

    The same precondition applies as for :class:`AuthedRequest`: only call this
    where ``IsAuthenticated`` has already run.
    """
    return cast(User, request.user)
