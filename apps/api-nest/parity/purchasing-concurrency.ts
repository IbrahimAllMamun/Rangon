/**
 * Race checks for suppliers and their price lists (phase 6 part 3), run by
 * run.ts after the comparison cases. Each puts the two tables back.
 *
 * One offer per SKU is the preferred one. `set-preferred` takes the offer's
 * own row first, so what it promotes is the offer as committed; the unique
 * index, not a lock, is what allows only one.
 */
import pg from 'pg';

import { staffHeaders } from './catalog-admin-cases.ts';
import { resetSuppliers } from './purchasing-cases.ts';
import { behind, type Check, message, statuses } from './races.ts';
import { send } from './run.ts';

export async function purchasingConcurrencyChecks(apis: {
  DJANGO: URL;
  NEST: URL;
}): Promise<Check[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const checks: Check[] = [];
  try {
    const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await db.query<T>(sql, values)).rows[0];
    const offerOf = async (supplier: string) =>
      (
        await one<{ id: string }>(
          `SELECT o.id FROM purchasing_supplierproduct o
             JOIN purchasing_supplier s ON s.id = o.supplier_id
             JOIN catalog_productvariant v ON v.id = o.variant_id
            WHERE s.code = $1 AND v.sku = 'PAR-TEE-S-WHT'`,
          [supplier],
        )
      )?.id;
    const idle = await offerOf('PARITY-IDLE');
    const sole = await offerOf('PARITY-SOLE');
    if (!idle || !sole) return [];
    const auth = await staffHeaders(db);
    const since = (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;
    const restore = async () => {
      await resetSuppliers(db);
      await db.query(`DELETE FROM core_auditlog WHERE created_at >= $1`, [since]);
    };
    const post = (api: URL, path: string, body: unknown = undefined) =>
      send(api, {
        name: 'purchasing',
        method: 'POST',
        path,
        headers: { ...auth('owner'), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const OFFERS = '/api/v1/supplier-products/';
    const either = (index: number) => (index % 2 ? apis.NEST : apis.DJANGO);
    /** Who the SKU prefers, and how many promotions the audit log holds since `from`. */
    const state = async (from: string) =>
      (await one<{ preferred: string | null; audits: string }>(
        `SELECT (SELECT string_agg(s.code, ',' ORDER BY s.code) FROM purchasing_supplierproduct o
                   JOIN purchasing_supplier s ON s.id = o.supplier_id
                   JOIN catalog_productvariant v ON v.id = o.variant_id
                  WHERE v.sku = 'PAR-TEE-S-WHT' AND o.is_preferred) AS preferred,
                (SELECT count(*)::text FROM core_auditlog a
                  WHERE a.created_at >= $1 AND a.entity_type = 'SupplierProduct') AS audits`,
        [from],
      )) as { preferred: string | null; audits: string };
    const now = async () =>
      (await one<{ now: string }>(`SELECT clock_timestamp() AS now`))?.now as string;

    // 1. An offer withdrawn while its promotion waits on its row.
    for (const [side, api] of [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const) {
      await restore();
      const from = await now();
      const held = await behind(
        db,
        [`SELECT id FROM purchasing_supplierproduct WHERE id = $1 FOR UPDATE`, [idle]],
        '%purchasing_supplierproduct%',
        [() => post(api, `${OFFERS}${idle}/set-preferred/`)],
        async (holder) => {
          await holder.query(
            `UPDATE purchasing_supplierproduct SET is_active = false WHERE id = $1`,
            [idle],
          );
        },
      );
      const end = await state(from);
      const answer = held.responses[0];
      checks.push({
        name: `purchasing: an offer withdrawn while its promotion (${side}) waits on its row is not promoted -- the offer's lock holds`,
        passed:
          held.queued === 1 &&
          answer?.status === 400 &&
          message(answer.body).includes('no longer supplies this product') &&
          end.preferred === 'PARITY-SOLE' &&
          end.audits === '0',
        detail: `${answer?.status} ${message(answer?.body ?? '').slice(0, 60)}, ${held.queued ? 'waited on the lock' : 'never waited'}, preferred ${end.preferred}, ${end.audits} audit entries`,
      });
    }

    // 2. Six promotions at once, three for each of a SKU's two offers.
    await restore();
    let from = await now();
    const promotions = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(either(index), `${OFFERS}${index < 3 ? idle : sole}/set-preferred/`),
      ),
    );
    let end = await state(from);
    const promoted = promotions.filter((response) => response.status === 200).length;
    checks.push({
      name: "purchasing: 6 promotions at once, three for each of a SKU's two offers, across both APIs -- one preferred offer, every promotion audited",
      passed:
        statuses(promotions).every((status) => status === 200 || status === 409) &&
        ['PARITY-IDLE', 'PARITY-SOLE'].includes(end.preferred ?? '') &&
        Number(end.audits) === promoted,
      detail: `statuses ${statuses(promotions).join(',')}, preferred ${end.preferred}, ${end.audits} audit entries`,
    });

    // 3. Six suppliers of one name at once: the code is derived, and unique.
    await restore();
    from = await now();
    const made = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        post(either(index), '/api/v1/suppliers/', { name: 'Parity Twin Mills' }),
      ),
    );
    const twins = await db.query<{ code: string }>(
      `SELECT code FROM purchasing_supplier WHERE name = 'Parity Twin Mills' ORDER BY code`,
    );
    const created = made.filter((response) => response.status === 201).length;
    checks.push({
      name: 'purchasing: 6 suppliers of one name at once, across both APIs -- each one made has a code of its own; the unique index decides, no lock is involved',
      passed:
        statuses(made).every((status) => status === 201 || status === 409) &&
        created >= 1 &&
        twins.rows.length === created &&
        new Set(twins.rows.map((row) => row.code)).size === created,
      detail: `statuses ${statuses(made).join(',')}, codes ${twins.rows.map((row) => row.code).join(' ')}`,
    });

    // 4. An edit writes every column back as it read them, the preference too.
    for (const [side, api] of [
      ['Django', apis.DJANGO],
      ['Nest', apis.NEST],
    ] as const) {
      await restore();
      from = await now();
      const held = await behind(
        db,
        [`SELECT id FROM purchasing_supplierproduct WHERE id = $1 FOR UPDATE`, [idle]],
        '%purchasing_supplierproduct%',
        [
          () =>
            send(api, {
              name: 'purchasing',
              method: 'PATCH',
              path: `${OFFERS}${idle}/`,
              headers: { ...auth('owner'), 'content-type': 'application/json' },
              body: JSON.stringify({ notes: 'Edited mid-flight' }),
            }),
        ],
        async (holder) => {
          await holder.query(
            `UPDATE purchasing_supplierproduct SET is_preferred = false WHERE id = $1`,
            [sole],
          );
          await holder.query(
            `UPDATE purchasing_supplierproduct SET is_preferred = true WHERE id = $1`,
            [idle],
          );
        },
      );
      end = await state(from);
      checks.push({
        name: `purchasing: an offer promoted while an edit of it (${side}) waits on its row is demoted again by the edit, and the SKU prefers nobody (D184, copied) -- no lock is involved`,
        passed: held.queued === 1 && held.responses[0]?.status === 200 && end.preferred === null,
        detail: `${held.responses[0]?.status}, ${held.queued ? 'waited at its UPDATE' : 'never waited'}, preferred ${end.preferred ?? 'nobody'}`,
      });
    }
    await restore();
  } finally {
    await db.end();
  }
  return checks;
}
