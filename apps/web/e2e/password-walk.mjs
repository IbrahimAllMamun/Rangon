/**
 * Scratch walk over password self-service: /admin/account and the app's
 * /api/auth/password route. No browser — it drives the same routes the form
 * does, with two sessions open for one account, and checks what the second one
 * can still do after the first changes the password.
 *
 * Runs against a dev server with the demo seed, as the stock cashier account,
 * and puts the README password back at the end so the seed stays usable:
 *
 *   BASE=http://localhost:4000 node e2e/password-walk.mjs
 */
const BASE = process.env.BASE ?? "http://localhost:4000";
const EMAIL = process.env.EMAIL ?? "cashier@rangon.test";
const PASSWORD = process.env.PASSWORD ?? "rangon12345";
const NEW = "walk-temporary-passphrase-7";

const failures = [];
function ok(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

const cookiesOf = (response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

async function signIn(password) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password }),
  });
  return response.ok ? cookiesOf(response) : null;
}

async function change(cookie, current, next) {
  const response = await fetch(`${BASE}/api/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ current_password: current, new_password: next }),
  });
  return { status: response.status, body: await response.json(), cookie: cookiesOf(response) };
}

/** 200 if the session can still load a staff page; a redirect to /login if not. */
async function staffPage(cookie) {
  const response = await fetch(`${BASE}/admin/account`, { headers: { cookie }, redirect: "manual" });
  return { status: response.status, html: response.status === 200 ? await response.text() : "" };
}

const mine = await signIn(PASSWORD);
const theirs = await signIn(PASSWORD);
ok("two sessions open for one account", Boolean(mine && theirs));

const page = await staffPage(mine);
ok("/admin/account renders for a cashier", page.status === 200 && /Change your password/.test(page.html));
ok("it says who is signed in", page.html.includes(EMAIL));
ok("the header links to it", /href="\/admin\/account"/.test(page.html));

const wrong = await change(mine, "not-the-password", NEW);
ok(
  "a wrong current password is refused against its field",
  wrong.status === 400 && Boolean(wrong.body?.error?.details?.current_password),
  `status ${wrong.status}`,
);

const same = await change(mine, PASSWORD, PASSWORD);
ok("the current password cannot be chosen again", same.status === 400 && Boolean(same.body?.error?.details?.new_password));

const done = await change(mine, PASSWORD, NEW);
ok("the change succeeds", done.status === 200, `status ${done.status}`);
ok("no token reaches the browser", !JSON.stringify(done.body).includes("eyJ"));
ok("the session that changed it is given new cookies", /rangon_access=/.test(done.cookie));

const stillMine = await staffPage(done.cookie);
ok("that session carries on", stillMine.status === 200);

const other = await staffPage(theirs);
ok("the other session is signed out at once", other.status !== 200, `status ${other.status}`);

ok("the old password no longer signs in", (await signIn(PASSWORD)) === null);
ok("the new one does", Boolean(await signIn(NEW)));

// Put the seed back the way it was.
const back = await change(done.cookie, NEW, PASSWORD);
ok("the README password is restored for the next person", back.status === 200, `status ${back.status}`);

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
