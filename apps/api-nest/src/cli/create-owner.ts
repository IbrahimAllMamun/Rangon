import { randomUUID } from 'node:crypto';

import { makePassword, validatePassword } from '../accounts/passwords';
import { Refusal } from './migrate';
import { type Flags, inTransaction, text } from './session';

/**
 * `create-owner`: the first account of a new shop, as `createsuperuser` makes
 * it -- a superuser, staff, active, holding the Owner role, in no organisation
 * and at no branch.
 *
 *     OWNER_PASSWORD=... node dist/cli.js create-owner --email owner@shop.example
 *
 * The password comes from the environment, never from the command line, where
 * every process on the machine could read it. It has to pass the same four
 * rules the API holds a password to (`AUTH_PASSWORD_VALIDATORS`): Django's
 * `createsuperuser --noinput` skips them, which this does not copy.
 */
export async function createOwner(
  databaseUrl: string,
  log: (line: string) => void,
  flags: Flags,
): Promise<void> {
  // `normalize_email(email).lower()`.
  const email = text(flags, 'email', 'OWNER_EMAIL').trim().toLowerCase();
  const firstName = text(flags, 'first-name');
  const lastName = text(flags, 'last-name');
  const password = process.env.OWNER_PASSWORD ?? '';
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email))
    throw new Refusal('Give the account an email address: --email owner@shop.example');
  if (!password)
    throw new Refusal('Set OWNER_PASSWORD in the environment: the password is not an argument.');
  const refused = validatePassword(password, { firstName, lastName, email });
  if (refused.length)
    throw new Refusal(
      `That password is refused. ${refused.map((error) => error.message).join(' ')}`,
    );

  await inTransaction(databaseUrl, async (q) => {
    if (await q.one(`SELECT 1 AS a FROM public.accounts_user WHERE email = $1`, [email]))
      throw new Refusal(`An account with the email ${email} already exists.`);
    const role = await q.one<{ id: string }>(
      `SELECT id FROM public.accounts_role WHERE code = 'OWNER'`,
    );
    if (!role) throw new Refusal('There is no Owner role yet: run sync-permissions first.');
    await q.query(
      `INSERT INTO public.accounts_user
         (id, password, last_login, is_superuser, created_at, updated_at, email, first_name,
          last_name, phone, organization_id, branch_id, role_id, status, is_staff, is_active,
          date_joined, last_login_ip)
       VALUES ($1, $2, NULL, true, clock_timestamp(), clock_timestamp(), $3, $4, $5, '', NULL, NULL,
               $6, 'ACTIVE', true, true, clock_timestamp(), NULL)`,
      [randomUUID(), await makePassword(password), email, firstName, lastName, role.id],
    );
  });
  log(`${email} is an owner: sign in at /login`);
}
