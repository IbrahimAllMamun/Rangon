"""Production settings.  Fails loudly rather than running insecurely."""

from .base import *
from .base import REST_FRAMEWORK, env, env_bool, env_list

DEBUG = False

# collectstatic runs during the image build, where no real secret exists.
BUILD_MODE = env_bool("DJANGO_COLLECTSTATIC")

ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS")
SECRET_KEY = env("DJANGO_SECRET_KEY")

if not BUILD_MODE:
    if not SECRET_KEY or SECRET_KEY.startswith(("insecure", "dev-", "build-", "test-")):
        raise RuntimeError("DJANGO_SECRET_KEY must be a real secret in production.")
    if not ALLOWED_HOSTS:
        raise RuntimeError("DJANGO_ALLOWED_HOSTS must be set in production.")
    if "*" in ALLOWED_HOSTS:
        raise RuntimeError("DJANGO_ALLOWED_HOSTS must not contain '*' in production.")

# No browsable API: it renders user data into HTML and invites poking.
REST_FRAMEWORK = {
    **REST_FRAMEWORK,
    "DEFAULT_RENDERER_CLASSES": ("rest_framework.renderers.JSONRenderer",),
}

# --- transport / cookies ---------------------------------------------------
SECURE_SSL_REDIRECT = env_bool("DJANGO_SECURE_SSL_REDIRECT", True)
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_HSTS_SECONDS = 31_536_000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"

CORS_ALLOW_ALL_ORIGINS = False

# --- observability ---------------------------------------------------------
SENTRY_DSN = env("SENTRY_DSN")
if SENTRY_DSN and not BUILD_MODE:  # pragma: no cover - requires the optional dependency
    try:
        import sentry_sdk
        from sentry_sdk.integrations.celery import CeleryIntegration
        from sentry_sdk.integrations.django import DjangoIntegration

        sentry_sdk.init(
            dsn=SENTRY_DSN,
            integrations=[DjangoIntegration(), CeleryIntegration()],
            traces_sample_rate=0.1,
            send_default_pii=False,  # never ship customer PII to a third party
            environment=env("RANGON_ENV", "production"),
            release=env("RANGON_RELEASE", ""),
        )
    except ImportError:
        pass
