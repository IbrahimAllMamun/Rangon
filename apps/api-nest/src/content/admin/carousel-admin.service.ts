import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { CataloguePayloads } from '../../catalog/admin/catalogue-payloads';
import { type AuditActor, type AuditContext, recordAudit } from '../../common/audit';
import { localIso } from '../../common/datetime';
import { Dec } from '../../common/decimal';
import { errorMessages, runSerializer, uuidField } from '../../common/drf';
import { Conflict, NotFound, ValidationError } from '../../common/errors';
import { orderingFrom } from '../../common/filtering';
import { mediaUrl } from '../../common/media';
import { pyStr } from '../../common/python';
import type { QueryDict } from '../../common/query-dict';
import { parseUuid } from '../../common/uuid';
import { ENV, Env } from '../../config/env';
import { Database, type Queryable } from '../../database/database.service';
import { Params as SqlParams } from '../../database/sql';
import { Revalidation } from '../../jobs/revalidation';
import { fail } from '../validators';
import { requestGet } from './navigation-admin.service';
import { moveRun } from './site-admin.service';

/**
 * `HomeCarouselViewSet` with `content.services`: the products in the
 * homepage carousel, in order -- add, remove, reorder. Each product sits
 * there once, an archived one never, and the run holds at most 24. An add
 * locks the run; a remove locks the item and, through the join, its product.
 * Adds and removes ask the storefront to drop `home` once committed (the
 * model's signals); a move, saved through `bulk_update`, asks for it itself.
 */

const MAX_CAROUSEL_PRODUCTS = 24;
const H = '"content_homecarouselitem"';
const ITEM_COLUMNS = ['id', 'created_at', 'updated_at', 'product_id', 'position', 'created_by_id'];
const PRODUCT_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'name',
  'slug',
  'category_id',
  'brand_id',
  'short_description',
  'description',
  'material',
  'care_instructions',
  'status',
  'published',
  'featured',
  'is_final_sale',
  'size_chart_id',
  'seo_title',
  'seo_description',
  'created_by_id',
];
/** `select_related("product")`, as Django sends it; read positionally. */
const SELECT = `SELECT ${ITEM_COLUMNS.map((c) => `${H}."${c}"`).join(', ')},
    ${PRODUCT_COLUMNS.map((c) => `"catalog_product"."${c}"`).join(', ')}
  FROM ${H} INNER JOIN "catalog_product" ON (${H}."product_id" = "catalog_product"."id")`;
const DEFAULT_ORDER = [`${H}."position" ASC`, `${H}."created_at" ASC`];
/** `OrderingFilter` with no `ordering_fields`: the serializer's model fields. */
const ORDERING = {
  id: `${H}."id"`,
  position: `${H}."position"`,
  created_at: `${H}."created_at"`,
};

interface CarouselRow {
  id: string;
  created_at: string;
  product_id: string;
  position: number;
  name: string;
  slug: string;
  status: string;
  published: boolean;
}

function rowFrom(values: unknown[]): CarouselRow {
  const product = ITEM_COLUMNS.length;
  return {
    id: values[0] as string,
    created_at: values[1] as string,
    product_id: values[3] as string,
    position: values[4] as number,
    name: values[product + 3] as string,
    slug: values[product + 4] as string,
    status: values[product + 11] as string,
    published: values[product + 12] as boolean,
  };
}

/** `carousel_hidden_reason`: why a product in the carousel is not on the homepage. */
function hiddenReason(row: { status: string; published: boolean }): string {
  if (row.status === 'ARCHIVED') return 'Archived, so it will not show.';
  if (row.status === 'DRAFT') return 'A draft. It shows once it is published.';
  if (!row.published) return 'Sold at the counter only. It shows once it is published online.';
  return '';
}

@Injectable()
export class CarouselAdminService {
  constructor(
    private readonly db: Database,
    private readonly payloads: CataloguePayloads,
    private readonly revalidation: Revalidation,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `HomeCarouselItemSerializer(items, many=True).data`, with the product's
   * images and variants prefetched: its primary image (the flagged one, else
   * the first) and the range of its sellable variants' prices.
   */
  private async serialise(rows: CarouselRow[]) {
    const ids = [...new Set(rows.map((row) => row.product_id))];
    const { images, colours } = await this.payloads.images(ids);
    const prices = new Map<string, string[]>();
    if (ids.length) {
      const sql = new SqlParams();
      const variants = await this.db.query<{ product_id: string; price: string; status: string }>(
        `SELECT "catalog_productvariant"."product_id", "catalog_productvariant"."price",
                "catalog_productvariant"."status"
           FROM "catalog_productvariant"
          INNER JOIN "catalog_product" ON ("catalog_productvariant"."product_id" = "catalog_product"."id")
          WHERE "catalog_productvariant"."product_id" IN ${sql.list(ids, 'uuid')}
          ORDER BY "catalog_product"."created_at" DESC, "catalog_productvariant"."position" ASC,
                   "catalog_productvariant"."sku" ASC`,
        sql.values,
      );
      for (const variant of variants) {
        if (variant.status !== 'ACTIVE') continue;
        const list = prices.get(variant.product_id) ?? [];
        list.push(variant.price);
        prices.set(variant.product_id, list);
      }
    }
    return rows.map((row) => {
      const productImages = images.get(row.product_id) ?? [];
      const primary = productImages.find((image) => image.is_primary) ?? productImages[0];
      const range = prices.get(row.product_id);
      // `min()` and `max()` over Decimals keep the first of equal values.
      const pickBy = (better: (a: string, b: string) => boolean) =>
        (range as string[]).reduce((best, price) => (better(price, best) ? price : best));
      const reason = hiddenReason(row);
      return {
        id: row.id,
        position: row.position,
        product: {
          id: row.product_id,
          name: row.name,
          slug: row.slug,
          status: row.status,
          published: row.published,
          image:
            primary && primary.image
              ? {
                  url: mediaUrl(primary.image, this.env.MEDIA_URL),
                  alt: this.payloads.alt(primary, row.name, colours),
                }
              : null,
          min_price: range ? pickBy((a, b) => new Dec(a).lt(b)) : null,
          max_price: range ? pickBy((a, b) => new Dec(a).gt(b)) : null,
        },
        shown: !reason,
        hidden_reason: reason,
        created_at: localIso(row.created_at, this.env.DJANGO_TIME_ZONE),
      };
    });
  }

  /** `list()`: the queryset as it is -- the view never filters it, so `?ordering=` is ignored. */
  async list() {
    const rows = (await this.db.arrays(`${SELECT} ORDER BY ${DEFAULT_ORDER.join(', ')}`)).map(
      rowFrom,
    );
    return this.serialise(rows);
  }

  /** `get_object()`. */
  private async find(pk: string, query: QueryDict): Promise<CarouselRow> {
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    const order = orderingFrom(query, ORDERING) ?? DEFAULT_ORDER;
    const rows = await this.db.arrays(
      `${SELECT} WHERE ${H}."id" = $1::uuid ORDER BY ${order.join(', ')} LIMIT 21`,
      [id],
    );
    if (!rows[0]) throw new NotFound();
    return rowFrom(rows[0]);
  }

  /** `_row(pk)`: `get_queryset().get(pk=pk)`, serialised. */
  private async row(id: string) {
    const rows = await this.db.arrays(`${SELECT} WHERE ${H}."id" = $1::uuid LIMIT 21`, [id]);
    return (await this.serialise([rowFrom(rows[0] as unknown[])]))[0];
  }

  /** `HomeCarouselAddSerializer`, then `add_carousel_product`. */
  async add(data: unknown, actor: AuditActor, context: AuditContext) {
    const validated = await runSerializer<{ product: string }>({ product: uuidField() }, data);
    if (!validated.ok)
      throw new ValidationError('Invalid input.', { details: errorMessages(validated.errors) });
    const productId = validated.values.product;
    const id = await this.db.transaction(async (tx: Queryable) => {
      const run = await tx.query<{ id: string; product_id: string; position: number }>(
        `SELECT ${ITEM_COLUMNS.map((c) => `${H}."${c}"`).join(', ')} FROM ${H}
          ORDER BY ${H}."position" ASC, ${H}."created_at" ASC FOR UPDATE`,
      );
      const product = await tx.one<{ id: string; name: string; status: string }>(
        `SELECT "catalog_product"."id", "catalog_product"."name", "catalog_product"."status"
           FROM "catalog_product" WHERE "catalog_product"."id" = $1::uuid
          ORDER BY "catalog_product"."created_at" DESC LIMIT 1`,
        [productId],
      );
      if (!product) throw fail('product', 'That product does not exist.');
      if (product.status === 'ARCHIVED')
        throw fail(
          'product',
          `${product.name} is archived, so it would never show. Restore it first.`,
        );
      if (run.some((item) => item.product_id === product.id))
        throw new Conflict(`${product.name} is already in the carousel.`);
      if (run.length >= MAX_CAROUSEL_PRODUCTS)
        throw fail(
          'product',
          `The carousel holds up to ${MAX_CAROUSEL_PRODUCTS} products. Remove one first.`,
        );
      const position = run.length ? (run[run.length - 1] as { position: number }).position + 1 : 0;
      const itemId = randomUUID();
      // The same product added from two screens at once: the unique index
      // answers for the one that lost.
      await tx.query('SAVEPOINT add_carousel_product');
      try {
        await tx.query(
          `INSERT INTO ${H} ("id", "created_at", "updated_at", "product_id", "position", "created_by_id")
           VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3, $4::uuid)`,
          [itemId, product.id, position, actor.id],
        );
        await tx.query('RELEASE SAVEPOINT add_carousel_product');
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT add_carousel_product');
        if ((error as { code?: string } | null)?.code === '23505')
          throw new Conflict(`${product.name} is already in the carousel.`);
        throw error;
      }
      await recordAudit(tx, context, {
        action: 'SETTINGS_CHANGED',
        entity: {
          type: 'HomeCarouselItem',
          id: itemId,
          label: `Carousel #${position}: ${product.id}`,
        },
        actor,
        newValues: { carousel_product: product.name, position },
      });
      return itemId;
    });
    // `post_save` waits for the commit.
    await this.revalidation.request('home');
    return this.row(id);
  }

  /** `get_object()`, then `remove_carousel_product`: the product itself is untouched. */
  async remove(pk: string, query: QueryDict, actor: AuditActor, context: AuditContext) {
    const target = await this.find(pk, query);
    await this.db.transaction(async (tx: Queryable) => {
      // `select_for_update()` over `select_related("product")` locks both rows.
      const item = await tx.query<{
        id: string;
        position: number;
        name: string;
        product_id: string;
      }>(
        `SELECT ${H}."id", ${H}."position", ${H}."product_id", "catalog_product"."name"
           FROM ${H} INNER JOIN "catalog_product" ON (${H}."product_id" = "catalog_product"."id")
          WHERE ${H}."id" = $1::uuid ORDER BY ${H}."position" ASC, ${H}."created_at" ASC
          LIMIT 1 FOR UPDATE`,
        [target.id],
      );
      const found = item[0];
      if (!found) throw new NotFound('That product is not in the carousel.');
      await recordAudit(tx, context, {
        action: 'SETTINGS_CHANGED',
        entity: {
          type: 'HomeCarouselItem',
          id: found.id,
          label: `Carousel #${found.position}: ${found.product_id}`,
        },
        actor,
        oldValues: { carousel_product: found.name, position: found.position },
        reason: 'Removed from the homepage carousel.',
      });
      await tx.query(`DELETE FROM ${H} WHERE ${H}."id" IN ($1::uuid)`, [found.id]);
    });
    await this.revalidation.request('home');
  }

  /** `get_object()`, then `move_carousel_product`, then `home` revalidated. */
  async move(
    pk: string,
    query: QueryDict,
    data: unknown,
    actor: AuditActor,
    context: AuditContext,
  ) {
    const target = await this.find(pk, query);
    const direction = pyStr(requestGet(data, 'direction') ?? '').toLowerCase();
    const item = await this.db.one<{ id: string }>(
      `SELECT ${ITEM_COLUMNS.map((c) => `${H}."${c}"`).join(', ')} FROM ${H}
        WHERE ${H}."id" = $1::uuid ORDER BY ${H}."position" ASC, ${H}."created_at" ASC LIMIT 1`,
      [target.id],
    );
    if (!item) throw new NotFound('That product is not in the carousel.');
    const moved = await moveRun(
      this.db,
      'content_homecarouselitem',
      '"position" ASC, "created_at" ASC',
      item.id,
      direction,
    );
    const after = rowFrom(
      (
        await this.db.arrays(`${SELECT} WHERE ${H}."id" = $1::uuid LIMIT 21`, [item.id])
      )[0] as unknown[],
    );
    if (moved) {
      await recordAudit(this.db, context, {
        action: 'SETTINGS_CHANGED',
        entity: {
          type: 'HomeCarouselItem',
          id: after.id,
          label: `Carousel #${after.position}: ${after.product_id}`,
        },
        actor,
        newValues: { carousel_product: after.name, moved: direction },
      });
    }
    await this.revalidation.request('home');
    return this.row(item.id);
  }
}
