"""Gunicorn settings for one experiment: Django under coverage while the
parity harness drives it, to learn which branches the cases reach."""
import coverage

bind = "0.0.0.0:8000"
workers = 1
threads = 8
timeout = 120
_cov = None


def post_fork(server, worker):
    global _cov
    _cov = coverage.Coverage(
        data_file="/covdata/parity.coverage",
        branch=True,
        concurrency=["thread"],
        source=["/app"],
        omit=["*/tests/*", "*/migrations/*"],
    )
    _cov.start()


def worker_exit(server, worker):
    if _cov is not None:
        _cov.stop()
        _cov.save()
