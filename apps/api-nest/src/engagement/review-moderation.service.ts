import { Inject, Injectable } from '@nestjs/common';

import type { RequestUser } from '../auth/authentication';
import { type AuditContext, recordAudit } from '../common/audit';
import { localIso } from '../common/datetime';
import { NotFound } from '../common/errors';
import {
  applyFilters,
  choiceFilter,
  type FilterField,
  modelFilter,
  numberFilter,
  orderingFrom,
} from '../common/filtering';
import { paginated, pageSizeFrom, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { pyStr, pyStrip } from '../common/python';
import type { QueryDict } from '../common/query-dict';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { Params as SqlParams } from '../database/sql';
import { dataGet } from '../http/request-body';

/**
 * `engagement.api.views.ReviewModerationViewSet`: a review is hidden from
 * the product page until someone approves it. The list, a review, and the
 * two decisions -- which take no lock and know no order: an approved review
 * can be approved again, or rejected, and each decision overwrites the last
 * moderator and time on the row while the audit log keeps them all.
 */

const R = '"engagement_review"';
const P = '"catalog_product"';
const C = '"customers_customer"';
const SELECT = `${R}."id", ${R}."created_at", ${R}."product_id", ${R}."customer_id",
  ${R}."order_id", ${R}."rating", ${R}."title", ${R}."comment", ${R}."verified_purchase",
  ${R}."status", ${R}."moderated_at", ${R}."moderation_note",
  ${P}."name" AS "product_name", ${C}."name" AS "customer_name"`;
const FROM = `FROM ${R} INNER JOIN ${P} ON (${R}."product_id" = ${P}."id")
  INNER JOIN ${C} ON (${R}."customer_id" = ${C}."id")`;
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
const FILTERS: readonly FilterField[] = [
  choiceFilter('status', `${R}."status"`, STATUSES),
  modelFilter('product', `${R}."product_id"`, 'catalog_product'),
  numberFilter('rating', `${R}."rating"`, 'smallint'),
];
const ORDERING = { created_at: `${R}."created_at"`, rating: `${R}."rating"` };

interface ReviewRow {
  id: string;
  created_at: string;
  product_id: string;
  customer_id: string;
  order_id: string | null;
  rating: number;
  title: string;
  comment: string;
  verified_purchase: boolean;
  status: string;
  moderated_at: string | null;
  moderation_note: string;
  product_name: string;
  customer_name: string;
}

@Injectable()
export class ReviewModerationService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `ReviewSerializer(review).data`. */
  private review(row: ReviewRow) {
    return {
      id: row.id,
      product: row.product_id,
      product_name: row.product_name,
      customer: row.customer_id,
      customer_name: row.customer_name,
      order: row.order_id,
      rating: row.rating,
      title: row.title,
      comment: row.comment,
      verified_purchase: row.verified_purchase,
      status: row.status,
      moderation_note: row.moderation_note,
      moderated_at: localIso(row.moderated_at, this.env.DJANGO_TIME_ZONE),
      created_at: localIso(row.created_at, this.env.DJANGO_TIME_ZONE),
    };
  }

  async list(query: QueryDict, absoluteUrl: string) {
    const sql = new SqlParams();
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = orderingFrom(query, ORDERING) ?? [`${R}."created_at" DESC`];
    const count = Number(
      (
        await this.db.one<{ count: string }>(
          `SELECT COUNT(*) AS "count" FROM ${R} ${whereSql}`,
          sql.values,
        )
      )?.count ?? 0,
    );
    const page = resolvePage(query, count, pageSizeFrom(query, STANDARD_PAGINATION));
    const rows = await this.db.query<ReviewRow>(
      `SELECT ${SELECT} ${FROM} ${whereSql} ORDER BY ${order.join(', ')}
        LIMIT ${page.limit} OFFSET ${page.offset}`,
      sql.values,
    );
    return paginated(
      page,
      rows.map((row) => this.review(row)),
      absoluteUrl,
    );
  }

  /** `get_object()`: the filtered queryset, then the key. */
  private async find(pk: string, query: QueryDict): Promise<ReviewRow> {
    const sql = new SqlParams();
    const where: string[] = [];
    await applyFilters(this.db, query, FILTERS, sql, where);
    const id = parseUuid(pk);
    if (!id) throw new NotFound();
    where.push(`${R}."id" = ${sql.add(id, 'uuid')}`);
    const row = await this.db.one<ReviewRow>(
      `SELECT ${SELECT} ${FROM} WHERE ${where.join(' AND ')} LIMIT 21`,
      sql.values,
    );
    if (!row) throw new NotFound();
    return row;
  }

  async retrieve(pk: string, query: QueryDict) {
    return this.review(await this.find(pk, query));
  }

  /**
   * `_moderate`: the decision stamped on the row and written to the audit
   * log. The review is found before the body is read. The note is whatever
   * the body's `note` is, as Python prints it -- a null is the note "None" --
   * and an absent or blank one leaves the last note where it was. Nothing is
   * locked and the two writes are not one transaction (copied).
   */
  async moderate(
    user: RequestUser,
    pk: string,
    query: QueryDict,
    data: () => unknown,
    status: 'APPROVED' | 'REJECTED',
    context: AuditContext,
  ) {
    const review = await this.find(pk, query);
    const given = dataGet(data(), 'note');
    const note = pyStrip(given === undefined ? '' : pyStr(given));
    const moderationNote = note || review.moderation_note;
    const saved = await this.db.one<{ moderated_at: string }>(
      `UPDATE ${R} SET "status" = $2, "moderated_by_id" = $3, "moderated_at" = clock_timestamp(),
              "moderation_note" = $4, "updated_at" = clock_timestamp()
        WHERE ${R}."id" = $1 RETURNING "moderated_at"`,
      [review.id, status, user.id, moderationNote],
    );
    await recordAudit(this.db, context, {
      action: 'SETTINGS_CHANGED',
      // `str(review)`: the rating and the product's key.
      entity: { type: 'Review', id: review.id, label: `${review.rating}★ ${review.product_id}` },
      actor: { id: user.id, email: user.email },
      oldValues: { status: review.status, moderation_note: review.moderation_note },
      newValues: { status, moderation_note: moderationNote },
      reason: note || `Review ${status.toLowerCase()}`,
    });
    return this.review({
      ...review,
      status,
      moderation_note: moderationNote,
      // A review deleted meanwhile is answered as it would have been saved.
      moderated_at: saved?.moderated_at ?? review.moderated_at,
    });
  }
}
