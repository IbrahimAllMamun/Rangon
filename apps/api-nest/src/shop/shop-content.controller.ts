import { Controller, Get, Inject, Param } from '@nestjs/common';

import { OrganizationService } from '../accounts/organization.service';
import { AllowAny } from '../auth/authentication';
import { MerchandisingService } from '../catalog/merchandising.service';
import { NotFound, slugParam } from '../common/errors';
import { mediaUrl } from '../common/media';
import { ENV, Env } from '../config/env';
import { ContentService } from '../content/content.service';
import { Database } from '../database/database.service';
import { StorefrontProducts } from './storefront-products.service';

/**
 * The storefront's content: `ShopHomeView` (orders/api/shop_views.py) and
 * `ShopNavigationView`, `ShopSiteView`, `ShopPageListView`, `ShopPageView`
 * (content/api/views.py).
 */
@Controller('api/v1/shop')
@AllowAny()
export class ShopContentController {
  constructor(
    private readonly db: Database,
    private readonly organization: OrganizationService,
    private readonly merchandising: MerchandisingService,
    private readonly products: StorefrontProducts,
    private readonly content: ContentService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('home/')
  async home() {
    const branchId = await this.organization.storefrontBranchId();
    // Hoisted: the organisation's VAT treatment is the same for every row.
    const tax = await this.organization.taxSettings();
    const serialise = (rows: Awaited<ReturnType<MerchandisingService['ranked']>>) =>
      this.products.serialise(rows, { branchId, tax });

    const hero = await this.content.liveBanner('HOME_HERO');
    const carousel = await this.merchandising.ranked(await this.merchandising.carouselIds());
    const newArrivals = await this.merchandising.visibleWithRelated(
      '',
      'ORDER BY "catalog_product"."created_at" DESC LIMIT 8',
    );
    const featured = await this.merchandising.visibleWithRelated(
      '"catalog_product"."featured"',
      'ORDER BY "catalog_product"."created_at" DESC LIMIT 8',
    );
    const bestSellers = await this.merchandising.bestSellers(8);
    // Deepest reduction first; `_ranked` reapplies the order the query lost.
    const priceDrops = await this.merchandising.ranked(await this.merchandising.priceDrops(8));
    const brands = await this.db.query<{ name: string; slug: string; logo: string | null }>(
      `SELECT name, slug, logo FROM catalog_brand WHERE is_active AND is_featured ORDER BY name ASC LIMIT 8`,
    );

    return {
      hero,
      carousel: await serialise(carousel),
      new_arrivals: await serialise(newArrivals),
      featured: await serialise(featured),
      best_sellers: await serialise(bestSellers),
      price_drops: await serialise(priceDrops),
      brands: brands.map((brand) => ({
        name: brand.name,
        slug: brand.slug,
        logo: mediaUrl(brand.logo, this.env.mediaBase),
      })),
    };
  }

  /** The whole navbar in one request, never one per item (spec section 29). */
  @Get('navigation/')
  async navigation() {
    return {
      announcement: await this.content.liveBanner('ANNOUNCEMENT'),
      items: (await this.content.navigation('HEADER')).map((node) =>
        this.content.serialiseNode(node),
      ),
      footer: (await this.content.footerColumns()).map((node) => this.content.serialiseNode(node)),
    };
  }

  /** The footer's brand block, social links and link columns. Never a 500 for want of setup. */
  @Get('site/')
  site() {
    return this.content.site();
  }

  @Get('pages/')
  pages() {
    return this.content.publishedPages();
  }

  @Get('pages/:slug/')
  async page(@Param('slug') rawSlug: string) {
    const page = await this.content.publishedPage(slugParam(rawSlug));
    if (!page) throw new NotFound('That page does not exist.');
    return page;
  }
}
