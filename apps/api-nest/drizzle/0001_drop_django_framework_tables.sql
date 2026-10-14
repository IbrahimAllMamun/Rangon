-- The removal plan's step 6.4 and step 8's contract migration, in one: the
-- tables only Django's own framework used, gone with it -- its content types,
-- its permissions and groups (and the user's links to them), its admin's log,
-- its sessions and Celery beat's schedule. `django_migrations` stays as the
-- history of how the schema came to be, and `token_blacklist_*` because the
-- NestJS API uses them. Hand-finished from `drizzle-kit generate`: it also
-- wrote row-security and identity MAXVALUE statements that change nothing here,
-- the second rounded past bigint's range.
-- On a new database this runs in the baseline's transaction, whose rows still
-- owe their deferred foreign-key checks; a table with checks pending cannot be
-- dropped. Settle them first.
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
DROP TABLE "django_content_type" CASCADE;--> statement-breakpoint
DROP TABLE "auth_permission" CASCADE;--> statement-breakpoint
DROP TABLE "auth_group" CASCADE;--> statement-breakpoint
DROP TABLE "auth_group_permissions" CASCADE;--> statement-breakpoint
DROP TABLE "accounts_user_groups" CASCADE;--> statement-breakpoint
DROP TABLE "accounts_user_user_permissions" CASCADE;--> statement-breakpoint
DROP TABLE "django_admin_log" CASCADE;--> statement-breakpoint
DROP TABLE "django_celery_beat_periodictasks" CASCADE;--> statement-breakpoint
DROP TABLE "django_celery_beat_intervalschedule" CASCADE;--> statement-breakpoint
DROP TABLE "django_celery_beat_solarschedule" CASCADE;--> statement-breakpoint
DROP TABLE "django_celery_beat_crontabschedule" CASCADE;--> statement-breakpoint
DROP TABLE "django_celery_beat_clockedschedule" CASCADE;--> statement-breakpoint
DROP TABLE "django_celery_beat_periodictask" CASCADE;--> statement-breakpoint
DROP TABLE "django_session" CASCADE;
