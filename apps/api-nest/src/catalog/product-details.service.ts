import { Injectable } from '@nestjs/common';

import { utcIso } from '../common/datetime';
import { Database } from '../database/database.service';
import { display } from './product-payload.service';

/**
 * What only the product page shows: structured specifications, the size
 * guide and approved reviews (`catalog.services.spec_payload`,
 * `size_chart_payload`, and the review block of `ShopProductViewSet.retrieve`).
 */
@Injectable()
export class ProductDetailsService {
  constructor(private readonly db: Database) {}

  /** Grouped by attribute, in `ProductAttributeValue.Meta.ordering`. */
  async specs(productId: string) {
    const rows = await this.db.query<{
      value: string;
      label: string;
      swatch: string;
      code: string;
      name: string;
      kind: string;
    }>(
      `SELECT "catalog_attributevalue"."value", "catalog_attributevalue"."label", "catalog_attributevalue"."swatch",
              "catalog_attribute"."code", "catalog_attribute"."name", "catalog_attribute"."kind"
         FROM "catalog_productattributevalue"
        INNER JOIN "catalog_attributevalue" ON ("catalog_productattributevalue"."attribute_value_id" = "catalog_attributevalue"."id")
        INNER JOIN "catalog_attribute" ON ("catalog_attributevalue"."attribute_id" = "catalog_attribute"."id")
        WHERE "catalog_productattributevalue"."product_id" = $1::uuid
        ORDER BY "catalog_attribute"."position" ASC, "catalog_attribute"."name" ASC,
                 "catalog_attributevalue"."position" ASC, "catalog_attributevalue"."value" ASC`,
      [productId],
    );
    const grouped = new Map<
      string,
      { attribute_code: string; attribute_name: string; kind: string; values: unknown[] }
    >();
    for (const row of rows) {
      let group = grouped.get(row.code);
      if (!group) {
        group = { attribute_code: row.code, attribute_name: row.name, kind: row.kind, values: [] };
        grouped.set(row.code, group);
      }
      group.values.push({ value: row.value, label: display(row), swatch: row.swatch });
    }
    return [...grouped.values()];
  }

  /** The product's chart, rows in the size attribute's own order; null without one. */
  async sizeChart(chartId: string | null) {
    if (!chartId) return null;
    const chart = await this.db.one<{
      name: string;
      system: string;
      columns: unknown[];
      notes: string;
      code: string;
      attribute_name: string;
    }>(
      `SELECT "catalog_sizechart"."name", "catalog_sizechart"."system", "catalog_sizechart"."columns",
              "catalog_sizechart"."notes", "catalog_attribute"."code", "catalog_attribute"."name" AS attribute_name
         FROM "catalog_sizechart"
        INNER JOIN "catalog_attribute" ON ("catalog_sizechart"."attribute_id" = "catalog_attribute"."id")
        WHERE "catalog_sizechart"."id" = $1::uuid`,
      [chartId],
    );
    if (!chart) return null;
    const rows = await this.db.query<{ value: string; label: string; cells: unknown[] }>(
      `SELECT "catalog_attributevalue"."value", "catalog_attributevalue"."label", "catalog_sizechartrow"."cells"
         FROM "catalog_sizechartrow"
        INNER JOIN "catalog_attributevalue" ON ("catalog_sizechartrow"."attribute_value_id" = "catalog_attributevalue"."id")
        WHERE "catalog_sizechartrow"."chart_id" = $1::uuid
        ORDER BY "catalog_attributevalue"."position" ASC, "catalog_attributevalue"."value" ASC`,
      [chartId],
    );
    return {
      name: chart.name,
      system: chart.system,
      attribute_code: chart.code,
      attribute_name: chart.attribute_name,
      columns: [...chart.columns],
      rows: rows.map((row) => ({ value: row.value, label: display(row), cells: [...row.cells] })),
      notes: chart.notes,
    };
  }

  /** Approved reviews: the average, the count and the newest twenty. */
  async reviews(productId: string) {
    const summary = await this.db.one<{ average: string | null; count: number }>(
      `SELECT AVG(rating) AS average, COUNT(*)::int AS count FROM "engagement_review"
        WHERE product_id = $1::uuid AND status = 'APPROVED'`,
      [productId],
    );
    const items = await this.db.query<{
      id: string;
      rating: number;
      title: string;
      comment: string;
      author: string;
      verified: boolean;
      created_at: string;
    }>(
      `SELECT "engagement_review"."id", "engagement_review"."rating", "engagement_review"."title",
              "engagement_review"."comment", "customers_customer"."name" AS author,
              "engagement_review"."verified_purchase" AS verified, "engagement_review"."created_at"
         FROM "engagement_review"
        INNER JOIN "customers_customer" ON ("engagement_review"."customer_id" = "customers_customer"."id")
        WHERE ("engagement_review"."product_id" = $1::uuid AND "engagement_review"."status" = 'APPROVED')
        ORDER BY "engagement_review"."created_at" DESC LIMIT 20`,
      [productId],
    );
    return {
      // Avg over an integer column is a float in Django; PostgreSQL's numeric
      // average read as a double gives the same number.
      average: summary?.average == null ? null : Number(summary.average),
      count: summary?.count ?? 0,
      items: items.map((review) => ({
        id: review.id,
        rating: review.rating,
        title: review.title,
        comment: review.comment,
        author: review.author,
        verified: review.verified,
        // A raw datetime in the response dict: DRF's encoder, UTC with `Z`.
        created_at: utcIso(review.created_at),
      })),
    };
  }
}
