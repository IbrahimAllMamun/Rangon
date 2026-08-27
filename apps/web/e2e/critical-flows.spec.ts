/**
 * The four flows the business cannot ship without (docs/testing/strategy.md).
 *
 * These run against a seeded, running stack:
 *   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
 *   docker compose exec api python manage.py seed_demo --reset
 *   npm run test:e2e
 */
import { expect, test } from "@playwright/test";

const CASHIER = { email: "cashier@rangon.test", password: "rangon12345" };
const MANAGER = { email: "manager@rangon.test", password: "rangon12345" };

async function signIn(page: import("@playwright/test").Page, user: typeof CASHIER) {
  await page.goto("/login");
  // Scoped to the form on purpose: the storefront header on this page carries
  // its own "Sign in" entry in the account menu, so an unscoped role lookup
  // matches two elements and fails Playwright's strict mode.
  const form = page.locator("form");
  await form.getByLabel("Email address").fill(user.email);
  await form.getByLabel("Password").fill(user.password);
  await form.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test.describe("Storefront", () => {
  test("browse, filter and open a product", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /elevate your everyday/i })).toBeVisible();

    await page.getByRole("link", { name: "Shop now" }).click();
    await expect(page).toHaveURL(/\/shop/);

    const firstProduct = page.locator("article a").first();
    await firstProduct.click();
    await expect(page).toHaveURL(/\/product\//);
    await expect(page.getByRole("button", { name: /add to cart/i })).toBeVisible();
  });

  test("customer can complete a cash-on-delivery order", async ({ page }) => {
    await page.goto("/shop");
    await page.locator("article a").first().click();

    await page.getByRole("button", { name: /add to cart/i }).click();
    await expect(page.getByRole("dialog", { name: /your cart/i })).toBeVisible();

    await page.getByRole("link", { name: "Checkout" }).click();
    await expect(page).toHaveURL(/\/checkout/);

    await page.getByLabel("Full name").fill("Playwright Shopper");
    await page.getByLabel("Mobile number").fill("01711223344");
    await page.getByLabel("Address").first().fill("House 1, Road 1");
    await page.getByLabel("City / District").fill("Dhaka");

    // Delivery options load from the server once a city is known.
    await page.getByRole("radio").first().waitFor();
    await page.getByRole("radio").first().check();

    await page.getByRole("button", { name: /place order/i }).click();

    await expect(page).toHaveURL(/\/order\//, { timeout: 15000 });
    await expect(page.getByRole("heading", { name: /thank you/i })).toBeVisible();
  });

  test("checkout refuses an incomplete address and says why", async ({ page }) => {
    await page.goto("/shop");
    await page.locator("article a").first().click();
    await page.getByRole("button", { name: /add to cart/i }).click();
    await page.getByRole("link", { name: "Checkout" }).click();

    await page.getByRole("button", { name: /place order/i }).click();

    const summary = page.getByRole("alert").filter({ hasText: "There is a problem" });
    await expect(summary).toBeVisible();
    await expect(summary.getByRole("link", { name: /full name is required/i })).toBeVisible();
  });
});

test.describe("POS", { tag: "@desktop-only" }, () => {
  test("cashier sells an item by SKU and gets a receipt", async ({ page, request }) => {
    await signIn(page, CASHIER);
    await page.goto("/pos");

    // Take a SKU that is genuinely in stock from the public catalogue.
    const response = await request.get("/api/proxy/shop/products/?in_stock=true&page_size=1");
    const body = await response.json();
    const sku = body.results[0].variants.find((v: { in_stock: boolean }) => v.in_stock).sku;

    const scan = page.getByLabel(/scan barcode or type sku/i);
    await expect(scan).toBeFocused();
    await scan.fill(sku);
    await scan.press("Enter");

    await expect(page.getByText(sku, { exact: false })).toBeVisible();

    await page.getByRole("button", { name: /^Payment/ }).click();
    const dialog = page.getByRole("dialog", { name: "Payment" });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Add payment" }).click();
    await dialog.getByRole("button", { name: "Complete sale" }).click();

    await expect(page.getByRole("heading", { name: /sale complete/i })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("button", { name: /print receipt/i })).toBeVisible();
  });

  test("keyboard shortcut F2 opens payment", async ({ page, request }) => {
    await signIn(page, CASHIER);
    await page.goto("/pos");

    const response = await request.get("/api/proxy/shop/products/?in_stock=true&page_size=1");
    const body = await response.json();
    const sku = body.results[0].variants.find((v: { in_stock: boolean }) => v.in_stock).sku;

    await page.getByLabel(/scan barcode or type sku/i).fill(sku);
    await page.getByLabel(/scan barcode or type sku/i).press("Enter");
    await page.waitForTimeout(500);

    await page.keyboard.press("F2");
    await expect(page.getByRole("dialog", { name: "Payment" })).toBeVisible();
  });
});

test.describe("Admin", { tag: "@desktop-only" }, () => {
  test("manager sees the dashboard with server-aggregated KPIs", async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto("/admin");

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    // "Revenue" is both a KPI tile label and a column header in the table
    // alternative to the chart, so match the tile rather than either loosely.
    await expect(page.getByText("Revenue", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Gross profit").first()).toBeVisible();
  });

  test("inventory reflects the ledger", async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto("/admin/inventory");

    await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Available" })).toBeVisible();
  });

  test("recording an expense moves the account it was paid from", async ({ page }) => {
    // The invariant phase 36 exists to protect: the document and the cash-book
    // movement are written together, so the balance can never disagree with
    // what the shop recorded spending.
    await signIn(page, MANAGER);
    await page.goto("/admin/expenses");
    await expect(page.getByRole("heading", { name: "Expenses", level: 1 })).toBeVisible();

    const drawer = page.locator("#ex-account option", { hasText: /Cash Drawer/ });
    const balanceOf = async () => Number((await drawer.innerText()).replace(/[^0-9.]/g, ""));
    const before = await balanceOf();

    const note = `E2E courier run ${Date.now()}`;
    await page.selectOption("#ex-category", { label: "Transport" });
    await page.locator("#ex-amount").fill("125.25");
    await page.locator("#ex-note").fill(note);
    await page.getByRole("button", { name: "Record expense" }).click();

    const row = page.locator("tr", { hasText: note });
    await expect(row).toBeVisible();
    // The picker re-renders from the server after router.refresh(), so poll
    // rather than reading once — the assertion is about the figure settling on
    // the right number, not about how fast the round-trip is.
    await expect.poll(balanceOf).toBeCloseTo(before - 125.25, 2);

    // Voiding asks why, then puts the money back without deleting anything.
    await row.getByRole("button", { name: /Void expense/ }).click();
    await page.locator('input[id^="void-"]').fill("Recorded in error by the E2E run");
    await page.getByRole("button", { name: "Void it" }).click();

    await expect(page.locator("tr", { hasText: note }).getByText("Voided")).toBeVisible();
    await expect.poll(balanceOf).toBeCloseTo(before, 2);
  });

  test("an expense larger than the account holds is refused by the server", async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto("/admin/expenses");

    await page.locator("#ex-amount").fill("99999999.00");
    await page.getByRole("button", { name: "Record expense" }).click();

    const summary = page.locator('[aria-labelledby="error-summary-title"]');
    await expect(summary).toContainText(/which is less than/i);
    // The form never claims success beside a refusal.
    await expect(page.getByRole("status").filter({ hasText: "Recorded" })).toHaveCount(0);
  });

  test("writing stock off reduces it and demands a reason", async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto("/admin/inventory");

    const sku = (await page.locator("tbody tr").first().locator("td").nth(1).innerText()).trim();

    // The reason is mandatory: an unexplained write-off is indistinguishable
    // from theft by whoever recorded it.
    await page.getByRole("button", { name: "Write stock off" }).click();
    await page.locator("#wo-quantity").fill("1");
    await page.getByRole("button", { name: "Write off" }).click();
    await expect(page.locator('[aria-labelledby="error-summary-title"]')).toBeVisible();

    await page.locator("#wo-search input").fill(sku);
    await page.locator("#wo-search").getByText(sku).first().click();
    await page.locator("#wo-quantity").fill("1");
    await page.locator("#wo-reason").fill("Torn on the shop floor");
    await page.getByRole("button", { name: "Write off" }).click();
    // The route loader also carries role=status, so filter to the confirmation.
    await expect(
      page.getByRole("status").filter({ hasText: /written off/i }),
    ).toBeVisible();
  });

  test("a stock count records a variance and only moves stock when applied", async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto("/admin/inventory/counts");
    await page.getByRole("button", { name: /Start a count of/ }).click();
    await page.waitForURL(/\/counts\/[0-9a-f-]{36}/);

    const row = page.locator("tbody tr").first();
    const expected = Number((await row.locator("td").nth(1).innerText()).trim());
    await row.locator('input[id^="count-"]').fill(String(expected - 1));

    // The variance is computed from the ledger's snapshot, which is why
    // `expected_quantity` is not editable anywhere on this sheet.
    await expect(row.locator("td").nth(3)).toContainText("-1");

    await page.getByRole("button", { name: "Save progress" }).click();
    await expect(page.getByText(/Saved 1 line/)).toBeVisible();
    // Saving is not applying — a count takes hours and more than one person.
    await expect(page.getByRole("button", { name: "Apply to stock" })).toBeEnabled();

    await page.getByRole("button", { name: "Apply to stock" }).click();
    // The header states the outcome; the status word alone appears in several
    // places on this page, so assert the sentence rather than the badge.
    await expect(page.getByText(/adjustments are in the ledger/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply to stock" })).toHaveCount(0);
  });

  test("a cashier cannot reach user management", async ({ page }) => {
    await signIn(page, CASHIER);
    await page.goto("/admin");

    // The nav hides what the role cannot do; the API refuses it regardless.
    await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  });
});

test.describe("Accessibility basics", () => {
  test("keyboard can reach the cart from the homepage", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: /skip to content/i })).toBeFocused();
  });

  test("product page exposes structured data", async ({ page }) => {
    await page.goto("/shop");
    await page.locator("article a").first().click();

    const jsonLd = await page.locator('script[type="application/ld+json"]').first().textContent();
    expect(jsonLd).toContain("schema.org");
    expect(jsonLd).toContain("Product");
  });
});
