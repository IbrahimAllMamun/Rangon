"""The parity stack's URLs: everything the API serves, and two stand-in views.

`config.settings.parity` points `ROOT_URLCONF` here. No other settings module
does, so the views below exist nowhere else.
"""

from django.urls import include, path

from parity_gateway.jobs import run_job, schedule

urlpatterns = [
    path("parity/jobs/run/", run_job, name="parity-run-job"),
    path("parity/jobs/schedule/", schedule, name="parity-job-schedule"),
    path("", include("config.urls")),
]
