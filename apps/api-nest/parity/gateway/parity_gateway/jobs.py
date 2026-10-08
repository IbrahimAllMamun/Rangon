"""Run one background task now, for the parity suite.

The parity stack has no Celery worker: a job each API queues stays on the
broker for the harness to read. To compare what a job *does*, the harness
asks for it by name -- here, and at the Nest API's twin of this view
(`apps/api-nest/parity/serve.ts`) -- and compares the word each returns, the
rows each wrote and what each sent.

`task.apply()` is Celery's eager run: a `self.retry()` is taken up at once, as
many times as the task allows, so one call is every attempt.

Installed by `config.settings.parity` alone, from a directory only
`docker-compose.nest.yml` mounts. No image contains it.
"""

import contextvars
import inspect
import json

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from config.celery import app


@csrf_exempt
@require_POST
def run_job(request):
    payload = json.loads(request.body or b"{}")
    app.loader.import_default_modules()
    task = app.tasks[payload["task"]]
    # In a context of its own: a worker has no request, so a task's audit
    # entries name no address and no request id. Run inside this view's, they
    # would carry the harness's.
    outcome = contextvars.Context().run(task.apply, args=payload.get("args", []), throw=False)
    succeeded = outcome.successful()
    return JsonResponse(
        {
            "state": "SUCCESS" if succeeded else "FAILURE",
            "result": outcome.result if succeeded else None,
        }
    )


@require_GET
def schedule(request):
    """What beat fires and what a worker can be asked for, read off Celery itself."""
    app.loader.import_default_modules()

    def cron(entry):
        when = entry["schedule"]
        return " ".join(
            str(field)
            for field in (
                when._orig_minute,
                when._orig_hour,
                when._orig_day_of_month,
                when._orig_month_of_year,
                when._orig_day_of_week,
            )
        )

    def policy(name):
        task = app.tasks[name]
        # A task is retried only where it asks to be: `max_retries` has a
        # default every task carries, used or not.
        retried = "self.retry(" in inspect.getsource(inspect.unwrap(task.run))
        return {
            "task": name,
            "retries": task.max_retries if retried else 0,
            "retry_delay": task.default_retry_delay if retried else 0,
        }

    ours = sorted(
        name
        for name in app.tasks
        if not name.startswith("celery.") and name != "config.celery.debug_task"
    )
    return JsonResponse(
        {
            "timezone": settings.CELERY_TIMEZONE,
            "time_limit": settings.CELERY_TASK_TIME_LIMIT,
            "schedule": sorted(
                (
                    {"task": entry["task"], "cron": cron(entry)}
                    for entry in app.conf.beat_schedule.values()
                ),
                key=lambda line: line["task"],
            ),
            "tasks": [policy(name) for name in ours],
        }
    )
