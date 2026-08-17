"""Health and readiness endpoints.

Liveness never touches a dependency: a database blip must not make the
orchestrator kill healthy application processes.  Readiness does, so the load
balancer can stop routing.  Neither leaks versions, settings or error detail
(docs/operations/deployment.md).
"""

from __future__ import annotations

import logging

from django.core.cache import cache
from django.db import connection
from django.http import HttpRequest, JsonResponse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET

logger = logging.getLogger("rangon.health")


@require_GET
@never_cache
def health_view(_request: HttpRequest) -> JsonResponse:
    return JsonResponse({"status": "ok"})


@require_GET
@never_cache
def ready_view(_request: HttpRequest) -> JsonResponse:
    checks = {"database": False, "cache": False}

    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
        checks["database"] = True
    except Exception:
        logger.exception("Readiness: database check failed")

    try:
        cache.set("rangon:ready", "1", 10)
        checks["cache"] = cache.get("rangon:ready") == "1"
    except Exception:
        logger.exception("Readiness: cache check failed")

    ready = all(checks.values())
    return JsonResponse(
        {"status": "ready" if ready else "not-ready", "checks": checks},
        status=200 if ready else 503,
    )
