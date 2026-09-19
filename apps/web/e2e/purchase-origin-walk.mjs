/**
 * Browser walk for goods arriving through purchasing (business-rules §4.0b).
 *
 * On /admin/purchases/new: add a supplier inline without submitting the order
 * (D81), take a line from the supplier's own history at their last price, make
 * a brand-new product with two sizes on the order, and receive the lot in the
 * same step. Then confirm the order is RECEIVED and the new product is on the
 * shelf at the cost typed.
 *
 * Writes real rows, so point it at a demo database. Two ways to run it:
 *
 *   # the Playwright container, as purchasing-walk.mjs documents
 *   BASE=http://web:3000 node purchase-origin-walk.mjs
 *
 *   # from a Windows host with no Playwright browsers downloaded: drive the
 *   # Edge that ships with Windows
 *   CHANNEL=msedge BASE=http://localhost:4000 node e2e/purchase-origin-walk.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://web:3000";
const EMAIL = process.env.EMAIL ?? "stock@rangon.test";
const PASSWORD = process.env.PASSWORD ?? "rangon12345";
const TIMEOUT = Number(process.env.TIMEOUT ?? 180_000);
const SUPPLIER = process.env.SUPPLIER ?? "Dhaka Textile House";
const CATEGORY = process.env.CATEGORY ?? "Kurti";

const violations = [];
const failures = [];
function ok(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
const page = await (await browser.newContext()).newPage();
page.setDefaultTimeout(TIMEOUT);
page.setDefaultNavigationTimeout(TIMEOUT);
page.on("console", (m) => {
  if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
});
page.on("pageerror", (e) => violations.push("pageerror: " + e.message));
const posts = [];
page.on("request", (r) => {
  if (r.method() === "POST") posts.push(new URL(r.url()).pathname);
});
// A native form submission shows up as a navigation to `...?` (D81).
const navs = [];
page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) navs.push(f.url());
});
const main = async () => (await page.locator("#main").innerText()).replace(/\s+/g, " ");

// ---- sign in -------------------------------------------------------------
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.waitForFunction(() => {
  const el = document.querySelector("#email");
  return el && Object.keys(el).some((k) => k.startsWith("__react"));
});
for (let i = 0; i < 5; i += 1) {
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  if ((await page.inputValue("#email")) === EMAIL) break;
  await page.waitForTimeout(1000);
}
await page.getByRole("button", { name: /^sign in$/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"));
ok("signed in", !page.url().includes("/login"), page.url());

// ---- the product form points here ----------------------------------------
await page.goto(`${BASE}/admin/products/new`, { waitUntil: "networkidle" });
ok(
  "the product form sends new stock to the purchase order",
  (await page.getByRole("link", { name: "purchase order" }).count()) === 1,
);

await page.goto(`${BASE}/admin/purchases/new`, { waitUntil: "networkidle" });
await page.locator("#po-supplier").waitFor();
ok("new purchase order form renders", true);

// ---- D81: saving a supplier inline does not submit the order --------------
const stamp = Date.now();
const newSupplier = `Walk Origin ${stamp}`;
await page.getByRole("button", { name: /^new$/i }).click();
await page.waitForSelector("#sup-name");
await page.fill("#sup-name", newSupplier);
const postsBefore = posts.length;
await page.getByRole("button", { name: /create supplier/i }).click();
await page.waitForFunction(
  (name) => {
    const select = document.querySelector("#po-supplier");
    return select && select.selectedOptions[0]?.textContent?.includes(name);
  },
  newSupplier,
);
await page.waitForTimeout(800);
const afterSupplier = await main();
ok(
  "saving a supplier neither reloads the page nor submits the order",
  !navs.some((url) => url.endsWith("?")) &&
    !/Could not raise this purchase order/i.test(afterSupplier) &&
    !posts.slice(postsBefore).some((p) => p.includes("purchase-orders")),
  posts.slice(postsBefore).join(", "),
);
ok("the new supplier is created and chosen", posts.slice(postsBefore).some((p) => p.includes("suppliers")));

// ---- the supplier's own history ------------------------------------------
await page.selectOption("#po-supplier", { label: SUPPLIER });
const history = page.locator('section[aria-labelledby="po-history-heading"] li button');
try {
  await history.first().waitFor({ state: "visible", timeout: 30_000 });
} catch {
  /* reported below */
}
const historyCount = await history.count();
ok(`${SUPPLIER}'s past deliveries are offered`, historyCount > 0, `${historyCount} shown`);
if (historyCount > 0) {
  await history.first().click();
  await page.waitForTimeout(400);
  ok(
    "a history line is priced at the supplier's last price",
    /last paid to them/i.test(await main()),
  );
  ok(
    "the same product cannot be added twice from history",
    await history.first().isDisabled(),
  );
}

// ---- a new product, made on the order ------------------------------------
await page.getByRole("button", { name: /new product/i }).click();
await page.waitForSelector("#np-name");
const productName = `Walk Kurti ${stamp}`;
await page.fill("#np-name", productName);
// Enter in the panel must create nothing yet and must not submit the order.
const postsBeforeEnter = posts.length;
await page.press("#np-name", "Enter");
await page.waitForTimeout(600);
ok(
  "Enter in the panel submits the panel, not the order, and reloads nothing",
  !navs.some((url) => url.endsWith("?")) &&
    !posts.slice(postsBeforeEnter).some((p) => p.includes("purchase-orders")) &&
    /Choose a category/i.test(await main()),
);

await page.selectOption("#np-category", { label: CATEGORY });
const size = page.locator("#np-axis-size");
await size.waitFor({ state: "visible", timeout: 60_000 });
for (const value of ["S", "M"]) {
  await size.getByText(value, { exact: true }).click();
}
await page.fill("#np-price", "1950");
await page.fill("#np-cost", "820");
await page.fill("#np-quantity", "3");
ok(
  "the button says how many lines it will make",
  (await page.getByRole("button", { name: /create and add 2 lines/i }).count()) === 1,
);
await page.getByRole("button", { name: /create and add 2 lines/i }).click();
await page.locator("#np-name").waitFor({ state: "detached" });

const lines = page.locator("table tbody tr");
const newLines = lines.filter({ hasText: productName });
ok("both sizes arrive as lines", (await newLines.count()) === 2, `${await newLines.count()}`);
ok("they are marked new", (await newLines.filter({ hasText: "New" }).count()) === 2);
ok(
  "at the cost typed",
  (await newLines.locator('input[aria-label^="Unit cost for"]').first().inputValue()) === "820",
);

// ---- receive it all now --------------------------------------------------
await page.getByLabel(/the goods are here/i).check();
const receiveButton = page.getByRole("button", { name: /receive \d+ units? into stock/i });
ok("the save button says what it will do", (await receiveButton.count()) === 1);
await receiveButton.click();
await page.waitForURL(/\/admin\/purchases\/[0-9a-f-]{36}/);
await page.waitForFunction(
  () => /Received/.test(document.getElementById("main")?.innerText ?? ""),
  undefined,
  { timeout: TIMEOUT },
);
const detail = await main();
ok("the order is received in the same step", /Received/.test(detail) && !/Partially/i.test(detail));
ok("the new product is on it", detail.includes(productName));

// ---- and on the shelf, at the cost paid ------------------------------------
const stock = await page.evaluate(async (name) => {
  const response = await fetch(`/api/proxy/inventory/?search=${encodeURIComponent(name)}`);
  return response.ok ? response.json() : { error: response.status };
}, productName);
const rows = stock.results ?? [];
ok(
  "three of each on hand",
  rows.length === 2 && rows.every((row) => Number(row.on_hand) === 3),
  JSON.stringify(rows.map((row) => row.on_hand)),
);
ok(
  "at a weighted average of 820",
  rows.length === 2 && rows.every((row) => Number(row.average_cost) === 820),
  JSON.stringify(rows.map((row) => row.average_cost)),
);

await page.screenshot({ path: process.env.SHOT ?? "po-origin-walk.png", fullPage: true });

console.log("\nCSP violations / page errors:", violations.length);
for (const v of violations.slice(0, 6)) console.log("   ", v.slice(0, 200));
console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${failures.join(", ")}`}`);
await browser.close();
process.exit(failures.length === 0 ? 0 : 1);
