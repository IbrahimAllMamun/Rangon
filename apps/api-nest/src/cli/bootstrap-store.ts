import { randomUUID } from 'node:crypto';

import { recordAudit } from '../common/audit';
import { slugify } from '../common/slugs';
import { Refusal } from './migrate';
import { type Flags, inTransaction, NO_REQUEST, text } from './session';

/**
 * `bootstrap-store`: `scripts/bootstrap-store.py`. Give a migrated database
 * the organisation, first branch and cash drawer a store needs -- nothing in
 * the app creates the organisation, and a branch added before there is one
 * belongs to none.
 *
 *     node dist/cli.js bootstrap-store --shop-name "Rangon Fashion" \
 *       --branch-name "Rangon Panthapath" --branch-code DHK1
 *
 * (or SHOP_NAME, BRANCH_NAME and BRANCH_CODE in the environment, as the
 * script reads them). Safe to run twice: the oldest organisation, its oldest
 * branch and any cash drawer there are reused, never doubled. It invents no
 * money: the drawer opens at zero with no opening entry, and the real float
 * is the owner's to post.
 */
export async function bootstrapStore(
  databaseUrl: string,
  log: (line: string) => void,
  flags: Flags,
): Promise<void> {
  const shopName = (text(flags, 'shop-name', 'SHOP_NAME') || 'Rangon Fashion').trim();
  const branchName = (text(flags, 'branch-name', 'BRANCH_NAME') || 'Main branch').trim();
  const branchCode = (text(flags, 'branch-code', 'BRANCH_CODE') || 'MAIN').trim().toUpperCase();
  if (!shopName || !branchName || !branchCode)
    throw new Refusal('The shop name, the branch name and the branch code must not be blank.');
  if (branchCode.length > 16)
    throw new Refusal('The branch code is printed on receipts and holds at most 16 characters.');

  const made = await inTransaction(databaseUrl, async (q) => {
    let organization = await q.one<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM public.accounts_organization ORDER BY created_at LIMIT 1`,
    );
    if (!organization) {
      organization = { id: randomUUID(), name: shopName, slug: slugify(shopName) };
      await q.query(
        `INSERT INTO public.accounts_organization
           (id, created_at, updated_at, name, slug, legal_name, status, email, phone, address,
            vat_registration, currency, logo, receipt_footer, tax_mode, default_tax_rate,
            tax_settled_at, tax_settled_by_id, counter_sells_reserved)
         VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, '', 'ACTIVE', '', '', '', '',
                 'BDT', '', '', 'EXCLUSIVE', 0, NULL, NULL, false)`,
        [organization.id, organization.name, organization.slug],
      );
    }

    let branch = await q.one<{ id: string; name: string; code: string; is_default: boolean }>(
      `SELECT id, name, code, is_default FROM public.accounts_branch
        WHERE organization_id = $1 ORDER BY created_at LIMIT 1`,
      [organization.id],
    );
    if (!branch) {
      branch = { id: randomUUID(), name: branchName, code: branchCode, is_default: true };
      await q.query(
        `INSERT INTO public.accounts_branch
           (id, created_at, updated_at, organization_id, name, code, address, phone, email,
            is_default, fulfils_online_orders, register_count, status)
         VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, $4, '', '', '', true, true, 1,
                 'ACTIVE')`,
        [branch.id, organization.id, branch.name, branch.code],
      );
    }

    const drawer = await q.one(
      `SELECT 1 AS a FROM public.finance_account WHERE branch_id = $1 AND kind = 'CASH' LIMIT 1`,
      [branch.id],
    );
    if (!drawer) {
      // `finance.services.create_account`, by nobody: the default drawer of
      // its branch, at zero, with the audit entry an account's opening has.
      const id = randomUUID();
      const name = `${branch.code} Cash Drawer`;
      await q.query(
        `UPDATE public.finance_account SET is_default = false
          WHERE branch_id = $1 AND is_default AND kind = 'CASH'`,
        [branch.id],
      );
      await q.query(
        `INSERT INTO public.finance_account
           (id, created_at, updated_at, branch_id, name, kind, account_number, bank_name, balance,
            is_active, is_default, allow_overdraft, notes, created_by_id)
         VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, 'CASH', '', '', 0.00, true, true,
                 false, '', NULL)`,
        [id, branch.id, name],
      );
      await recordAudit(q, NO_REQUEST, {
        action: 'SETTINGS_CHANGED',
        entity: { type: 'Account', id, label: `${name} (Cash drawer)` },
        actor: null,
        newValues: { name, kind: 'CASH', opening_balance: '0.00' },
        reason: 'Account opened',
        branchId: branch.id,
      });
    }
    const drawers = await q.one<{ n: string }>(
      `SELECT count(*) AS n FROM public.finance_account WHERE branch_id = $1 AND kind = 'CASH'`,
      [branch.id],
    );
    return { organization, branch, drawers: Number(drawers?.n ?? 0) };
  });
  // The three lines the script prints, for whoever reads either's output.
  log(`Organization: ${made.organization.name} (${made.organization.slug})`);
  log(
    `Branch:       ${made.branch.name} (${made.branch.code}), default=${made.branch.is_default ? 'True' : 'False'}`,
  );
  log(`Cash drawers: ${made.drawers}`);
}
