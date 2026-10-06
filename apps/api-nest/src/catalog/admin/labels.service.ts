import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { RequestUser } from '../../auth/authentication';
import { type BranchRow, RolePermissions } from '../../auth/permissions';
import { pyIsoformat } from '../../common/datetime';
import {
  booleanField,
  errorMessages,
  type Field,
  type Fields,
  integerField,
  Invalid,
  InvalidNested,
  listField,
  runSerializer,
  uuidField,
  withDefault,
} from '../../common/drf';
import { ValidationError } from '../../common/errors';
import { pyStrip } from '../../common/python';
import { Database } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { AvailabilityService } from '../../inventory/availability.service';
import { CataloguePayloads } from './catalogue-payloads';

/**
 * `inventory.labels` and `ProductViewSet.labels`: the barcode label sheet.
 * Every variant of a product beside the stock a branch holds -- the hint for
 * how many stickers each needs -- and the ticks that say whose labels are
 * done. A tick is a new `LabelPrint` row, never an edit: the newest row for
 * a branch and variant is the state. Nothing here moves stock, and no lock
 * is taken, because nothing is protected by one: two people marking a
 * variant at once each write a row, and the newer stands.
 */

/** `MAX_LABELS`: the most stickers one mark may claim. */
const MAX_LABELS = 500;

interface Mark {
  variant: string;
  printed: boolean;
  quantity: number;
}

interface MarkRow {
  variant_id: string;
  printed: boolean;
  quantity: number;
  on_hand: number;
  created_at: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

/** `LabelMarkSerializer`. */
const MARK_FIELDS: Fields = {
  variant: uuidField(),
  printed: booleanField(),
  quantity: withDefault(
    integerField({ minValue: 0, maxValue: MAX_LABELS, required: false }),
    () => 0,
  ),
};
/** A serializer as a `ListField`'s child: each item validated on its own. */
const MARK: Field<Record<string, unknown>> = {
  async run(data, partial) {
    if (data === null) throw Invalid.of('This field may not be null.', 'null');
    const result = await runSerializer(MARK_FIELDS, data, { partial });
    if (!result.ok) throw new InvalidNested(result.errors);
    return result.values;
  },
};
/** `LabelMarksSerializer`: a branch, and between 1 and 200 marks. */
const MARKS_FIELDS: Fields = {
  branch: uuidField({ required: false, allowNull: true }),
  marks: listField(MARK, { minLength: 1, maxLength: 200 }),
};

export interface LabelProduct {
  id: string;
  name: string;
  brand_name: string | null;
  status: string;
}

@Injectable()
export class LabelsService {
  constructor(
    private readonly db: Database,
    private readonly payloads: CataloguePayloads,
    private readonly availability: AvailabilityService,
    private readonly permissions: RolePermissions,
  ) {}

  /** `LabelMarksSerializer(data=request.data).is_valid(raise_exception=True)`. */
  async validate(data: unknown): Promise<{ branch: string | null; marks: Mark[] }> {
    const validated = await runSerializer<{ branch?: string | null; marks: Mark[] }>(
      MARKS_FIELDS,
      data,
    );
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    return { branch: validated.values.branch ?? null, marks: validated.values.marks };
  }

  /**
   * `mark_labels`: every variant must be the product's, each once, and all
   * of the marks are written or none. `on_hand` is read from the branch's
   * stock row here, never taken from the request; an un-mark records no count.
   */
  async mark(
    user: RequestUser,
    product: LabelProduct,
    branch: BranchRow,
    marks: Mark[],
  ): Promise<void> {
    if (!marks.length) throw new ValidationError('Choose at least one variant to mark.');
    const wanted = marks.map((mark) => mark.variant);
    if (new Set(wanted).size !== wanted.length)
      throw new ValidationError('Each variant may be marked once per request.');
    for (const mark of marks) {
      if (mark.quantity < 0 || mark.quantity > MAX_LABELS) {
        throw new ValidationError(`Labels printed must be between 0 and ${MAX_LABELS}.`, {
          details: { variant: mark.variant },
        });
      }
    }
    const owned = new Set(
      (
        await this.db.query<{ id: string }>(
          `SELECT "id" FROM "catalog_productvariant"
            WHERE ("id" = ANY($2::uuid[]) AND "product_id" = $1)`,
          [product.id, wanted],
        )
      ).map((row) => row.id),
    );
    const stray = wanted.filter((id) => !owned.has(id));
    if (stray.length) {
      throw new ValidationError('Some of those variants are not part of this product.', {
        details: { variants: stray },
      });
    }
    const onHand = new Map(
      (
        await this.db.query<{ variant_id: string; on_hand: number }>(
          `SELECT "variant_id", "on_hand" FROM "inventory_inventory"
            WHERE ("branch_id" = $1 AND "variant_id" = ANY($2::uuid[]))`,
          [branch.id, wanted],
        )
      ).map((row) => [row.variant_id, row.on_hand]),
    );
    await this.db.transaction(async (tx) => {
      for (const mark of marks) {
        await tx.query(
          `INSERT INTO "inventory_labelprint"
             ("id", "created_at", "updated_at", "branch_id", "variant_id", "printed", "quantity",
              "on_hand", "created_by_id")
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4, $5, $6,
                   $7::uuid)`,
          [
            randomUUID(),
            branch.id,
            mark.variant,
            mark.printed,
            mark.printed ? mark.quantity : 0,
            onHand.get(mark.variant) ?? 0,
            user.id,
          ],
        );
      }
    });
  }

  /**
   * The sheet as it stands at `branch`: the product, the branch, and every
   * variant with its stock, its newest mark, the units purchased in since a
   * printed mark, and how many labels the screen should offer.
   */
  async sheet(product: LabelProduct, branch: BranchRow): Promise<Record<string, unknown>> {
    const { variants: byProduct, links } = await this.payloads.variants([product.id]);
    const variants = byProduct.get(product.id) ?? [];
    const ids = variants.map((variant) => variant.id);

    // `latest_marks`: the newest row per variant.
    const marks = new Map<string, MarkRow>();
    if (ids.length) {
      const sql = new SqlParams();
      const branchMark = sql.add(branch.id, 'uuid');
      for (const row of await this.db.query<MarkRow>(
        `SELECT DISTINCT ON (l."variant_id") l."variant_id", l."printed", l."quantity", l."on_hand",
                l."created_at", u."first_name", u."last_name", u."email"
           FROM "inventory_labelprint" l
           LEFT OUTER JOIN "accounts_user" u ON (l."created_by_id" = u."id")
          WHERE (l."branch_id" = ${branchMark} AND l."variant_id" IN ${sql.list(ids, 'uuid')})
          ORDER BY l."variant_id" ASC, l."created_at" DESC`,
        sql.values,
      ))
        marks.set(row.variant_id, row);
    }

    // `received_since`: purchases into the branch after each printed mark.
    const received = new Map<string, number>();
    const printed = [...marks.values()].filter((mark) => mark.printed);
    if (printed.length) {
      const sql = new SqlParams();
      const branchMark = sql.add(branch.id, 'uuid');
      const after = printed
        .map(
          (mark) =>
            `(t."created_at" > ${sql.add(mark.created_at, 'timestamptz')} AND t."variant_id" = ${sql.add(mark.variant_id, 'uuid')})`,
        )
        .join(' OR ');
      for (const row of await this.db.query<{ variant_id: string; total: string | null }>(
        `SELECT t."variant_id", SUM(t."quantity") AS "total"
           FROM "inventory_inventorytransaction" t
          WHERE (t."branch_id" = ${branchMark} AND t."transaction_type" IN ('PURCHASE')
                 AND (${after}))
          GROUP BY t."variant_id"`,
        sql.values,
      ))
        received.set(row.variant_id, Number(row.total ?? 0));
    }

    const stock = await this.availability.availability(branch.id, ids);
    return {
      product: {
        id: product.id,
        name: product.name,
        brand_name: product.brand_name ?? '',
        status: product.status,
      },
      branch: { id: branch.id, name: branch.name, code: branch.code },
      variants: variants.map((variant) => {
        const mark = marks.get(variant.id);
        const since = received.get(variant.id) ?? 0;
        // `suggested_labels`: one per unit on hand, or per unit delivered since
        // a printed mark -- never more than are on hand, never more than 500.
        const onHand = Math.max(stock.get(variant.id)?.onHand ?? 0, 0);
        const suggested = mark?.printed
          ? Math.min(since, onHand, MAX_LABELS)
          : Math.min(onHand, MAX_LABELS);
        return {
          ...this.payloads.variant(
            variant,
            { name: product.name, brandName: product.brand_name },
            links,
            { stock },
          ),
          label_status: mark
            ? {
                printed: mark.printed,
                quantity: mark.quantity,
                on_hand: mark.on_hand,
                marked_at: pyIsoformat(mark.created_at),
                // `User.full_name`: the name, or the email where there is none.
                marked_by:
                  mark.email === null
                    ? ''
                    : pyStrip(`${mark.first_name} ${mark.last_name}`) || mark.email,
                received_since: mark.printed ? since : 0,
              }
            : null,
          suggested_labels: suggested,
        };
      }),
    };
  }

  /** `resolve_branch(request.user, ...)`. */
  branch(user: RequestUser, branchId: unknown): Promise<BranchRow> {
    return this.permissions.resolveBranch(user, branchId);
  }
}
