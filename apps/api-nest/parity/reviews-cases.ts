/**
 * Parity cases for review moderation (phase 6 part 9): `/reviews/` in the
 * back office -- the list, a review, and the two decisions. What a shopper
 * writes and what a product page shows were phases 1 and 2. Each decision is
 * compared by the reviews it changed and by the audit log.
 *
 * The reviews come from fixture_reviews.py, fixture.py and fixture_orders.py.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { mintedBlanker } from './pos-sale-cases.ts';
import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';

export const REVIEW_TABLES = ['engagement_review'];

export const REVIEW_EFFECTS = [
  // 0. Reviews a decision changed. A stamp is compared by whether it moved, never by its value.
  `SELECT r.title, r.rating, r.status, r.moderation_note, u.email AS moderated_by,
          r.moderated_at IS NOT NULL AS moderated,
          r.moderated_at IS DISTINCT FROM snap.moderated_at AS stamped,
          r.moderated_at >= $1 AS stamped_now, r.updated_at >= $1 AS touched,
          r.created_at = snap.created_at AND r.comment = snap.comment
            AND r.verified_purchase = snap.verified_purchase
            AND r.order_id IS NOT DISTINCT FROM snap.order_id AS rest_as_before
     FROM engagement_review r JOIN "snap_engagement_review" snap ON snap.id = r.id
     LEFT JOIN accounts_user u ON u.id = r.moderated_by_id
    WHERE to_jsonb(r) IS DISTINCT FROM to_jsonb(snap) ORDER BY r.title, r.created_at`,
  // 1. Reviews made or deleted: none should be.
  `SELECT (SELECT count(*) FROM engagement_review r
            WHERE r.id NOT IN (SELECT id FROM "snap_engagement_review")) AS made,
          (SELECT count(*) FROM "snap_engagement_review" s
            WHERE s.id NOT IN (SELECT id FROM engagement_review)) AS deleted`,
  // 2. The audit log, a review's label read by its title.
  `SELECT a.action, a.entity_type,
          regexp_replace(a.entity_label, '[0-9a-f]{8}-[0-9a-f-]{27}', '<product>') AS entity_label,
          (SELECT r.title FROM engagement_review r WHERE r.id::text = a.entity_id) AS review,
          a.actor_label, a.old_values::text AS old_values, a.new_values::text AS new_values,
          a.reason, a.branch_id IS NULL AS no_branch
     FROM core_auditlog a WHERE a.created_at >= $1 ORDER BY a.created_at, a.action`,
];

/** Set once the cases are built: the fixture's reviews were there when the run began. */
export const reviewsFixture = { seen: false };

export async function resetReviews(client: pg.Client): Promise<void> {
  await restoreTables(client, REVIEW_TABLES);
}

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';

export async function reviewsCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const found = new Map(
    (
      await db.query<{ key: string; id: string }>(
        `SELECT title AS key, id FROM engagement_review WHERE title LIKE 'Parity mod %'`,
      )
    ).rows.map((row) => [row.key, row.id]),
  );
  if (!found.has('Parity mod five')) {
    await db.end();
    console.log('SKIP  reviews: fixture_reviews.py has not been applied');
    return [];
  }
  reviewsFixture.seen = true;
  // A name the fixture does not hold is a mistake in this file, not a case.
  const review = (title: string) => {
    const id = found.get(`Parity mod ${title}`);
    if (!id) throw new Error(`reviews-cases: no review called Parity mod ${title}`);
    return id;
  };
  const products = (
    await db.query<{ id: string }>(
      `SELECT DISTINCT product_id AS id FROM engagement_review ORDER BY 1`,
    )
  ).rows.map((row) => row.id);
  const unreviewed = (
    await db.query<{ id: string }>(
      `SELECT id FROM catalog_product WHERE id NOT IN (SELECT product_id FROM engagement_review)
        ORDER BY slug LIMIT 1`,
    )
  ).rows[0]?.id as string;
  const everyId = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM engagement_review UNION ALL SELECT id::text FROM catalog_product
       UNION ALL SELECT id::text FROM customers_customer UNION ALL SELECT id::text FROM orders_order`,
    )
  ).rows.map((row) => row.id);
  await db.end();
  const minted = mintedBlanker(new Set(everyId), Date.now() - 60_000);
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  const cases: Case[] = [];
  const REVIEWS = '/api/v1/reviews/';
  const one = (title: string, action = '') =>
    `${REVIEWS}${review(title)}/${action ? `${action}/` : ''}`;
  const read = (name: string, path: string, who: Who = 'owner', extra: Partial<Case> = {}) =>
    cases.push({ name: `reviews: ${name}`, path, headers: auth(who), ...extra });
  const write = (
    name: string,
    path: string,
    body: unknown,
    who: Who = 'manager',
    extra: Partial<Case> = {},
  ) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `reviews: ${name}`,
      method: 'POST',
      path,
      headers: { ...auth(who), ...JSON_TYPE, ...(headers ?? {}) },
      body: text(body),
      reset: resetReviews,
      effects: REVIEW_EFFECTS,
      normalize: minted,
      ...rest,
    });
  };
  const everyone = Object.keys(STAFF) as Who[];
  const DECISIONS = ['approve', 'reject'] as const;

  // === Who may do what =========================================================================
  for (const who of everyone) {
    read(`[${who}] the list`, `${REVIEWS}?page_size=3`, who);
    read(`[${who}] a review`, one('five'), who);
    for (const decision of DECISIONS) {
      write(`[${who}] ${decision}`, one('five', decision), { note: 'Parity decision' }, who);
      write(
        `[${who}] ${decision} one that is not there`,
        `${REVIEWS}${MISSING}/${decision}/`,
        {},
        who,
      );
    }
  }

  // === Reading =================================================================================
  for (const query of [
    '',
    'page_size=4',
    'page_size=4&page=2',
    'page=last&page_size=5',
    'page=99',
    'page_size=0',
    ...['PENDING', 'APPROVED', 'REJECTED', 'pending', 'NOPE', ''].map(
      (status) => `status=${status}`,
    ),
    ...products.map((id) => `product=${id}`),
    `product=${unreviewed}`,
    `product=${MISSING}`,
    'product=abc',
    'product=',
    ...[
      '5',
      '4',
      '1',
      '0',
      '-1',
      '6',
      ' 5 ',
      '4.5',
      '4.9',
      '-0.5',
      '5.0',
      '1e0',
      '5e0',
      '1E0',
      '0.1e1',
      '+5',
      '05',
      '5.',
      '.5',
      '1_0',
      '_5_',
      '0x5',
      '5,0',
      '5 5',
      '--5',
      '5e',
      'abc',
      'NaN',
      'nan',
      'sNaN',
      'Infinity',
      '-Infinity',
      'inf',
      '32767',
      '32768',
      '-32769',
      '99999999999999999999',
      '1e50',
      '1e51',
      '100000000000000007629769841091887003294964970946560',
      '100000000000000007629769841091887003294964970946561',
      '-1e400',
      '1e400',
      '1e-400',
      '%EF%BC%95',
      '%E0%A7%AB',
      '%D9%A5',
      'a%00b',
    ].map((rating) => `rating=${rating.replaceAll(' ', '%20').replaceAll('+', '%2B')}`),
    'status=PENDING&rating=5',
    `status=APPROVED&rating=4&product=${products[0]}`,
    'status=NOPE&product=abc&rating=abc',
    'ordering=created_at',
    'ordering=-created_at',
    'ordering=rating,created_at',
    'ordering=-rating,created_at',
    'ordering=-rating,-created_at&page_size=3',
    'ordering=rating',
    'ordering=status,created_at',
    'ordering=product',
    'ordering=nope',
    'ordering=',
    'ordering=created_at,rating',
    'ordering=rating,rating,created_at',
    'ordering=rating,-rating,created_at',
    'search=Parity&verified_purchase=true&customer=abc',
  ]) {
    read(`the list ${query || 'unfiltered'}`, `${REVIEWS}?${query}`);
  }
  for (const title of ['five', 'one', 'three', 'refused', 'passed']) {
    read(`the review "${title}"`, one(title));
  }
  read('one that is not there', `${REVIEWS}${MISSING}/`);
  read('a key that is no id', `${REVIEWS}abc/`);
  read('no trailing slash', REVIEWS.slice(0, -1));
  read('a review through a filter that holds it', `${one('five')}?status=PENDING&rating=5`);
  read('a review through a filter that does not', `${one('five')}?status=APPROVED`);
  read('a review through a rating cut to its own', `${one('five')}?rating=5.9`);
  read('a review through a filter that is wrong', `${one('five')}?rating=abc`);
  read('a review, ordered', `${one('five')}?ordering=-rating`);
  read('a decision cannot be read', one('five', 'approve'));

  // === What the API does not offer =============================================================
  for (const [what, method, path] of [
    ['a review cannot be written', 'POST', REVIEWS],
    ['the list cannot be deleted', 'DELETE', REVIEWS],
    ['a review cannot be replaced', 'PUT', one('five')],
    ['a review cannot be edited', 'PATCH', one('five')],
    ['a review cannot be deleted', 'DELETE', one('five')],
    ['a review cannot be posted to', 'POST', one('five')],
    ['a decision cannot be put', 'PUT', one('five', 'approve')],
    ['a decision cannot be deleted', 'DELETE', one('five', 'reject')],
  ] as const) {
    write(what, path, { status: 'APPROVED', rating: 1 }, 'owner', { method });
  }
  write('a decision that is none', one('five', 'publish'), {}, 'owner');

  // === Deciding ================================================================================
  const NOTES: [string, unknown][] = [
    ['no body', undefined],
    ['an empty object', {}],
    ['a note', { note: 'Checked against the order' }],
    ['a note with space around it', { note: '  Trimmed  ' }],
    ['a blank note', { note: '' }],
    ['a note of spaces', { note: '   ' }],
    ['a null note', { note: null }],
    ['a note that is a number', { note: 5 }],
    ['a note that is zero', { note: 0 }],
    ['a note that is a fraction', { note: 1.5 }],
    ['a note that is a whole fraction', '{"note": 2.0}'],
    ['a note in exponent form', '{"note": 1e3}'],
    ['a note that is minus nothing', '{"note": -0.0}'],
    ['a note that is a large number', '{"note": 12345678901234567890}'],
    ['a note that is true', { note: true }],
    ['a note that is false', { note: false }],
    ['a note that is an empty list', { note: [] }],
    ['a note that is a list', { note: ['spam', 2, null, true] }],
    ['a note that is an empty object', { note: {} }],
    ['a note that is an object', { note: { why: "it's spam", n: 1.5 } }],
    ['a note in Bengali', { note: 'অশালীন ভাষা — "quoted"' }],
    ['the longest note', { note: 'n'.repeat(255) }],
    ['a note too long', { note: 'n'.repeat(256) }],
    ['a note too long before it is trimmed', { note: `  ${'n'.repeat(255)}  ` }],
    ['a note with a NUL', { note: 'a\u0000b' }],
    ['a note of several lines', { note: 'First\n  second\n' }],
    ['other keys', { status: 'PENDING', moderation_note: 'ignored', rating: 1, notes: 'x' }],
    ['a list', []],
    ['a list holding a note', [{ note: 'x' }]],
    ['a string', '"spam"'],
    ['a number', '7'],
    ['null', 'null'],
    ['true', 'true'],
    ['broken JSON', '{"note": '],
  ];
  for (const title of ['five', 'refused', 'passed']) {
    for (const decision of DECISIONS) {
      for (const [what, body] of NOTES) {
        write(`${decision} "${title}" with ${what}`, one(title, decision), body);
      }
    }
  }
  for (const decision of DECISIONS) {
    write(`${decision} by the owner`, one('one', decision), { note: 'Owner says' }, 'owner');
    write(`${decision} a review with no comment`, one('three', decision), {});
    write(
      `${decision} through a filter that holds the review`,
      `${one('five', decision)}?status=PENDING`,
      {},
    );
    write(
      `${decision} through a filter that does not`,
      `${one('five', decision)}?status=REJECTED`,
      {},
    );
    write(`${decision} through a filter that is wrong`, `${one('five', decision)}?product=abc`, {});
    write(`${decision} a key that is no id`, `${REVIEWS}abc/${decision}/`, {});
    write(
      `${decision} one that is not there, from a list`,
      `${REVIEWS}${MISSING}/${decision}/`,
      [],
    );
    cases.push({
      name: `reviews: ${decision}: a form body`,
      method: 'POST',
      path: one('five', decision),
      headers: { ...auth('manager'), 'content-type': 'application/x-www-form-urlencoded' },
      body: 'note=From+a+form',
      reset: resetReviews,
      effects: REVIEW_EFFECTS,
      normalize: minted,
    });
  }

  return cases;
}
