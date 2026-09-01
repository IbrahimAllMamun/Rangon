"""Root URL configuration.

Everything the browser can reach lives under /api/.  The versioned surface is
/api/v1/ (see docs/api/endpoints.md); health checks sit outside the version so
infrastructure never has to care about API versions.
"""

from django.conf import settings
from django.contrib import admin
from django.urls import include, path, re_path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from core.media import serve_media
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

if not settings.USE_S3:
    # Uploaded media has to be served by *something*, and with USE_S3=0 the only
    # thing that has the files is this container.
    #
    # `django.conf.urls.static.static()` is not usable here: it returns an empty
    # list unless DEBUG, so with DEBUG=0 every product photograph 404ed while the
    # upload itself reported success. WhiteNoise is not usable either — it
    # indexes its files once at startup, so an image uploaded a minute ago would
    # not exist until the next deploy.
    #
    # Serving through the WSGI worker is slower than handing the path to Nginx,
    # which is why S3 is the production answer (USE_S3=1 removes this route
    # entirely). For a single-server deployment the cost is one gunicorn thread
    # per image, and correctness beats a photograph that cannot be seen.
    urlpatterns += [re_path(r"^media/(?P<path>.*)$", serve_media, name="media")]
