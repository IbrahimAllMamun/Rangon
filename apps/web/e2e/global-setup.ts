import { execSync } from "node:child_process";

/**
 * Put the database into a known state before the suite runs.
 *
 * The suite is not self-contained: several specs *consume* seeded fixtures. The
 * returns flow is the clearest — it looks for a return in `Requested` state,
 * approves it, receives it and refunds it. The seed creates exactly one, so a
 * second run against the same database finds none and the spec times out
 * waiting for a table row that will never appear (D18 in docs/roadmap.md).
 *
 * That was diagnosed as "the specs are order-coupled". They are not: run in any
 * order against a fresh database they all pass. What they are is *not
 * repeatable*, which looks the same from the outside and is fixed differently —
 * by restoring the fixtures rather than by reordering anything.
 *
 * Set `E2E_SEED_CMD` to the command that reseeds, and this runs it first. With
 * it unset the suite still runs, but only cleanly once, so it says so rather
 * than letting the failure arrive 20 minutes later as a locator timeout.
 */
async function globalSetup() {
  const command = process.env.E2E_SEED_CMD;

  if (!command) {
    console.warn(
      "\n  [e2e] E2E_SEED_CMD is not set, so the database will not be reseeded.\n" +
        "  [e2e] The suite consumes seeded fixtures and is only repeatable once.\n" +
        "  [e2e] If the returns spec times out, that is why — reseed and re-run:\n" +
        "  [e2e]   E2E_SEED_CMD='python manage.py seed_demo --reset' npx playwright test\n",
    );
    return;
  }

  console.log(`  [e2e] reseeding: ${command}`);
  try {
    execSync(command, {
      cwd: process.env.E2E_SEED_CWD ?? "../api",
      stdio: "pipe",
      env: process.env,
    });
    console.log("  [e2e] database reseeded");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Failing here rather than letting every spec fail one by one: a suite run
    // against an unseeded database produces fifteen confusing timeouts instead
    // of one clear cause.
    throw new Error(`[e2e] reseed failed, so the suite would not be meaningful:\n${detail}`);
  }

  await dropStorefrontCache();
}

/**
 * Reseeding alone is not enough — the storefront must be told to forget.
 *
 * `seed_demo --reset` recreates every row, so every UUID changes. Next's data
 * cache does not know that: it keeps serving the product page it rendered
 * before, whose buy panel carries variant ids that no longer exist. "Add to
 * cart" then posts a dead id and silently does nothing, and the checkout spec
 * fails on a cart drawer that never opens — with nothing in the logs but a 200.
 *
 * This is not only a test problem. Any operation that regenerates ids behind a
 * running storefront has the same effect: restoring a backup, or reseeding a
 * staging environment. The cache has to be dropped alongside it.
 */
async function dropStorefrontCache() {
  const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  const secret = process.env.REVALIDATE_SECRET;

  if (!secret) {
    console.warn(
      "  [e2e] REVALIDATE_SECRET is not set, so the storefront cache was not dropped.\n" +
        "  [e2e] Specs that add to cart may fail on stale variant ids.",
    );
    return;
  }

  try {
    const response = await fetch(`${baseURL}/api/revalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-revalidate-secret": secret },
      body: JSON.stringify({ tags: ["navigation", "categories", "home", "products"] }),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    console.log("  [e2e] storefront cache dropped");
  } catch (error) {
    throw new Error(
      `[e2e] could not drop the storefront cache, so it would serve ids the reseed destroyed:\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export default globalSetup;
