/**
 * Scratch walk over the two reader screens: /admin/audit and
 * /admin/inventory/movements. No browser — every screen here is a server
 * component and its filters are plain GET forms, so the HTML the server
 * renders is what is being checked.
 *
 * Runs against a dev server with the demo seed, signing in through the app's
 * own `/api/auth/login` route with the README's development accounts:
 *
 *   BASE=http://localhost:4000 node e2e/readers-walk.mjs
 */
const BASE = process.env.BASE ?? "http://localhost:4000";
const PASSWORD = process.env.PASSWORD ?? "rangon12345";

const failures = [];
function ok(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

async function signIn(email) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`sign-in as ${email} failed: ${response.status}`);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function page(cookie, path) {
  const response = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: response.status, html: await response.text() };
}

/** The text a reader sees, near enough: tags and the RSC payload's escapes gone. */
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");

// ------------------------------------------------------------- the ledger --
const owner = await signIn("owner@rangon.test");

let movements = await page(owner, "/admin/inventory/movements");
ok("movements renders for the owner", movements.status === 200, `status ${movements.status}`);
ok("movements has rows", /Stock movements, newest first/.test(movements.html));
ok(
  "a receipt row opens its purchase order, labelled with both numbers",
  /href="\/admin\/purchases\/[0-9a-f-]{36}"[^>]*>PO-\d+ · GRN-\d+</.test(movements.html),
);
ok("a sale row opens its order", /href="\/admin\/orders\/[0-9a-f-]{36}"/.test(movements.html));

const written = await page(owner, "/admin/inventory/movements?family=written-off");
ok(
  "a family filter narrows the rows",
  written.status === 200 && !/>Sale</.test(text(written.html)),
);

const unknown = await page(owner, "/admin/inventory/movements?family=bananas");
ok("an unknown family shows everything, not an error", unknown.status === 200 && !/Could not load/.test(unknown.html));

const badDate = await page(owner, "/admin/inventory/movements?date_from=yesterday");
ok(
  "an unreadable date is reported on the page, not a crash",
  badDate.status === 200 && /Could not load stock movements/.test(badDate.html),
);

const inventory = await page(owner, "/admin/inventory");
const history = inventory.html.match(/href="(\/admin\/inventory\/movements\?variant=[^"]+)"/);
ok("each stock row links to its history", Boolean(history));
if (history) {
  const scoped = await page(owner, history[1].replace(/&amp;/g, "&"));
  ok("a variant's history names the variant", /History of/.test(text(scoped.html)));
}

// ---------------------------------------------------------------- the audit --
const audit = await page(owner, "/admin/audit");
ok("audit renders for the owner", audit.status === 200 && /Audit log/.test(audit.html));
ok("audit shows sign-ins", />Login</.test(audit.html));

const order = audit.html.match(/href="\/admin\/orders\/[0-9a-f-]{36}"[^>]*>(RGN-[A-Z]+-\d+)</);
ok("an order entry links to the order", Boolean(order));
if (order) {
  const searched = await page(owner, `/admin/audit?search=${order[1]}`);
  const labels = [...searched.html.matchAll(/>(RGN-[A-Z]+-\d+)</g)].map((match) => match[1]);
  ok(
    "search finds that order's entries and nothing else",
    labels.length > 0 && labels.every((label) => label === order[1]),
    `${labels.length} labels`,
  );
}

const badAuditDate = await page(owner, "/admin/audit?date_to=soon");
ok("an unreadable audit date is reported, not a crash", /Could not load the audit log/.test(badAuditDate.html));

ok("the owner's sidebar offers the audit log", /href="\/admin\/audit"/.test(audit.html));
ok("the owner's sidebar offers stock movements", /href="\/admin\/inventory\/movements"/.test(audit.html));

// ------------------------------------------------------------------- roles --
const manager = await signIn("manager@rangon.test");
const managerAudit = await page(manager, "/admin/audit");
ok(
  "a manager is told they cannot read the audit log",
  /needs the audit.view permission/.test(managerAudit.html),
);
const managerHome = await page(manager, "/admin/inventory");
ok("a manager's sidebar does not offer it", !/href="\/admin\/audit"/.test(managerHome.html));

const accountant = await signIn("accounts@rangon.test");
const accountantAudit = await page(accountant, "/admin/audit");
ok("an accountant can read the audit log", accountantAudit.status === 200 && !/Could not load/.test(accountantAudit.html));

const cashier = await signIn("cashier@rangon.test");
const cashierMovements = await page(cashier, "/admin/inventory/movements");
ok("a cashier can read stock movements", cashierMovements.status === 200 && !/Could not load/.test(cashierMovements.html));
ok(
  "a cashier is not linked to purchase orders they cannot open",
  !/href="\/admin\/purchases\//.test(cashierMovements.html),
);

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
