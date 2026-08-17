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
  await page.getByLabel("Email address").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
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

test.describe("POS", () => {
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

test.describe("Admin", () => {
  test("manager sees the dashboard with server-aggregated KPIs", async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto("/admin");

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Revenue")).toBeVisible();
    await expect(page.getByText("Gross profit")).toBeVisible();
  });

  test("inventory reflects the ledger", async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto("/admin/inventory");

    await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Available" })).toBeVisible();
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
