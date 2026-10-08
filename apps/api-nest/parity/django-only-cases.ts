/**
 * What Django serves and the Nest API, by decision, does not (ADR-0017):
 * the router's two index pages, the OpenAPI schema and its Swagger page, and
 * the Django admin. Each is a declared difference (known-differences.ts), and
 * each is here so that the difference is measured rather than remembered: a
 * page ported later stops matching its entry, and the run says so.
 *
 * In production nginx sends the last three to Django whichever API serves,
 * and they answer 503 while Django is not running.
 */
import type { Case } from './run.ts';

export function djangoOnlyCases(): Case[] {
  return [
    { name: "django only: the router's index", path: '/api/v1/' },
    { name: "django only: the POS router's index", path: '/api/v1/pos/' },
    { name: 'django only: the OpenAPI schema', path: '/api/schema/' },
    { name: 'django only: the Swagger page', path: '/api/docs/' },
    { name: 'django only: the Django admin', path: '/django-admin/' },
    { name: "django only: the Django admin's sign-in page", path: '/django-admin/login/' },
  ];
}
