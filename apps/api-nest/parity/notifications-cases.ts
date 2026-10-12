/**
 * Parity cases for notifications (phase 7 part 2): `/notifications/` -- the
 * list, one notice, the unread count and marking read. Anyone signed in reads
 * their own, a customer too. Marking read is compared by the notices it
 * changed.
 *
 * The notices come from fixture_notifications.py: two readers nothing else
 * in the run ever notifies.
 */
import pg from 'pg';

import { STAFF, staffHeaders, type Who } from './catalog-admin-cases.ts';
import { restoreTables } from './restore.ts';
import { type Case, token } from './run.ts';

export const NOTIFICATION_TABLES = ['notifications_notification'];

export const NOTIFICATION_EFFECTS = [
  // 0. Notices a request changed. A stamp is compared by whether it moved, never by its value.
  `SELECT n.title, u.email AS reader, n.read_at IS NOT NULL AS read,
          n.read_at IS DISTINCT FROM snap.read_at AS stamped, n.read_at >= $1 AS stamped_now,
          n.updated_at = snap.updated_at AND n.emailed_at IS NOT DISTINCT FROM snap.emailed_at
            AND n.data::text = snap.data::text AND n.body = snap.body AS rest_as_before
     FROM notifications_notification n JOIN "snap_notifications_notification" snap ON snap.id = n.id
     LEFT JOIN accounts_user u ON u.id = n.user_id
    WHERE to_jsonb(n) IS DISTINCT FROM to_jsonb(snap) ORDER BY u.email, n.title`,
  // 1. One moment for everything a request marked; nothing made or deleted.
  `SELECT (SELECT count(DISTINCT n.read_at) FROM notifications_notification n
             JOIN "snap_notifications_notification" snap ON snap.id = n.id
            WHERE n.read_at IS DISTINCT FROM snap.read_at) AS moments,
          (SELECT count(*) FROM notifications_notification n
            WHERE n.id NOT IN (SELECT id FROM "snap_notifications_notification")) AS made,
          (SELECT count(*) FROM "snap_notifications_notification" s
            WHERE s.id NOT IN (SELECT id FROM notifications_notification)) AS deleted`,
];

/** Set once the cases are built: the fixture's notices were there when the run began. */
export const notificationsFixture = { seen: false };

export async function resetNotifications(client: pg.Client): Promise<void> {
  await restoreTables(client, NOTIFICATION_TABLES);
}

const JSON_TYPE = { 'content-type': 'application/json' };
const MISSING = '00000000-0000-4000-8000-000000000000';
export const AUDITOR = 'parity.auditor@rangon.test';
export const BARE = 'parity.bare@rangon.test';

/** Signed headers for the two readers the fixture writes for. */
export async function readerHeaders(
  db: pg.Client,
): Promise<Record<string, Record<string, string>>> {
  const rows = await db.query<{ id: string; email: string; password: string }>(
    `SELECT id, email, password FROM accounts_user WHERE email = ANY($1)`,
    [[AUDITOR, BARE]],
  );
  const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
  return Object.fromEntries(
    rows.rows.map((row) => [row.email, { authorization: `Bearer ${token(row, { exp })}` }]),
  );
}

export async function notificationsCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const staff = await staffHeaders(db);
  const readers = await readerHeaders(db);
  const found = new Map(
    (
      await db.query<{ key: string; id: string }>(
        `SELECT title AS key, id FROM notifications_notification WHERE title ILIKE 'Parity %'`,
      )
    ).rows.map((row) => [row.key, row.id]),
  );
  await db.end();
  if (!found.has('Parity notice one') || !readers[AUDITOR] || !readers[BARE]) {
    console.log('SKIP  notifications: fixture_notifications.py has not been applied');
    return [];
  }
  notificationsFixture.seen = true;
  // A name the fixture does not hold is a mistake in this file, not a case.
  const notice = (title: string) => {
    const id = found.get(title);
    if (!id) throw new Error(`notifications-cases: no notice called ${title}`);
    return id;
  };
  type Reader = Who | 'auditor' | 'bare';
  const auth = (who: Reader) =>
    who === 'auditor'
      ? (readers[AUDITOR] as Record<string, string>)
      : who === 'bare'
        ? (readers[BARE] as Record<string, string>)
        : staff(who);
  const text = (body: unknown) =>
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  const cases: Case[] = [];
  const NOTICES = '/api/v1/notifications/';
  const COUNT = `${NOTICES}count/`;
  const MARK = `${NOTICES}mark-read/`;
  const one = (title: string) => `${NOTICES}${notice(title)}/`;
  const read = (name: string, path: string, who: Reader = 'auditor', extra: Partial<Case> = {}) =>
    cases.push({ name: `notifications: ${name}`, path, headers: auth(who), ...extra });
  const mark = (
    name: string,
    body: unknown,
    who: Reader = 'auditor',
    extra: Partial<Case> = {},
  ) => {
    const { headers, ...rest } = extra;
    cases.push({
      name: `notifications: mark read, ${name}`,
      method: 'POST',
      path: MARK,
      headers: { ...auth(who), ...JSON_TYPE, ...(headers ?? {}) },
      body: text(body),
      reset: resetNotifications,
      effects: NOTIFICATION_EFFECTS,
      ...rest,
    });
  };
  const everyone: Reader[] = [...(Object.keys(STAFF) as Who[]), 'auditor', 'bare'];

  // === Who may read, and what each route answers a method it does not serve =====================
  for (const who of everyone) {
    read(`[${who}] the list`, `${NOTICES}?page_size=5`, who);
    read(`[${who}] the count`, COUNT, who);
    read(`[${who}] the auditor's notice`, one('Parity notice one'), who);
    read(`[${who}] the customer's notice`, one('Parity bare one'), who);
    read(`[${who}] the notice for nobody`, one('Parity notice for nobody'), who);
    mark(`[${who}] everything`, {}, who);
    mark(`[${who}] the auditor's notice`, { ids: [notice('Parity notice one')] }, who);
    read(`[${who}] POST to the list`, NOTICES, who, { method: 'POST', body: '{}' });
    read(`[${who}] POST to the count`, COUNT, who, { method: 'POST', body: '{}' });
    read(`[${who}] GET mark-read`, MARK, who);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      read(`[${who}] ${method} a notice`, one('Parity notice one'), who, { method });
      read(`[${who}] ${method} the count`, COUNT, who, { method });
    }
  }

  // === The list =================================================================================
  for (const query of [
    '',
    'unread=true',
    'unread=false',
    'unread=True',
    'unread=TRUE',
    'unread=1',
    'unread=',
    'unread=%20true',
    'unread=false&unread=true',
    'unread=true&unread=false',
    'page_size=3',
    'page_size=3&page=2',
    'page_size=3&page=3',
    'page_size=3&page=4',
    'page_size=4&page=last',
    'page_size=0',
    'page_size=abc',
    'page=0',
    'page=abc',
    'unread=true&page_size=2&page=2',
    ...[
      'id',
      'notification_type',
      'level',
      'title',
      'body',
      'link',
      'data',
      'read_at',
      'created_at',
      // A property of the model, a column the serializer leaves out, and nothing at all.
      'is_read',
      'emailed_at',
      'updated_at',
      'user',
      'branch',
      'permission_code',
      'nope',
      '',
    ].flatMap((field) => [`ordering=${field}`, `ordering=-${field}`]),
    'ordering=level,title',
    'ordering=-level,-title',
    'ordering=level,-created_at&page_size=3',
    'ordering=read_at,title',
    'ordering=-read_at,title',
    'ordering=is_read,title',
    'ordering=title,title',
    'ordering=%20title%20',
    'ordering=title&unread=true',
    // Not filters: ignored.
    'level=ERROR&notification_type=LOW_STOCK&search=one&is_read=false&user=abc',
  ]) {
    read(`the list ${query || 'as it is'}`, `${NOTICES}?${query}`);
  }
  read('the list of a customer', NOTICES, 'bare');
  read('the unread of a customer', `${NOTICES}?unread=true`, 'bare');
  read('the list of someone with none', NOTICES, 'norole');
  read('no trailing slash', NOTICES.slice(0, -1));
  read('the list, a format nobody renders', `${NOTICES}?format=csv`);
  read('the list, as JSON', `${NOTICES}?format=json&page_size=1`);

  // === One notice ===============================================================================
  for (const title of [
    'Parity notice one',
    'Parity notice two',
    'Parity notice three',
    'Parity notice four',
    'Parity notice five',
    'Parity notice six',
    'parity notice seven',
  ]) {
    read(`the notice "${title}"`, one(title));
  }
  read('a read notice among the unread', `${one('Parity notice three')}?unread=true`);
  read('an unread notice among the unread', `${one('Parity notice one')}?unread=true`);
  read('a notice, an ordering', `${one('Parity notice one')}?ordering=-title`);
  read("someone else's notice", one('Parity bare one'));
  read('a notice for nobody', one('Parity notice for nobody'), 'owner');
  read("a customer's own notice", one('Parity bare two'), 'bare');
  read('one that is not there', `${NOTICES}${MISSING}/`);
  read('a key that is no id', `${NOTICES}abc/`);
  read('a key with no hyphens', `${NOTICES}${notice('Parity notice one').replaceAll('-', '')}/`);
  read('a key in capitals', `${NOTICES}${notice('Parity notice one').toUpperCase()}/`);
  read('a notice, no trailing slash', one('Parity notice one').slice(0, -1));

  // === The count ================================================================================
  read('the count', COUNT);
  read('the count of a customer', COUNT, 'bare');
  read('the count of someone with none', COUNT, 'norole');
  read('the count takes no filter', `${COUNT}?unread=false&page_size=1&ordering=title`);
  read('the count, no trailing slash', COUNT.slice(0, -1));
  read('the count, a format nobody renders', `${COUNT}?format=xml`);

  // === Marking read =============================================================================
  const first = notice('Parity notice one');
  const second = notice('Parity notice two');
  const already = notice('Parity notice three');
  const theirs = notice('Parity bare one');
  for (const [name, body] of [
    ['an empty body', {}],
    ['no ids', { ids: [] }],
    ['ids of null', { ids: null }],
    ['one', { ids: [first] }],
    ['two', { ids: [first, second] }],
    ['one twice', { ids: [first, first] }],
    ['one read already', { ids: [already] }],
    ['one read already and one not', { ids: [already, second] }],
    ["someone else's", { ids: [theirs] }],
    ["someone else's and one's own", { ids: [theirs, first] }],
    ['a notice for nobody', { ids: [notice('Parity notice for nobody')] }],
    ['one that is not there', { ids: [MISSING] }],
    ['a null among them', { ids: [null, first] }],
    ['nothing but a null', { ids: [null] }],
    ['a key with no hyphens', { ids: [first.replaceAll('-', '')] }],
    ['a key in capitals and braces', { ids: [`{${first.toUpperCase()}}`] }],
    ['a key as a urn', { ids: [`urn:uuid:${first}`] }],
    ['a key that is no id', { ids: ['abc'] }],
    ['a good key, then one that is no id', { ids: [first, 'abc'] }],
    ['two keys that are no ids', { ids: ['abc', 'def'] }],
    ['a blank key', { ids: [''] }],
    ['a whole number for a key', { ids: [5] }],
    ['zero for a key', { ids: [0] }],
    ['a negative number for a key', { ids: [-1] }],
    ['a number past 128 bits for a key', '{"ids": [340282366920938463463374607431768211456]}'],
    ['the largest key there is', '{"ids": [340282366920938463463374607431768211455]}'],
    ['true for a key', { ids: [true] }],
    ['false for a key', { ids: [false] }],
    ['a fraction for a key', '{"ids": [1.5]}'],
    ['a whole fraction for a key', '{"ids": [5.0]}'],
    ['a list for a key', { ids: [[first]] }],
    ['an object for a key', { ids: [{ id: first }] }],
    ['an empty object for a key', { ids: [{}] }],
    // Not a list: Python iterates whatever it is.
    ['ids as a key, not a list', { ids: first }],
    ['ids as a word', { ids: 'abc' }],
    ['ids as a blank', { ids: '' }],
    ['ids as an object of keys', { ids: { [first]: 1, [second]: 2 } }],
    ['ids as an object of words', { ids: { abc: 1 } }],
    ['ids as an empty object', { ids: {} }],
    ['ids as a number', { ids: 5 }],
    ['ids as zero', { ids: 0 }],
    ['ids as a fraction', '{"ids": 1.5}'],
    ['ids as a zero fraction', '{"ids": 0.0}'],
    ['ids as true', { ids: true }],
    ['ids as false', { ids: false }],
    ['other keys beside ids', { ids: [first], all: true, unread: false }],
    ['a body that is a list', [first]],
    ['a body that is a word', '"abc"'],
    ['a body that is null', 'null'],
    ['a body that is a number', '5'],
    ['a body that is not JSON', '{"ids": ['],
  ] as [string, unknown][]) {
    mark(name, body);
  }
  mark('no body at all', undefined);
  mark('no body and no content type', undefined, 'auditor', {
    headers: { 'content-type': '' },
  });
  mark('a customer, everything', {}, 'bare');
  mark("a customer, the auditor's", { ids: [first] }, 'bare');
  mark('someone with none', {}, 'norole');
  mark('a query string changes nothing', { ids: [first] }, 'auditor', {
    path: `${MARK}?unread=false&ids=${second}`,
  });
  mark('a format nobody renders', {}, 'auditor', { path: `${MARK}?format=xml` });
  mark('no trailing slash', {}, 'auditor', { path: MARK.slice(0, -1) });

  return cases;
}
