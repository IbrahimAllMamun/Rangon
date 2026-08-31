import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  // Restores the fixtures the suite consumes, so a second run behaves like the
  // first (D18). See e2e/global-setup.ts.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false, // these flows share one seeded database
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Escape hatch for an environment that already ships a Chromium but not
    // the exact build this Playwright version downloads (D7 in
    // docs/roadmap.md). Unset in CI and locally, where `npx playwright
    // install` is the right path.
    ...(process.env.PW_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
      : {}),
  },

  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      // POS and Admin are desktop surfaces by design (CLAUDE.md section 10:
      // POS is barcode-and-keyboard, Admin is dense and tabular), so they are
      // not run at a phone viewport. The `@desktop-only` tag does this; the
      // previous `testIgnore: /pos|admin/` matched file *paths*, and every
      // flow lives in one spec file, so it never excluded anything.
      grepInvert: /@desktop-only/,
    },
  ],
});
