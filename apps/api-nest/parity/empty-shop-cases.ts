/**
 * Parity cases for a shop on its first day (`scripts/nest-parity.sh empty`).
 *
 * Every other case runs on the seeded shop, and no case can empty it: orders
 * and variants protect what they refer to. So what an installation does
 * before it has anything -- and the port has code for each -- was compared
 * with nothing (docs/architecture/djangos-tests-sorted.md, "What is left to
 * port"). This is that database, at the two moments a new store passes
 * through (docs/operations/new-store-from-scratch.md):
 *
 *   unopened   `migrate` and `createsuperuser`: the roles, one owner, and no
 *              organisation, branch, account, product or order
 *   opened     `scripts/bootstrap-store.py` run on that: an organisation, its
 *              first branch and a cash drawer, and still nothing to sell
 *
 * The same requests are sent at both: every list a screen opens on, what the
 * storefront shows a visitor, and the first things an owner does -- settle
 * the VAT, name the shop, add a branch, import a catalogue.
 */
import pg from 'pg';

import { multipart, type Part } from './image-cases.ts';
import { IMPORT_EFFECTS, IMPORT_TABLES } from './import-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { restoreSequences, restoreTables } from './restore.ts';
import { type Case, token } from './run.ts';

export type Stage = 'unopened' | 'opened';

/** What a visitor's browser asks for. */
const SHOP = [
  'home/',
  'navigation/',
  'site/',
  'pages/',
  'categories/',
  'brands/',
  'products/',
  'products/?search=shirt&ordering=-price',
  'facets/',
  'search/suggest/?q=sh',
  'shipping-options/?city=Dhaka&subtotal=1000',
  'feed.csv',
  'feed.xml',
];

/** The list each back-office screen opens on, and the till's. */
const STAFF = [
  'organization/',
  'organization/tax/',
  'branches/',
  'users/',
  'roles/',
  'permissions/',
  'products/',
  'variants/',
  'categories/',
  'brands/',
  'attributes/',
  'attribute-values/',
  'size-charts/',
  'product-images/',
  'inventory/',
  'inventory/low-stock/',
  'inventory/valuation/',
  'inventory-transactions/',
  'stock-counts/',
  'stock-transfers/',
  'orders/',
  'returns/',
  'abandoned-checkouts/',
  'customers/',
  'coupons/',
  'reviews/',
  'suppliers/',
  'supplier-products/',
  'purchase-orders/',
  'supplier-payments/',
  'accounts/',
  'accounts/cash-position/',
  'account-transactions/',
  'account-transfers/',
  'expense-categories/',
  'expenses/',
  'expenses/summary/',
  'party-ledger/',
  'couriers/',
  'shipments/',
  'shipping-zones/',
  'shipping-methods/',
  'site-settings/',
  'site-pages/',
  'social-links/',
  'storefront-banners/',
  'navigation-items/',
  'home-carousel/',
  'notifications/',
  'notifications/count/',
  'audit-logs/',
  'pos/session/',
  'pos/products/',
  'pos/holds/',
  // A stated window: left out, each report's ends at the moment it is asked.
  'reports/dashboard/?date_from=2026-01-01&date_to=2026-01-31',
  'reports/sales/?date_from=2026-01-01&date_to=2026-01-31',
  'reports/profit/?date_from=2026-01-01&date_to=2026-01-31',
  'reports/vat/?date_from=2026-01-01&date_to=2026-01-31',
  'reports/business-summary/?date_from=2026-01-01&date_to=2026-01-31',
  'reports/inventory/valuation/',
];

/** An audit entry's values as text, with what each API mints taken out: ids and moments. */
const minted = (column: string) =>
  `regexp_replace(regexp_replace(${column}::text,
     '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', 'g'),
     '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(\\+[0-9:]+|Z)?', '<moment>', 'g')`;

const SHOP_TABLES = [
  'accounts_organization',
  'accounts_branch',
  'finance_account',
  'finance_accounttransaction',
  'orders_cart',
  'orders_cartitem',
];

const SHOP_EFFECTS = [
  `SELECT name, legal_name, slug, currency, status, tax_mode, default_tax_rate::text AS rate,
          tax_settled_at >= $1 AS settled, updated_at >= $1 AS touched, created_at >= $1 AS created
     FROM accounts_organization ORDER BY created_at`,
  `SELECT b.name, b.code, b.is_default, b.status, o.name AS organization, b.created_at >= $1 AS created
     FROM accounts_branch b LEFT JOIN accounts_organization o ON o.id = b.organization_id
    ORDER BY b.code`,
  `SELECT name, kind, is_default, is_active, balance::text AS balance FROM finance_account ORDER BY name`,
  `SELECT (SELECT count(*) FROM orders_cart)::int AS carts`,
  `SELECT a.action, a.entity_type, a.entity_label, ${minted('a.old_values')} AS old,
          ${minted('a.new_values')} AS new, a.reason, u.email AS actor
     FROM core_auditlog a LEFT JOIN accounts_user u ON u.id = a.actor_id
    WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
];

/** The first catalogue: its sizes and colours are the first the shop has. */
const CATALOGUE = [
  'Product Name,Category,Brand,SKU,Size,Color,Price,Cost,Opening stock',
  'First Day Shirt,Men > Shirts,First Looms,FD-SHIRT-M-WHT,M,White,1450,620,12',
  'First Day Shirt,Men > Shirts,First Looms,FD-SHIRT-L-SKY,L,Sky,1490,620,0',
  'First Day Scarf,Accessories,,FD-SCARF,,,490,200,5',
].join('\r\n');

export async function emptyShopCases(stage: Stage): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const owner = (
    await db.query<{ id: string; password: string }>(
      `SELECT id, password FROM accounts_user WHERE is_superuser ORDER BY created_at LIMIT 1`,
    )
  ).rows[0];
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM accounts_user UNION ALL SELECT id::text FROM accounts_organization
       UNION ALL SELECT id::text FROM accounts_branch UNION ALL SELECT id::text FROM accounts_role
       UNION ALL SELECT id::text FROM accounts_permission UNION ALL SELECT id::text FROM finance_account`,
    )
  ).rows.map((row) => row.id);
  const shop = (
    await db.query<{
      organizations: number;
      orders: number;
      products: number;
      branch: string | null;
    }>(
      `SELECT (SELECT count(*) FROM accounts_organization)::int AS organizations,
              (SELECT count(*) FROM orders_order)::int AS orders,
              (SELECT count(*) FROM catalog_product)::int AS products,
              (SELECT id::text FROM accounts_branch ORDER BY created_at LIMIT 1) AS branch`,
    )
  ).rows[0];
  await db.end();
  if (!owner) throw new Error('No owner: `scripts/nest-parity.sh empty` makes one.');
  if (shop?.orders || shop?.products)
    throw new Error(
      'This shop has orders or products: `scripts/nest-parity.sh empty` starts one without.',
    );
  if (Boolean(shop?.organizations) !== (stage === 'opened'))
    throw new Error(
      `PARITY_SHOP=${stage}, and the database holds ${shop?.organizations} organisation(s).`,
    );

  const as = {
    authorization: `Bearer ${token(owner, { exp: Math.floor(Date.now() / 1000) + 3600 })}`,
  };
  const json = { 'content-type': 'application/json' };
  const blank = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const cases: Case[] = [];
  const read = (name: string, path: string, headers: Record<string, string> = {}) =>
    cases.push({ name: `${stage} shop: ${name}`, path, headers, flushCache: true });
  const write = (
    name: string,
    method: string,
    path: string,
    body: unknown,
    extra: Partial<Case> = {},
  ) =>
    cases.push({
      name: `${stage} shop: ${name}`,
      method,
      path,
      headers: { ...as, ...json },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      reset: (client) => restoreTables(client, SHOP_TABLES),
      effects: SHOP_EFFECTS,
      normalize: blank,
      ...extra,
    });

  // --- What anyone can ask ---------------------------------------------------------
  read('the health check', '/api/health/');
  read('the readiness probe', '/api/ready/');
  for (const path of SHOP) read(`a visitor, ${path}`, `/api/v1/shop/${path}`);
  read('a visitor, a product that is not there', '/api/v1/shop/products/first-day-shirt/');
  // A cart is made for whoever asks, at the default branch -- if there is one.
  cases.push({
    name: `${stage} shop: a visitor's cart`,
    path: '/api/v1/shop/cart/',
    reset: (client) => restoreTables(client, SHOP_TABLES),
    effects: SHOP_EFFECTS,
    normalize: (body) => {
      blank(body);
      const cart = body as Record<string, unknown> | null;
      if (!cart || typeof cart !== 'object') return;
      for (const key of ['token', 'header:x-cart-token']) {
        if (typeof cart[key] === 'string') cart[key] = '<minted>';
      }
    },
  });

  // --- The owner, signed in ----------------------------------------------------------
  read('the owner, me', '/api/v1/auth/me/', as);
  for (const path of STAFF) read(`the owner, ${path}`, `/api/v1/${path}`, as);
  read('nobody, the staff list', '/api/v1/users/');

  // --- The first things an owner does ---------------------------------------------------
  const TAX = '/api/v1/organization/tax/';
  // No order has been priced, so there is nothing to warn about and nothing to confirm.
  write('the VAT settled for the first time', 'PATCH', TAX, {
    tax_mode: 'INCLUSIVE',
    default_tax_rate: '0.1500',
  });
  write('the VAT settled as it stands', 'PATCH', TAX, {
    tax_mode: 'EXCLUSIVE',
    default_tax_rate: '0.0000',
  });
  write('the VAT settled, nothing sent', 'PATCH', TAX, {});
  write('the shop named', 'PATCH', '/api/v1/organization/', { name: 'First Day Fashion' });
  write('a branch added', 'POST', '/api/v1/branches/', { name: 'Second Shop', code: 'TWO' });
  // At the first branch, once there is one; before that there is nowhere to open it.
  write('a cash account opened', 'POST', '/api/v1/accounts/', {
    name: 'Petty Cash',
    kind: 'CASH',
    ...(shop?.branch ? { branch: shop.branch } : {}),
  });

  const upload = (name: string, fields: Record<string, string>) => {
    const parts: Part[] = Object.entries(fields).map(([key, value]) => [key, value] as Part);
    parts.push([
      'file',
      { filename: 'catalogue.csv', type: 'text/csv', bytes: Buffer.from(CATALOGUE, 'utf8') },
    ]);
    const boundary = '----ParityFirstDay7';
    cases.push({
      name: `${stage} shop: ${name}`,
      method: 'POST',
      path: '/api/v1/products/import/',
      headers: { ...as, 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: multipart(parts, boundary),
      reset: async (client) => {
        await restoreTables(client, [...IMPORT_TABLES, ...SHOP_TABLES]);
        await restoreSequences(client);
      },
      effects: [...IMPORT_EFFECTS, ...SHOP_EFFECTS],
      normalize: blank,
    });
  };
  // The first catalogue: nothing to match a size or a colour against, so the
  // import makes the two attributes as well as the values.
  upload('the first catalogue, looked at', {});
  upload('the first catalogue, brought in', { dry_run: 'false' });
  return cases;
}
