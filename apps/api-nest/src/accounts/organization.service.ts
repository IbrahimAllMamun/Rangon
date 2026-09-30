import { Inject, Injectable } from '@nestjs/common';

import { pyDecimal } from '../common/python';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';

export type TaxSettings = readonly [mode: string, defaultRate: string];

/** `accounts.services`: the organisation and branch the storefront acts for. */
@Injectable()
export class OrganizationService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `default_branch()` / `storefront_branch()`: the active default branch, else
   * the oldest active one. Null when none is active -- which reads every
   * product as out of stock rather than failing (a DECISION REQUIRED in
   * docs/business-rules.md, preserved as the Django API has it).
   */
  async storefrontBranchId(): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM accounts_branch WHERE status = 'ACTIVE'
        ORDER BY is_default DESC, created_at ASC LIMIT 1`,
    );
    return row?.id ?? null;
  }

  /** `tax_settings()`: (mode, default rate), falling back to the deployment default. */
  async taxSettings(): Promise<TaxSettings> {
    const row = await this.db.one<{ tax_mode: string; default_tax_rate: string }>(
      `SELECT tax_mode, default_tax_rate FROM accounts_organization WHERE status = 'ACTIVE'
        ORDER BY created_at ASC LIMIT 1`,
    );
    if (row) return [row.tax_mode, row.default_tax_rate];
    return [
      'EXCLUSIVE',
      pyDecimal(this.env.RANGON_DEFAULT_TAX_RATE) ?? this.env.RANGON_DEFAULT_TAX_RATE,
    ];
  }
}
