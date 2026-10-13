import { Client } from 'pg';

import { CUSTOMER_ROLE, PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../auth/permission-catalogue';

/**
 * `accounts.services.sync_permissions`: make the three tables say what the
 * catalogue says. Every code and role it names is there with its name; a code
 * it no longer names is gone, and its grants with it, so that a revoked
 * capability cannot linger on a role; each role holds exactly its codes, and
 * OWNER every one.
 *
 * One transaction, and safe to run on every release. A row is written only
 * where it differs, so a second run changes nothing -- which Django's, saving
 * every row each time, cannot say of `updated_at`.
 */
export async function syncPermissions(
  databaseUrl: string,
  log: (line: string) => void,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const codes = Object.keys(PERMISSIONS);
    let written = 0;
    for (const [code, [group, name]] of Object.entries(PERMISSIONS)) {
      const result = await client.query(
        `INSERT INTO public.accounts_permission
                (id, created_at, updated_at, code, name, "group", description)
         VALUES (gen_random_uuid(), clock_timestamp(), clock_timestamp(), $1, $2, $3, '')
         ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name, "group" = EXCLUDED."group", updated_at = clock_timestamp()
          WHERE (accounts_permission.name, accounts_permission."group")
                IS DISTINCT FROM (EXCLUDED.name, EXCLUDED."group")`,
        [code, name, group],
      );
      written += result.rowCount ?? 0;
    }
    // Django deletes a permission's grants in Python before the permission;
    // the constraint itself does not cascade.
    await client.query(
      `DELETE FROM public.accounts_role_permissions g USING public.accounts_permission p
        WHERE p.id = g.permission_id AND NOT (p.code = ANY($1))`,
      [codes],
    );
    const removed = await client.query(
      `DELETE FROM public.accounts_permission WHERE NOT (code = ANY($1))`,
      [codes],
    );

    let granted = 0;
    let revoked = 0;
    for (const [code, name] of ROLES) {
      const role = await client.query<{ id: string }>(
        `INSERT INTO public.accounts_role
                (id, created_at, updated_at, code, name, description, is_staff_role, is_system)
         VALUES (gen_random_uuid(), clock_timestamp(), clock_timestamp(), $1, $2, '', $3, true)
         ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name, is_staff_role = EXCLUDED.is_staff_role, is_system = true,
                updated_at = CASE
                  WHEN (accounts_role.name, accounts_role.is_staff_role, accounts_role.is_system)
                       IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.is_staff_role, true)
                  THEN clock_timestamp() ELSE accounts_role.updated_at END
         RETURNING id`,
        [code, name, code !== CUSTOMER_ROLE],
      );
      const roleId = role.rows[0]?.id as string;
      const holds = code === 'OWNER' ? codes : [...(ROLE_PERMISSIONS[code] ?? [])];
      const gone = await client.query(
        `DELETE FROM public.accounts_role_permissions g USING public.accounts_permission p
          WHERE p.id = g.permission_id AND g.role_id = $1 AND NOT (p.code = ANY($2))`,
        [roleId, holds],
      );
      const added = await client.query(
        `INSERT INTO public.accounts_role_permissions (role_id, permission_id)
         SELECT $1, p.id FROM public.accounts_permission p
          WHERE p.code = ANY($2)
            AND NOT EXISTS (SELECT 1 FROM public.accounts_role_permissions g
                             WHERE g.role_id = $1 AND g.permission_id = p.id)`,
        [roleId, holds],
      );
      revoked += gone.rowCount ?? 0;
      granted += added.rowCount ?? 0;
    }
    await client.query('COMMIT');
    log(
      `${codes.length} permissions and ${ROLES.length} roles are as the catalogue has them: ` +
        `${written} permissions written, ${removed.rowCount ?? 0} removed, ` +
        `${granted} grants made, ${revoked} taken away`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
