import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { RolePermissions } from '../auth/permissions';
import { CataloguePayloads } from '../catalog/admin/catalogue-payloads';
import { mediaUrl } from '../common/media';
import { compareCodePoints, pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import { AvailabilityService } from '../inventory/availability.service';
import { HoldsService } from './holds.service';

/** Django's `prep_for_like_query`: a literal inside `LIKE '%...%'`. */
function likeContains(text: string): string {
  return `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

interface SearchRow {
  id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  name: string;
  price: string;
  product_name: string;
  category_name: string;
}

/**
 * The register's reads (`orders.api.pos_views`): what it needs to open, and
 * the product grid. Scans go through the catalogue's own lookup.
 */
@Injectable()
export class PosReadsService {
  constructor(
    private readonly db: Database,
    private readonly permissions: RolePermissions,
    private readonly payloads: CataloguePayloads,
    private readonly availability: AvailabilityService,
    private readonly holds: HoldsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `PosSessionView.get`: the branch, the cashier, the shop, the open holds and the tills. */
  async session(user: RequestUser, query: QueryDict) {
    const resolved = await this.permissions.resolveBranch(user, query.get('branch') ?? null);
    const branch = (await this.db.one<{
      id: string;
      name: string;
      code: string;
      address: string;
      phone: string;
      register_count: number;
    }>(
      `SELECT "id", "name", "code", "address", "phone", "register_count"
         FROM "accounts_branch" WHERE "id" = $1`,
      [resolved.id],
    )) as {
      id: string;
      name: string;
      code: string;
      address: string;
      phone: string;
      register_count: number;
    };
    const organization = await this.db.one<{
      name: string;
      currency: string;
      receipt_footer: string;
      vat_registration: string;
    }>(
      `SELECT "name", "currency", "receipt_footer", "vat_registration" FROM "accounts_organization"
        WHERE "accounts_organization"."status" = 'ACTIVE'
        ORDER BY "accounts_organization"."created_at" ASC LIMIT 1`,
    );
    const accounts = await this.db.query<{
      id: string;
      name: string;
      kind: string;
      is_default: boolean;
    }>(
      `SELECT "finance_account"."id", "finance_account"."name", "finance_account"."kind",
              "finance_account"."is_default"
         FROM "finance_account"
        INNER JOIN "accounts_branch" ON ("finance_account"."branch_id" = "accounts_branch"."id")
        WHERE ("finance_account"."is_active" AND "finance_account"."branch_id" = $1)
        ORDER BY "accounts_branch"."name" ASC, "finance_account"."kind" ASC,
                 "finance_account"."name" ASC`,
      [branch.id],
    );
    const fullName = pyStrip(`${user.firstName} ${user.lastName}`) || user.email;
    return {
      branch: {
        id: branch.id,
        name: branch.name,
        code: branch.code,
        address: branch.address,
        phone: branch.phone,
        register_count: branch.register_count,
      },
      cashier: {
        id: user.id,
        name: fullName,
        email: user.email,
        permissions: [...(await this.permissions.codes(user))].sort(compareCodePoints),
      },
      organization: {
        name: organization ? organization.name : 'Rangon Fashion',
        currency: organization ? organization.currency : 'BDT',
        receipt_footer: organization ? organization.receipt_footer : '',
        vat_registration: organization ? organization.vat_registration : '',
      },
      holds: await this.holds.recent(branch.id),
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        kind: account.kind,
        is_default: account.is_default,
      })),
    };
  }

  /**
   * `PosProductSearchView.get`: the grid. Sixty active SKUs of active
   * products, by product name and position, with what the branch can sell.
   * The statement is Django's, so SKUs that tie come back alike.
   */
  async products(user: RequestUser, query: QueryDict) {
    const branch = await this.permissions.resolveBranch(user, query.get('branch') ?? null);
    const term = pyStrip(query.get('q', '') ?? '');
    const category = pyStrip(query.get('category', '') ?? '');
    const sql = new SqlParams();
    const where = [
      `"catalog_product"."status" = 'ACTIVE'`,
      `"catalog_productvariant"."status" = 'ACTIVE'`,
    ];
    if (term) {
      const like = sql.add(likeContains(term));
      where.push(
        `(UPPER("catalog_productvariant"."sku"::text) LIKE UPPER(${like})
           OR "catalog_productvariant"."barcode" = ${sql.add(term)}
           OR UPPER("catalog_product"."name"::text) LIKE UPPER(${like}))`,
      );
    }
    if (category) where.push(`"catalog_category"."slug" = ${sql.add(category)}`);
    const rows = await this.db.query<SearchRow>(
      `SELECT "catalog_productvariant"."id", "catalog_productvariant"."product_id",
              "catalog_productvariant"."sku", "catalog_productvariant"."barcode",
              "catalog_productvariant"."name", "catalog_productvariant"."price",
              "catalog_product"."name" AS "product_name", "catalog_category"."name" AS "category_name"
         FROM "catalog_productvariant"
        INNER JOIN "catalog_product"
           ON ("catalog_productvariant"."product_id" = "catalog_product"."id")
        INNER JOIN "catalog_category" ON ("catalog_product"."category_id" = "catalog_category"."id")
        WHERE (${where.join(' AND ')})
        ORDER BY "catalog_product"."name" ASC, "catalog_productvariant"."position" ASC LIMIT 60`,
      sql.values,
    );
    const ids = rows.map((row) => row.id);
    const images = await this.primaryImages([...new Set(rows.map((row) => row.product_id))]);
    const links = await this.payloads.links(ids);
    const snapshots = await this.availability.availability(branch.id, ids);
    return {
      results: rows.map((row) => ({
        id: row.id,
        sku: row.sku,
        barcode: row.barcode || '',
        name: row.product_name,
        label:
          row.name ||
          (links.get(row.id) ?? []).map(({ value }) => value.label || value.value).join(' / '),
        price: row.price,
        available: snapshots.get(row.id)?.available ?? 0,
        image: images.get(row.product_id) ?? '',
        category: row.category_name,
      })),
    };
  }

  /** `product.primary_image` over the prefetch: the flagged image, else the first by position. */
  private async primaryImages(productIds: string[]): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (!productIds.length) return urls;
    const sql = new SqlParams();
    const rows = await this.db.query<{ product_id: string; image: string; is_primary: boolean }>(
      `SELECT "catalog_productimage"."product_id", "catalog_productimage"."image",
              "catalog_productimage"."is_primary"
         FROM "catalog_productimage"
        WHERE "catalog_productimage"."product_id" IN ${sql.list(productIds, 'uuid')}
        ORDER BY "catalog_productimage"."position" ASC, "catalog_productimage"."created_at" ASC`,
      sql.values,
    );
    const chosen = new Map<string, { image: string; is_primary: boolean }>();
    for (const row of rows) {
      const current = chosen.get(row.product_id);
      if (!current || (row.is_primary && !current.is_primary)) chosen.set(row.product_id, row);
    }
    for (const [productId, row] of chosen)
      urls.set(productId, mediaUrl(row.image, this.env.mediaBase));
    return urls;
  }
}
