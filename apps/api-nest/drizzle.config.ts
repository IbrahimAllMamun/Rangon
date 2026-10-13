import { defineConfig } from 'drizzle-kit';

/**
 * Django owns the schema until the removal plan's step 6.4, and until then
 * this is used for one thing: `scripts/nest-baseline.sh cut` reads the tables
 * Django created (`drizzle-kit pull`) into `drizzle/`, beside the baseline
 * migration cut from the same database. Never run `drizzle-kit push`, and
 * never `generate`, against a Rangon database before that step: a schema
 * change is a Django migration, then a new cut.
 *
 * `schema` is the whole schema, foreign keys included: what the first
 * migration written here will be a difference from. The API reads a copy
 * without them (`scripts/pull-schema.mjs`).
 */
export default defineConfig({
  dialect: 'postgresql',
  out: './drizzle',
  schema: './drizzle/schema.ts',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  introspect: { casing: 'camel' },
});
