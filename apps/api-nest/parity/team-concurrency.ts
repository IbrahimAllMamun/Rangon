/**
 * Race checks for staff accounts and the organisation (phase 6 part 10), run
 * by run.ts after the comparison cases. Each puts the accounts, the branches
 * and the organisation back.
 *
 * One lock is taken here: a profile's row, before its stored values are read
 * and written back. Everything else -- an account's edit, the two guards,
 * the organisation's edit -- reads and writes with none, in both APIs; those
 * checks record what that leaves.
 */
import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { behind, type Check, statuses } from './races.ts';
import { send } from './run.ts';
import { resetTeam, teamFixture } from './team-cases.ts';

export async function teamConcurrencyChecks(apis: { DJANGO: URL; NEST: URL }): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const userId = async (email: string) =>
      (await one<{ id: string }>(`SELECT id FROM accounts_user WHERE email = $1`, [email]))?.id;
    const ids = {
      owner: await userId('owner@rangon.test'),
      owner2: await userId('parity.owner2@rangon.test'),
      clerk: await userId('parity.clerk@rangon.test'),
      gone: await userId('parity.gone@rangon.test'),
    };
    if (!ids.owner2 || !ids.clerk) {
      // There when the cases were built and gone now: another suite removed the fixture.
      return teamFixture.seen
        ? [
            {
              name: "team: the fixture's accounts are still there after the cases",
              passed: false,
              detail: 'parity.owner2 or parity.clerk is gone: another suite deleted it mid-run',
            },
          ]
        : [];
    }
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetTeam(db);
      await db.query(`DELETE FROM token_blacklist_blacklistedtoken WHERE blacklisted_at >= $1`, [
        since,
      ]);
    };
    const request = (api: URL, who: Who, method: string, path: string, body: unknown) =>
      send(api, {
        name: 'team',
        method,
        path,
        headers: { ...auth(who), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const either = (index: number) => (index % 2 ? apis.NEST : apis.DJANGO);
    const SIDES = [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const;
    const twoOwners = () =>
      db.query(`UPDATE accounts_user SET status = 'ACTIVE', is_active = true WHERE id = $1`, [
        ids.owner2,
      ]);
    const activeOwners = async () =>
      Number(
        (
          await one<{ count: string }>(
            `SELECT count(*) AS count FROM accounts_user u JOIN accounts_role r ON r.id = u.role_id
              WHERE r.code = 'OWNER' AND u.status = 'ACTIVE'`,
          )
        )?.count,
      );
    const entries = async (entity: string | undefined) =>
      Number(
        (
          await one<{ count: string }>(
            `SELECT count(*) AS count FROM core_auditlog a
              WHERE a.entity_id = $1 AND a.id NOT IN (SELECT id FROM "snap_core_auditlog")`,
            [entity],
          )
        )?.count,
      );

    // 1. A profile changed while an edit of it waits on the profile's row.
    for (const [side, api] of SIDES) {
      await restore();
      const held = await behind(
        db,
        [`SELECT id FROM accounts_staffprofile WHERE user_id = $1 FOR UPDATE`, [ids.clerk]],
        '%accounts_staffprofile%',
        [
          () =>
            request(api, 'owner', 'PATCH', `/api/v1/users/${ids.clerk}/`, {
              profile: { designation: 'Shift lead' },
            }),
        ],
        async (holder) => {
          await holder.query(
            `UPDATE accounts_staffprofile SET national_id = 'CHANGED MEANWHILE', notes = 'Meanwhile'
              WHERE user_id = $1`,
            [ids.clerk],
          );
        },
      );
      const answer = held.responses[0];
      const now = await one<{ designation: string; national_id: string; notes: string }>(
        `SELECT designation, national_id, notes FROM accounts_staffprofile WHERE user_id = $1`,
        [ids.clerk],
      );
      checks.push({
        name: `team: a profile's ID number changed while an edit of its title (${side}) waits on the profile's row -- both changes stand; the profile's lock holds`,
        passed:
          held.queued === 1 &&
          answer?.status === 200 &&
          now?.designation === 'Shift lead' &&
          now.national_id === 'CHANGED MEANWHILE' &&
          now.notes === 'Meanwhile',
        detail: `${answer?.status}, ${held.queued ? 'waited on the lock' : 'never waited'}, title "${now?.designation}", ID "${now?.national_id}", notes "${now?.notes}"`,
      });
    }

    // 2. Six first saves of one profile at once: the account's own row queues them.
    await restore();
    const profiles = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        request(either(index), 'owner', 'PATCH', `/api/v1/users/${ids.gone}/`, {
          profile: { designation: 'Returning', notes: 'Rehired' },
        }),
      ),
    );
    const made = await one<{ count: string }>(
      `SELECT count(*) AS count FROM accounts_staffprofile WHERE user_id = $1`,
      [ids.gone],
    );
    checks.push({
      name: "team: 6 first saves of one profile at once, across both APIs -- six 200s and one profile: each waits on the account's row, which its own edit wrote first",
      passed: statuses(profiles).join() === '200,200,200,200,200,200' && made?.count === '1',
      detail: `statuses ${statuses(profiles).join(',')}, ${made?.count} profile`,
    });

    // 3. The second owner switched off while the first's deactivation waits to write.
    for (const [side, api] of SIDES) {
      await restore();
      await twoOwners();
      const held = await behind(
        db,
        [`SELECT id FROM accounts_user WHERE id = $1 FOR UPDATE`, [ids.owner]],
        '%UPDATE%accounts_user%',
        [() => request(api, 'admin', 'POST', `/api/v1/users/${ids.owner}/deactivate/`, {})],
        async (holder) => {
          await holder.query(
            `UPDATE accounts_user SET status = 'INACTIVE', is_active = false WHERE id = $1`,
            [ids.owner2],
          );
        },
      );
      const answer = held.responses[0];
      const left = await activeOwners();
      checks.push({
        name: `team: the second owner switched off while the first's deactivation (${side}) waits to write -- it was judged with two owners and goes through: no active owner is left (copied: the guard takes no lock)`,
        passed: held.queued === 1 && answer?.status === 200 && left === 0,
        detail: `${answer?.status}, ${held.queued ? 'its write waited' : 'never waited'}, ${left} active owners left`,
      });
    }

    // 4. A password changed while an edit of the account's name waits to write.
    for (const [side, api] of SIDES) {
      await restore();
      const held = await behind(
        db,
        [`SELECT id FROM accounts_user WHERE id = $1 FOR UPDATE`, [ids.clerk]],
        '%UPDATE%accounts_user%',
        [
          () =>
            request(api, 'owner', 'PATCH', `/api/v1/users/${ids.clerk}/`, {
              first_name: 'Renamed',
            }),
        ],
        async (holder) => {
          await holder.query(
            `UPDATE accounts_user SET password = 'argon2$changed-meanwhile' WHERE id = $1`,
            [ids.clerk],
          );
        },
      );
      const answer = held.responses[0];
      const now = await one<{ first_name: string; kept: boolean }>(
        `SELECT first_name, password = 'argon2$changed-meanwhile' AS kept
           FROM accounts_user WHERE id = $1`,
        [ids.clerk],
      );
      checks.push({
        name: `team: a password changed while an edit of the account's name (${side}) waits to write -- the edit puts back the password it read (copied: the save writes every column, with no lock)`,
        passed:
          held.queued === 1 && answer?.status === 200 && now?.first_name === 'Renamed' && !now.kept,
        detail: `${answer?.status}, ${held.queued ? 'its write waited' : 'never waited'}, name "${now?.first_name}", the new password ${now?.kept ? 'kept' : 'lost'}`,
      });
    }

    // 5. The VAT settled while an edit of the organisation's name waits to write.
    for (const [side, api] of SIDES) {
      await restore();
      const held = await behind(
        db,
        [`SELECT id FROM accounts_organization WHERE status = 'ACTIVE' FOR UPDATE`, []],
        '%UPDATE%accounts_organization%',
        [() => request(api, 'owner', 'PATCH', '/api/v1/organization/', { name: 'Renamed' })],
        async (holder) => {
          await holder.query(
            `UPDATE accounts_organization SET tax_mode = 'INCLUSIVE', default_tax_rate = 0.0750,
                    tax_settled_at = clock_timestamp()
              WHERE status = 'ACTIVE'`,
          );
        },
      );
      const answer = held.responses[0];
      const now = await one<{ name: string; tax_mode: string; rate: string; settled: boolean }>(
        `SELECT name, tax_mode, default_tax_rate::text AS rate, tax_settled_at IS NOT NULL AS settled
           FROM accounts_organization WHERE status = 'ACTIVE'`,
      );
      checks.push({
        name: `team: the VAT settled while an edit of the organisation's name (${side}) waits to write -- the edit puts back the VAT it read, and the settlement is gone (copied: the save writes every column, with no lock)`,
        passed:
          held.queued === 1 &&
          answer?.status === 200 &&
          now?.name === 'Renamed' &&
          now.tax_mode === 'EXCLUSIVE' &&
          now.rate === '0.0000' &&
          !now.settled,
        detail: `${answer?.status}, ${held.queued ? 'its write waited' : 'never waited'}, name "${now?.name}", VAT ${now?.tax_mode} ${now?.rate}, ${now?.settled ? 'settled' : 'not settled'}`,
      });
    }

    // 6. Six deactivations of one account at once.
    await restore();
    const offs = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        request(either(index), 'owner', 'POST', `/api/v1/users/${ids.clerk}/deactivate/`, {
          reason: `Click ${index}`,
        }),
      ),
    );
    const clerk = await one<{ status: string; is_active: boolean }>(
      `SELECT status, is_active FROM accounts_user WHERE id = $1`,
      [ids.clerk],
    );
    const logged = await entries(ids.clerk);
    checks.push({
      name: 'team: 6 deactivations of one account at once, across both APIs -- six 200s and six audit entries, the account off (nothing refuses a repeat)',
      passed:
        statuses(offs).join() === '200,200,200,200,200,200' &&
        clerk?.status === 'INACTIVE' &&
        clerk.is_active === false &&
        logged === 6,
      detail: `statuses ${statuses(offs).join(',')}, ${clerk?.status}, ${logged} audit entries`,
    });

    // 7. Six accounts under one email, and six branches under one code, at once.
    for (const [what, path, body, count] of [
      [
        'accounts under one email',
        '/api/v1/users/',
        (index: number) => ({
          email: index % 3 ? 'parity.racer@rangon.test' : 'Parity.Racer@Rangon.test',
          password: 'correct horse 42',
          first_name: `Racer ${index}`,
        }),
        `SELECT count(*)::text AS count FROM accounts_user WHERE email = 'parity.racer@rangon.test'`,
      ],
      [
        'branches under one code',
        '/api/v1/branches/',
        (index: number) => ({ name: `Parity Racer ${index}`, code: 'RACE' }),
        `SELECT count(*)::text AS count FROM accounts_branch WHERE code = 'RACE'`,
      ],
    ] as const) {
      await restore();
      const tried = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          request(either(index), 'owner', 'POST', path, body(index)),
        ),
      );
      const rows = await one<{ count: string }>(count);
      const codes = statuses(tried);
      checks.push({
        name: `team: 6 ${what} at once, across both APIs -- one is made; the rest are refused by the check or by the index, none a 500`,
        passed:
          codes[0] === 201 &&
          codes.slice(1).every((status) => status === 400 || status === 409) &&
          rows?.count === '1',
        detail: `statuses ${codes.join(',')}, ${rows?.count} made`,
      });
    }

    // 8. Six settlements of the VAT at once.
    await restore();
    const settled = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        request(either(index), 'owner', 'PATCH', '/api/v1/organization/tax/', {
          tax_mode: index % 2 ? 'INCLUSIVE' : 'EXCLUSIVE',
          default_tax_rate: '0.0750',
          confirm: true,
        }),
      ),
    );
    const vat = await one<{ tax_mode: string; rate: string; settled: boolean; id: string }>(
      `SELECT id::text, tax_mode, default_tax_rate::text AS rate, tax_settled_at IS NOT NULL AS settled
         FROM accounts_organization WHERE status = 'ACTIVE'`,
    );
    const settlements = await entries(vat?.id);
    checks.push({
      name: 'team: 6 settlements of the VAT at once, three each way, across both APIs -- six 200s and six audit entries; the rate is the one all six sent, the mode one of the two',
      passed:
        statuses(settled).join() === '200,200,200,200,200,200' &&
        vat?.rate === '0.0750' &&
        vat.settled &&
        settlements === 6,
      detail: `statuses ${statuses(settled).join(',')}, left ${vat?.tax_mode} ${vat?.rate}, ${settlements} audit entries`,
    });
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
