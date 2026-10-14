import { defineConfig } from 'drizzle-kit';

/**
 * The schema's owner since the removal plan's step 6.4. A change is made in
 * `drizzle/schema.ts` (and `drizzle/relations.ts` for a join), then:
 *
 *   npm run db:generate -- --name <what-it-does>   writes drizzle/NNNN_*.sql
 *   npm run db:copy                                 the API's copy, src/database/
 *
 * Read the SQL it wrote before committing it: `generate` also emits identity
 * limits rounded past bigint's range, which PostgreSQL refuses, and a new
 * foreign key is not DEFERRABLE INITIALLY DEFERRED unless finished by hand,
 * as every older one is (docs/database/migrations.md). It needs no database.
 * Never `drizzle-kit push`: a schema changes by a migration, applied by
 * `node dist/cli.js migrate` as a release step.
 */
export default defineConfig({
  dialect: 'postgresql',
  out: './drizzle',
  schema: './drizzle/schema.ts',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  introspect: { casing: 'camel' },
});
