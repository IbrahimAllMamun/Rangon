import { Inject, Injectable } from '@nestjs/common';

import { localIso } from '../common/datetime';
import { compareCodePoints, pyStrip } from '../common/python';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';

/** The `accounts_user` columns the account endpoints read. */
export interface AccountRow {
  id: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  phone: string;
  status: string;
  is_active: boolean;
  is_superuser: boolean;
  role_id: string | null;
  branch_id: string | null;
  organization_id: string | null;
}

export const ACCOUNT_COLUMNS = `id, email, password, first_name, last_name, phone, status, is_active,
  is_superuser, role_id, branch_id, organization_id`;

/** `User.full_name`. */
export function fullName(user: Pick<AccountRow, 'first_name' | 'last_name' | 'email'>): string {
  return pyStrip(`${user.first_name} ${user.last_name}`) || user.email;
}

interface BranchRow {
  id: string;
  name: string;
  code: string;
  address: string;
  phone: string;
  email: string;
  is_default: boolean;
  fulfils_online_orders: boolean;
  register_count: number;
  status: string;
  created_at: string;
}

/** `MeSerializer`: who is signed in, what they may do, and for which organisation. */
@Injectable()
export class MeService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async account(id: string): Promise<AccountRow | null> {
    return this.db.one<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts_user WHERE id = $1::uuid`,
      [id],
    );
  }

  async payload(user: AccountRow): Promise<Record<string, unknown>> {
    const role = user.role_id
      ? await this.db.one<{ code: string; name: string }>(
          `SELECT code, name FROM accounts_role WHERE id = $1::uuid`,
          [user.role_id],
        )
      : null;
    return {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      full_name: fullName(user),
      phone: user.phone,
      role: role?.code ?? '',
      role_name: role?.name ?? '',
      branch: user.branch_id ? await this.branch(user.branch_id) : null,
      permissions: await this.permissions(user, role?.code ?? null),
      organization: await this.organization(user.organization_id),
      status: user.status,
    };
  }

  /** `BranchSerializer`. */
  private async branch(id: string): Promise<Record<string, unknown> | null> {
    const row = await this.db.one<BranchRow>(
      `SELECT id, name, code, address, phone, email, is_default, fulfils_online_orders,
              register_count, status, created_at
         FROM accounts_branch WHERE id = $1::uuid`,
      [id],
    );
    if (!row) return null;
    return { ...row, created_at: localIso(row.created_at, this.env.DJANGO_TIME_ZONE) };
  }

  /** `sorted(user.permission_codes())`: `*` for an owner or a superuser. */
  private async permissions(user: AccountRow, roleCode: string | null): Promise<string[]> {
    if (roleCode === 'OWNER' || user.is_superuser) return ['*'];
    if (!user.role_id) return [];
    const rows = await this.db.query<{ code: string }>(
      `SELECT DISTINCT p.code FROM accounts_permission p
         JOIN accounts_role_permissions rp ON rp.permission_id = p.id
        WHERE rp.role_id = $1::uuid`,
      [user.role_id],
    );
    return rows.map((row) => row.code).sort(compareCodePoints);
  }

  /** The user's organisation, else `get_organization()`: the oldest active one. */
  private async organization(id: string | null): Promise<Record<string, unknown> | null> {
    const columns = `id, name, currency, receipt_footer`;
    const row = id
      ? await this.db.one<Record<string, unknown>>(
          `SELECT ${columns} FROM accounts_organization WHERE id = $1::uuid`,
          [id],
        )
      : await this.db.one<Record<string, unknown>>(
          `SELECT ${columns} FROM accounts_organization WHERE status = 'ACTIVE'
            ORDER BY created_at ASC LIMIT 1`,
        );
    return row ?? null;
  }
}
