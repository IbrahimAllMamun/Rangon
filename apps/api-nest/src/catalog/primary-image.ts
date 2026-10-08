import { type MediaBase, mediaUrl } from '../common/media';
import type { Queryable } from '../database/database.service';

const IMAGE_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'product_id',
  'attribute_value_id',
  'image',
  'alt_text',
  'position',
  'is_primary',
  'width',
  'height',
]
  .map((column) => `"catalog_productimage"."${column}"`)
  .join(', ');

/**
 * `media_url(product.primary_image.image)`, or "" for a product with no
 * image: the flagged image, else the first by `Meta.ordering`. Django's own
 * statement, one product at a time as the property reads it, so a tie on
 * (position, created_at) resolves the same way.
 */
export async function primaryImageUrl(
  q: Queryable,
  productId: string,
  mediaBase: MediaBase,
): Promise<string> {
  const rows = await q.query<{ image: string; is_primary: boolean }>(
    `SELECT ${IMAGE_COLUMNS} FROM "catalog_productimage"
      WHERE "catalog_productimage"."product_id" = $1::uuid
      ORDER BY "catalog_productimage"."position" ASC, "catalog_productimage"."created_at" ASC`,
    [productId],
  );
  const chosen = rows.find((row) => row.is_primary) ?? rows[0];
  return chosen ? mediaUrl(chosen.image, mediaBase) : '';
}
