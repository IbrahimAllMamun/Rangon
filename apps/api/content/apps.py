from django.apps import AppConfig


class ContentConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "content"
    verbose_name = "Storefront content"

    def ready(self) -> None:
        from content import signals  # noqa: F401  (registers the receivers)
