"""Root URL configuration.

Everything the browser can reach lives under /api/.  The versioned surface is
/api/v1/ (see docs/api/endpoints.md); health checks sit outside the version so
infrastructure never has to care about API versions.
"""

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from core.views import health_view, ready_view

urlpatterns = [
    path("django-admin/", admin.site.urls),
    path("api/health/", health_view, name="health"),
    path("api/ready/", ready_view, name="ready"),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path(
        "api/docs/",
        SpectacularSwaggerView.as_view(url_name="schema"),
        name="swagger-ui",
    ),
    path("api/v1/", include("config.api_urls")),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
