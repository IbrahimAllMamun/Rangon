import { makePassword, validatePassword } from '../accounts/passwords';
import { Refusal } from './migrate';
import { type Flags, inTransaction, text } from './session';

/**
 * `set-password`: an account's password, set by the operator, as Django's
 * `changepassword` did -- for a locked-out owner, and for a demo shop restored
 * from a snapshot that carries the password printed in the README.
 *
 *     NEW_PASSWORD=... node dist/cli.js set-password --email owner@shop.example
 *
 * From the environment, never the command line, as `create-owner` takes it,
 * and held to the same four rules, with the account's own names and address.
 */
export async function setPassword(
  databaseUrl: string,
  log: (line: string) => void,
  flags: Flags,
): Promise<void> {
  const email = text(flags, 'email').trim().toLowerCase();
  const password = process.env.NEW_PASSWORD ?? '';
  if (!email) throw new Refusal('Name the account: --email someone@shop.example');
  if (!password)
    throw new Refusal('Set NEW_PASSWORD in the environment: the password is not an argument.');

  await inTransaction(databaseUrl, async (q) => {
    const user = await q.one<{ id: string; first_name: string; last_name: string }>(
      `SELECT id, first_name, last_name FROM public.accounts_user WHERE email = $1 FOR UPDATE`,
      [email],
    );
    if (!user) throw new Refusal(`There is no account with the email ${email}.`);
    const refused = validatePassword(password, {
      firstName: user.first_name,
      lastName: user.last_name,
      email,
    });
    if (refused.length)
      throw new Refusal(
        `That password is refused. ${refused.map((error) => error.message).join(' ')}`,
      );
    await q.query(
      `UPDATE public.accounts_user SET password = $1, updated_at = clock_timestamp() WHERE id = $2`,
      [await makePassword(password), user.id],
    );
  });
  log(`Password changed for ${email}.`);
}
