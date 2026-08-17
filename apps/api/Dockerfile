# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Production image for the Rangon API.  Multi-stage: wheels are built in a
# throwaway stage so the runtime image carries no compiler toolchain.
# ---------------------------------------------------------------------------

FROM python:3.12-slim-bookworm AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /wheels
COPY requirements/base.txt ./base.txt
RUN pip wheel --wheel-dir /wheels -r base.txt


# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DJANGO_SETTINGS_MODULE=config.settings.prod

RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 appuser \
    && useradd --system --uid 1001 --gid appuser --create-home appuser

WORKDIR /app

COPY --from=builder /wheels /wheels
COPY requirements/base.txt ./requirements/base.txt
RUN pip install --no-index --find-links=/wheels -r requirements/base.txt \
    && rm -rf /wheels

COPY --chown=appuser:appuser . .

RUN mkdir -p /app/staticfiles /app/media /app/logs \
    && chown -R appuser:appuser /app/staticfiles /app/media /app/logs

# Collect static with a throwaway secret: the build must not need real secrets.
RUN DJANGO_SECRET_KEY=build-only DJANGO_COLLECTSTATIC=1 \
    python manage.py collectstatic --noinput --clear

USER appuser
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/api/health/ || exit 1

# Migrations are a deployment step, not a container-start step. See
# docs/operations/deployment.md.
CMD ["gunicorn", "config.wsgi:application", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "3", \
     "--threads", "2", \
     "--timeout", "60", \
     "--graceful-timeout", "30", \
     "--access-logfile", "-", \
     "--error-logfile", "-"]
