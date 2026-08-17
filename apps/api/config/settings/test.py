"""Test settings.

Real PostgreSQL, real constraints, real locking — concurrency tests are
meaningless against SQLite.  Only speed-ups that cannot change behaviour are
applied.
"""

from .base import *
from .base import DATABASES

DEBUG = False
ALLOWED_HOSTS = ["*", "testserver"]

# Fast hashing: the tests assert authorisation, not Argon2's work factor.
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True

EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"

CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}

STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.InMemoryStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}

# Throttling off by default: rate limits are asserted explicitly in
# tests/api/test_throttling.py, which re-enables them.
REST_FRAMEWORK = {**globals()["REST_FRAMEWORK"], "DEFAULT_THROTTLE_CLASSES": ()}

DATABASES["default"]["TEST"] = {"NAME": "rangon_test_db"}

LOGGING = {"version": 1, "disable_existing_loggers": True, "root": {"handlers": []}}
