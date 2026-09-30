import { defineConfig } from 'drizzle-kit';

/**
 * Introspection only. Django owns the schema and its migrations; this reads
 * the tables Django created into `src/database/schema.ts`. Never run
 * `drizzle-kit push` or `migrate` against a Rangon database.
 */
export default defineConfig({
  dialect: 'postgresql',
  out: './drizzle-pull',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  introspect: { casing: 'camel' },
});
