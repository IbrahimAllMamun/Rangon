import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { NotFound, ValidationError } from '../common/errors';
import { pyIntText, pySlice, pyStr } from '../common/python';
import { Database } from '../database/database.service';
import { ORDER_SELECT } from '../orders/customer-orders.service';
import { dataGet } from '../http/request-body';

const RECEIVED = `"orders_order"."status" IN ('DELIVERED', 'RETURNED', 'REFUNDED')`;

/**
 * `ShopProductViewSet.reviews`: only a verified purchaser may review, once per
 * purchase, and the review waits for moderation.
 */
@Injectable()
export class ReviewsService {
  constructor(private readonly db: Database) {}

  /**
   * `data` is read only once the purchase checks have passed -- where the
   * Django view first touches `request.data` -- so a malformed body is
   * refused at the same point.
   */
  async submit(
    slug: string,
    customerId: string | null,
    data: () => unknown,
  ): Promise<Record<string, unknown>> {
    // `get_object_or_404(visible_products(), slug=slug)`.
    const product = await this.db.one<{ id: string }>(
      `SELECT "catalog_product"."id" FROM "catalog_product"
        WHERE ("catalog_product"."published" AND "catalog_product"."status" = 'ACTIVE'
               AND "catalog_product"."slug" = $1) LIMIT 21`,
      [slug],
    );
    if (!product) throw new NotFound();
    if (!customerId) throw new ValidationError('A customer account is required to review.');

    const received = `FROM "orders_order"
        INNER JOIN "orders_orderitem" ON ("orders_order"."id" = "orders_orderitem"."order_id")
        INNER JOIN "catalog_productvariant" ON ("orders_orderitem"."variant_id" = "catalog_productvariant"."id")
       WHERE ("orders_order"."customer_id" = $1::uuid
              AND "catalog_productvariant"."product_id" = $2::uuid AND ${RECEIVED}`;
    const anything = await this.db.one(`SELECT 1 AS "a" ${received}) LIMIT 1`, [
      customerId,
      product.id,
    ]);
    if (!anything) throw new ValidationError('You can only review a product you have received.');

    // One review per *purchase* (business-rules section 6a): the most recent
    // received order not yet reviewed. Django's exact statement, NOT IN
    // included -- a review with no order puts a NULL in the subquery, and then
    // every order is excluded. That is the Django API's answer, so it is this one's.
    const order = await this.db.one<{ id: string }>(
      `SELECT ${ORDER_SELECT} ${received}
              AND NOT ("orders_order"."id" IN (
                SELECT U0."order_id" FROM "engagement_review" U0
                 WHERE (U0."customer_id" = $1::uuid AND U0."product_id" = $2::uuid))))
       ORDER BY "orders_order"."placed_at" DESC LIMIT 1`,
      [customerId, product.id],
    );
    if (!order) throw new ValidationError('You have already reviewed this purchase.');

    // `int(str(request.data.get("rating")).strip())`: whole numbers only, so
    // "excellent" and 4.7 are refused rather than coerced.
    const body = data();
    const rating = pyIntText(pyStr(dataGet(body, 'rating') ?? null));
    if (rating === null)
      throw new ValidationError('Rating must be a whole number between 1 and 5.');
    if (rating < 1n || rating > 5n) throw new ValidationError('Rating must be between 1 and 5.');
    const title = dataGet(body, 'title');
    const comment = dataGet(body, 'comment');

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO engagement_review
         (id, created_at, updated_at, product_id, customer_id, order_id, rating, title, comment,
          verified_purchase, status, moderated_by_id, moderated_at, moderation_note)
       VALUES ($1::uuid, clock_timestamp(), clock_timestamp(), $2::uuid, $3::uuid, $4::uuid, $5,
               $6, $7, true, 'PENDING', NULL, NULL, '')`,
      [
        id,
        product.id,
        customerId,
        order.id,
        Number(rating),
        pySlice(title === undefined ? '' : pyStr(title), 140),
        comment === undefined ? '' : pyStr(comment),
      ],
    );
    return {
      id,
      status: 'PENDING',
      message: 'Thank you — your review will appear once it has been checked.',
    };
  }
}
