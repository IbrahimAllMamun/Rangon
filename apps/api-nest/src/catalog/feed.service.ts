import { Inject, Injectable } from '@nestjs/common';

import { OrganizationService } from '../accounts/organization.service';
import { Dec } from '../common/decimal';
import { BusinessError } from '../common/errors';
import { mediaUrl } from '../common/media';
import { pyLen, pySlice, pySplit } from '../common/python';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { AvailabilityService } from '../inventory/availability.service';
import { display, ProductPayloadService } from './product-payload.service';

/**
 * `catalog.feeds`: the product feed Meta and Google read. One row per buyable
 * variant; `price` is the pre-discount figure and `sale_price` the charged
 * one; availability is the storefront branch's; every URL absolute.
 */

const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 5000;
const ADDITIONAL_IMAGE_LIMIT = 10;
export const G_NAMESPACE = 'http://base.google.com/ns/1.0';

export const CSV_COLUMNS = [
  'id',
  'item_group_id',
  'title',
  'description',
  'availability',
  'inventory',
  'condition',
  'price',
  'sale_price',
  'link',
  'image_link',
  'additional_image_link',
  'brand',
  'product_type',
  'color',
  'size',
  'gtin',
  'mpn',
] as const;

/** Omitted from the XML when blank (`FeedItem.OPTIONAL`). */
const OPTIONAL = new Set([
  'item_group_id',
  'sale_price',
  'additional_image_link',
  'product_type',
  'color',
  'size',
  'gtin',
  'mpn',
]);

export type FeedItem = Record<(typeof CSV_COLUMNS)[number], string | number>;

export class FeedNotConfigured extends BusinessError {
  static override code = 'FEED_NOT_CONFIGURED';
  static override statusCode = 503;
}

/** `_clip`: collapse whitespace, then trim on a word boundary where there is one. */
export function clip(text: string, limit: number): string {
  const collapsed = pySplit(text ?? '').join(' ');
  if (pyLen(collapsed) <= limit) return collapsed;
  const cut = pySlice(collapsed, limit);
  const space = cut.lastIndexOf(' ');
  const spaced = space === -1 ? cut : cut.slice(0, space);
  const chosen = pyLen(spaced) > limit * 0.6 ? spaced : cut;
  return `${chosen.replace(/[ ,;.-]+$/, '')}…`;
}

/** The GS1 modulo-10 check digit, weights 3 and 1 from the right. */
function checkDigit(digits: string): number {
  let total = 0;
  [...digits].reverse().forEach((digit, index) => {
    total += Number(digit) * (index % 2 === 0 ? 3 : 1);
  });
  return (10 - (total % 10)) % 10;
}

/** `_looks_like_gtin`: a real, globally meaningful GTIN -- not the shop's own number. */
export function looksLikeGtin(barcode: string): boolean {
  if (!/^\d+$/.test(barcode) || ![8, 12, 13, 14].includes(barcode.length)) return false;
  if (checkDigit(barcode.slice(0, -1)) !== Number(barcode.slice(-1))) return false;
  const thirteen = barcode.slice(-13).padStart(13, '0');
  const prefix = Number(thirteen.slice(0, 3));
  const restricted =
    (prefix >= 20 && prefix < 30) ||
    (prefix >= 40 && prefix < 50) ||
    (prefix >= 200 && prefix < 300);
  return !restricted;
}

function absolute(url: string, origin: string): string {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${origin}/${url.replace(/^\/+/, '')}`;
}

@Injectable()
export class FeedService {
  constructor(
    private readonly db: Database,
    private readonly organization: OrganizationService,
    private readonly payloads: ProductPayloadService,
    private readonly stock: AvailabilityService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `public_url()`: the configured origin, no trailing slash, or 503. */
  publicUrl(): string {
    const configured = this.env.RANGON_PUBLIC_URL.trim();
    if (!configured) {
      throw new FeedNotConfigured(
        'The product feed needs the public address of the storefront. ' +
          'Set RANGON_PUBLIC_URL to it, for example https://rangonfashion.com.',
      );
    }
    return configured.replace(/\/+$/, '');
  }

  async shopName(): Promise<string> {
    const row = await this.db.one<{ name: string }>(
      `SELECT name FROM accounts_organization WHERE status = 'ACTIVE' ORDER BY created_at ASC LIMIT 1`,
    );
    return row ? row.name : 'Rangon Fashion';
  }

  private money(amount: string): string {
    return `${new Dec(amount).toFixed(2)} ${this.env.RANGON_CURRENCY}`;
  }

  async items(): Promise<FeedItem[]> {
    const origin = this.publicUrl();
    const shopName = await this.shopName();
    const branchId = await this.organization.storefrontBranchId();

    const products = await this.db.query<{
      id: string;
      name: string;
      slug: string;
      description: string;
      short_description: string;
      category_id: string;
      brand_name: string | null;
    }>(
      `SELECT p.id, p.name, p.slug, p.description, p.short_description, p.category_id, b.name AS brand_name
         FROM catalog_product p LEFT OUTER JOIN catalog_brand b ON p.brand_id = b.id
        WHERE p.published AND p.status = 'ACTIVE' ORDER BY p.name ASC, p.id ASC`,
    );
    const relations = await this.payloads.relations(products.map((product) => product.id));

    // One query for the whole category chain, not one per product.
    const categories = new Map(
      (
        await this.db.query<{ id: string; parent_id: string | null; name: string }>(
          `SELECT id, parent_id, name FROM catalog_category`,
        )
      ).map((row) => [row.id, row]),
    );
    const categoryPath = (id: string): string => {
      const names: string[] = [];
      let node = categories.get(id);
      // Ten levels at most: a cycle here would hang the feed.
      for (let seen = 0; node && seen < 10; seen++) {
        names.push(node.name);
        node = node.parent_id ? categories.get(node.parent_id) : undefined;
      }
      return names.reverse().join(' > ');
    };

    const sellable = [...relations.values()].flatMap((relation) =>
      relation.variants
        .filter((variant) => variant.status === 'ACTIVE')
        .map((variant) => variant.id),
    );
    const snapshots = await this.stock.availability(branchId, sellable);
    const barcodes = new Map(
      (
        await this.db.query<{ id: string; barcode: string | null }>(
          `SELECT id, barcode FROM catalog_productvariant WHERE id = ANY($1::uuid[])`,
          [sellable],
        )
      ).map((row) => [row.id, row.barcode ?? '']),
    );
    const kinds = new Map(
      (
        await this.db.query<{ id: string; kind: string }>(`SELECT id, kind FROM catalog_attribute`)
      ).map((row) => [row.id, row.kind]),
    );

    const items: FeedItem[] = [];
    for (const product of products) {
      const relation = relations.get(product.id) ?? { images: [], variants: [] };
      const images = relation.images;
      const primary = images.find((image) => image.isPrimary) ?? images[0] ?? null;
      const productType = categoryPath(product.category_id);
      const link = `${origin}/product/${product.slug}`;

      for (const variant of relation.variants) {
        if (variant.status !== 'ACTIVE') continue;
        const label = variant.name || variant.links.map((value) => display(value)).join(' / ');
        const title = label ? `${product.name} — ${label}` : product.name;

        // `kind`, not `code`: what the attribute is, not what someone named it.
        const colour =
          variant.links.find((value) => kinds.get(value.attribute.id) === 'COLOR') ?? null;
        const variantImages = colour
          ? images.filter((image) => image.attributeValue?.id === colour.id)
          : [];
        const hero = variantImages[0] ?? primary;
        const rest = images.filter((image) => image !== hero).slice(0, ADDITIONAL_IMAGE_LIMIT);
        const size = variant.links.find((value) => kinds.get(value.attribute.id) === 'SIZE');

        const available = snapshots.get(variant.id)?.available ?? 0;
        const compareAt = variant.compareAtPrice;
        const onSale =
          compareAt !== null &&
          !new Dec(compareAt).isZero() &&
          new Dec(compareAt).gt(variant.price);
        const barcode = barcodes.get(variant.id) ?? '';

        items.push({
          id: variant.sku,
          item_group_id: product.slug,
          title: clip(title, TITLE_LIMIT),
          description: clip(
            product.description || product.short_description || product.name,
            DESCRIPTION_LIMIT,
          ),
          availability: available > 0 ? 'in stock' : 'out of stock',
          inventory: Math.max(available, 0),
          condition: 'new',
          // Higher figure as `price`, charged figure as `sale_price`: the
          // strikethrough in the ad comes from the difference.
          price: this.money(onSale ? (compareAt as string) : variant.price),
          sale_price: onSale ? this.money(variant.price) : '',
          link,
          image_link: absolute(hero ? mediaUrl(hero.image, this.env.MEDIA_URL) : '', origin),
          additional_image_link: rest
            .map((image) => absolute(mediaUrl(image.image, this.env.MEDIA_URL), origin))
            .join(','),
          brand: product.brand_name ?? shopName,
          product_type: productType,
          color: colour ? display(colour) : '',
          size: size ? display(size) : '',
          gtin: looksLikeGtin(barcode) ? barcode : '',
          mpn: variant.sku,
        });
      }
    }
    return items;
  }

  /** `render_csv`: Python's `csv.DictWriter`, excel dialect. */
  renderCsv(items: FeedItem[]): string {
    const field = (value: string | number): string => {
      const text = String(value);
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const lines = [CSV_COLUMNS.join(',')];
    for (const item of items)
      lines.push(CSV_COLUMNS.map((column) => field(item[column])).join(','));
    return `${lines.join('\r\n')}\r\n`;
  }

  /** `render_xml`: RSS 2.0 with the `g:` namespace, as ElementTree writes it. */
  async renderXml(items: FeedItem[]): Promise<string> {
    const cdata = (text: string) =>
      text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const element = (tag: string, text: string) =>
      text ? `<${tag}>${cdata(text)}</${tag}>` : `<${tag} />`;

    const shopName = await this.shopName();
    let body = '';
    let usesNamespace = false;
    for (const item of items) {
      body += '<item>';
      for (const column of CSV_COLUMNS) {
        const value = String(item[column]);
        if (value === '' && OPTIONAL.has(column)) continue;
        // Plain RSS `title`/`link`/`description` are what a feed reader shows.
        const plain = column === 'title' || column === 'description' || column === 'link';
        if (!plain) usesNamespace = true;
        body += element(plain ? column : `g:${column}`, value);
      }
      body += '</item>';
    }
    const channel =
      element('title', `${shopName} product feed`) +
      element('link', this.publicUrl()) +
      element('description', `Every product ${shopName} currently sells online.`);
    // ElementTree declares a namespace only where one is used, before the attributes.
    const root = usesNamespace
      ? `<rss xmlns:g="${G_NAMESPACE}" version="2.0">`
      : '<rss version="2.0">';
    return `<?xml version="1.0" encoding="utf-8"?>\n${root}<channel>${channel}${body}</channel></rss>`;
  }
}
