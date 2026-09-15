"""Test settings.

Real PostgreSQL, real constraints, real locking — concurrency tests are
meaningless against SQLite.  Only speed-ups that cannot change behaviour are
applied.
"""

import os
import uuid

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

# One database per run, not one per machine (D47).
#
# This line used to pin `rangon_test_db`, and `docker-compose.test.yml` pins a
# fixed project name, so two suites started from two worktrees shared one
# PostgreSQL *and* one database. pytest-django drops and recreates the test
# database at session start, so the second run pulled the database out from
# under the first.
#
# It never failed cleanly. It manufactured believable failures somewhere else:
# `database "rangon_test_db" does not exist` halfway through one suite, and
# `assert '2000.00' == '1000.00'` in another -- the other run's committed rows,
# read straight through. Both were first read as regressions from the change
# under test, which is what makes this worth a line of code rather than a note
# in the runbook.
#
# Random, not the process id. The obvious per-run token is `os.getpid()`, and
# it does not work here: each `docker compose run` gets its own PID namespace,
# so two containers both start at 1 and collide exactly as before. That was
# tried first and reproduced the original failure, which is worth recording
# because it looks correct.
#
# pytest-django creates the database in the session that owns it and drops it
# at the end of that session, so the name only has to survive one run.
# `TEST_DB_NAME` pins it when something outside needs to know it.
DATABASES["default"]["TEST"] = {
    "NAME": os.environ.get("TEST_DB_NAME") or f"rangon_test_{uuid.uuid4().hex[:12]}",
}

LOGGING = {"version": 1, "disable_existing_loggers": True, "root": {"handlers": []}}
