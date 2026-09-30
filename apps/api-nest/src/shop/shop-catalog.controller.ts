import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { OrganizationService } from '../accounts/organization.service';
import { AllowAny } from '../auth/authentication';
import { DiscoveryService } from '../catalog/discovery.service';
import { MerchandisingService } from '../catalog/merchandising.service';
import { ProductDetailsService } from '../catalog/product-details.service';
import { ProductSearchService, SearchFilters } from '../catalog/product-search';
import { SearchLogService } from '../catalog/search-log.service';
import { NotFound, slugParam } from '../common/errors';
import { absoluteUri } from '../common/http';
import { mediaUrl } from '../common/media';
import { pageSizeFrom, paginated, resolvePage, STANDARD_PAGINATION } from '../common/pagination';
import { pyDecimal } from '../common/python';
import { Params, QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { StorefrontProducts } from './storefront-products.service';

/** `_decimal_or_none`: a price bound from the query string, or nothing. */
function decimalOrNone(raw: string | undefined): string | null {
  if (!raw) return null;
  return pyDecimal(raw);
}

/**
 * The public catalogue: `ShopProductViewSet`, `ShopBrandView`,
 * `ShopCategoryView`, `ShopFacetsView` and `ShopSearchSuggestView` from
 * orders/api/shop_views.py.
 */
@Controller('api/v1/shop')
@AllowAny()
export class ShopCatalogController {
  constructor(
    private readonly db: Database,
    private readonly organization: OrganizationService,
    private readonly search: ProductSearchService,
    private readonly products: StorefrontProducts,
    private readonly merchandising: MerchandisingService,
    private readonly details: ProductDetailsService,
    private readonly discovery: DiscoveryService,
    private readonly searchLog: SearchLogService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('products/')
  async productList(@Req() request: FastifyRequest, @Params() params: QueryDict) {
    const branchId = await this.organization.storefrontBranchId();
    const listing = await this.search.search(this.filters(params, branchId));

    const count = await listing.count();
    const page = resolvePage(params, count, pageSizeFrom(params, STANDARD_PAGINATION));
    const rows = await listing.page(page.offset, page.limit);
    const payload = await this.products.serialise(rows, { branchId });

    // Merchandising signal, logged once per search rather than per page.
    const query = params.get('q', '');
    if (query && params.get('page', '1') === '1') await this.searchLog.logSearch(query, count);

    return paginated(page, payload, absoluteUri(request, this.env));
  }

  @Get('products/:slug/')
  async productDetail(@Param('slug') rawSlug: string) {
    const slug = slugParam(rawSlug);
    const product = await this.merchandising.visibleBySlug(slug);
    if (!product) throw new NotFound('That product is not available.');

    const branchId = await this.organization.storefrontBranchId();
    const tax = await this.organization.taxSettings();
    const [payload] = await this.products.serialise([product], { branchId, tax });
    const result = payload as Record<string, unknown>;

    result.specs = await this.details.specs(product.id);
    result.size_chart = await this.details.sizeChart(product.sizeChartId);
    result.reviews = await this.details.reviews(product.id);

    // Real basket co-occurrence, degrading to the category on a young shop.
    const related = await this.merchandising.ranked(
      await this.merchandising.boughtTogether(product, 8),
    );
    result.related = await this.products.serialise(related, { branchId, tax });
    return result;
  }

  @Get('brands/')
  async brands() {
    const counts = new Map(
      (
        await this.db.query<{ brand_id: string | null; total: number }>(
          `SELECT "catalog_product"."brand_id", COUNT("catalog_product"."id")::int AS "total" FROM "catalog_product"
            WHERE ("catalog_product"."published" AND "catalog_product"."status" = 'ACTIVE')
            GROUP BY "catalog_product"."brand_id"`,
        )
      ).map((row) => [row.brand_id, row.total]),
    );
    const brands = await this.db.query<{
      id: string;
      name: string;
      slug: string;
      description: string;
      logo: string | null;
      is_featured: boolean;
    }>(
      `SELECT id, name, slug, description, logo, is_featured FROM catalog_brand WHERE is_active ORDER BY name ASC`,
    );
    // A brand with nothing to sell is a dead end, not a destination.
    return brands
      .filter((brand) => (counts.get(brand.id) ?? 0) > 0)
      .map((brand) => ({
        name: brand.name,
        slug: brand.slug,
        description: brand.description,
        logo: mediaUrl(brand.logo, this.env.MEDIA_URL),
        is_featured: brand.is_featured,
        product_count: counts.get(brand.id) ?? 0,
      }));
  }

  @Get('brands/:slug/')
  async brand(@Param('slug') rawSlug: string) {
    const slug = slugParam(rawSlug);
    const brand = await this.db.one<{
      id: string;
      name: string;
      slug: string;
      description: string;
      logo: string | null;
    }>(
      `SELECT id, name, slug, description, logo FROM catalog_brand WHERE slug = $1 AND is_active`,
      [slug],
    );
    if (!brand) throw new NotFound();
    const count = await this.db.one<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM catalog_product
        WHERE published AND status = 'ACTIVE' AND brand_id = $1::uuid`,
      [brand.id],
    );
    return {
      id: brand.id,
      name: brand.name,
      slug: brand.slug,
      description: brand.description,
      logo: mediaUrl(brand.logo, this.env.MEDIA_URL),
      product_count: count?.count ?? 0,
    };
  }

  @Get('categories/')
  async categories() {
    const roots = await this.db.query<{
      id: string;
      name: string;
      slug: string;
      image: string | null;
    }>(
      `SELECT id, name, slug, image FROM catalog_category
        WHERE is_active AND parent_id IS NULL AND show_in_navigation ORDER BY position ASC, name ASC`,
    );
    const children = await this.childrenOf(roots.map((root) => root.id));
    return roots.map((root) => ({
      name: root.name,
      slug: root.slug,
      path: root.slug,
      image: mediaUrl(root.image, this.env.MEDIA_URL),
      children: (children.get(root.id) ?? []).map((child) => ({
        name: child.name,
        slug: child.slug,
        path: `${root.slug}/${child.slug}`,
      })),
    }));
  }

  @Get('categories/:slug/')
  async category(@Param('slug') rawSlug: string) {
    const slug = slugParam(rawSlug);
    const category = await this.db.one<{
      id: string;
      name: string;
      slug: string;
      description: string;
      image: string | null;
      seo_title: string;
      seo_description: string;
    }>(
      `SELECT id, name, slug, description, image, seo_title, seo_description FROM catalog_category
        WHERE slug = $1 AND is_active`,
      [slug],
    );
    if (!category) throw new NotFound();

    // `path` is what /category/[...slug] canonicalises against
    // (docs/architecture/navigation.md section 5).
    const ancestors = await this.discovery.ancestors(category.id);
    const crumbPaths: string[] = [];
    for (const ancestor of ancestors) {
      crumbPaths.push(
        crumbPaths.length ? `${crumbPaths[crumbPaths.length - 1]}/${ancestor.slug}` : ancestor.slug,
      );
    }
    const path = crumbPaths.length
      ? `${crumbPaths[crumbPaths.length - 1]}/${category.slug}`
      : category.slug;
    const children = (await this.childrenOf([category.id])).get(category.id) ?? [];

    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      path,
      description: category.description,
      image: mediaUrl(category.image, this.env.MEDIA_URL),
      breadcrumbs: ancestors.map((ancestor, index) => ({
        name: ancestor.name,
        slug: ancestor.slug,
        path: crumbPaths[index],
      })),
      children: children.map((child) => ({
        name: child.name,
        slug: child.slug,
        path: `${path}/${child.slug}`,
      })),
      seo_title: category.seo_title || category.name,
      seo_description: category.seo_description,
    };
  }

  @Get('facets/')
  async facets(@Params() params: QueryDict) {
    const listing = await this.search.search({
      query: params.get('q', ''),
      categorySlug: params.get('category', ''),
    });
    return this.discovery.facets(await listing.ids());
  }

  @Get('search/suggest/')
  async suggest(@Params() params: QueryDict) {
    const query = params.get('q', '');
    const result = await this.discovery.suggest(query);
    return { query: query.trim(), ...result };
  }

  private filters(params: QueryDict, branchId: string | null): SearchFilters {
    return {
      query: params.get('q', ''),
      categorySlug: params.get('category', ''),
      brandSlugs: params.getlist('brand'),
      // Query strings, typed for Decimal on the Django side: a value that is
      // not a number reads as "no bound" rather than reaching SQL as junk.
      priceMin: decimalOrNone(params.get('price_min')),
      priceMax: decimalOrNone(params.get('price_max')),
      attributeFilters: params
        .keys()
        .filter((key) => key.startsWith('attr_'))
        .map((key) => [key.slice(5), params.getlist(key)] as [string, string[]]),
      inStockOnly: params.get('in_stock') === 'true',
      branchId,
      sort: params.get('sort', 'relevance'),
    };
  }

  /** Active children of each category, in `Category.Meta.ordering`. */
  private async childrenOf(ids: string[]) {
    const byParent = new Map<string, { name: string; slug: string }[]>();
    if (!ids.length) return byParent;
    const rows = await this.db.query<{ parent_id: string; name: string; slug: string }>(
      `SELECT parent_id, name, slug FROM catalog_category
        WHERE parent_id = ANY($1::uuid[]) AND is_active ORDER BY position ASC, name ASC`,
      [ids],
    );
    for (const row of rows) {
      const list = byParent.get(row.parent_id) ?? [];
      list.push({ name: row.name, slug: row.slug });
      byParent.set(row.parent_id, list);
    }
    return byParent;
  }
}
